/* Синхронизация карточек с аккаунтом (js/account.js, API — backend/).

   Карточки по-прежнему живут в localStorage (js/flashcards.js):
     flashcards-user        { decks, extra, folders } — свои колоды и папки;
     flashcards:<id колоды> прогресс колоды.
   В облаке они лежат строками: deck:<id>, extra:<id>, folders,
   progress:<id> — одна строка на колоду.

   Как узнаём, что поменялось: в "cloud-sync" лежит отпечаток (hash) каждой
   строки на момент последней сверки с сервером. Перед отправкой собираем
   строки из localStorage и сравниваем — разница и есть изменения. Поэтому
   правка не потеряется, даже если сигнал CloudSync.changed() не дошёл.

   Когда отправляем: через 4 секунды после последней правки (но не позже
   20 секунд после первой) и сразу при уходе со страницы — так прогресс
   уходит пачкой, а не после каждой карточки. Сверка с сервером («что
   поменялось на других устройствах») — при открытии раздела карточек, при
   возвращении на вкладку и после входа.

   Первый вход на устройстве: что уже есть в браузере, объединяется с тем,
   что есть в аккаунте (слова, папки и прогресс складываются), и уходит в
   аккаунт — ничего не теряется. */
(function () {
  "use strict";

  var USER_KEY = "flashcards-user";
  var PREFIX = "flashcards:";
  var STATE_KEY = "cloud-sync";
  var ID_RE = /^(?:folders|(?:deck|extra|progress):[A-Za-z0-9_.-]{1,96})$/;   // как в backend/src/sync.js
  var PUSH_DELAY = 4000;
  var PUSH_MAX_WAIT = 20000;
  var PULL_AGAIN = 30000;            // сверка при возвращении на вкладку — не чаще
  var PULL_ELSEWHERE = 5 * 60000;    // на других страницах — не чаще раза в 5 минут
  var MAX_ROW = 120 * 1024;          // сервер принимает до 128 КБ на строку
  var BATCH_BYTES = 800 * 1024;
  var BATCH_ITEMS = 100;
  var KEEPALIVE_BYTES = 60 * 1024;   // предел fetch keepalive при закрытии страницы

  var Account = null;
  var status = "idle";
  var statusListeners = [];
  var running = null;
  var again = false;
  var timer = null;
  var firstChangeAt = 0;
  var onFlashcards = /\/flashcards\//.test(location.pathname);

  function noop() {}

  // ------------------------------------------------------- хранилище
  function getItem(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }
  function setItem(k, v) {
    try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }
  function removeItem(k) {
    try { window.localStorage.removeItem(k); } catch (e) {}
  }
  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function storageKeys() {
    var out = [];
    try {
      for (var i = 0; i < window.localStorage.length; i++) out.push(window.localStorage.key(i));
    } catch (e) {}
    return out;
  }

  // state: { userId, cursor: { rev, id }, rows: { id: hash }, dirty: { id: { u, h, q } }, lastPull }
  // dirty — несохранённые изменения: u — время правки, h — отпечаток (null —
  // удаление), q — сервер не принял (место кончилось), повторять только после новой правки.
  function freshState(userId) {
    return { userId: userId, cursor: { rev: 0, id: "" }, rows: {}, dirty: {}, lastPull: 0 };
  }

  function loadState() {
    var s = parse(getItem(STATE_KEY));
    if (!s || typeof s !== "object" || !s.rows || !s.dirty || !s.cursor) return freshState(null);
    return s;
  }

  function saveState(s) {
    setItem(STATE_KEY, JSON.stringify(s));
  }

  // ------------------------------------------------ строки и отпечатки
  function str(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  // Как cleanWords в flashcards.js: слово — с иероглифами, повтор (тот же
  // иероглиф и пиньинь) — один раз.
  function cleanWords(list) {
    var out = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (w) {
      if (!w || !str(w.hanzi)) return;
      var word = { hanzi: str(w.hanzi), pinyin: str(w.pinyin), translation: str(w.translation) };
      var key = word.hanzi + "|" + word.pinyin;
      if (seen[key]) return;
      seen[key] = true;
      out.push(word);
    });
    return out;
  }

  function cleanStatus(v) {
    if (v === "learning" || v === "learned") return v;
    if (v && typeof v === "object") return (Math.round(v.box) || 1) > 1 ? "learned" : "learning";
    return null;
  }

  // Приводит данные строки к одному виду (null — строки нет): одинаковые
  // данные дают одинаковый отпечаток, откуда бы ни пришли.
  function normalize(id, data) {
    if (!data || typeof data !== "object") return null;
    if (id.indexOf("deck:") === 0) {
      var words = cleanWords(data.words);
      return words.length ? { title: str(data.title).slice(0, 120) || id.slice(5), words: words } : null;
    }
    if (id.indexOf("extra:") === 0) {
      var extra = cleanWords(data);
      return extra.length ? extra : null;
    }
    if (id === "folders") {
      if (!Array.isArray(data)) return null;
      // public — отметка «общая» (папку издателя видят все, GET /public).
      var folders = data.filter(function (f) { return f && str(f.id); }).map(function (f) {
        var out = { id: str(f.id), title: str(f.title), decks: (Array.isArray(f.decks) ? f.decks : []).map(String) };
        if (f.public === true) out.public = true;
        return out;
      });
      return folders.length ? folders : null;
    }
    if (id.indexOf("progress:") === 0) {
      var saved = data.words && typeof data.words === "object" ? data.words : {};
      var progress = {};
      var any = false;
      Object.keys(saved).sort().forEach(function (k) {
        var s = cleanStatus(saved[k]);
        if (s) {
          progress[k] = s;
          any = true;
        }
      });
      return any ? { words: progress } : null;
    }
    return null;
  }

  // FNV-1a по JSON — короткий отпечаток для сравнения.
  function hash(data) {
    var text = JSON.stringify(data);
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + "." + text.length.toString(36);
  }

  function byteSize(text) {
    try { return new Blob([text]).size; } catch (e) { return text.length * 3; }
  }

  // Все строки из localStorage: { id: данные }.
  function collectLocal() {
    var out = {};
    var user = parse(getItem(USER_KEY)) || {};
    function put(id, data) {
      if (!ID_RE.test(id)) return;          // id, которые сервер не примет, остаются только здесь
      var n = normalize(id, data);
      if (n) out[id] = n;
    }
    (Array.isArray(user.decks) ? user.decks : []).forEach(function (d) {
      if (d && typeof d.id === "string") put("deck:" + d.id, d);
    });
    var extra = user.extra && typeof user.extra === "object" ? user.extra : {};
    Object.keys(extra).forEach(function (id) { put("extra:" + id, extra[id]); });
    put("folders", user.folders);
    storageKeys().forEach(function (k) {
      if (k && k.indexOf(PREFIX) === 0) put("progress:" + k.slice(PREFIX.length), parse(getItem(k)));
    });
    return out;
  }

  // Записать строки с сервера в localStorage. changes — [{ id, data|null }].
  function applyLocal(changes) {
    var user = parse(getItem(USER_KEY));
    if (!user || typeof user !== "object") user = {};
    if (!Array.isArray(user.decks)) user.decks = [];
    if (!user.extra || typeof user.extra !== "object") user.extra = {};
    if (!Array.isArray(user.folders)) user.folders = [];
    var userChanged = false;
    var added = [];
    changes.forEach(function (c) {
      var id = c.id;
      var data = c.data;
      if (id.indexOf("deck:") === 0) {
        var deckId = id.slice(5);
        var i = -1;
        user.decks.forEach(function (d, k) { if (d && d.id === deckId) i = k; });
        if (data) {
          var raw = { id: deckId, title: data.title, words: data.words };
          if (i >= 0) user.decks[i] = raw;
          else added.push(raw);
        } else if (i >= 0) {
          user.decks.splice(i, 1);
        }
        userChanged = true;
      } else if (id.indexOf("extra:") === 0) {
        if (data) user.extra[id.slice(6)] = data;
        else delete user.extra[id.slice(6)];
        userChanged = true;
      } else if (id === "folders") {
        user.folders = data || [];
        userChanged = true;
      } else if (id.indexOf("progress:") === 0) {
        if (data) setItem(PREFIX + id.slice(9), JSON.stringify(data));
        else removeItem(PREFIX + id.slice(9));
      }
    });
    // Новые колоды — в порядке создания (id своих колод растёт со временем).
    added.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    user.decks = user.decks.concat(added);
    if (userChanged) setItem(USER_KEY, JSON.stringify(user));
  }

  function unionWords(a, b) {
    return cleanWords([].concat(a || [], b || []));
  }

  // Первый вход: строка есть и здесь, и в аккаунте — складываем.
  function mergeRow(id, local, remote) {
    if (id.indexOf("deck:") === 0) return { title: remote.title, words: unionWords(remote.words, local.words) };
    if (id.indexOf("extra:") === 0) return unionWords(remote, local);
    if (id === "folders") {
      var out = remote.map(function (f) {
        var copy = { id: f.id, title: f.title, decks: f.decks.slice() };
        if (f.public) copy.public = true;
        return copy;
      });
      local.forEach(function (f) {
        var same = out.filter(function (o) { return o.id === f.id; })[0];
        if (!same) out.push(f);
        else f.decks.forEach(function (d) { if (same.decks.indexOf(d) === -1) same.decks.push(d); });
      });
      return out;
    }
    var words = Object.assign({}, remote.words);
    Object.keys(local.words).forEach(function (k) {
      if (local.words[k] === "learned" || !words[k]) words[k] = local.words[k];
    });
    return { words: words };
  }

  // Найти несохранённые изменения: сравнить localStorage с отпечатками.
  function scan(state) {
    var local = collectLocal();
    var now = Date.now();
    var mark = function (id, h) {
      var d = state.dirty[id];
      if (!d || d.h !== h) state.dirty[id] = { u: now, h: h };   // та же правка — время не трогаем
    };
    Object.keys(local).forEach(function (id) {
      var h = hash(local[id]);
      if (state.rows[id] === h) delete state.dirty[id];
      else mark(id, h);
    });
    Object.keys(state.rows).forEach(function (id) {
      if (!local[id]) mark(id, null);
    });
    Object.keys(state.dirty).forEach(function (id) {
      if (!local[id] && !state.rows[id]) delete state.dirty[id];      // создали и удалили до отправки
    });
    return local;
  }

  // «Что поменялось на сервере» — страницами, пока не догоним.
  function pullAll(state, first) {
    var changes = [];
    var local = first ? collectLocal() : null;
    function page() {
      var q = "?rev=" + encodeURIComponent(state.cursor.rev) + "&id=" + encodeURIComponent(state.cursor.id || "");
      return Account.api("GET", "/cards" + q).then(function (res) {
        (res.items || []).forEach(function (item) {
          var id = item.id;
          if (typeof id !== "string" || !ID_RE.test(id)) return;
          var remote = item.deleted ? null : normalize(id, item.data);
          var remoteHash = remote ? hash(remote) : null;
          if (first && local[id]) {
            // Удалено в аккаунте, а здесь есть — оставляем: уйдёт в аккаунт заново.
            if (!remote) {
              delete state.rows[id];
              return;
            }
            var merged = normalize(id, mergeRow(id, local[id], remote));
            local[id] = merged;
            changes.push({ id: id, data: merged });
            state.rows[id] = remoteHash;     // отличие от аккаунта найдёт scan и отправит
            return;
          }
          var d = state.dirty[id];
          if (!first && d && d.u > item.updatedAt) return;   // здесь правка новее — она уйдёт при отправке
          changes.push({ id: id, data: remote });
          if (remoteHash) state.rows[id] = remoteHash;
          else delete state.rows[id];
          delete state.dirty[id];
        });
        if (res.cursor && typeof res.cursor.rev === "number") state.cursor = res.cursor;
        if (res.more) return page();
      });
    }
    return page().then(function () {
      if (changes.length) {
        applyLocal(changes);
        reloadCards();
      }
    });
  }

  // Отправить несохранённое. keepalive — страница закрывается.
  function push(state, keepalive) {
    var local = collectLocal();
    var items = [];
    Object.keys(state.dirty).forEach(function (id) {
      var d = state.dirty[id];
      if (d.q) return;
      var data = local[id];
      if (data) {
        var h = hash(data);
        if (h !== d.h) return;               // поменялось после scan — отправит следующий раз
        var bytes = byteSize(JSON.stringify(data));
        if (bytes > MAX_ROW) {
          d.q = true;
          return;
        }
        items.push({ body: { id: id, data: data, updatedAt: d.u }, h: h, bytes: bytes + 64 });
      } else if (d.h === null) {
        items.push({ body: { id: id, deleted: true, updatedAt: d.u }, h: null, bytes: 64 });
      }
    });
    var batches = [];
    var cur = [];
    var curBytes = 0;
    items.forEach(function (it) {
      if (cur.length && (cur.length >= BATCH_ITEMS || curBytes + it.bytes > BATCH_BYTES)) {
        batches.push({ items: cur, bytes: curBytes });
        cur = [];
        curBytes = 0;
      }
      cur.push(it);
      curBytes += it.bytes;
    });
    if (cur.length) batches.push({ items: cur, bytes: curBytes });

    var needPull = false;
    function send(i) {
      if (i >= batches.length) return Promise.resolve(needPull);
      var batch = batches[i];
      var body = { items: batch.items.map(function (it) { return it.body; }) };
      var opts = { keepalive: !!keepalive && batch.bytes < KEEPALIVE_BYTES };
      return Account.api("PUT", "/cards", body, opts).then(function (res) {
        var byId = {};
        batch.items.forEach(function (it) { byId[it.body.id] = it; });
        (res.results || []).forEach(function (r) {
          var it = byId[r.id];
          var d = state.dirty[r.id];
          if (!it || !d || d.h !== it.h) return;
          if (r.status === "ok") {
            if (it.h) state.rows[r.id] = it.h;
            else delete state.rows[r.id];
            delete state.dirty[r.id];
            state.pushed = true;
          } else if (r.status === "stale") {
            delete state.dirty[r.id];        // на сервере новее — заберём при сверке
            needPull = true;
          } else if (r.status === "quota") {
            d.q = true;
          }
        });
        saveState(state);
        return send(i + 1);
      });
    }
    return send(0);
  }

  function reloadCards() {
    if (window.Flashcards && typeof window.Flashcards.reload === "function") {
      try { window.Flashcards.reload(); } catch (e) {}
    }
  }

  function setStatus(s) {
    if (status === s) return;
    status = s;
    statusListeners.forEach(function (fn) {
      try { fn(s); } catch (e) {}
    });
  }

  function hasQuota(state) {
    return Object.keys(state.dirty).some(function (id) { return state.dirty[id].q; });
  }

  function finish(state) {
    saveState(state);
    setStatus(hasQuota(state) ? "quota" : "idle");
  }

  function failed(state, err) {
    if (state) saveState(state);
    if (!Account.user()) setStatus("idle");             // пропуск отклонён — вышли
    else setStatus(err && err.status === 0 ? "offline" : "error");
  }

  function guard(work) {
    if (running) {
      again = true;
      return running;
    }
    running = work().then(noop, noop).then(function () {
      running = null;
      if (again) {
        again = false;
        return sync();
      }
    });
    return running;
  }

  // Полная сверка: свои правки → забрать чужие → отправить свои.
  function sync() {
    var user = Account && Account.user();
    if (!user) return Promise.resolve();
    return guard(function () {
      var state = loadState();
      var first = state.userId !== user.id;
      if (first) state = freshState(user.id);
      else scan(state);
      setStatus("syncing");
      return pullAll(state, first).then(function () {
        scan(state);
        saveState(state);
        return push(state, false);
      }).then(function (needPull) {
        state.lastPull = Date.now();
        finish(state);
        if (needPull) again = true;
      }, function (err) {
        // Первая сверка оборвалась — её не запоминаем: в следующий раз
        // объединение начнётся заново, а не перезапишет аккаунт.
        if (first && !state.pushed) return failed(null, err);
        failed(state, err);
      });
    });
  }

  // Только отправить (после правок и при уходе со страницы).
  function flush(keepalive) {
    clearTimeout(timer);
    timer = null;
    firstChangeAt = 0;
    var user = Account && Account.user();
    if (!user) return Promise.resolve();
    var state = loadState();
    if (state.userId !== user.id) return sync();
    if (running) {
      again = true;
      return running;
    }
    scan(state);
    saveState(state);
    if (!Object.keys(state.dirty).some(function (id) { return !state.dirty[id].q; })) return Promise.resolve();
    return guard(function () {
      setStatus("syncing");
      return push(state, keepalive).then(function (needPull) {
        finish(state);
        if (needPull) again = true;
      }, function (err) {
        failed(state, err);
      });
    });
  }

  var soon = null;
  function syncSoon(ms) {
    if (soon) return;
    soon = setTimeout(function () {
      soon = null;
      sync();
    }, ms || 0);
  }

  // ---------------------------------------------------------- снаружи
  window.CloudSync = {
    // Сигнал из flashcards.js: карточки или прогресс поменялись.
    changed: function () {
      if (!Account || !Account.user()) return;
      var now = Date.now();
      if (!firstChangeAt) firstChangeAt = now;
      clearTimeout(timer);
      timer = setTimeout(function () { flush(false); }, Math.max(0, Math.min(PUSH_DELAY, firstChangeAt + PUSH_MAX_WAIT - now)));
    },
    syncSoon: syncSoon,
    status: function () { return status; },
    onStatus: function (fn) { statusListeners.push(fn); },

    // Перед выходом: дослать, что не ушло. false — человек передумал выходить.
    beforeLogout: function () {
      return flush(false).then(noop, noop).then(function () {
        var state = loadState();
        if (!Account.user() || state.userId !== Account.user().id) return true;
        scan(state);
        if (!Object.keys(state.dirty).length) return true;
        return window.confirm("Часть изменений не успела сохраниться в аккаунте (нет связи). " +
          "Если выйти сейчас, на этом устройстве они пропадут. Выйти?");
      });
    },

    // Убрать карточки аккаунта из браузера (выход, смена человека в Telegram).
    clearLocal: function (flushFirst) {
      var before = flushFirst ? flush(false).then(noop, noop) : Promise.resolve();
      return before.then(function () {
        removeItem(USER_KEY);
        storageKeys().forEach(function (k) {
          if (k && k.indexOf(PREFIX) === 0) removeItem(k);
        });
        removeItem(STATE_KEY);
        reloadCards();
      });
    },

    // Вызывает js/account.js, когда window.Account готов.
    start: function () {
      Account = window.Account;
      if (!Account || !Account.enabled) return;
      Account.onChange(function (s) {
        if (s && s.user) syncSoon(0);
      });
      if (Account.user()) {
        var state = loadState();
        if (onFlashcards || state.userId !== Account.user().id || Date.now() - (state.lastPull || 0) > PULL_ELSEWHERE) syncSoon(0);
        else flush(false);
      }
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") {
          flush(true);
        } else if (onFlashcards && Account.user() && Date.now() - (loadState().lastPull || 0) > PULL_AGAIN) {
          syncSoon(0);
        }
      });
      window.addEventListener("pagehide", function () { flush(true); });
      window.addEventListener("online", function () { if (Account.user()) syncSoon(0); });
    },

    // для проверки в тестах
    _internal: { normalize: normalize, collectLocal: collectLocal, mergeRow: mergeRow, hash: hash }
  };
})();
