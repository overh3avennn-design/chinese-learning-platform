/* Раздел «ИИ-помощник» (assistant/index.html): чат с нейросетью о
   китайском. Запрос — задача "chat" через js/ai.js, системный промпт — в
   воркере (ai-worker/src/tasks.js).

   Гость хранит диалог в sessionStorage. В аккаунте диалоги хранятся
   в API /chat, до подтверждения записи сообщения ждут в локальной очереди. Нейросети уходят
   последние HISTORY_SENT сообщений — ей хватает, чтобы понять, о чём речь,
   а запрос не растёт бесконечно. */
(function () {
  "use strict";

  var root = document.querySelector("[data-assistant]");
  if (!root || !window.AI) return;

  var STORE_KEY = "assistant:chat";
  var HISTORY_SENT = 12;
  var KEEP = 60;            // сообщений в хранилище — не больше

  var log = root.querySelector("[data-log]");
  var intro = root.querySelector("[data-intro]");
  var form = root.querySelector("[data-form]");
  var input = root.querySelector("[data-input]");
  var sendBtn = root.querySelector("[data-send]");
  var newBtn = root.querySelector("[data-new-chat]");
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

  var account = null;
  var chat = null;            // сессия экрана конкретного аккаунта
  var historyPanel = root.querySelector("[data-history]");
  var historyList = root.querySelector("[data-history-list]");
  var feedback = root.querySelector("[data-history-feedback]");
  var retrySync = root.querySelector("[data-history-retry]");
  var historyClear = root.querySelector("[data-history-clear]");
  var messages = load();
  var pending = null;       // { ctrl, node } — запрос в пути

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ хранилище
  function valid(m) {
    return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
  }

  function load() {
    try {
      var list = JSON.parse(window.sessionStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(list) ? list.filter(valid) : [];
    } catch (e) {
      return [];
    }
  }

  function saveGuest() {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-KEEP)));
    } catch (e) {}
  }

  function uid() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function notice(text, retry) {
    feedback.hidden = !text;
    feedback.querySelector("[data-history-status]").textContent = text || "";
    retrySync.hidden = !retry;
  }

  function byTime(a, b) {
    return a.time - b.time || a.id.localeCompare(b.id);
  }

  function queued(c) {
    var items = Object.assign({}, c.memory);
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(c.prefix) === 0) {
          var op = JSON.parse(localStorage.getItem(key));
          if (op && op.message) items[op.message.id] = op;
        }
      }
    } catch (e) {}
    return Object.values(items).sort(function (a, b) { return byTime(a.message, b.message); });
  }

  function forget(c, op) {
    delete c.memory[op.message.id];
    try { localStorage.removeItem(c.prefix + op.message.id); } catch (e) {}
  }

  function rows(c) {
    var all = new Map(c.saved.map(function (m) { return [m.id, m]; }));
    queued(c).forEach(function (op) {
      if (op.epoch === c.epoch) all.set(op.message.id, op.message);
    });
    return Array.from(all.values()).sort(byTime);
  }

  function topics(c, all) {
    var first = new Map();
    all.forEach(function (m) { if (!first.has(m.chat)) first.set(m.chat, m); });
    historyList.textContent = "";
    Array.from(first.values()).reverse().forEach(function (m) {
      var button = el("button", "btn btn--sm btn--outline assistant-thread", m.content.slice(0, 70));
      button.type = "button";
      button.setAttribute("data-thread", m.chat);
      button.setAttribute("aria-current", String(m.chat === c.thread));
      button.disabled = !!pending || c.busy || !c.epoch;
      var date = el("time", "", new Date(m.time).toLocaleDateString("ru-RU"));
      date.setAttribute("datetime", new Date(m.time).toISOString());
      button.appendChild(date);
      historyList.appendChild(button);
    });
    if (!first.size) historyList.appendChild(el("p", "ai-note", "Здесь появятся ваши диалоги."));
    historyClear.disabled = c.busy || !c.epoch;
  }

  function showThread(c, newest) {
    var all = rows(c);
    if (newest && all.length) c.thread = all[all.length - 1].chat;
    messages = all.filter(function (m) { return m.chat === c.thread; });
    topics(c, all);
    render();
    if (!pending && messages.length && messages[messages.length - 1].role === "user") {
      log.appendChild(errorBubble("Ответ ещё не сохранён."));
    }
  }

  async function sync(c, refresh) {
    if (c !== chat || c.busy) return;
    c.busy = true;
    c.refreshing = !!refresh;
    update();
    try {
      if (!c.epoch || refresh) {
        var snapshot = await account.api("GET", "/chat");
        if (c !== chat) return;
        var first = !c.epoch;
        c.epoch = snapshot.epoch;
        c.saved = snapshot.messages;
        if (!pending) showThread(c, first);
      }
      // Читаем очередь после каждой записи: ответ ИИ может прийти, пока
      // идёт запись вопроса. Подтверждённую операцию повторять безопасно.
      var stale = false;
      for (;;) {
        var queue = queued(c);
        var op = queue[0];
        if (!op) break;
        try {
          await account.api("POST", "/chat", op);
        } catch (err) {
          if (c !== chat) return;
          if (err.code !== "history_cleared") throw err;
          // Только сервер может подтвердить, что поколение операции устарело:
          // другая вкладка могла уже получить более новую историю.
          forget(c, op);
          stale = true;
          if (c.epoch === op.epoch) {
            var current = await account.api("GET", "/chat");
            if (c !== chat) return;
            stop(true);
            c.epoch = current.epoch;
            c.saved = current.messages;
            showThread(c, true);
          }
          continue;
        }
        if (c !== chat) return;
        if (op.epoch === c.epoch && !c.saved.some(function (m) { return m.id === op.message.id; })) c.saved.push(op.message);
        forget(c, op);
      }
      notice(stale ? "История удалена на другом устройстве. Старые локальные сообщения исключены из синхронизации." : "");
    } catch (err) {
      if (c !== chat) return;
      notice(err.code === "history_cleared" ? "Историю удалили на другом устройстве. Обновите диалоги." : err.code === "chat_full" ? "История заполнена. Новые сообщения ожидают сохранения на этом устройстве." :
        "Не удалось синхронизировать историю. Проверьте соединение и повторите.", true);
    } finally {
      if (c === chat) {
        c.busy = false;
        c.refreshing = false;
        topics(c, rows(c));
        update();
      }
    }
  }

  function record(m) {
    if (!chat) {
      messages.push(m);
      saveGuest();
      return;
    }
    var last = messages[messages.length - 1];
    m.time = Math.max(Date.now(), last ? last.time + 1 : 0);
    m.id = uid();
    m.chat = chat.thread;
    var op = { action: "append", epoch: chat.epoch, message: m };
    chat.memory[m.id] = op;
    try { localStorage.setItem(chat.prefix + m.id, JSON.stringify(op)); }
    catch (e) { notice("До подтверждения сервером держите вкладку открытой."); }
    messages.push(m);
    topics(chat, rows(chat));
    sync(chat, false);
  }

  function changeAccount() {
    var user = account.user();
    if ((chat && chat.user) === (user && user.id)) return;
    stop(true);
    input.value = "";
    autosize();
    notice("");
    chat = user ? { user: user.id, prefix: "assistant:pending:" + user.id + ":", memory: {},
      thread: uid(), epoch: null, saved: [], busy: false } : null;
    root.querySelector("[data-history-guest]").hidden = !!chat;
    historyClear.hidden = !chat;
    if (!chat) {
      historyPanel.hidden = true;
      root.querySelector("[data-history-toggle]").setAttribute("aria-expanded", "false");
    }
    root.querySelector("[data-chat-note]").textContent = chat ? "история в аккаунте" : "хранится только в этой вкладке";
    messages = chat ? [] : load();
    historyList.textContent = "";
    render();
    if (chat) sync(chat, true);
  }

  function connect() {
    if (account || !window.Account) return;
    account = window.Account;
    account.onChange(changeAccount);
    changeAccount();
  }

  async function clearHistory() {
    var c = chat;
    if (!c || c.busy || !c.epoch || !window.confirm("Удалить все диалоги этого аккаунта на всех устройствах, включая сообщения, ожидающие отправки?")) return;
    stop(true);
    c.busy = true;
    c.clearing = true;
    update();
    try {
      var result = await account.api("POST", "/chat", { action: "clear", epoch: c.epoch, next: uid() });
      if (c !== chat) return;
      // Удаляем только операции прежних поколений: другое устройство или
      // вкладка уже могли начать новый диалог после подтверждения очистки.
      queued(c).forEach(function (op) { if (op.epoch === c.epoch) forget(c, op); });
      c.epoch = result.epoch;
      c.saved = [];
      c.thread = uid();
      showThread(c, false);
      notice("");
    } catch (err) {
      if (c === chat) notice("Не удалось подтвердить удаление. Обновите историю и проверьте результат.", true);
    } finally {
      if (c === chat) { c.busy = false; c.clearing = false; update(); }
    }
  }

  historyList.addEventListener("click", function (event) {
    var button = event.target.closest("[data-thread]");
    if (!button || !chat || pending || chat.busy) return;
    chat.thread = button.getAttribute("data-thread");
    showThread(chat, false);
    input.focus();
  });
  root.querySelector("[data-history-toggle]").addEventListener("click", function () {
    historyPanel.hidden = !historyPanel.hidden;
    this.setAttribute("aria-expanded", String(!historyPanel.hidden));
    if (chat && !pending && !historyPanel.hidden) sync(chat, true);
  });

  function greet() {
    var greetings = ["Что сегодня разберём по-китайски?", "你好! С чего начнём?", "Какой вопрос о китайском у вас сегодня?", "Давайте разберёмся в китайском вместе."];
    var previous = -1;
    try { previous = Number(window.sessionStorage.getItem("assistant:greeting")); } catch (e) {}
    var choice = Math.floor(Math.random() * (greetings.length - 1));
    if (choice >= previous && previous >= 0) choice++;
    choice %= greetings.length;
    root.querySelector("[data-greeting]").textContent = greetings[choice];
    try { window.sessionStorage.setItem("assistant:greeting", String(choice)); } catch (e) {}
  }
  greet();
  historyClear.addEventListener("click", clearHistory);
  retrySync.addEventListener("click", function () { if (chat && !pending) sync(chat, true); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && chat && !pending) sync(chat, true);
  });
  window.addEventListener("online", function () { if (chat) sync(chat, !pending); });
  window.addEventListener("load", connect);

  // ------------------------------------------------------------ сообщения
  function bubble(msg) {
    var node = el("article", "ai-msg is-" + msg.role);
    if (msg.role === "user") {
      var text = el("p", "ai-user-text");
      text.innerHTML = window.AI.text(msg.content);
      node.appendChild(text);
      return node;
    }
    node.setAttribute("aria-label", "Ответ помощника");
    var body = el("div", "ai-md");
    body.innerHTML = window.AI.markdown(msg.content);
    node.appendChild(body);
    if (msg.truncated) {
      var more = el("p", "ai-truncated", "Ответ получился длинным и оборвался. ");
      var btn = el("button", "ai-link", "Продолжить");
      btn.type = "button";
      btn.setAttribute("data-continue", "");
      more.appendChild(btn);
      node.appendChild(more);
    }
    return node;
  }

  function waiting() {
    var node = el("div", "ai-msg is-assistant is-waiting");
    node.setAttribute("role", "status");
    node.innerHTML = '<span class="ai-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="ai-waiting-text">Думаю над ответом…</span>' +
      '<button class="ai-link ai-stop" type="button" data-stop>Отменить</button>';
    return node;
  }

  function errorBubble(message) {
    var node = el("div", "ai-msg is-error");
    node.setAttribute("role", "alert");
    node.appendChild(el("p", null, message));
    var retry = el("button", "btn btn--sm btn--outline ai-retry", "повторить");
    retry.type = "button";
    retry.setAttribute("data-retry", "");
    node.appendChild(retry);
    return node;
  }

  function render() {
    log.textContent = "";
    messages.forEach(function (m) {
      log.appendChild(bubble(m));
    });
    update();
  }

  function update() {
    var empty = !messages.length && !log.children.length;
    intro.hidden = !empty;
    newBtn.hidden = false;
    var blocked = chat && (!chat.epoch || chat.clearing || chat.refreshing);
    sendBtn.disabled = !!pending || !!blocked;
    if (chat) {
      historyList.disabled = !!pending || chat.busy || !chat.epoch;
      historyClear.disabled = chat.busy || !chat.epoch;
    }
    log.setAttribute("aria-busy", pending ? "true" : "false");
  }

  // Ответ — с его начала: длинный ответ читают сверху, а не с конца.
  function reveal(node) {
    if (node.scrollIntoView) node.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function scrollToEnd() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }

  // ------------------------------------------------------------- запрос
  function send(text) {
    text = String(text || "").trim();
    if (!text || pending || (chat && (!chat.epoch || chat.clearing || chat.refreshing))) return;
    // Старые ошибки больше не нужны: вопрос задан заново.
    Array.prototype.forEach.call(log.querySelectorAll(".ai-msg.is-error"), function (node) {
      node.parentNode.removeChild(node);
    });
    record({ role: "user", content: text });
    input.value = "";
    autosize();
    log.appendChild(bubble(messages[messages.length - 1]));
    request();
  }

  function request() {
    var token = {};
    var ctrl = window.AbortController ? new AbortController() : null;
    var node = waiting();
    pending = { token: token, ctrl: ctrl, node: node };
    log.appendChild(node);
    update();
    scrollToEnd();

    var history = messages.slice(-HISTORY_SENT).map(function (m) {
      return { role: m.role, content: m.content };
    });
    window.AI.ask("chat", { messages: history }, { signal: ctrl ? ctrl.signal : undefined })
      .then(function (result) {
        if (!pending || pending.token !== token) return;
        done();
        var msg = { role: "assistant", content: String(result && result.text || "") };
        if (result && result.truncated) msg.truncated = true;
        record(msg);
        var answer = bubble(msg);
        log.appendChild(answer);
        update();
        reveal(answer);
      }, function (err) {
        if (!pending || pending.token !== token) return;
        done();
        if (err.code !== "aborted") log.appendChild(errorBubble(err.message));
        update();
      });
  }

  function done() {
    if (pending && pending.node.parentNode) pending.node.parentNode.removeChild(pending.node);
    pending = null;
  }

  // «Отменить»: вопрос остаётся в диалоге, его можно отправить снова.
  function stop(quiet) {
    if (!pending) return;
    if (pending.ctrl) pending.ctrl.abort();
    done();
    if (!quiet) log.appendChild(errorBubble("Запрос отменён."));
    update();
  }

  function newChat() {
    greet();
    stop(true);
    messages = [];
    if (chat) { chat.thread = uid(); topics(chat, rows(chat)); }
    else saveGuest();
    render();
    input.focus();
  }

  // ------------------------------------------------------------- события
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 200) + "px";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });

  // Enter отправляет, Shift+Enter — новая строка. На телефоне Enter — это
  // новая строка, отправка — кнопкой. Пока набор идёт через метод ввода
  // (пиньинь → иероглиф), Enter выбирает иероглиф и ничего не отправляет.
  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey || coarse || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener("input", autosize);

  root.addEventListener("click", function (e) {
    var prompt = e.target.closest(".ai-prompt");
    if (prompt) {
      // Полный текст вопроса — в data-ask: на кнопке он бывает короче.
      send(prompt.getAttribute("data-ask") || prompt.textContent);
      return;
    }
    if (e.target.closest("[data-new-chat]")) {
      newChat();
      return;
    }
    if (e.target.closest("[data-stop]")) {
      stop(false);
      return;
    }
    var retry = e.target.closest("[data-retry]");
    if (retry) {
      var box = retry.closest(".ai-msg");
      box.parentNode.removeChild(box);
      var last = messages[messages.length - 1];
      if (last && last.role === "user" && !pending) request();
      return;
    }
    if (e.target.closest("[data-continue]")) send("Продолжи");
  });

  connect();
  render();
  if (messages.length) window.scrollTo(0, document.documentElement.scrollHeight);
})();
