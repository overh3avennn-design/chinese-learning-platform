/* Окно слова: само слово крупно (иероглифы, пиньинь, перевод, озвучка), под
   ним — карточка на каждый иероглиф: значение, разбор на части (графемы) с
   ключом, порядок черт и «Написать самому». Открывается из словаря
   (js/dictionary.js) вызовом HanziWindow.open({ word, entry, lookup, search }).
   Разметку окна строит этот файл, так что подключить его можно на любой
   странице: <script src="../js/hanzi-window.js"></script>.

   Данные об иероглифе — strokes/<код символа>.json в репозитории
   chinese-dictionary-data (тот же хост, что у сайта; как собраны —
   build/build_strokes.py там же): контуры и оси черт, ключ с русским
   названием, схема строения и части с номерами их черт. Значения
   иероглифа и частей — из словаря: lookup(иероглифы) отдаёт статью БКРС.

   Иероглиф рисует этот файл: каждая черта — толстая линия вдоль оси,
   обрезанная по контуру черты, анимация — рост этой линии. Части
   раскрашены каждая своим цветом. «Написать самому» — библиотека Hanzi
   Writer (js/vendor/), она грузится при первом нажатии.

   «Объяснить» под словом — объяснение от нейросети: значение, примеры,
   отличие от похожих слов (window.AI.explainWord, js/ai.js — его надо
   подключить до этого файла, иначе кнопки нет). opts.explain: true — окно
   откроется сразу с объяснением.

   Открытое окно добавляет запись в историю (адрес тот же), поэтому кнопка
   «Назад» на телефоне закрывает окно, а не уводит со страницы. */
(function () {
  "use strict";

  // Как в js/dictionary.js: тот же адрес *.github.io, что у сайта, а
  // локальный сервер с обоими репозиториями рядом отдаёт и данные.
  var DATA_URL = "https://overh3avennn-design.github.io/chinese-dictionary-data/";
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    DATA_URL = location.origin + "/chinese-dictionary-data/";
  }
  var STROKES_URL = DATA_URL + "strokes/";
  var script = document.currentScript;
  var WRITER_SRC = (script && script.src ? script.src.replace(/[^\/]*$/, "") : "../js/") +
    "vendor/hanzi-writer.min.js";

  var FETCH_TIMEOUT = 10000;  // запрос, молчащий дольше, обрывается и повторяется
  var FETCH_TRIES = 3;
  // Скорость роста черты — единиц квадрата 1024 в миллисекунду.
  var SPEEDS = { slow: 0.4, normal: 0.85, fast: 1.7 };
  var GAP_MS = 260;           // пауза между чертами на обычной скорости
  var SPEED_KEY = "strokes:speed";
  var PART_COLORS = 4;        // цветов частей в css/style.css: .is-p0 … .is-p3
  // Hanzi Writer рисует сам и CSS не читает — цвета те же, что в
  // css/theme.css и css/style.css (--text, --hz-p0, --hanzi-pale, --accent).
  var WRITER_COLORS = {
    strokeColor: "#2F3441",
    radicalColor: "#B3302A",
    outlineColor: "#C3C9D5",
    highlightColor: "#EE5A52",
    drawingColor: "#555B6B",
    highlightCompleteColor: "#2F3441"
  };
  var LAYOUTS = {
    "⿰": "слева направо",
    "⿱": "сверху вниз",
    "⿲": "три части слева направо",
    "⿳": "три части сверху вниз",
    "⿴": "одна часть внутри другой",
    "⿵": "охват сверху",
    "⿶": "охват снизу",
    "⿷": "охват слева",
    "⿸": "охват сверху и слева",
    "⿹": "охват сверху и справа",
    "⿺": "охват снизу и слева",
    "⿻": "части наложены"
  };
  var CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff]/g;
  var CJK_START = /^(?:[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff])/;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var ICONS = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    say: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M18.5 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>'
  };

  function plural(n, forms) {
    var d = n % 10, h = n % 100;
    if (d === 1 && h !== 11) return forms[0];
    if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return forms[1];
    return forms[2];
  }

  function strokesWord(n) {
    return plural(n, ["черта", "черты", "черт"]);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function button(className, html, label) {
    var b = el("button", className);
    b.type = "button";
    b.innerHTML = html;
    if (label) {
      b.setAttribute("aria-label", label);
      b.title = label;
    }
    return b;
  }

  // Статья БКРС → короткое значение: первые строки перевода. Без примеров
  // (строки с иероглифами), заголовков разделов (I, II gěn [p]диал.[/p]),
  // пометок [p]сущ.[/p], комментариев [i]…[/i], подразделов «А» и нумерации.
  // Строка из одного комментария ([i]ключевой знак «человек»[/i]) остаётся.
  function shortGloss(text, lines) {
    var out = [];
    (text || "").split("\n").forEach(function (raw) {
      var line = raw.trim();
      if (out.length >= (lines || 3) || !line || CJK_START.test(line) || /^[IVX]+(\s|$)/.test(line)) return;
      // Запятая курсивом ([i],[/i]) — всё же запятая.
      var labelsOff = line.replace(/\[p\][\s\S]*?\[\/p\]/g, "").replace(/\[i\]([\s,;.:]*)\[\/i\]/g, "$1");
      var clean = labelsOff
        .replace(/\[i\][\s\S]*?\[\/i\]/g, "")
        .replace(/\(\s*\)/g, "")
        .replace(/^\s*(?:\d+[).]|[а-я]\))\s*/, "")
        .replace(/^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+\s+(?=[а-яё])/i, "")
        .replace(/\s+([,;.])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s,;.]+|[\s,;.]+$/g, "");
      if (!clean) clean = labelsOff.replace(/\[\/?i\]/g, "").replace(/^\s*\d+[).]\s*/, "").trim();
      if (clean.length > 2) out.push(clean);
    });
    // Значения через «;» без повторов: «дерево» и «дерево; древесина» → одно «дерево».
    var seen = {};
    return out.join("; ").split(/;\s*/).filter(function (item) {
      var key = item.toLowerCase();
      if (!item || seen[key]) return false;
      seen[key] = true;
      return true;
    }).join("; ");
  }

  function plainPinyin(text) {
    return (text || "").replace(/\[\/?[pi]\]/g, "").trim();
  }

  var CYRILLIC = /[а-яё]/i;
  var AUTO_PINYIN = "Пиньинь подобран автоматически и может быть неточным";

  // Короткое значение статьи: машинный перевод (e[3].m), если он есть, —
  // у таких статей в БКРС перевод не на русском.
  function entryGloss(e, lines) {
    var extra = e && e[3];
    return extra && extra.m ? shortGloss(extra.m, lines) : shortGloss(e && e[2], lines);
  }

  // Пиньинь статьи; подобранный автоматически — с пометкой «авто».
  function setPinyin(node, e) {
    node.textContent = e ? plainPinyin(e[1]) : "";
    var auto = !!(e && e[3] && e[3].a && node.textContent);
    node.classList.toggle("is-auto", auto);
    node.title = auto ? AUTO_PINYIN : "";
    if (auto) node.appendChild(el("span", "hz-auto", "авто"));
  }

  // ---------------------------------------------------------------- данные

  var cache = {};             // иероглиф → Promise(данные или null, если их нет)

  function fetchOnce(url) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (r.status === 404) return null;      // такого иероглифа в наборе нет
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function fetchRetry(url, tries) {
    return fetchOnce(url).catch(function (err) {
      if (tries <= 1) throw err;
      return new Promise(function (r) { setTimeout(r, 700); }).then(function () {
        return fetchRetry(url, tries - 1);
      });
    });
  }

  function polyLength(points) {
    var len = 0;
    for (var i = 1; i < points.length; i++) {
      len += Math.sqrt(Math.pow(points[i][0] - points[i - 1][0], 2) + Math.pow(points[i][1] - points[i - 1][1], 2));
    }
    return len;
  }

  function charData(ch) {
    if (!cache[ch]) {
      cache[ch] = fetchRetry(STROKES_URL + ch.codePointAt(0).toString(16) + ".json", FETCH_TRIES)
        .then(function (d) {
          if (!d || !d.strokes || !d.strokes.length) return null;
          d.lengths = d.medians.map(polyLength);
          // Черта → номер части (для цвета).
          d.partOf = [];
          (d.parts || []).forEach(function (p, k) {
            p[1].forEach(function (s) { d.partOf[s] = k; });
          });
          return d;
        })
        .catch(function (err) {
          delete cache[ch];                   // следующая попытка — заново
          throw err;
        });
    }
    return cache[ch];
  }

  // Цвет черты: своей части, а если частей нет — черты ключа золотом.
  function strokeTone(d, i) {
    if (d.parts) return d.partOf[i] === undefined ? "" : "is-p" + (d.partOf[i] % PART_COLORS);
    return d.radStrokes && d.radStrokes.indexOf(i) !== -1 ? "is-p0" : "";
  }

  // Номера черт: [0, 1] → «черты 1–2», [0, 2, 3] → «черты 1, 3–4».
  function strokeRuns(list) {
    var runs = [];
    list.slice().sort(function (a, b) { return a - b; }).forEach(function (n) {
      var last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else runs.push([n, n]);
    });
    return (list.length > 1 ? "черты " : "черта ") + runs.map(function (r) {
      return r[0] === r[1] ? r[0] + 1 : (r[0] + 1) + "–" + (r[1] + 1);
    }).join(", ");
  }

  // ---------------------------------------------------------------- клетка

  var uid = 0;

  function gridLines(parent) {
    var g = svgEl("g", { "class": "hz-grid" });
    [[512, 0, 512, 1024], [0, 512, 1024, 512], [0, 0, 1024, 1024], [1024, 0, 0, 1024]].forEach(function (l) {
      g.appendChild(svgEl("line", { x1: l[0], y1: l[1], x2: l[2], y2: l[3] }));
    });
    parent.appendChild(g);
  }

  // Иероглиф в клетке 米字格. opts.badge — номер текущей черты у её начала,
  // opts.onChange — после каждой перемены (шаг, показ, пауза).
  function Board(host, data, opts) {
    this.data = data;
    this.opts = opts || {};
    this.shown = data.strokes.length;     // видны черты 0 … shown-1
    this.current = -1;                    // черта цветом «текущей», -1 — нет
    this.anim = null;
    this.timer = null;
    this.playing = false;
    this.paused = false;

    var id = "hz" + (++uid);
    var svg = svgEl("svg", { viewBox: "0 0 1024 1024", "class": "hz-char", "aria-hidden": "true" });
    gridLines(svg);
    var defs = svgEl("defs");
    var g = svgEl("g", { transform: "translate(0, 900) scale(1, -1)" });
    this.inks = data.strokes.map(function (path, i) {
      g.appendChild(svgEl("path", { d: path, "class": "hz-ghost" }));
      var clip = svgEl("clipPath", { id: id + "-" + i });
      clip.appendChild(svgEl("path", { d: path }));
      defs.appendChild(clip);
      var len = data.lengths[i];
      var ink = svgEl("path", {
        d: "M" + data.medians[i].map(function (p) { return p[0] + " " + p[1]; }).join(" L"),
        "class": ("hz-ink " + strokeTone(data, i)).trim(),
        "clip-path": "url(#" + id + "-" + i + ")",
        "stroke-dasharray": len + " " + (len + 600),
        "stroke-dashoffset": 0
      });
      g.appendChild(ink);
      return ink;
    });
    svg.appendChild(defs);
    svg.appendChild(g);
    if (this.opts.badge) {
      this.badge = svgEl("g", { "class": "hz-badge" });
      this.badge.appendChild(svgEl("circle", { r: 48 }));
      this.badge.appendChild(svgEl("text", { y: 20 }));
      svg.appendChild(this.badge);
    }
    host.appendChild(svg);
    this.svg = svg;
    this.paint();
  }

  Board.prototype.count = function () {
    return this.data.strokes.length;
  };

  Board.prototype.paint = function () {
    var self = this;
    this.inks.forEach(function (ink, i) {
      var visible = i < self.shown;
      ink.classList.toggle("is-hidden", !visible);
      ink.classList.toggle("is-current", i === self.current);
      if (!(self.anim && self.anim.i === i)) ink.setAttribute("stroke-dashoffset", visible ? 0 : self.data.lengths[i]);
    });
    if (this.badge) {
      this.badge.style.display = this.current >= 0 ? "" : "none";
      if (this.current >= 0) {
        var p = this.data.medians[this.current][0];
        this.badge.setAttribute("transform", "translate(" + p[0] + " " + (900 - p[1]) + ")");
        this.badge.querySelector("text").textContent = this.current + 1;
      }
    }
    if (this.opts.onChange) this.opts.onChange(this);
  };

  // Подсветка одной части (наведение на строку «Состава»), -1 — снять.
  Board.prototype.focusPart = function (k) {
    var d = this.data;
    this.svg.classList.toggle("has-focus", k >= 0);
    this.inks.forEach(function (ink, i) {
      ink.classList.toggle("is-focus", k >= 0 && d.partOf[i] === k);
    });
  };

  // Черта i растёт вдоль оси; done — когда дорисовалась.
  Board.prototype.animateStroke = function (i, done) {
    var self = this;
    var len = this.data.lengths[i];
    this.shown = i + 1;
    this.current = i;
    this.anim = { i: i, ink: this.inks[i], len: len, elapsed: 0, last: null, done: done,
      dur: (len + 250) / SPEEDS[speed] };
    this.anim.ink.setAttribute("stroke-dashoffset", len);
    this.paint();
    this.anim.raf = requestAnimationFrame(function (now) { self.frame(now); });
  };

  Board.prototype.frame = function (now) {
    var self = this;
    var a = this.anim;
    if (!a) return;
    if (a.last !== null) a.elapsed += Math.min(now - a.last, 100);
    a.last = now;
    var t = Math.min(1, a.elapsed / a.dur);
    var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    a.ink.setAttribute("stroke-dashoffset", a.len * (1 - eased));
    if (t < 1) {
      a.raf = requestAnimationFrame(function (n) { self.frame(n); });
    } else {
      this.anim = null;
      if (a.done) a.done();
    }
  };

  // Останавливает показ; недорисованная черта дорисовывается сразу.
  Board.prototype.stop = function () {
    clearTimeout(this.timer);
    if (this.anim) {
      cancelAnimationFrame(this.anim.raf);
      this.anim.ink.setAttribute("stroke-dashoffset", 0);
      this.anim = null;
    }
    this.playing = false;
    this.paused = false;
  };

  Board.prototype.play = function () {
    this.stop();
    // Всё уже нарисовано — начинаем сначала, иначе — с того места, где стоим.
    if (this.shown >= this.count()) this.shown = 0;
    this.current = this.shown - 1;
    this.playing = true;
    this.paint();
    this.playNext();
  };

  Board.prototype.playNext = function () {
    var self = this;
    if (this.shown >= this.count()) {
      this.playing = false;
      this.current = -1;
      this.paint();
      return;
    }
    this.animateStroke(this.shown, function () {
      self.timer = setTimeout(function () { self.playNext(); }, GAP_MS * SPEEDS.normal / SPEEDS[speed]);
    });
  };

  Board.prototype.togglePlay = function () {
    var self = this;
    if (this.playing && !this.paused) {
      this.paused = true;
      clearTimeout(this.timer);
      if (this.anim) cancelAnimationFrame(this.anim.raf);
      this.paint();
    } else if (this.paused) {
      this.paused = false;
      if (this.anim) {
        this.anim.last = null;
        this.anim.raf = requestAnimationFrame(function (now) { self.frame(now); });
      } else {
        this.playNext();
      }
      this.paint();
    } else {
      this.play();
    }
  };

  Board.prototype.next = function () {
    var self = this;
    var n = this.count();
    this.stop();
    if (this.current === -1 && this.shown >= n) this.shown = 0;   // всё нарисовано — с первой черты
    if (this.shown >= n) {
      this.paint();
      return;
    }
    this.animateStroke(this.shown, function () { self.paint(); });
  };

  Board.prototype.prev = function () {
    var n = this.count();
    this.stop();
    if (this.current === -1) {
      if (this.shown >= n) this.current = n - 1;
    } else if (this.current > 0) {
      this.shown = this.current;
      this.current = this.shown - 1;
    }
    this.paint();
  };

  Board.prototype.setStep = function (i) {
    this.stop();
    this.shown = i + 1;
    this.current = i;
    this.paint();
  };

  Board.prototype.destroy = function () {
    this.stop();
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  };

  // Маленькая картинка: черты 0…upto, черта mark — цветом текущей.
  // only — нарисовать лишь эти черты (часть иероглифа без своего знака).
  function miniSvg(d, upto, mark, only) {
    var svg = svgEl("svg", { viewBox: "0 0 1024 1024", "aria-hidden": "true" });
    var g = svgEl("g", { transform: "translate(0, 900) scale(1, -1)" });
    d.strokes.forEach(function (path, j) {
      if (only && only.indexOf(j) === -1) return;
      var cls = j > upto ? "" : j === mark ? "is-current" : (strokeTone(d, j) || "is-ink");
      g.appendChild(svgEl("path", { d: path, "class": cls }));
    });
    svg.appendChild(g);
    return svg;
  }

  // ------------------------------------------------------------- озвучка

  var synth = window.speechSynthesis;
  var canSpeak = !!(synth && window.SpeechSynthesisUtterance);
  var zhVoice = null;

  function pickVoice() {
    var voices = synth.getVoices() || [];
    zhVoice = voices.filter(function (v) { return /^zh[-_]CN/i.test(v.lang); })[0] ||
      voices.filter(function (v) { return /^(zh|cmn)/i.test(v.lang); })[0] || null;
    // Пока список пуст, голоса ещё грузятся — кнопку оставляем; если голоса
    // есть, а китайского нет, кнопка ничего бы не сказала.
    if (ui) ui.say.hidden = voices.length > 0 && !zhVoice;
  }

  function speak(text) {
    if (!canSpeak || !text) return;
    try {
      synth.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      if (zhVoice) u.voice = zhVoice;
      u.rate = 0.85;
      synth.speak(u);
    } catch (e) {}
  }

  // ----------------------------------------------------------------- окно

  var ui = null;
  var state = null;           // открытое слово
  var speed = "normal";
  var pushed = false;         // окно добавило запись в историю
  var writerPromise = null;
  var lookups = {};           // иероглифы → Promise(статья БКРС или null)

  try {
    var saved = window.localStorage.getItem(SPEED_KEY);
    if (SPEEDS[saved]) speed = saved;
  } catch (e) {}

  function build() {
    var d = el("dialog", "hz");
    d.setAttribute("aria-labelledby", "hz-word");
    d.innerHTML =
      // Фокус при открытии — на само окно, а не на крестик (иначе вокруг
      // него сразу рамка фокуса).
      '<div class="hz-sheet" tabindex="-1" autofocus>' +
        '<div class="hz-bar"><button class="hz-close" type="button" aria-label="Закрыть">' + ICONS.close + '</button></div>' +
        '<div class="hz-hero">' +
          '<p class="hz-word" id="hz-word" lang="zh-CN"></p>' +
          '<p class="hz-pinyin"></p>' +
          '<p class="hz-gloss"></p>' +
          '<div class="hz-actions">' +
            '<button class="hz-say" type="button" aria-label="Озвучить" title="Озвучить">' + ICONS.say + '</button>' +
            '<button class="hz-explain" type="button" data-explain>' + ICONS.spark + 'Объяснить</button>' +
          '</div>' +
        '</div>' +
        // Объяснение слова нейросетью (js/ai.js) — по кнопке «Объяснить».
        '<section class="hz-ai" aria-live="polite" hidden></section>' +
        '<h2 class="hz-section"></h2>' +
        '<div class="hz-cards"></div>' +
        '<p class="hz-note">Состав, ключи и порядок черт — <a href="https://github.com/skishore/makemeahanzi" target="_blank" rel="noopener">Make Me a Hanzi</a>, значения — 大БКРС</p>' +
      '</div>';
    document.body.appendChild(d);
    ui = {
      dialog: d,
      word: d.querySelector(".hz-word"),
      pinyin: d.querySelector(".hz-pinyin"),
      gloss: d.querySelector(".hz-gloss"),
      say: d.querySelector(".hz-say"),
      explain: d.querySelector(".hz-explain"),
      ai: d.querySelector(".hz-ai"),
      section: d.querySelector(".hz-section"),     // в .hz-ai пока пусто — это заголовок иероглифов
      cards: d.querySelector(".hz-cards")
    };
    ui.say.hidden = !canSpeak;
    if (canSpeak) {
      pickVoice();
      if (synth.addEventListener) synth.addEventListener("voiceschanged", pickVoice);
      else synth.onvoiceschanged = pickVoice;
    }

    d.addEventListener("click", onClick);
    d.addEventListener("keydown", onKey);
    d.addEventListener("mouseover", onHover);
    d.addEventListener("mouseout", onHover);
    // Esc: закрываем сами — чтобы заодно убрать запись из истории.
    d.addEventListener("cancel", function (e) {
      e.preventDefault();
      requestClose();
    });
    window.addEventListener("popstate", function () {
      if (pushed && !(history.state && history.state.hanziWindow)) {
        pushed = false;
        closeNow();
      }
    });
    window.addEventListener("resize", resizeWriter);
  }

  function cardOf(node) {
    var c = node.closest && node.closest(".hz-card");
    return c && state ? state.cards[+c.getAttribute("data-index")] : null;
  }

  function onClick(e) {
    // Нажатие мимо окна (на затемнение) попадает в сам <dialog>.
    if (e.target === ui.dialog || e.target.closest(".hz-close")) {
      requestClose();
      return;
    }
    if (!state) return;
    if (e.target.closest(".hz-say")) {
      speak(state.word);
      return;
    }
    if (e.target.closest("[data-explain]")) {
      explain();
      return;
    }
    var search = e.target.closest("[data-search]");
    if (search) {
      searchWord(search.getAttribute("data-search"));
      return;
    }
    var card = cardOf(e.target);
    if (!card) return;
    var cell = e.target.closest(".hz-cell");
    if (cell && card.panel && card.panel.board) {
      card.panel.board.setStep(+cell.getAttribute("data-step"));
      return;
    }
    var sp = e.target.closest("[data-speed]");
    if (sp) {
      speed = sp.getAttribute("data-speed");
      try { window.localStorage.setItem(SPEED_KEY, speed); } catch (err) {}
      paintSpeed();
      return;
    }
    if (e.target.closest(".hz-retry")) {
      fillCard(card);
      return;
    }
    var act = e.target.closest("[data-act]");
    if (!act) {
      // Нажатие на маленькую клетку — показать порядок черт.
      if (e.target.closest(".hz-card-board") && card.board) togglePlay(card);
      return;
    }
    var p = card.panel;
    switch (act.getAttribute("data-act")) {
      case "play": togglePlay(card); break;
      case "steps": togglePanel(card, "steps"); break;
      case "write": togglePanel(card, "write"); break;
      case "prev": if (p && p.board) p.board.prev(); break;
      case "next": if (p && p.board) p.board.next(); break;
      case "big-play": if (p && p.board) p.board.togglePlay(); break;
      case "hint": hint(card); break;
      case "outline": toggleOutline(card); break;
      case "restart": makeWriter(card); break;
    }
  }

  function onKey(e) {
    if (!state || e.altKey || e.ctrlKey || e.metaKey) return;
    var card = cardOf(e.target) || state.cards.filter(function (c) { return c.panel && c.panel.board; })[0];
    var board = card && card.panel && card.panel.board;
    if (!board) return;
    if (e.key === "ArrowLeft" || e.key === "Left") {
      e.preventDefault();
      board.prev();
    } else if (e.key === "ArrowRight" || e.key === "Right") {
      e.preventDefault();
      board.next();
    }
  }

  // Наведение на строку «Состава» подсвечивает часть в клетке.
  function onHover(e) {
    var row = e.target.closest(".hz-part");
    var card = row && cardOf(row);
    if (!card || !card.board) return;
    var leaving = e.type === "mouseout" && !(e.relatedTarget && row.contains(e.relatedTarget));
    if (e.type === "mouseover" || leaving) card.board.focusPart(leaving ? -1 : +row.getAttribute("data-part"));
  }

  // opts.word — заголовок статьи; opts.entry — сама статья [иероглифы,
  // пиньинь, перевод]; opts.lookup(иероглифы) → Promise(статья или null);
  // opts.search(иероглифы, replace) — искать в словаре (окно уже закрыто).
  function open(opts) {
    if (!ui) build();
    var word = String(opts.word || "");
    var chars = [];
    (word.match(CJK_CHAR) || []).forEach(function (ch) {
      if (chars.indexOf(ch) === -1) chars.push(ch);
    });
    if (!chars.length) return;
    if (state) cleanup();

    var entry = opts.entry || [];
    state = {
      word: word,
      opts: opts,
      cards: [],
      returnFocus: opts.returnFocus || document.activeElement
    };
    ui.word.textContent = word;
    var len = Array.from ? Array.from(word).length : word.length;
    ui.word.className = "hz-word" + (len > 8 ? " is-long" : len > 4 ? " is-mid" : "");
    setPinyin(ui.pinyin, entry.length ? entry : [word, opts.pinyin || ""]);
    ui.pinyin.hidden = !ui.pinyin.textContent;
    var extra = entry[3] || {};
    ui.gloss.textContent = "";
    if (extra.m) {
      ui.gloss.appendChild(el("span", "hz-mt", "машинный перевод"));
      ui.gloss.appendChild(document.createTextNode(" " + shortGloss(extra.m)));
    } else if (entry.length && !CYRILLIC.test(entry[2] || "")) {
      ui.gloss.textContent = "Русского перевода в словаре нет — значения иероглифов ниже.";
    } else {
      ui.gloss.textContent = shortGloss(entry[2]) || opts.gloss || "";
    }
    ui.gloss.hidden = !ui.gloss.textContent;
    ui.section.textContent = chars.length > 1 ? "Иероглифы" : "Иероглиф";

    // Для «Объяснить»: пиньинь и значение из словаря подсказывают нейросети,
    // какое из значений слова объяснять.
    state.hint = {
      pinyin: entry.length ? plainPinyin(entry[1]) : opts.pinyin || "",
      gloss: extra.m ? shortGloss(extra.m) : entry.length ? shortGloss(entry[2]) : opts.gloss || ""
    };
    ui.explain.hidden = !window.AI;
    ui.ai.hidden = true;
    ui.ai.textContent = "";

    ui.cards.textContent = "";
    chars.forEach(function (ch, i) {
      var card = { ch: ch, index: i, data: null, board: null, panel: null, token: 0 };
      card.el = buildCard(card);
      ui.cards.appendChild(card.el);
      state.cards.push(card);
      fillCard(card);
    });

    if (typeof ui.dialog.showModal === "function") {
      if (!ui.dialog.open) ui.dialog.showModal();
    } else {
      ui.dialog.setAttribute("open", "");
    }
    ui.dialog.querySelector(".hz-sheet").scrollTop = 0;
    document.documentElement.classList.add("hz-lock");
    if (!pushed) {
      try {
        history.pushState({ hanziWindow: true }, "");
        pushed = true;
      } catch (e) {}
    }
    if (opts.explain) explain();
  }

  function requestClose() {
    if (pushed && history.state && history.state.hanziWindow) history.back();   // закроет popstate
    else closeNow();
  }

  function closeNow() {
    if (!state) return;
    var focus = state.returnFocus;
    cleanup();
    state = null;
    if (ui.dialog.open) {
      if (typeof ui.dialog.close === "function") ui.dialog.close();
      else ui.dialog.removeAttribute("open");
    }
    document.documentElement.classList.remove("hz-lock");
    if (focus && focus.focus && document.contains(focus)) {
      try { focus.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function cleanup() {
    if (canSpeak) {
      try { synth.cancel(); } catch (e) {}
    }
    state.cards.forEach(function (card) {
      card.token++;
      closePanel(card);
      if (card.board) card.board.stop();
    });
  }

  // Поиск слова в словаре из окна: запись окна в истории становится записью
  // нового поиска, так что «Назад» потом вернёт к прежнему.
  function searchWord(word) {
    var search = state.opts.search;
    if (!search) return;
    var replace = pushed && history.state && history.state.hanziWindow;
    pushed = false;
    closeNow();
    search(word, !!replace);
  }

  function lookup(word) {
    var fn = state && state.opts.lookup;
    if (!fn) return Promise.resolve(null);
    if (!lookups[word]) {
      lookups[word] = Promise.resolve().then(function () { return fn(word); })
        .then(function (e) { return e || null; })
        .catch(function () {
          delete lookups[word];
          return null;
        });
    }
    return lookups[word];
  }

  // ------------------------------------------------------- объяснение слова
  // «Объяснить»: значение, примеры и похожие слова от нейросети
  // (window.AI.explainWord из js/ai.js). Текст ответа экранирует js/ai.js;
  // похожее слово — кнопка поиска в словаре.
  function attr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function explain() {
    if (!state || !window.AI) return;
    var current = state;
    ui.explain.hidden = true;
    ui.ai.hidden = false;
    ui.ai.innerHTML = '<h2 class="hz-section">Объяснение</h2>' +
      '<p class="hz-ai-wait"><span class="ai-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      "Нейросеть готовит объяснение…</p>";
    window.AI.explainWord(current.word, current.hint).then(function (r) {
      if (state === current) renderExplain(r);
    }, function (err) {
      if (state !== current) return;
      ui.ai.innerHTML = '<h2 class="hz-section">Объяснение</h2>' +
        '<div class="hz-ai-card is-error"><p></p>' +
        '<button class="hz-ai-retry" type="button" data-explain>Повторить</button></div>';
      ui.ai.querySelector("p").textContent = err.message;
    });
  }

  function renderExplain(r) {
    var AI = window.AI;
    var html = '<h2 class="hz-section">Объяснение</h2><div class="hz-ai-card">';
    if (r.pinyin || r.partOfSpeech) {
      html += '<p class="hz-ai-head">' + (r.pinyin ? '<span class="hz-ai-py">' + AI.text(r.pinyin) + "</span>" : "") +
        (r.partOfSpeech ? '<span class="hz-ai-pos">' + AI.text(r.partOfSpeech) + "</span>" : "") + "</p>";
    }
    html += '<p class="hz-ai-meaning">' + AI.inline(r.meaning) + "</p>";
    if (r.examples && r.examples.length) {
      html += '<h3 class="hz-ai-sub">Примеры</h3><ul class="hz-ai-examples">';
      r.examples.forEach(function (e) {
        html += '<li><span class="hz-ai-zh">' + AI.text(e.zh) + "</span>" +
          (e.pinyin ? '<span class="hz-ai-expy">' + AI.text(e.pinyin) + "</span>" : "") +
          (e.ru ? '<span class="hz-ai-ru">' + AI.inline(e.ru) + "</span>" : "") + "</li>";
      });
      html += "</ul>";
    }
    if (r.synonyms && r.synonyms.length) {
      html += '<h3 class="hz-ai-sub">Чем отличается от похожих слов</h3><ul class="hz-ai-syn">';
      r.synonyms.forEach(function (s) {
        var word = state.opts.search
          ? '<button class="hz-ai-word" type="button" data-search="' + attr(s.word) + '" title="Найти в словаре">' + AI.text(s.word) + "</button>"
          : '<b class="hz-ai-word">' + AI.text(s.word) + "</b>";
        html += "<li>" + word + (s.pinyin ? ' <span class="hz-ai-expy">' + AI.text(s.pinyin) + "</span>" : "") +
          " — " + AI.inline(s.difference) + "</li>";
      });
      html += "</ul>";
    }
    if (r.note) html += '<p class="hz-ai-note">' + AI.inline(r.note) + "</p>";
    html += '<p class="hz-ai-foot">Объяснение составила нейросеть — она может ошибаться.</p></div>';
    ui.ai.innerHTML = html;
  }

  // ------------------------------------------------------- карточка иероглифа

  function buildCard(card) {
    var c = el("article", "hz-card");
    c.setAttribute("data-index", card.index);
    c.innerHTML =
      '<div class="hz-card-main">' +
        '<div class="hz-card-side">' +
          '<div class="hz-card-board hz-box"></div>' +
          '<div class="hz-mini">' +
            '<button class="hz-icon" type="button" data-act="play" aria-label="Показать порядок черт" title="Показать порядок черт">' + ICONS.play + '</button>' +
            '<button class="hz-icon" type="button" data-act="steps" aria-expanded="false" aria-label="Порядок черт по шагам" title="Порядок черт по шагам">' + ICONS.steps + '</button>' +
            '<button class="hz-icon" type="button" data-act="write" aria-expanded="false" aria-label="Написать самому" title="Написать самому">' + ICONS.pen + '</button>' +
          '</div>' +
          '<p class="hz-count"></p>' +
        '</div>' +
        '<div class="hz-card-info">' +
          '<p class="hz-char-head"><span class="hz-char-pinyin"></span></p>' +
          '<p class="hz-char-gloss"></p>' +
        '</div>' +
        '<div class="hz-card-more">' +
          '<div class="hz-parts" hidden>' +
            '<p class="hz-parts-title">Состав <span class="hz-layout"></span></p>' +
            '<ul class="hz-part-list"></ul>' +
          '</div>' +
          '<p class="hz-radical" hidden></p>' +
          '<button class="hz-link" type="button"></button>' +
        '</div>' +
      '</div>' +
      '<div class="hz-panel" hidden></div>';
    var link = c.querySelector(".hz-link");
    link.setAttribute("data-search", card.ch);
    link.innerHTML = 'Слова с <b lang="zh-CN"></b> в словаре ›';
    link.querySelector("b").textContent = card.ch;
    link.hidden = !(state && state.opts.search);
    return c;
  }

  function fillCard(card) {
    var c = card.el;
    var token = ++card.token;
    var boardHost = c.querySelector(".hz-card-board");
    if (card.board) card.board.destroy();
    card.board = null;
    boardHost.textContent = "";
    boardHost.classList.add("is-loading");
    setMini(card, false);

    // Значение иероглифа — из словаря.
    lookup(card.ch).then(function (e) {
      if (token !== card.token) return;
      setPinyin(c.querySelector(".hz-char-pinyin"), e);
      c.querySelector(".hz-char-gloss").textContent = e ? entryGloss(e, 2) : "";
    });

    charData(card.ch).then(function (d) {
      if (token !== card.token) return;
      boardHost.classList.remove("is-loading");
      card.data = d;
      if (!d) {
        // Данных о чертах нет — показываем сам знак шрифтом.
        var plainChar = el("span", "hz-plain-char", card.ch);
        plainChar.lang = "zh-CN";
        boardHost.appendChild(plainChar);
        c.querySelector(".hz-count").textContent = "порядка черт нет";
        return;
      }
      card.board = new Board(boardHost, d, { onChange: function () { paintMini(card); } });
      c.querySelector(".hz-count").textContent = d.strokes.length + " " + strokesWord(d.strokes.length);
      setMini(card, true);
      fillParts(card, d);
    }, function () {
      if (token !== card.token) return;
      boardHost.classList.remove("is-loading");
      boardHost.innerHTML = '<button class="hz-retry" type="button">Повторить</button>';
      c.querySelector(".hz-count").textContent = "не загрузилось";
    });
  }

  function setMini(card, on) {
    Array.prototype.forEach.call(card.el.querySelectorAll(".hz-mini button"), function (b) { b.disabled = !on; });
  }

  function paintMini(card) {
    var b = card.board;
    var playing = b && b.playing && !b.paused;
    var btn = card.el.querySelector('.hz-mini [data-act="play"]');
    btn.innerHTML = playing ? ICONS.pause : ICONS.play;
    btn.setAttribute("aria-label", playing ? "Пауза" : "Показать порядок черт");
    btn.title = btn.getAttribute("aria-label");
  }

  function togglePlay(card) {
    if (!card.board) return;
    if (!card.board.playing && reduceMotion) return;
    card.board.togglePlay();
  }

  function fillParts(card, d) {
    var c = card.el;
    var radical = d.radical ? d.radical[0] : "";
    var radicalShown = false;
    var list = c.querySelector(".hz-part-list");
    list.textContent = "";
    (d.parts || []).forEach(function (part, k) {
      var li = el("li", "hz-part");
      li.setAttribute("data-part", k);
      var btn = el("button", "hz-part-btn");
      btn.type = "button";
      var tone = "is-p" + (k % PART_COLORS);
      var sign;
      if (part[0]) {
        sign = el("span", "hz-part-char " + tone, part[0]);
        sign.lang = "zh-CN";
      } else {
        // Части без своего знака — рисуем её черты.
        sign = el("span", "hz-part-char hz-part-shape " + tone);
        sign.appendChild(miniSvg(d, d.strokes.length, -1, part[1]));
      }
      btn.appendChild(sign);
      var body = el("span", "hz-part-body");
      var line = el("span", "hz-part-line");
      var py = el("b", "hz-part-py");
      line.appendChild(py);
      if (part[0] && part[0] === radical) {
        line.appendChild(el("span", "hz-tag", "ключ"));
        radicalShown = true;
      }
      if (part[2]) line.appendChild(el("span", "hz-part-name", "«" + part[2] + "»"));
      body.appendChild(line);
      var gloss = el("span", "hz-part-gloss");
      body.appendChild(gloss);
      btn.appendChild(body);
      var chev = el("span", "hz-chev", "›");
      chev.setAttribute("aria-hidden", "true");
      btn.appendChild(chev);
      btn.disabled = true;
      li.appendChild(btn);
      list.appendChild(li);
      if (part[0]) {
        lookup(part[0]).then(function (e) {
          if (!e) return;
          setPinyin(py, e);
          gloss.textContent = entryGloss(e, 2);
          if (state && state.opts.search) {
            btn.disabled = false;
            btn.setAttribute("data-search", part[0]);
            btn.title = "Искать " + part[0] + " в словаре";
          }
        });
      }
    });
    c.querySelector(".hz-parts").hidden = !(d.parts && d.parts.length);
    c.querySelector(".hz-layout").textContent = d.layout && LAYOUTS[d.layout] ? d.layout + " " + LAYOUTS[d.layout] : "";

    // Ключ, если его нет среди частей: 口 — сам ключ, у 奉 ключ 大 внутри.
    var rad = c.querySelector(".hz-radical");
    rad.hidden = !d.radical || radicalShown;
    if (!rad.hidden) {
      if (radical === card.ch) {
        rad.textContent = "Иероглиф сам — ключ «" + d.radical[1] + "»";
      } else {
        rad.innerHTML = (d.radStrokes ? '<i class="hz-swatch" aria-hidden="true"></i>' : "") + 'Ключ <b lang="zh-CN"></b> ';
        rad.querySelector("b").textContent = radical;
        rad.appendChild(document.createTextNode("«" + d.radical[1] + "»" + (d.radStrokes ? " — " + strokeRuns(d.radStrokes) : "")));
      }
    }
  }

  // ---------------------------------------------- порядок черт и письмо

  function closePanel(card) {
    var p = card.panel;
    if (!p) return;
    if (p.board) p.board.destroy();
    destroyWriter(p);
    card.panel = null;
    var host = card.el.querySelector(".hz-panel");
    host.hidden = true;
    host.textContent = "";
    Array.prototype.forEach.call(card.el.querySelectorAll(".hz-mini [aria-expanded]"), function (b) {
      b.setAttribute("aria-expanded", "false");
    });
  }

  function togglePanel(card, type) {
    if (!card.data) return;
    var wasOpen = card.panel && card.panel.type === type;
    // Открыта одна панель на всё окно: письмо и показ не мешают друг другу.
    state.cards.forEach(closePanel);
    if (wasOpen) return;
    if (card.board) card.board.stop();
    card.board.shown = card.data.strokes.length;
    card.board.current = -1;
    card.board.paint();

    var host = card.el.querySelector(".hz-panel");
    card.panel = { type: type, outline: true, written: 0 };
    card.el.querySelector('.hz-mini [data-act="' + type + '"]').setAttribute("aria-expanded", "true");
    host.hidden = false;
    host.innerHTML =
      '<div class="hz-panel-main">' +
        '<div class="hz-big hz-box"></div>' +
        '<div class="hz-panel-side"></div>' +
      '</div>';
    if (type === "steps") buildSteps(card, host);
    else buildWrite(card, host);
    host.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }

  function buildSteps(card, host) {
    var d = card.data;
    var side = host.querySelector(".hz-panel-side");
    side.innerHTML =
      '<p class="hz-step" aria-live="polite"></p>' +
      '<div class="hz-controls">' +
        '<button class="hz-btn" type="button" data-act="prev" aria-label="Предыдущая черта" title="Предыдущая черта (←)">' + ICONS.prev + '</button>' +
        '<button class="hz-btn is-play" type="button" data-act="big-play"></button>' +
        '<button class="hz-btn" type="button" data-act="next" aria-label="Следующая черта" title="Следующая черта (→)">' + ICONS.next + '</button>' +
      '</div>' +
      '<div class="hz-speed" role="group" aria-label="Скорость">' +
        '<button type="button" data-speed="slow">медленно</button>' +
        '<button type="button" data-speed="normal">обычно</button>' +
        '<button type="button" data-speed="fast">быстро</button>' +
      '</div>';
    var strip = el("div", "hz-strip");
    strip.setAttribute("aria-label", "Порядок черт по шагам");
    for (var step = 0; step < d.strokes.length; step++) {
      var cell = el("button", "hz-cell");
      cell.type = "button";
      cell.setAttribute("data-step", step);
      cell.setAttribute("aria-label", "Черта " + (step + 1));
      cell.appendChild(miniSvg(d, step, step));
      cell.appendChild(document.createTextNode(step + 1));
      strip.appendChild(cell);
    }
    host.appendChild(strip);
    paintSpeed();
    card.panel.board = new Board(host.querySelector(".hz-big"), d, {
      badge: true,
      onChange: function (b) { paintSteps(card, b); }
    });
    if (reduceMotion) card.panel.board.paint();
    else card.panel.board.play();
  }

  function paintSteps(card, b) {
    var host = card.el.querySelector(".hz-panel");
    var n = b.count();
    var cur = b.current;
    host.querySelector(".hz-step").innerHTML = cur >= 0
      ? "Черта <b>" + (cur + 1) + "</b> из " + n
      : "<b>" + n + "</b> " + strokesWord(n);
    host.querySelector('[data-act="prev"]').disabled = !(cur > 0 || (cur === -1 && b.shown >= n));
    host.querySelector('[data-act="next"]').disabled = cur === n - 1 && !b.anim;
    var playing = b.playing && !b.paused;
    var play = host.querySelector('[data-act="big-play"]');
    play.innerHTML = playing ? ICONS.pause + "Пауза" : (b.paused ? ICONS.play + "Дальше" : ICONS.play + "Показать");
    var strip = host.querySelector(".hz-strip");
    Array.prototype.forEach.call(strip.children, function (cell, i) {
      if (i !== cur) {
        cell.removeAttribute("aria-current");
        return;
      }
      cell.setAttribute("aria-current", "step");
      // Длинная лента прокручивается к текущему шагу (.hz-strip —
      // position: relative, offsetLeft считается от неё).
      if (strip.scrollWidth > strip.clientWidth) {
        var left = cell.offsetLeft;
        if (left < strip.scrollLeft || left + cell.offsetWidth > strip.scrollLeft + strip.clientWidth) {
          strip.scrollLeft = left - (strip.clientWidth - cell.offsetWidth) / 2;
        }
      }
    });
  }

  function paintSpeed() {
    Array.prototype.forEach.call(ui.dialog.querySelectorAll("[data-speed]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-speed") === speed ? "true" : "false");
    });
  }

  function buildWrite(card, host) {
    var side = host.querySelector(".hz-panel-side");
    side.innerHTML =
      '<p class="hz-step hz-write-step"></p>' +
      '<p class="hz-write-msg" aria-live="polite"></p>' +
      '<div class="hz-controls">' +
        '<button class="hz-btn" type="button" data-act="hint">Подсказка</button>' +
        '<button class="hz-btn" type="button" data-act="outline" aria-pressed="true">Контур</button>' +
        '<button class="hz-btn" type="button" data-act="restart">Заново</button>' +
      '</div>';
    var big = host.querySelector(".hz-big");
    var grid = svgEl("svg", { viewBox: "0 0 1024 1024", "class": "hz-char", "aria-hidden": "true" });
    gridLines(grid);
    big.appendChild(grid);
    big.classList.add("is-writing");
    makeWriter(card);
  }

  function loadWriter() {
    if (window.HanziWriter) return Promise.resolve(window.HanziWriter);
    if (!writerPromise) {
      writerPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = WRITER_SRC;
        s.onload = function () {
          if (window.HanziWriter) resolve(window.HanziWriter);
          else reject(new Error("HanziWriter не загрузился"));
        };
        s.onerror = function () {
          writerPromise = null;
          s.parentNode.removeChild(s);
          reject(new Error("HanziWriter не загрузился"));
        };
        document.head.appendChild(s);
      });
    }
    return writerPromise;
  }

  function makeWriter(card) {
    var p = card.panel;
    if (!p || p.type !== "write") return;
    destroyWriter(p);
    var d = card.data;
    var token = card.token;
    p.written = 0;
    paintWrite(card, "Пишите черты по порядку прямо в клетке — пальцем или мышкой.");
    var big = card.el.querySelector(".hz-big");
    loadWriter().then(function (HW) {
      if (card.panel !== p || token !== card.token) return;
      var size = big.clientWidth;
      var holder = el("div", "hz-writer");
      big.appendChild(holder);
      var opts = {
        width: size,
        height: size,
        padding: 0,
        showCharacter: false,
        showOutline: p.outline,
        drawingWidth: Math.max(4, Math.round(size / 45)),
        showHintAfterMisses: 2,
        highlightOnComplete: true,
        renderer: "svg",
        charDataLoader: function (c, onLoad) { onLoad(d); }
      };
      Object.keys(WRITER_COLORS).forEach(function (k) { opts[k] = WRITER_COLORS[k]; });
      p.writer = HW.create(holder, card.ch, opts);
      p.holder = holder;
      p.writer.quiz({
        onCorrectStroke: function (s) {
          p.written = s.strokeNum + 1;
          paintWrite(card, s.strokesRemaining ? "Верно! Дальше — черта " + (p.written + 1) + "." : "");
        },
        onMistake: function (s) {
          paintWrite(card, s.mistakesOnStroke >= 2
            ? "Смотрите на клетку: там подсвечено, как пишется черта " + (s.strokeNum + 1) + "."
            : "Не та черта или не в ту сторону — попробуйте ещё раз.", "is-miss");
        },
        onComplete: function (sum) {
          p.written = d.strokes.length;
          paintWrite(card, sum.totalMistakes
            ? "Готово! Ошибок: " + sum.totalMistakes + ". «Заново» — чтобы написать ещё раз."
            : "Готово, без единой ошибки!", "is-done");
        }
      });
    }, function () {
      if (card.panel !== p) return;
      paintWrite(card, "Не получилось загрузить режим письма. Проверьте интернет и нажмите «Заново».", "is-miss");
    });
  }

  function paintWrite(card, text, tone) {
    var p = card.panel;
    var host = card.el.querySelector(".hz-panel");
    var n = card.data.strokes.length;
    host.querySelector(".hz-write-step").innerHTML = p.written >= n
      ? "<b>" + n + "</b> из " + n + " " + strokesWord(n)
      : "Черта <b>" + (p.written + 1) + "</b> из " + n;
    // Пустой text — сообщение и его цвет остаются прежними.
    var msg = host.querySelector(".hz-write-msg");
    if (text !== "") {
      msg.textContent = text;
      msg.className = "hz-write-msg" + (tone ? " " + tone : "");
    }
    host.querySelector('[data-act="hint"]').disabled = p.written >= n;
    host.querySelector('[data-act="outline"]').setAttribute("aria-pressed", p.outline ? "true" : "false");
  }

  function destroyWriter(p) {
    if (p && p.writer) {
      try { p.writer.cancelQuiz(); } catch (e) {}
      p.writer = null;
    }
    if (p && p.holder) {
      if (p.holder.parentNode) p.holder.parentNode.removeChild(p.holder);
      p.holder = null;
    }
  }

  function hint(card) {
    var p = card.panel;
    if (p && p.writer && p.written < card.data.strokes.length) p.writer.highlightStroke(p.written);
  }

  function toggleOutline(card) {
    var p = card.panel;
    if (!p) return;
    p.outline = !p.outline;
    if (p.writer) {
      if (p.outline) p.writer.showOutline();
      else p.writer.hideOutline();
    }
    paintWrite(card, "");
  }

  function resizeWriter() {
    if (!state) return;
    state.cards.forEach(function (card) {
      var p = card.panel;
      if (p && p.writer) {
        var size = card.el.querySelector(".hz-big").clientWidth;
        p.writer.updateDimensions({ width: size, height: size });
      }
    });
  }

  // gloss(статья, строк) — короткое значение; им пользуется и словарь
  // (строка «по словам»).
  // ------------------------------------------------ «написание» в словаре
  // Блок «написание» для выдачи словаря (js/dictionary.js): порядок черт
  // каждого иероглифа слова по шагам — те же рисунки, что в ленте шагов
  // окна, в клетках 田字格 — и строки о ключе и составе. Возвращает
  // Promise({ meta }): meta — строка «4 черты · ключ 水 «вода»» для
  // карточки слова; null, если данных о чертах нет.
  var WRITING_MAX = 4;        // для стольких иероглифов слова рисуется порядок черт

  function radicalText(d) {
    return d.radical ? '<span lang="zh-CN">' + attr(d.radical[0]) + "</span> «" + attr(d.radical[1]) + "»" : "";
  }

  function writing(host, word) {
    var chars = [];
    (String(word || "").match(CJK_CHAR) || []).forEach(function (ch) {
      if (chars.indexOf(ch) === -1 && chars.length < WRITING_MAX) chars.push(ch);
    });
    if (!chars.length) return Promise.resolve(null);
    return Promise.all(chars.map(function (ch) {
      return charData(ch).catch(function () { return null; });
    })).then(function (list) {
      var known = [];
      list.forEach(function (d, i) {
        if (d) known.push({ ch: chars[i], d: d });
      });
      if (!known.length) return null;
      var single = chars.length === 1;
      var facts = el("dl", "hz-facts");

      function fact(label, html, zh) {
        var row = el("div", "hz-fact");
        var dt = el("dt", null, label);
        if (zh) dt.lang = "zh-CN";
        var dd = el("dd");
        dd.innerHTML = html;
        row.appendChild(dt);
        row.appendChild(dd);
        facts.appendChild(row);
      }

      host.textContent = "";
      var total = 0;
      known.forEach(function (item) {
        var d = item.d;
        var n = d.strokes.length;
        total += n;
        var block = el("div", "hz-writing");
        if (!single) {
          var name = el("span", "hz-writing__char", item.ch);
          name.lang = "zh-CN";
          block.appendChild(name);
        }
        var cells = el("div", "hz-writing__cells");
        cells.setAttribute("aria-hidden", "true");
        for (var step = 0; step < n; step++) {
          var cell = el("span", "hz-wcell");
          cell.appendChild(miniSvg(d, step, step));
          cells.appendChild(cell);
        }
        block.appendChild(cells);
        host.appendChild(block);

        var selfRadical = d.radical && d.radical[0] === item.ch;
        if (!single) {
          fact(item.ch, n + " " + strokesWord(n) + (d.radical ? " · ключ " + radicalText(d) : ""), true);
        } else if (selfRadical && !(d.parts && d.parts.length)) {
          fact("состав", "самостоятельный ключ — «" + attr(d.radical[1]) + "»");
        } else {
          if (d.radical) fact("ключ", radicalText(d));
          if (d.parts && d.parts.length) {
            fact("состав", (d.layout && LAYOUTS[d.layout] ? LAYOUTS[d.layout] + ": " : "") + d.parts.map(function (part) {
              return (part[0] ? '<span lang="zh-CN">' + attr(part[0]) + "</span>" : "часть без своего знака") +
                (part[2] ? " «" + attr(part[2]) + "»" : "");
            }).join(" · "));
          }
        }
      });
      if (facts.firstChild) host.appendChild(facts);

      var meta = total + " " + strokesWord(total);
      if (single) {
        if (known[0].d.radical) meta += " · ключ " + radicalText(known[0].d);
      } else {
        meta += " · " + known.length + " " + plural(known.length, ["иероглиф", "иероглифа", "иероглифов"]);
      }
      return { meta: meta };
    });
  }

  window.HanziWindow = { open: open, gloss: entryGloss, writing: writing };
})();
