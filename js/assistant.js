/* Раздел «ИИ-помощник» (assistant/index.html): чат с нейросетью о
   китайском. Запрос — задача "chat" через js/ai.js, системный промпт — в
   воркере (ai-worker/src/tasks.js).

   Диалог хранится в sessionStorage: переживает перезагрузку страницы, но
   не закрытие вкладки; «Новый диалог» его стирает. Нейросети уходят
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

  function save() {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-KEEP)));
    } catch (e) {}
  }

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
    newBtn.hidden = empty;
    sendBtn.disabled = !!pending;
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
    if (!text || pending) return;
    // Старые ошибки больше не нужны: вопрос задан заново.
    Array.prototype.forEach.call(log.querySelectorAll(".ai-msg.is-error"), function (node) {
      node.parentNode.removeChild(node);
    });
    messages.push({ role: "user", content: text });
    save();
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
        messages.push(msg);
        save();
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
    stop(true);
    messages = [];
    save();
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

  render();
  if (messages.length) window.scrollTo(0, document.documentElement.scrollHeight);
})();
