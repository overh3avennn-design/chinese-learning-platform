/* Аккаунт: вход через Telegram или Google и меню в шапке.

   Подключает components/site-header/header.js на каждой странице. Без
   входа сайт работает как раньше — всё хранится в браузере. После входа
   карточки синхронизирует js/cloud-sync.js.

   - Внутри Telegram (Mini App) вход сам: данные запуска Telegram.WebApp.initData
     проверяет сервер (backend/src/telegram.js).
   - На сайте — кнопки «Telegram» (Login Widget) и «Google» (Google Identity
     Services) в меню «войти».
   - Сервер выдаёт свой пропуск (JWT) на 30 дней; он лежит в localStorage
     "account" вместе с именем и фото.

   window.Account — для cloud-sync.js: user(), api(), onChange(fn),
   isMiniApp(), enabled. */
(function () {
  "use strict";

  // Адрес API (Yandex API Gateway) — из итога workflow backend.yml.
  var API_URL = "";
  var GOOGLE_CLIENT_ID = "254577720957-qpip2qlvvvkkb8hdfmci5bunatcaq9o2.apps.googleusercontent.com";
  var BOT_USERNAME = "chinese_free_bot";
  var KEY = "account";
  var RENEW_BEFORE = 3 * 24 * 3600 * 1000;    // в Mini App пропуск продлевается за 3 дня до конца

  var enabled = !!API_URL;
  var listeners = [];
  var relogins = 0;

  function readSession() {
    try {
      var s = JSON.parse(window.localStorage.getItem(KEY) || "null");
      if (s && typeof s.token === "string" && s.user && s.expiresAt > Date.now()) return s;
    } catch (e) {}
    return null;
  }

  var session = readSession();

  function writeSession(s) {
    session = s;
    try {
      if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
      else window.localStorage.removeItem(KEY);
    } catch (e) {}
    listeners.forEach(function (fn) {
      try { fn(session); } catch (e) {}
    });
  }

  function isMiniApp() {
    try {
      return window.sessionStorage.getItem("tg-mini-app") === "1";
    } catch (e) {
      return false;
    }
  }

  // Ошибка запроса: status — HTTP-код (0 — нет связи), code — причина от сервера.
  function ApiError(status, code) {
    this.status = status;
    this.code = code;
    this.message = code || "HTTP " + status;
  }

  // Запрос к API. Пропуск отклонён (истёк, аккаунт слит с другим) —
  // выходим без удаления карточек: при следующем входе они сольются.
  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    var token = opts.token !== undefined ? opts.token : session && session.token;
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(API_URL + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: !!opts.keepalive,
      cache: "no-store"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        if (res.status === 401 && token && session && token === session.token) {
          writeSession(null);
          // В Telegram входим заново сами (например, аккаунт слили с другим
          // при привязке) — не больше двух раз за страницу, без зацикливания.
          if (isMiniApp() && relogins++ < 2) setTimeout(function () { miniAppLogin(true); }, 0);
        }
        throw new ApiError(res.status, data && data.error);
      });
    }, function () {
      throw new ApiError(0, "offline");
    });
  }

  function saveLogin(data, extra) {
    writeSession(Object.assign({ token: data.token, expiresAt: data.expiresAt, user: data.user }, extra || {}));
  }

  function login(method, payload, extra) {
    return api("POST", "/auth/" + method, payload, { token: null }).then(function (data) {
      saveLogin(data, extra);
      return data.user;
    });
  }

  function link(method, payload) {
    return api("POST", "/auth/link/" + method, payload).then(function (data) {
      writeSession(Object.assign({}, session, { user: data.user }));
      if (data.merged && window.CloudSync) window.CloudSync.syncSoon(0);
      return data;
    });
  }

  // ------------------------------------------------------- Mini App
  // Библиотеку Telegram подгружает js/main.js — ждём её до 6 секунд.
  function waitTelegram(done) {
    var tries = 0;
    (function check() {
      var app = window.Telegram && window.Telegram.WebApp;
      if (app && app.initData) return done(app);
      if (++tries > 60) return done(null);
      setTimeout(check, 100);
    })();
  }

  var miniAppState = "idle";    // idle | pending | failed

  function miniAppLogin(force) {
    if (!enabled || !isMiniApp() || miniAppState === "pending") return;
    miniAppState = "pending";
    render();
    waitTelegram(function (app) {
      if (!app) {
        miniAppState = "failed";
        render();
        return;
      }
      var tgUser = app.initDataUnsafe && app.initDataUnsafe.user;
      var tgId = tgUser && tgUser.id;
      var fresh = session && session.expiresAt - Date.now() > RENEW_BEFORE;
      // Тот же человек и пропуск ещё долго действует — ничего не делаем.
      if (!force && fresh && (!session.tg || session.tg === tgId)) {
        miniAppState = "idle";
        render();
        return;
      }
      var switching = session && session.tg && tgId && session.tg !== tgId;
      var before = switching && window.CloudSync ? window.CloudSync.clearLocal() : Promise.resolve();
      before.then(function () {
        return login("telegram-miniapp", { initData: app.initData }, { tg: tgId });
      }).then(function () {
        miniAppState = "idle";
        render();
      }, function () {
        miniAppState = "failed";
        render();
      });
    });
  }

  // ------------------------------------------------------------ меню
  var root = window.SITE_ROOT || "";
  var slot = null;
  var button = null;
  var panel = null;
  var open = false;
  var busy = false;
  var errorText = "";

  var ERRORS = {
    offline: "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.",
    auth_expired: "Данные входа устарели — попробуйте ещё раз.",
    already_linked: "К аккаунту уже привязан другой вход этого вида.",
    other_account_conflict: "Этот вход уже связан с другим аккаунтом, у которого есть свой второй вход. Выйдите и войдите им.",
    merge_too_large: "Вместе карточек слишком много — удалите лишние колоды в одном из аккаунтов.",
    rate_limited: "Слишком много попыток. Подождите минуту.",
    default: "Не получилось войти. Попробуйте ещё раз."
  };

  function errorMessage(err) {
    return ERRORS[err && err.code] || ERRORS.default;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "hidden") node.hidden = !!attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function avatar(user, big) {
    var box = el("span", { "class": "account__avatar" + (big ? " account__avatar--big" : ""), "aria-hidden": "true" });
    var letter = ((user.name || "?").trim()[0] || "?").toUpperCase();
    box.textContent = letter;
    if (user.photo && /^https:\/\//.test(user.photo)) {
      var img = el("img", { src: user.photo, alt: "", referrerpolicy: "no-referrer", loading: "lazy" });
      img.onerror = function () { img.remove(); };
      box.appendChild(img);
    }
    return box;
  }

  function legal() {
    return el("p", { "class": "account__legal" }, [
      "Входя, вы соглашаетесь с ",
      el("a", { href: root + "support/terms.html", text: "условиями" }),
      " и ",
      el("a", { href: root + "support/privacy.html", text: "политикой конфиденциальности" }),
      "."
    ]);
  }

  // Кнопки входа. mode — "login" или "link"; only — "telegram"/"google"
  // (для привязки нужен только недостающий вход).
  function providers(mode, only) {
    var box = el("div", { "class": "account__providers" });
    if (!only || only === "telegram") {
      var tg = el("div", { "class": "account__provider account__provider--telegram" });
      box.appendChild(tg);
      mountTelegramWidget(tg, mode);
    }
    if (!only || only === "google") {
      var g = el("div", { "class": "account__provider account__provider--google" });
      box.appendChild(g);
      mountGoogleButton(g, mode);
    }
    return box;
  }

  function status() {
    var s = window.CloudSync ? window.CloudSync.status() : "idle";
    var text = {
      idle: "Карточки и прогресс сохраняются в аккаунте.",
      syncing: "Синхронизация…",
      offline: "Нет связи — изменения сохранятся, когда она появится.",
      quota: "Места в аккаунте не хватает: часть колод не сохранена.",
      error: "Не получилось синхронизировать — попробую ещё раз позже."
    }[s] || "";
    return el("p", { "class": "account__status account__status--" + s, "data-sync-status": "", text: text });
  }

  function panelContent() {
    var nodes = [];
    var user = session && session.user;
    if (!user) {
      nodes.push(el("p", { "class": "account__title", text: "вход" }));
      if (isMiniApp()) {
        if (miniAppState === "pending") {
          nodes.push(el("p", { "class": "account__text", text: "Входим через Telegram…" }));
        } else {
          nodes.push(el("p", { "class": "account__text", text: "Не получилось войти через Telegram." }));
          var retry = el("button", { type: "button", "class": "account__action", text: "попробовать ещё раз" });
          retry.addEventListener("click", function () { miniAppLogin(true); });
          nodes.push(retry);
        }
      } else {
        nodes.push(el("p", { "class": "account__text", text: "Войдите, чтобы свои колоды и прогресс были на всех устройствах — в браузере и в Telegram." }));
        nodes.push(providers("login"));
        nodes.push(legal());
      }
    } else {
      var ways = [user.telegram ? "Telegram" : "", user.google ? "Google" : ""].filter(Boolean).join(" · ");
      nodes.push(el("div", { "class": "account__who" }, [
        avatar(user, true),
        el("div", { "class": "account__who-text" }, [
          el("p", { "class": "account__who-name", text: user.name || "Без имени" }),
          el("p", { "class": "account__who-ways", text: "вход: " + ways })
        ])
      ]));
      nodes.push(status());
      var missing = !user.google ? "google" : !user.telegram ? "telegram" : null;
      if (missing && !isMiniApp()) {
        nodes.push(el("p", { "class": "account__subtitle", text: "привязать " + (missing === "google" ? "Google" : "Telegram") }));
        nodes.push(el("p", { "class": "account__text", text: "Тогда в этот же аккаунт можно будет входить и через " +
          (missing === "google" ? "Google" : "Telegram") + ". Если там уже есть свои карточки, они объединятся." }));
        nodes.push(providers("link", missing));
      } else if (missing === "google") {
        nodes.push(el("p", { "class": "account__text account__text--muted", text: "Google можно привязать на сайте в обычном браузере — внутри Telegram вход Google не работает." }));
      }
      var out = el("button", { type: "button", "class": "account__action account__action--logout", text: "выйти" });
      out.addEventListener("click", logout);
      nodes.push(out);
    }
    if (errorText) nodes.push(el("p", { "class": "account__error", role: "alert", text: errorText }));
    return nodes;
  }

  function render() {
    if (!slot) return;
    var user = session && session.user;
    button.textContent = "";
    if (user) {
      button.appendChild(avatar(user));
      button.appendChild(el("span", { "class": "account__name", text: user.name || "аккаунт" }));
      button.setAttribute("aria-label", "Аккаунт: " + (user.name || ""));
    } else {
      button.appendChild(el("span", { "class": "account__login", text: miniAppState === "pending" ? "вход…" : "войти" }));
      button.removeAttribute("aria-label");
    }
    button.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
    if (open) {
      panel.textContent = "";
      panelContent().forEach(function (n) { panel.appendChild(n); });
    }
    slot.classList.toggle("account--in", !!user);
    slot.classList.toggle("account--busy", busy);
  }

  function setOpen(value) {
    if (open === value) return;
    open = value;
    if (!open) errorText = "";
    render();
  }

  function run(promise) {
    busy = true;
    errorText = "";
    render();
    return promise.then(function () {
      busy = false;
      render();
    }, function (err) {
      busy = false;
      errorText = errorMessage(err);
      render();
    });
  }

  function logout() {
    var check = window.CloudSync ? window.CloudSync.beforeLogout() : Promise.resolve(true);
    run(check.then(function (ok) {
      if (!ok) return;
      writeSession(null);
      setOpen(false);
      if (window.CloudSync) return window.CloudSync.clearLocal(false);
    }));
  }

  // ------------------------------------------------- Telegram Login Widget
  // https://core.telegram.org/widgets/login — работает только на домене,
  // который указан у бота в BotFather (/setdomain).
  var telegramMode = "login";

  window.__accountTelegramAuth = function (user) {
    if (!user || !user.hash) return;
    if (telegramMode === "link") {
      run(link("telegram-widget", { user: user }));
    } else {
      run(login("telegram-widget", { user: user }, { tg: user.id }).then(function () { setOpen(false); }));
    }
  };

  function mountTelegramWidget(box, mode) {
    telegramMode = mode;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", BOT_USERNAME);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "0");
    s.setAttribute("data-userpic", "false");
    s.setAttribute("data-lang", "ru");
    s.setAttribute("data-onauth", "__accountTelegramAuth(user)");
    box.appendChild(s);
  }

  // ------------------------------------------- Google Identity Services
  // https://developers.google.com/identity/gsi/web — кнопка «Войти через
  // Google» во всплывающем окне; ID token проверяет сервер.
  var gisLoading = null;
  var gisReady = false;
  var googleMode = "login";

  function loadGis() {
    if (!gisLoading) {
      gisLoading = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true;
        s.onload = resolve;
        s.onerror = function () {
          gisLoading = null;
          reject(new Error("gsi"));
        };
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }

  function onGoogle(response) {
    var credential = response && response.credential;
    if (!credential) return;
    if (googleMode === "link") run(link("google", { credential: credential }));
    else run(login("google", { credential: credential }).then(function () { setOpen(false); }));
  }

  function mountGoogleButton(box, mode) {
    googleMode = mode;
    loadGis().then(function () {
      var id = window.google && window.google.accounts && window.google.accounts.id;
      if (!id) throw new Error("gsi");
      if (!gisReady) {
        id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogle, ux_mode: "popup", auto_select: false });
        gisReady = true;
      }
      if (!box.isConnected) return;
      id.renderButton(box, {
        type: "standard", theme: "outline", size: "large", shape: "rectangular", logo_alignment: "left",
        text: mode === "link" ? "continue_with" : "signin_with", locale: "ru", width: 260
      });
    }).catch(function () {
      if (box.isConnected) box.appendChild(el("p", { "class": "account__text account__text--muted", text: "Кнопка Google не загрузилась — проверьте интернет." }));
    });
  }

  // ------------------------------------------------------------ запуск
  window.Account = {
    enabled: enabled,
    user: function () { return session && session.user; },
    api: api,
    isMiniApp: isMiniApp,
    onChange: function (fn) { listeners.push(fn); }
  };

  function init() {
    slot = document.querySelector("[data-account]");
    if (!enabled || !slot) return;
    slot.hidden = false;
    button = el("button", { type: "button", "class": "account__button", "aria-haspopup": "true", "aria-expanded": "false" });
    panel = el("div", { "class": "account__panel", hidden: true });
    slot.appendChild(button);
    slot.appendChild(panel);
    button.addEventListener("click", function () { setOpen(!open); });
    // Путь события — на момент нажатия: кнопка внутри меню могла уже
    // пропасть после перерисовки.
    document.addEventListener("click", function (e) {
      if (open && e.composedPath().indexOf(slot) === -1) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (open && e.key === "Escape") {
        setOpen(false);
        button.focus();
      }
    });
    listeners.push(render);
    if (window.CloudSync) {
      window.CloudSync.start();
      window.CloudSync.onStatus(function () {
        var old = open && panel.querySelector("[data-sync-status]");
        if (old) old.replaceWith(status());
      });
    }
    render();
    miniAppLogin(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
