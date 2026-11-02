/* Рукописный ввод в словаре: кнопка с кисточкой рядом с «Найти» открывает
   клетку, где иероглиф рисуют пальцем или мышкой. После каждой черты
   рисунок уходит на распознавание в Google — тот же сервис, что в Google
   Переводчике, — и рядом с клеткой появляются похожие иероглифы. Нажатый
   иероглиф встаёт в поле поиска и сразу ищется; следующий дописывается к
   нему, так набирается слово целиком. Первый выбранный после открытия
   иероглиф заменяет прежний запрос: клетку открывают, чтобы найти новое.

   Адрес распознавания неофициальный, без документации. Если Google его
   изменит или закроет, окно скажет «не отвечает» и подскажет рукописную
   клавиатуру телефона. В запросе только черты (точки в квадрате 1000×1000
   и время от начала рисунка), без cookie.

   На компьютере клетка раскрывается под строкой поиска, на телефоне —
   панелью внизу экрана, как клавиатура: поле и результаты видны над ней.
   Подключается на странице словаря после js/dictionary.js: ищет, отправляя
   форму поиска, так что сам поиск остаётся в dictionary.js. */
(function () {
  "use strict";

  var form = document.querySelector("[data-dict-form]");
  var toggle = form && form.querySelector("[data-hw-toggle]");
  var input = form && form.querySelector("[data-dict-input]");
  if (!toggle || !input) return;

  var API = "https://inputtools.google.com/request?ime=handwriting&app=translate&dbg=0&cs=1&oe=UTF-8";
  var AREA = 1000;          // черты уходят в Google в квадрате AREA×AREA
  var SEND_DELAY = 200;     // пауза после черты, прежде чем распознавать
  var TIMEOUT = 8000;       // дольше ответа не ждём
  var MAX_CANDS = 10;
  var LINE = 0.032;         // толщина линии — доля стороны клетки
  var CJK = /[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff]/;
  var CJK_ONLY = /^(?:[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff])+$/;

  var ICONS = {
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 13.5 4.5 9 9 4.5"/><path d="M4.5 9H15a5 5 0 0 1 0 10h-4"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="m6.5 7 .9 12.5h9.2L17.5 7"/></svg>',
    erase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 5.5H9.5L3.5 12l6 6.5H21z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
  };

  var pad = null;
  var canvas = null;
  var ctx = null;
  var cands = null;
  var strokes = [];         // черты: [[x, y, мс от начала рисунка], …], x и y — доли стороны клетки
  var t0 = 0;
  var pointer = null;       // палец или мышь, которыми рисуют сейчас
  var sendTimer = null;
  var request = 0;          // номер последнего запроса: ответы прежних отбрасываются
  var abort = null;
  var replaceQuery = false;

  // ---------------------------------------------------------------- панель

  function tool(act, text, label) {
    return '<button class="hz-btn hw-tool" type="button" data-hw="' + act + '" title="' + label +
      '" aria-label="' + label + '">' + ICONS[act] + "<span>" + text + "</span></button>";
  }

  function build() {
    pad = document.createElement("div");
    pad.className = "hw";
    pad.id = "dict-hw";
    pad.hidden = true;
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-label", "Рукописный ввод");
    pad.innerHTML =
      '<div class="hw-board hz-box">' +
        '<svg class="hz-char" viewBox="0 0 1024 1024" aria-hidden="true"><g class="hz-grid">' +
          '<line x1="512" y1="0" x2="512" y2="1024"/><line x1="0" y1="512" x2="1024" y2="512"/>' +
          '<line x1="0" y1="0" x2="1024" y2="1024"/><line x1="1024" y1="0" x2="0" y2="1024"/>' +
        "</g></svg>" +
        '<canvas class="hw-canvas" role="img" aria-label="Клетка для рисования иероглифа"></canvas>' +
      "</div>" +
      '<div class="hw-cands" aria-live="polite"></div>' +
      '<div class="hw-tools">' +
        tool("undo", "Отменить", "Отменить последнюю черту") +
        tool("clear", "Очистить", "Очистить клетку") +
        tool("erase", "Стереть", "Стереть последний знак в поле поиска") +
        tool("done", "Готово", "Закрыть рукописный ввод") +
      "</div>";
    var row = form.querySelector(".dict-search-row");
    row.parentNode.insertBefore(pad, row.nextSibling);
    toggle.setAttribute("aria-controls", pad.id);
    canvas = pad.querySelector(".hw-canvas");
    ctx = canvas.getContext("2d");
    cands = pad.querySelector(".hw-cands");

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    // Долгое нажатие пальцем не открывает меню.
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    pad.addEventListener("click", function (e) {
      var cand = e.target.closest(".hw-cand");
      if (cand) {
        pick(cand.textContent);
        return;
      }
      var btn = e.target.closest("[data-hw]");
      if (!btn) return;
      switch (btn.getAttribute("data-hw")) {
        case "undo": undo(); break;
        case "clear": clearBoard(); break;
        case "erase": erase(); break;
        case "retry": recognize(); break;
        case "done": close(); break;
      }
    });
    pad.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.key === "Esc") {
        close();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "я")) {
        e.preventDefault();
        undo();
      }
    });
    window.addEventListener("resize", layout);
    if (window.ResizeObserver) new ResizeObserver(layout).observe(pad);
  }

  // На телефоне панель стоит внизу экрана поверх страницы (position: fixed
  // в css/style.css) — страница получает снизу отступ высотой с панель,
  // чтобы до конца результатов можно было докрутить.
  function docked() {
    return !!pad && !pad.hidden && getComputedStyle(pad).position === "fixed";
  }

  function layout() {
    if (!pad || pad.hidden) return;
    fit();
    var root = document.documentElement;
    root.classList.toggle("hw-docked", docked());
    root.style.setProperty("--hw-space", pad.offsetHeight + "px");
  }

  function open() {
    if (!pad) build();
    pad.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    replaceQuery = true;
    showHint();
    layout();
    if (docked()) {
      // Системная клавиатура закрывается, поле поиска — над панелью.
      if (document.activeElement === input) input.blur();
      form.scrollIntoView({ block: "start" });
    }
  }

  function close() {
    if (!pad || pad.hidden) return;
    var inside = pad.contains(document.activeElement);
    clearBoard();
    pad.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("hw-docked");
    if (inside) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", function () {
    if (pad && !pad.hidden) close();
    else open();
  });

  // Две клавиатуры сразу не нужны: нажали на поле на телефоне — панель
  // уступает место системной.
  input.addEventListener("focus", function () {
    if (docked()) close();
  });

  // ---------------------------------------------------------------- рисунок

  function fit() {
    var size = canvas.clientWidth;
    var px = Math.round(size * (window.devicePixelRatio || 1));
    if (!size || (canvas.width === px && canvas.height === px)) return;
    canvas.width = px;
    canvas.height = px;
    redraw();
  }

  // Рисуем в долях стороны клетки: масштаб — сам размер холста.
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);
    ctx.lineWidth = LINE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(canvas).color;
    strokes.forEach(function (s) {
      dot(s[0]);
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      for (var i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
      ctx.stroke();
    });
  }

  // Точка — кружок: линия нулевой длины на холсте не рисуется.
  function dot(p) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], LINE / 2, 0, 2 * Math.PI);
    ctx.fill();
  }

  function point(e) {
    var r = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      Date.now() - t0
    ];
  }

  function onDown(e) {
    if (pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    pointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    clearTimeout(sendTimer);
    if (!strokes.length) t0 = Date.now();
    var p = point(e);
    strokes.push([p]);
    dot(p);
  }

  function onMove(e) {
    if (e.pointerId !== pointer) return;
    var s = strokes[strokes.length - 1];
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    (list.length ? list : [e]).forEach(function (ev) {
      var p = point(ev);
      var last = s[s.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.004) return;
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      s.push(p);
    });
  }

  function onUp(e) {
    if (e.pointerId !== pointer) return;
    pointer = null;
    var s = strokes[strokes.length - 1];
    // Точка (、) — тоже черта: Google нужно хотя бы две точки.
    if (s.length === 1) s.push([s[0][0], s[0][1], s[0][2] + 30]);
    clearTimeout(sendTimer);
    sendTimer = setTimeout(recognize, SEND_DELAY);
  }

  function undo() {
    if (!strokes.length) return;
    strokes.pop();
    redraw();
    recognize();
  }

  function clearBoard() {
    strokes = [];
    pointer = null;
    if (ctx) redraw();
    recognize();
  }

  // ----------------------------------------------------------- распознавание

  function recognize() {
    clearTimeout(sendTimer);
    var id = ++request;
    if (abort) abort.abort();
    abort = null;
    if (!strokes.length) {
      if (cands) showHint();
      return;
    }
    if (!cands.querySelector(".hw-cand")) showMessage("Распознаю…");
    var ctrl = window.AbortController ? new AbortController() : null;
    abort = ctrl;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var ink = strokes.map(function (s) {
      return [
        s.map(function (p) { return Math.round(p[0] * AREA); }),
        s.map(function (p) { return Math.round(p[1] * AREA); }),
        s.map(function (p) { return p[2]; })
      ];
    });
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ requests: [{
        writing_guide: { writing_area_width: AREA, writing_area_height: AREA },
        ink: ink,
        language: "zh_CN"
      }] })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      clearTimeout(timer);
      if (id !== request) return;
      // Ответ: ["SUCCESS", [[номер запроса, [варианты…], …]]]. Среди
      // вариантов бывают латинские буквы и знаки — их убираем.
      if (!data || data[0] !== "SUCCESS") throw new Error(String(data && data[0]));
      var seen = {};
      var list = ((data[1] && data[1][0] && data[1][0][1]) || []).filter(function (c) {
        if (typeof c !== "string" || !CJK_ONLY.test(c) || seen[c]) return false;
        seen[c] = true;
        return true;
      });
      showCands(list.slice(0, MAX_CANDS));
    }).catch(function () {
      clearTimeout(timer);
      if (id === request) showError();
    });
  }

  function showMessage(text, isError) {
    cands.textContent = "";
    var p = document.createElement("p");
    p.className = "hw-msg" + (isError ? " is-error" : "");
    p.textContent = text;
    cands.appendChild(p);
    return p;
  }

  function showHint() {
    showMessage("Нарисуйте иероглиф в клетке — здесь появятся похожие.");
  }

  function showCands(list) {
    if (!list.length) {
      showMessage("Не похоже ни на один иероглиф — допишите или нарисуйте заново.");
      return;
    }
    cands.textContent = "";
    list.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hw-cand";
      b.lang = "zh-CN";
      b.textContent = c;
      cands.appendChild(b);
    });
  }

  function showError() {
    var p = showMessage("Распознавание не отвечает — проверьте интернет. ", true);
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "hw-retry";
    retry.setAttribute("data-hw", "retry");
    retry.textContent = "Повторить";
    p.appendChild(retry);
    if (window.matchMedia("(pointer: coarse)").matches) {
      p.appendChild(document.createTextNode(" Иероглиф можно нарисовать и в клавиатуре телефона: у китайской раскладки есть рукописный ввод."));
    }
  }

  // ------------------------------------------------------------------ поиск

  function pick(text) {
    var current = input.value.trim();
    // Иероглифы дописываются к иероглифам; русское слово или пиньинь в
    // поле, как и прежний запрос при первом выборе, заменяются.
    input.value = (replaceQuery || !CJK.test(current) ? "" : current) + text;
    replaceQuery = false;
    clearBoard();
    search();
  }

  // Последний знак в поле — по символам, а не по UTF-16: редкие иероглифы
  // занимают две единицы.
  function erase() {
    var chars = Array.from(input.value.trim());
    chars.pop();
    input.value = chars.join("");
    replaceQuery = false;
    search();
  }

  // Ищет js/dictionary.js — по отправке формы.
  function search() {
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true }));
  }
})();
