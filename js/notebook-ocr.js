/* Карточки по фото тетради без сервера: фото распознаётся прямо в браузере
   (js/ocr-worker.js), прочитанное раскладывается на слова, а пиньинь и
   перевод сверяются со словарём БКРС (js/dict-lookup.js). Вызывает модуль
   js/photo-cards.js; подключается после js/dict-lookup.js.

   NotebookOCR.read(image, { onStatus }) → Promise({ words, checked })
     image — загруженная картинка (<img>). onStatus({ stage, … }) говорит,
     что происходит: "download" (loaded, total — байты; только в первый
     раз), "detect" — поиск строк, "read" (done, total — строки), "check" —
     сверка со словарём.
     words — [{ hanzi, pinyin, translation, added: [поля], unsure: [поля] }]:
     added — на фото этого нет или прочитать не удалось, взято из словаря;
     unsure — прочитано неуверенно, стоит сверить с фото. checked — false,
     если словарь не загрузился и всё взято только с фото.
     Ошибка — Error с понятным message и code: "unsupported", "image",
     "load" (не скачался распознаватель), "run", "aborted".
   NotebookOCR.cancel() — остановить распознавание.
   NotebookOCR.supported() — умеет ли браузер распознавать (нужны Web Worker
     и SIMD WebAssembly); нет — read сразу отвечает ошибкой "unsupported".

   Как фото становится словами:
   1. Строку режем на куски: иероглифы, а между ними текст, разделённый
      тире, двоеточием или пробелом. Текст — пиньинь, если китайская модель
      прочитала его как правильные слоги, и русский, если русская модель
      прочитала его кириллицей.
   2. Куски собираются в ряды по высоте на фото (с поправкой на наклон), в
      ряду — слева направо: иероглифы начинают слово, пиньинь и перевод
      справа от них относятся к нему. Ряд из одного пиньиня над
      иероглифами — их пиньинь, ряд из одного русского под словом —
      продолжение перевода.
   3. Словарь. Неуверенные иероглифы проверяются запасными вариантами
      модели: берётся тот, что есть в словаре и сходится с пиньинем и
      переводом на фото. Пиньинь с фото сравнивается со словарным без тонов
      и заменяется словарным — с верными тонами. Перевод с фото
      сравнивается со значениями статьи с поправкой на похожие буквы
      прописи (т ↔ m, л ↔ n, д ↔ g) и пишется как в словаре. Чего на фото
      нет — берётся из словаря с пометкой added. */
(function () {
  "use strict";

  var MAX_SIDE = 2048;        // длинная сторона фото, которое уходит в распознавание
  var MAX_WORDS = 150;
  var MAX_HANZI = 12;         // длиннее — предложение из упражнения, а не слово
  var MAX_LEN = { hanzi: 40, pinyin: 100, translation: 200 };
  var OCR_DIR = "ocr/v1/";    // папка моделей в данных словаря

  var MESSAGES = {
    unsupported: "Этот браузер не умеет распознавать фото. Откройте страницу в Chrome, Firefox или Edge, на iPhone и iPad — в Safari с iOS 16.4 и новее. Или введите слова вручную.",
    image: "Не получилось открыть фото. Выберите другое — в формате JPEG или PNG.",
    load: "Не получилось скачать распознаватель. Проверьте интернет и попробуйте ещё раз.",
    run: "Не получилось распознать фото. Попробуйте ещё раз или выберите другое.",
    crash: "Распознавание прервалось — возможно, телефону не хватило памяти. Закройте другие вкладки и попробуйте ещё раз.",
    aborted: "Распознавание остановлено."
  };

  var script = document.currentScript;
  var WORKER_URL = (script && script.src ? script.src : "../js/notebook-ocr.js")
    .replace(/notebook-ocr\.js(?:\?.*)?$/, "ocr-worker.js");

  var worker = null;
  var seq = 0;
  var pending = null;     // { id, resolve, reject, status } — текущее распознавание

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  // Движок распознавания собран с командами SIMD WebAssembly. Их нет, например,
  // в Safari на компьютерах Mac с процессором Intel и в iOS старше 16.4 —
  // проверяем заранее крошечным модулем (функция, возвращающая v128.const 0).
  var SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11];

  function supported() {
    try {
      return !!window.Worker && !!window.DictLookup && typeof WebAssembly === "object" &&
        WebAssembly.validate(new Uint8Array(SIMD_PROBE));
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------ поток распознавания

  function settle(err, value) {
    var p = pending;
    pending = null;
    if (!p) return;
    if (err) p.reject(err);
    else p.resolve(value);
  }

  function onMessage(e) {
    var m = e.data || {};
    if (!pending || m.id !== pending.id) return;
    if (m.type === "progress") {
      pending.status({ stage: "download", loaded: m.loaded, total: m.total });
    } else if (m.type === "stage") {
      pending.status({ stage: m.stage, done: m.done || 0, total: m.total || 0 });
    } else if (m.type === "result") {
      settle(null, m.lines);
    } else if (m.type === "error") {
      if (window.console) console.warn("notebook-ocr:", m.code, m.message, m.stack || "");
      // Движок не запустился в этом браузере — дело не в интернете.
      if (/no available backend|not supported/i.test(m.message || "")) settle(fail("unsupported", MESSAGES.unsupported));
      else settle(fail(m.code === "load" ? "load" : "run", m.code === "load" ? MESSAGES.load : MESSAGES.run));
    }
  }

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function getWorker() {
    if (!worker) {
      worker = new Worker(WORKER_URL);
      worker.onmessage = onMessage;
      // Поток упал целиком (чаще всего — не хватило памяти).
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        stopWorker();
        settle(fail("run", MESSAGES.crash));
      };
    }
    return worker;
  }

  // Счёт внутри потока не прервать — поток закрывается целиком. Модели в
  // следующий раз загрузятся заново, но уже из хранилища браузера.
  function cancel() {
    if (!pending) return;
    stopWorker();
    settle(fail("aborted", MESSAGES.aborted));
  }

  // Фото → пиксели RGBA не больше MAX_SIDE по длинной стороне. Поворот с
  // камеры телефона (EXIF) браузер применяет к картинке сам.
  function pixels(image) {
    var w0 = image.naturalWidth || image.width;
    var h0 = image.naturalHeight || image.height;
    if (!w0 || !h0) throw fail("image", MESSAGES.image);
    var k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    var w = Math.max(1, Math.round(w0 * k));
    var h = Math.max(1, Math.round(h0 * k));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";             // прозрачный PNG — на белом, как бумага
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 0;   // iOS держит память холста до сборки мусора
    return { width: w, height: h, data: data };
  }

  function read(image, opts) {
    opts = opts || {};
    var status = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
    cancel();
    if (!supported()) return Promise.reject(fail("unsupported", MESSAGES.unsupported));
    var px;
    try {
      px = pixels(image);
    } catch (e) {
      return Promise.reject(e.code ? e : fail("image", MESSAGES.image));
    }
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending = { id: id, resolve: resolve, reject: reject, status: status };
      try {
        getWorker().postMessage({
          type: "run",
          id: id,
          base: window.DictLookup.dataUrl + OCR_DIR,
          width: px.width,
          height: px.height,
          pixels: px.data.buffer
        }, [px.data.buffer]);
      } catch (e) {
        stopWorker();
        settle(fail("unsupported", MESSAGES.unsupported));
      }
    }).then(function (lines) {
      status({ stage: "check" });
      return toWords(lines);
    });
  }

  // ---------------------------------------------------------- куски строк

  var HANZI = /[㐀-䶿一-鿿豈-﫿]/;
  var HANZI_START = /^(?:[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff])/;
  var HANZI_MIN_P = 0.25;     // ниже — не иероглиф, а помарка
  var SEPARATOR = /[-—–−‐‑:：=→|ー]/;
  var CYRILLIC = /[а-яё]/i;
  var LETTER = /[a-zа-яёàáâãäåāăǎèéêëēěìíîïīǐòóôõöōǒùúûüūǔǖǘǚǜńňǹ]/i;

  function dist(p, q) {
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  }

  // Точка посередине высоты строки на доле f её ширины.
  function pointAt(box, f) {
    var tl = box[0], tr = box[1], br = box[2], bl = box[3];
    var top = [tl[0] + (tr[0] - tl[0]) * f, tl[1] + (tr[1] - tl[1]) * f];
    var bot = [bl[0] + (br[0] - bl[0]) * f, bl[1] + (br[1] - bl[1]) * f];
    return [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2];
  }

  // Знаки чтения с местом в строке: a…b — доли её ширины.
  function placed(r, from, to) {
    var span = to - from;
    return r.chars.map(function (c) {
      return {
        c: c.c,
        p: c.p,
        alts: c.alts || [],
        a: from + c.t0 * r.step * span,
        b: from + (c.t1 + 1) * r.step * span
      };
    });
  }

  function mid(c) {
    return (c.a + c.b) / 2;
  }

  function inRange(chars, a, b) {
    return chars.filter(function (c) {
      var m = mid(c);
      return m >= a && m < b;
    });
  }

  function textOf(chars) {
    return chars.map(function (c) { return c.c; }).join("").replace(/\s+/g, " ").trim();
  }

  function letters(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (LETTER.test(text.charAt(i))) n++;
    }
    return n;
  }

  function isHanzi(c) {
    return !!c && HANZI.test(c.c) && (c.p >= HANZI_MIN_P || c.promoted);
  }

  // Рукописный иероглиф модель иногда читает похожим значком (平 → «￥»).
  // Если среди её запасных вариантов есть иероглиф, значок им и заменяется.
  var GLYPH_LIKE = /[￥¥$#&@§※□■△○●◎]/;
  var PROMOTE_P = 0.1;

  // Ключ 讠 слева от знака модель часто читает латинской «i» (i人 — 认,
  // i井 — 讲). Пары «правая часть → знак с 讠» для частых слов; такой знак
  // становится запасным вариантом следующего за «i» иероглифа.
  var WITH_SPEECH = "人认井讲上让己记舌话吾语兑说卖读果课青请射谢司词只识式试亥该仑论殳设" +
    "方访午许斥诉寸讨川训义议正证平评寺诗吴误周调炎谈隹谁宜谊成诚羊详十计丁订牙讶" +
    "秀诱者诸胃谓皆谐夬诀兼谦普谱";
  var SPEECH_I = /^[iìíīǐ]$/;

  function compose(chars) {
    chars.forEach(function (c, i) {
      var next = chars[i + 1];
      if (!next || !SPEECH_I.test(c.c) || !HANZI.test(next.c)) return;
      var k = WITH_SPEECH.indexOf(next.c);
      if (k < 0 || k % 2) return;
      next.alts = [[WITH_SPEECH.charAt(k + 1), Math.max(next.p, 0.5)]].concat(next.alts);
      next.composed = true;
      c.c = " ";
    });
  }

  function promote(chars) {
    chars.forEach(function (c) {
      if (!GLYPH_LIKE.test(c.c)) return;
      var alt = c.alts.filter(function (a) { return HANZI_START.test(a[0]) && a[1] >= PROMOTE_P; })[0];
      if (!alt) return;
      c.alts = c.alts.filter(function (a) { return a !== alt; });
      c.c = alt[0];
      c.p = alt[1];
      c.promoted = true;
    });
  }

  // Следующий после i знак, не пробел.
  function nextSolid(chars, i) {
    for (var k = i + 1; k < chars.length; k++) {
      if (chars[k].c !== " ") return chars[k];
    }
    return null;
  }

  // Вид текста: "ru" — русская модель прочитала его кириллицей, "py" —
  // китайская прочитала правильными слогами пиньиня, "" — ни то ни другое.
  function kindOf(zhText, ruText) {
    var ruLetters = letters(ruText);
    var cyr = (ruText.match(/[а-яё]/gi) || []).length;
    // Пиньинь русская модель читает латиницей, без единой русской буквы. А
    // русскую пропись — часто наполовину латиницей («дpyr», «pабоmаmь»),
    // и китайская модель видит в ней похожие на слоги буквы.
    if (ruLetters && (cyr / ruLetters >= 0.5 || cyr >= 2)) return "ru";
    if (isPinyin(zhText)) return "py";
    if (cyr >= 1 && ruLetters >= 2) return "ru";
    // Плохо прочитанный пиньинь («2wu quu» — zhuī qiú): латиница, где
    // слогов не меньше, чем лишних букв. Если это всё же русское слово
    // латиницей («cnacuso»), сверка со словарём узнает его как перевод.
    var norm = pyNorm(zhText), syl = syllables(norm);
    if (!cyr && norm.length >= 2 && syl.count && syl.misses <= syl.count) return "py";
    // Латиница, но не пиньинь, — русская пропись, прочитанная латиницей
    // обеими моделями («cnacuδo»): в тетради рядом с иероглифами ей больше
    // нечем быть.
    if (ruLetters >= 3 && letters(zhText) >= 3) return "ru";
    return "";
  }

  // Текст между иероглифами: режем по пробелам китайского чтения, каждое
  // слово определяем отдельно, соседние слова одного вида склеиваем.
  function textTokens(zh, ru, a, b) {
    var cuts = [a];
    inRange(zh, a, b).forEach(function (c) {
      if (c.c === " ") cuts.push(mid(c));
    });
    cuts.push(b);
    var parts = [];
    for (var i = 0; i + 1 < cuts.length; i++) {
      var zc = inRange(zh, cuts[i], cuts[i + 1]);
      var rc = inRange(ru, cuts[i], cuts[i + 1]);
      parts.push({ i: i, zc: zc, rc: rc, kind: kindOf(textOf(zc), textOf(rc)) });
    }
    // «Пиньинь», в котором русская модель увидела русскую букву, рядом с
    // русским словом — тоже русский («paδоma; pабоmаmь»).
    parts.forEach(function (p, k) {
      var near = (parts[k - 1] || {}).kind === "ru" || (parts[k + 1] || {}).kind === "ru";
      if (p.kind === "py" && near && CYRILLIC.test(textOf(p.rc))) p.kind = "ru";
    });
    var out = [];
    parts.forEach(function (p) {
      var i = p.i, zc = p.zc, rc = p.rc, kind = p.kind;
      if (!kind) return;
      var last = out[out.length - 1];
      if (last && last.kind === kind) {
        last.b = cuts[i + 1];
        last.zhChars = last.zhChars.concat(zc);
        last.ruChars = last.ruChars.concat(rc);
      } else {
        out.push({ kind: kind, a: cuts[i], b: cuts[i + 1], zhChars: zc, ruChars: rc });
      }
    });
    out.forEach(function (t) {
      t.zhText = textOf(t.zhChars);
      t.ruText = textOf(t.ruChars);
    });
    return out;
  }

  // Строка → куски: иероглифы (kind "h") и текст ("py", "ru").
  function lineTokens(line) {
    var box = line.box;
    var h = (dist(box[0], box[3]) + dist(box[1], box[2])) / 2;
    var w = (dist(box[0], box[1]) + dist(box[3], box[2])) / 2;
    var zh = placed(line.zh, 0, 1);
    promote(zh);
    compose(zh);
    var ru = [];
    (line.ru || []).forEach(function (r) {
      ru = ru.concat(placed(r, r.from, r.to));
    });

    var hanzi = [];
    var cur = null;
    zh.forEach(function (c, i) {
      if (isHanzi(c)) {
        // Длинное тире от руки китайская модель читает как 一 «один». Если
        // 一 стоит отдельно (после пробела или текста, а не вплотную к
        // иероглифам, как в 统一) и в строке до него уже были иероглифы, а
        // после него иероглифов нет — это разделитель.
        if (c.c === "一" && ((cur && cur.gap) || (!cur && hanzi.length)) && !isHanzi(nextSolid(zh, i))) {
          cur = null;
          c.c = "—";
          return;
        }
        if (!cur) {
          cur = { kind: "h", chars: [], breaks: [], a: c.a, b: c.b };
          hanzi.push(cur);
        } else if (cur.gap) {
          cur.breaks.push(cur.chars.length);
        }
        cur.gap = false;
        cur.chars.push(c);
        cur.b = c.b;
        return;
      }
      // Пробел между иероглифами слово не рвёт (широко написанное 学 习):
      // словарь потом решит, одно это слово или два.
      if (cur && c.c === " " && isHanzi(zh[i + 1])) {
        cur.gap = true;
        return;
      }
      cur = null;
    });

    var tokens = hanzi.slice();
    var edges = [0];
    hanzi.forEach(function (t) { edges.push(t.a, t.b); });
    edges.push(1);
    for (var k = 0; k < edges.length; k += 2) {
      var a = edges[k], b = edges[k + 1];
      if (b - a < 0.02) continue;
      // Разделители из обоих чтений: тире, двоеточие, знак равенства.
      // Дефис между буквами («по-китайски») — не разделитель.
      var cuts = [a];
      [zh, ru].forEach(function (chars) {
        chars.forEach(function (c, i) {
          var m = mid(c);
          if (m <= a || m >= b || !SEPARATOR.test(c.c)) return;
          var inWord = c.c === "-" && LETTER.test((chars[i - 1] || {}).c || "") && LETTER.test((chars[i + 1] || {}).c || "");
          if (!inWord) cuts.push(m);
        });
      });
      cuts.push(b);
      cuts.sort(function (x, y) { return x - y; });
      var zhText = zh.filter(function (c) { return !SEPARATOR.test(c.c); });
      var ruText = ru.filter(function (c) { return !SEPARATOR.test(c.c); });
      for (var j = 0; j + 1 < cuts.length; j++) {
        if (cuts[j + 1] - cuts[j] < 0.01) continue;
        tokens = tokens.concat(textTokens(zhText, ruText, cuts[j], cuts[j + 1]));
      }
    }

    // Одиночное 一 прямо перед русским текстом — тоже тире («一 друг»).
    tokens.sort(function (p, q) { return p.a - q.a; });
    tokens = tokens.filter(function (t, i) {
      var next = tokens[i + 1];
      return !(t.kind === "h" && t.chars.length === 1 && t.chars[0].c === "一" && next && next.kind === "ru");
    });

    var angle = w >= 2 * h ? Math.atan2(box[1][1] - box[0][1], box[1][0] - box[0][0]) : null;
    tokens.forEach(function (t) {
      if (t.kind === "h") t.text = t.chars.map(function (c) { return c.c; }).join("");
      t.h = h;
      t.angle = angle;
      t.p0 = pointAt(box, t.a);
      t.p1 = pointAt(box, t.b);
      t.pc = pointAt(box, (t.a + t.b) / 2);
    });
    return tokens;
  }

  // ---------------------------------------------------------------- ряды

  // Куски → ряды по высоте. Фото обычно снято с наклоном: поворачиваем
  // координаты на средний наклон длинных строк, чтобы ряды стали ровными.
  function rowsOf(tokens) {
    var angles = tokens.filter(function (t) { return t.angle !== null; })
      .map(function (t) { return t.angle; })
      .sort(function (x, y) { return x - y; });
    var angle = angles.length ? angles[angles.length >> 1] : 0;
    var cos = Math.cos(angle), sin = Math.sin(angle);
    function x(p) { return p[0] * cos + p[1] * sin; }
    function y(p) { return -p[0] * sin + p[1] * cos; }
    tokens.forEach(function (t) {
      t.x0 = Math.min(x(t.p0), x(t.p1));
      t.x1 = Math.max(x(t.p0), x(t.p1));
      t.y = y(t.pc);
    });
    tokens.sort(function (p, q) { return p.y - q.y; });
    var rows = [];
    tokens.forEach(function (t) {
      var row = null;
      for (var i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
        if (Math.abs(t.y - rows[i].y) <= 0.5 * Math.max(t.h, rows[i].h)) {
          row = rows[i];
          break;
        }
      }
      if (!row) {
        row = { y: t.y, h: t.h, toks: [] };
        rows.push(row);
      }
      row.toks.push(t);
      row.y += (t.y - row.y) / row.toks.length;
      row.h = Math.max(row.h, t.h);
    });
    rows.sort(function (p, q) { return p.y - q.y; });
    rows.forEach(function (r) {
      r.toks.sort(function (p, q) { return p.x0 - q.x0; });
    });
    return rows;
  }

  function attach(word, t) {
    if (t.kind === "py") word.py.push(t);
    else if (t.kind === "ru") word.ru.push(t);
  }

  // Слово в соседнем ряду, над или под иероглифами которого стоит кусок t.
  function wordAbove(row, t) {
    if (!row || !row.words.length || Math.abs(row.y - t.y) > 1.6 * Math.max(row.h, t.h)) return null;
    var best = null, bestOverlap = 0;
    row.words.forEach(function (w) {
      if (w.pyNear.length) return;
      var overlap = Math.min(w.hanzi.x1, t.x1) - Math.max(w.hanzi.x0, t.x0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = w;
      }
    });
    if (!best) return null;
    return bestOverlap >= 0.3 * Math.min(t.x1 - t.x0, best.hanzi.x1 - best.hanzi.x0) ? best : null;
  }

  // Слово из ряда выше, перевод которого продолжает русский кусок t: его
  // начало стоит под началом перевода, а если перевода ещё нет — под
  // иероглифами.
  function wordToContinue(row, t) {
    if (!row || Math.abs(t.y - row.y) > 1.8 * Math.max(t.h, row.h)) return null;
    var list = row.cont ? [row.cont] : row.words;
    var found = null;
    list.forEach(function (w) {
      if (found) return;
      var ref = w.ru.length ? w.ru[w.ru.length - 1] : null;
      if (ref ? Math.abs(t.x0 - ref.x0) <= 1.5 * t.h : t.x0 >= w.hanzi.x0 - t.h && t.x0 <= w.hanzi.x1 + t.h) found = w;
    });
    return found;
  }

  // Ряды → слова: иероглифы начинают слово, текст справа от них — его.
  function wordsOf(rows) {
    var items = [];
    rows.forEach(function (row) {
      var lead = [];
      row.words = [];
      row.toks.forEach(function (t) {
        if (t.kind === "h") {
          var w = { hanzi: t, py: [], ru: [], pyNear: [] };
          row.words.push(w);
          // Текст слева от первых иероглифов («друг — 朋友») — тоже их.
          lead.forEach(function (x) { attach(w, x); });
          lead = [];
        } else if (row.words.length) {
          attach(row.words[row.words.length - 1], t);
        } else {
          lead.push(t);
        }
      });
      row.rest = row.words.length ? [] : lead;
      items = items.concat(row.words);
    });
    // Ряды без иероглифов: пиньинь над словами (или под ними) и строки
    // перевода, которые не уместились в ряд слова.
    rows.forEach(function (row, i) {
      row.rest.forEach(function (t) {
        if (t.kind === "py") {
          var w = wordAbove(rows[i + 1], t) || wordAbove(rows[i - 1], t);
          if (w) w.pyNear.push(t);
        } else if (t.kind === "ru") {
          var c = wordToContinue(rows[i - 1], t);
          if (c) {
            c.ru.push(t);
            row.cont = c;
          }
        }
      });
    });
    return items;
  }

  // ------------------------------------------------------------- пиньинь

  var TONED = "āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ";
  var PLAIN = "aaaaeeeeiiiioooouuuuvvvv";

  // Без тонов и пробелов, ü → v: «Péng yǒu» → «pengyou».
  function bare(text) {
    var s = String(text || "").toLowerCase().replace(/ü/g, "v");
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var k = TONED.indexOf(ch);
      if (k >= 0) out += PLAIN.charAt(k);
      else if (/[a-z]/.test(ch)) out += ch;
    }
    return out;
  }

  // Слог: необязательная начальная согласная и финаль. Сочетания проверяются
  // несколькими общими правилами, а не полным списком слогов: здесь важно
  // лишь отличить пиньинь от кириллицы, прочитанной латиницей («boga»,
  // «cnacuso»), а редкий несуществующий слог вреда не сделает.
  var SYLLABLE = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ueng|ang|eng|ing|ong|ian|iao|uai|uan|van|ai|ei|ao|ou|an|en|in|un|vn|er|ia|ie|iu|ua|uo|ui|ue|ve|a|o|e|i|u|v)$/;
  var SYL_MAX = 6;

  function isSyllable(s) {
    var m = SYLLABLE.exec(s);
    if (!m) return false;
    var ini = m[1] || "", fin = m[2], i0 = fin.charAt(0);
    if (!ini) return /^[aoe]/.test(fin);                              // ai, ou, er…; i/u/ü — только с y/w
    if (/^[jqx]$/.test(ini)) return i0 === "i" || i0 === "v" || /^(u|ue|uan|un)$/.test(fin);
    if (ini === "y") return /^(a|ao|an|ang|e|i|in|ing|o|ong|ou|u|ue|uan|un)$/.test(fin);
    if (ini === "w") return /^(a|ai|an|ang|ei|en|eng|o|u)$/.test(fin);
    if (fin === "o") return /^[bpmfl]$/.test(ini);                     // bo, po, mo, fo, lo
    if (i0 === "v") return ini === "n" || ini === "l";                 // nü, lüe
    if (fin === "er" || fin === "ueng") return false;
    if (i0 === "i" && fin !== "i") return /^[bpmdtnl]$/.test(ini);    // bian, diao, ling…
    if (fin === "i") return !/^[fgkh]$/.test(ini);
    if (i0 === "u" && /^[bpmf]$/.test(ini)) return fin === "u";       // bu, pu, mu, fu
    return true;
  }

  // Разбор строки на слоги динамикой: на каждом месте — лучший из
  // вариантов «слог» или «пропуск буквы». { misses — букв не легло в слоги
  // (меньше — лучше), count — слогов, first — первый слог }.
  function syllables(s) {
    var best = [{ misses: 0, count: 0, first: "" }];
    for (var i = 1; i <= s.length; i++) {
      var p = best[i - 1];
      best[i] = { misses: p.misses + 1, count: p.count, first: p.first };
      for (var k = 1; k <= SYL_MAX && k <= i; k++) {
        var q = best[i - k], syl = s.slice(i - k, i);
        if (!isSyllable(syl)) continue;
        if (q.misses < best[i].misses || (q.misses === best[i].misses && q.count + 1 < best[i].count)) {
          best[i] = { misses: q.misses, count: q.count + 1, first: q.first || syl };
        }
      }
    }
    return best[s.length];
  }

  function pinyinMisses(s) {
    return syllables(s).misses;
  }

  // Пиньинь с фото для сравнения: цифры, похожие на буквы прописи («2h» —
  // zh, «0» — o), — буквами; затем без тонов и пробелов.
  function pyNorm(text) {
    return bare(String(text || "").toLowerCase()
      .replace(/2(?=h)/g, "z").replace(/2(?=[a-z])/g, "z").replace(/0/g, "o"));
  }

  // Пиньинь ли это: только латиница (с тонами), без цифр, и почти всё
  // ложится в слоги. Пропись при чтении теряет и путает буквы, поэтому
  // одна лишняя буква на четыре допустима.
  function isPinyin(text) {
    var t = String(text || "").replace(/[\s'’·.,;]/g, "");
    if (t.length < 2 || /[^a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ]/.test(t)) return false;
    var s = bare(t);
    return s.length >= 2 && /[aeiouv]/.test(s) && pinyinMisses(s) <= Math.floor(s.length / 4);
  }

  // Похожесть строк 0…1 по расстоянию Левенштейна.
  function similar(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  // ------------------------------------------------------- русский текст

  // Буквы прописи, которые модели путают между собой и с латиницей: в
  // «сравнительном» виде они сливаются в одну, чтобы «camonëm» нашлось как
  // «самолёт». Пары по строкам: какие знаки → во что.
  var LOOKALIKE = [
    ["мтm", "м"], ["лпn", "л"], ["дg∂", "д"], ["иuй", "и"], ["уy", "у"],
    ["гr", "г"], ["рp", "р"], ["сc", "с"], ["аa", "а"], ["оo0", "о"],
    ["еёeë", "е"], ["хx", "х"], ["кk", "к"], ["ьбвb6δs", "ь"], ["нh", "н"],
    ["шщw", "ш"], ["з3z", "з"], ["ч4", "ч"], ["ыъ", "ы"]
  ];
  var SKELETON = {};
  LOOKALIKE.forEach(function (pair) {
    for (var i = 0; i < pair[0].length; i++) SKELETON[pair[0].charAt(i)] = pair[1];
  });

  // Латиница, которую русская модель иногда оставляет в слове, — в
  // кириллицу по самому частому значению этой буквы в прописи.
  var TO_CYRILLIC = { a: "а", c: "с", e: "е", "ë": "ё", o: "о", p: "р", x: "х", y: "у", k: "к", m: "т", n: "п", u: "и", d: "д", g: "д", "∂": "д", r: "г", b: "в", h: "н", "6": "ь", "3": "з", z: "з", "δ": "б" };

  function skeleton(text) {
    var s = String(text || "").toLowerCase(), out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (SKELETON[ch]) out += SKELETON[ch];
      else if (/[а-я]/.test(ch)) out += ch;
      else if (/[\s,;\-]/.test(ch) && out && out.charAt(out.length - 1) !== " ") out += " ";
    }
    return out.trim();
  }

  // Перевод как прочитан: тире и знаки по краям убраны, латиница —
  // кириллицей (перевод, прочитанный целиком латиницей: «cnacuδo» →
  // «спасибо»).
  function cleanRu(text) {
    return String(text || "")
      .replace(/^[\s\-—–−:=.,;·|]+|[\s\-—–−:=,;·|]+$/g, "")
      .replace(/[^\s,;()]+/g, function (word) {
        if (!/[a-zа-яё]/i.test(word)) return word;
        return word.replace(/[a-zë∂δ0-9]/gi, function (ch) {
          return TO_CYRILLIC[ch.toLowerCase()] || ch;
        });
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  var PY_WORD = "[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+";
  var HEAD = new RegExp("^([IVX]+)(?:\\s+(" + PY_WORD + "))?(?![a-zа-яё])\\s*");
  var LEAD_PY = new RegExp("^(" + PY_WORD + ")\\s+(?=[^a-z\\s])");

  // Значения статьи БКРС: строки без иероглифов (с иероглифами — примеры),
  // без пометок [i]…[/i], [p]…[/p], скобок и нумерации. Каждое значение —
  // { syn: синонимы, reading: чтение } — «друг, приятель» → ["друг",
  // "приятель"]. Чтение нужно иероглифам с несколькими чтениями: у них
  // раздел начинается строкой «II liǎo», а значение — с чтения («1) zé
  // ответственность»).
  function meanings(entry) {
    var out = [], reading = "", sense = 0;
    String(entry[2] || "").split("\n").forEach(function (line) {
      var s = line
        .replace(/\[(i|p|c|com|ex)\][\s\S]*?\[\/\1\]/g, "")
        .replace(/\[\/?[a-z*]+\d*\]/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\([^)]*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // Иероглифы вне скобок — строка-пример («老朋友 старый друг»); в
      // скобках — пометка к значению («мастер своего дела (также 老行家)»).
      if (HANZI.test(s)) return;
      sense++;                                     // строка статьи — отдельное значение
      var head = HEAD.exec(s);
      if (head) {
        if (head[2]) reading = head[2];
        s = s.slice(head[0].length);
      }
      s = s.replace(/^(?:\d+\)\s*|[а-я]\)\s*|\*\s*)+/, "");
      var own = LEAD_PY.exec(s);
      if (own && isPinyin(own[1])) s = s.slice(own[0].length);
      if (!s || /^см\.|^то же/.test(s) || !CYRILLIC.test(s)) return;
      s.split(";").forEach(function (group) {
        var syn = group.split(",").map(function (x) {
          return x.replace(/^[\s*]+|[\s.!?]+$/g, "");
        }).filter(function (x) {
          // Названия в кавычках («"Тайм"» у 时代) для карточки не годятся.
          return x.length >= 2 && x.length <= 40 && CYRILLIC.test(x) && !/["«»„“]/.test(x);
        });
        if (syn.length) out.push({ syn: syn, reading: own && isPinyin(own[1]) ? own[1] : reading, sense: sense });
      });
    });
    return out;
  }

  // Перевод для карточки, когда на фото его нет: первое значение (для
  // выбранного чтения, если у иероглифа их несколько), до трёх синонимов.
  function shortMeaning(entries, reading) {
    var first = null, exact = null;
    entries.forEach(function (e) {
      meanings(e).forEach(function (m) {
        if (!first) first = m;
        if (!exact && reading && m.reading && bare(m.reading) === bare(reading)) exact = m;
      });
    });
    var m = exact || first;
    return m ? m.syn.slice(0, 3).join(", ") : "";
  }

  // Перевод с фото, сверенный со статьёй: каждая часть через запятую
  // ищется среди синонимов по «сравнительному» виду. Нашлось всё — пишем
  // как в словаре (sure); иначе — как прочитано. score — доля найденного.
  function matchTranslation(photo, entries) {
    var parts = photo.split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!parts.length) return { text: "", score: 0, sure: false };
    var syns = [];
    entries.forEach(function (e) {
      meanings(e).forEach(function (m) { syns = syns.concat(m.syn); });
    });
    var found = 0, text = [];
    parts.forEach(function (part) {
      var sk = skeleton(part), best = null, bestSim = 0;
      var low = part.toLowerCase().replace(/ё/g, "е");
      syns.forEach(function (syn) {
        var ss = skeleton(syn), sim = similar(sk, ss), text = syn;
        // Начало значения («читать» из «читать книгу») или значение с
        // окончанием («здравствуйте» при «здравствуй») буква в букву:
        // слово оставляем как написано, словарь его лишь подтверждает.
        var lowSyn = syn.toLowerCase().replace(/ё/g, "е");
        if (low.length >= 3 && lowSyn.length >= 3 && (lowSyn.indexOf(low + " ") === 0 ||
            (low.indexOf(lowSyn) === 0 && low.length > lowSyn.length && low.length - lowSyn.length <= 3))) {
          sim = 1;
          text = part;
        }
        if (sim > bestSim) {
          bestSim = sim;
          best = text;
        }
      });
      if (best && bestSim >= 0.75) {
        found++;
        if (text.indexOf(best) < 0) text.push(best);
      } else {
        text.push(part);
      }
    });
    return { text: text.join(", "), score: found / parts.length, sure: found === parts.length };
  }

  // --------------------------------------------------------- сверка

  var UNSURE_P = 0.8;         // знак ниже этой уверенности стоит сверить
  var MAX_VARIANTS = 6;       // на слово: каждый вариант — запрос к словарю

  // Варианты написания: каждый неуверенный знак (до трёх самых неуверенных)
  // меняется на запасные варианты модели. prob — средняя уверенность.
  function variants(chars) {
    var list = [{ text: "", logp: 0 }];
    var weak = chars.map(function (c, i) { return i; })
      .filter(function (i) { return (chars[i].p < UNSURE_P || chars[i].composed) && chars[i].alts.length; })
      .sort(function (x, y) { return chars[x].p - chars[y].p; })
      .slice(0, 3);
    chars.forEach(function (c, i) {
      var options = [[c.c, c.p]];
      if (weak.indexOf(i) >= 0) {
        options = options.concat(c.alts.filter(function (a) { return HANZI_START.test(a[0]); }));
      }
      var next = [];
      list.forEach(function (v) {
        options.forEach(function (o) {
          next.push({ text: v.text + o[0], logp: v.logp + Math.log(Math.max(o[1], 0.001)) });
        });
      });
      next.sort(function (x, y) { return y.logp - x.logp; });
      list = next.slice(0, MAX_VARIANTS);
    });
    return list.map(function (v) {
      return { text: v.text, prob: Math.exp(v.logp / Math.max(1, chars.length)) };
    });
  }

  // Чтения статьи: «le, liǎo, liào» → ["le", "liǎo", "liào"].
  function readings(entry) {
    return String(entry[1] || "").split(/\s*[,;]\s*/).filter(Boolean);
  }

  var PY_FITS = 0.45;         // ниже — кусок не похож на пиньинь этого слова

  // Похожесть куска «пиньиня» с фото на чтение r (без тонов). Кусок рядом
  // с иероглифами прочитан и русской моделью — берётся лучшее из двух.
  // { sim, text } — text: то из двух чтений куска, что ближе (уже без тонов).
  function pySim(p, r) {
    var b = bare(r), zh = pyNorm(p.zh);
    var out = { sim: similar(zh, b), text: zh };
    var ruSyl = p.ru ? syllables(pyNorm(p.ru)) : null;
    if (ruSyl && !CYRILLIC.test(p.ru) && ruSyl.count && ruSyl.misses <= ruSyl.count) {
      var ru = pyNorm(p.ru), sim = similar(ru, b);
      if (sim > out.sim) out = { sim: sim, text: ru };
    }
    return out;
  }

  // Лучшее чтение статей для кусков пиньиня с фото: { text, sim, sims,
  // syl } — sims[i] — насколько i-й кусок похож на лучшее для него чтение,
  // syl — на сколько слогов кусок с фото длиннее или короче чтения.
  function bestReading(entries, pys) {
    var best = { text: "", sim: 0, syl: 0, sims: pys.map(function () { return 0; }) };
    entries.forEach(function (e) {
      readings(e).forEach(function (r) {
        if (!best.text) best.text = r;
        pys.forEach(function (p, i) {
          var m = pySim(p, r);
          if (m.sim > best.sims[i]) best.sims[i] = m.sim;
          if (m.sim > best.sim) {
            best.sim = m.sim;
            best.text = r;
            best.syl = Math.abs(syllables(m.text).count - syllables(bare(r)).count);
          }
        });
      });
    });
    return best;
  }

  function charList(text) {
    return String(text || "").match(/[\ud800-\udbff][\udc00-\udfff]|[\s\S]/g) || [];
  }

  // Насколько слово сходится с прочитанными иероглифами: знаки по порядку
  // (наибольшая общая подпоследовательность), каждый совпавший — с
  // уверенностью модели в нём или в запасном варианте; делится на длину
  // большего из двух. Пропущенный моделью знак (学() → 学问) стоит только
  // доли оценки, а не всего слова.
  function charScore(chars, word) {
    var w = charList(word), n = chars.length, m = w.length;
    if (!n || !m) return 0;
    var prev = [], cur, i, j;
    for (j = 0; j <= m; j++) prev[j] = 0;
    for (i = 1; i <= n; i++) {
      cur = [0];
      var c = chars[i - 1];
      for (j = 1; j <= m; j++) {
        var gain = 0;
        if (c.c === w[j - 1]) gain = c.p;
        else c.alts.forEach(function (a) { if (a[0] === w[j - 1] && a[1] > gain) gain = a[1]; });
        cur[j] = Math.max(prev[j], cur[j - 1], gain ? prev[j - 1] + gain : 0);
      }
      prev = cur;
    }
    return prev[m] / Math.max(n, m);
  }

  // Употребительность по номеру статьи (меньше — важнее): 0…0,3, и ещё
  // 0,15 словам HSK — в тетрадях учеников в основном они. Из одинаково
  // подходящих вариантов берётся обычное слово (讲究, а не 进究; 确保, а не
  // 取保 при прочитанном «qu bao»).
  function prior(entries) {
    var id = Math.min.apply(null, entries.map(function (e) { return typeof e.id === "number" ? e.id : 4e6; }));
    var hsk = entries.some(function (e) { return e.hsk; });
    return 0.3 * Math.max(0, 1 - Math.log(id + 10) / Math.log(4e6)) + (hsk ? 0.15 : 0);
  }

  // Насколько перевод с фото похож хоть на одно значение (0…1), даже когда
  // прочитан слишком плохо, чтобы его исправить: подсказка, какое из
  // похожих слов записано.
  function translationHint(item, entries, spare) {
    var texts = [item.ruText, item.ruAlt].concat(spare || []).filter(Boolean);
    if (!texts.length) return 0;
    var best = 0;
    entries.forEach(function (e) {
      meanings(e).forEach(function (m) { best = Math.max(best, meaningSim(m, texts).score); });
    });
    return best;
  }

  // Машинный перевод (m) — в конец: человеческая статья надёжнее.
  function ordered(entries) {
    return entries.slice().sort(function (x, y) {
      return (x[3] && x[3].m ? 1 : 0) - (y[3] && y[3].m ? 1 : 0);
    });
  }

  // Перевод сверяется по обоим чтениям: русская модель надёжнее, но
  // китайская иногда ближе («Komn6omep»). Не нашлось — текст русской.
  function translationFor(item, entries) {
    var tr = matchTranslation(item.ruText, entries);
    if (!tr.sure && item.ruAlt) {
      var alt = matchTranslation(item.ruAlt, entries);
      if (alt.score > tr.score) tr = alt.sure ? alt : { text: item.ruText, score: alt.score, sure: false };
    }
    return tr;
  }

  // Вариант написания + его статьи → оценка. Кусок «пиньиня», совсем не
  // похожий на чтение слова, может оказаться переводом, прочитанным
  // латиницей («boga» — «вода»): если он нашёлся среди значений, это перевод.
  // «Перевод», прочитанный целиком латиницей, верен, только если нашёлся в
  // словаре; иначе это скорее плохо прочитанный пиньинь («jintiak») — он
  // сверяется с чтениями наравне с пиньинем.
  function judge(item, v, entries) {
    var py = bestReading(entries, item.py.concat(item.latinRu));
    var tr = item.ruText ? translationFor(item, entries) : null;
    if (tr && !tr.sure && item.ruLatinOnly) tr = null;
    var pyLeft = item.py.length;
    if (!tr) {
      pyLeft += py.sims.slice(item.py.length).filter(function (s) { return s >= PY_FITS; }).length;
    }
    // Куски «пиньиня», не похожие на чтение слова, — скорее плохо
    // прочитанный перевод: по ним потом выбирается значение из словаря.
    var spare = [];
    item.py.forEach(function (p, i) {
      if (py.sims[i] >= PY_FITS || (tr && tr.sure)) return;
      var text = p.ru && CYRILLIC.test(p.ru) ? cleanRu(p.ru) : p.zh;
      var alt = matchTranslation(text, entries);
      if (alt.sure) {
        tr = alt;
        pyLeft--;
      } else {
        spare.push(text);
      }
    });
    var fits = py.sim >= PY_FITS;
    var chars = charScore(item.chars, v.text);
    var hint = tr && tr.sure ? 0 : 0.4 * Math.max(0, translationHint(item, entries, spare) - 0.35);
    return {
      v: v,
      entries: entries,
      py: py,
      pyLeft: pyLeft,
      tr: tr,
      spare: spare,
      chars: chars,
      score: chars + (fits ? 1.2 * py.sim - Math.min(0.5, 0.25 * py.syl) : 0) +
        (tr ? 0.5 * tr.score : 0) + hint + prior(entries)
    };
  }

  // Лучший вариант слова среди найденных в словаре. found — { написание:
  // [статьи] } (ответ DictLookup.exact); extra — кандидаты из поиска по
  // знакам и пиньиню: [{ text, entries }], они помечаются rescued.
  function pick(item, found, extra) {
    var best = null;
    function consider(v, entries) {
      if (!entries || !entries.length) return;
      var j = judge(item, v, ordered(entries));
      // Кандидат без единого общего знака с прочитанным — не исправление,
      // а другое слово с похожим чтением (耨 вместо 表现).
      if (v.rescued && !j.chars) return;
      if (!best || j.score > best.score) best = j;
    }
    item.variants.forEach(function (v) { consider(v, found[v.text]); });
    (extra || []).forEach(function (c) {
      if (!(found[c.text] && found[c.text].length)) consider({ text: c.text, rescued: true }, c.entries);
    });
    return best;
  }

  // Прочитано плохо: в словаре не нашлось, или пиньинь с фото не похож на
  // словарный либо в нём другое число слогов (平 при «pinun» — 平均). Таким
  // словам ищутся кандидаты по знакам и пиньиню; найденное вариант с фото
  // заменит, только если сойдётся лучше.
  function weak(item, best) {
    var photoPy = item.py.length || item.latinRu.length;
    return !best || (photoPy && (best.py.sim < 0.8 || best.py.syl > 0));
  }

  // Слово с фото + выбранный вариант → карточка.
  function settleWord(item, best) {
    var w = { hanzi: item.text, pinyin: "", translation: "", added: [], unsure: [] };
    if (!best) {
      // В словаре нет — всё как прочитано.
      w.pinyin = readablePinyin(item.py);
      w.translation = item.ruLatinOnly ? "" : item.ruText;
      if (item.minP < UNSURE_P) w.unsure.push("hanzi");
      if (w.pinyin) w.unsure.push("pinyin");
      if (w.translation) w.unsure.push("translation");
      return w;
    }
    w.hanzi = best.v.text;
    var pinyinAgrees = best.py.sim >= 0.6;
    var trSure = !!(best.tr && best.tr.sure);
    // Слово, подобранное по части знаков, — догадка, пока её не подтвердили
    // и пиньинь, и перевод (или пиньинь почти буква в букву).
    var unsureHanzi = best.v.rescued ? !((pinyinAgrees && trSure) || best.py.sim >= 0.85)
      : best.v.text !== item.text ? !pinyinAgrees && !trSure
      : item.minP < 0.6 && !pinyinAgrees;
    if (unsureHanzi) w.unsure.push("hanzi");
    w.pinyin = best.py.text;
    if (!best.pyLeft) w.added.push("pinyin");
    else if (!pinyinAgrees) w.unsure.push("pinyin");
    if (best.tr && best.tr.score > 0) {
      w.translation = best.tr.text;
      if (!best.tr.sure) w.unsure.push("translation");
    } else if (item.hasRu || best.spare.length) {
      // Перевод на фото есть, но не прочитался: вместо набора букв — самое
      // похожее на прочитанное значение статьи, с пометкой «проверьте».
      w.translation = closestMeaning(best.entries, [item.ruText, item.ruAlt].concat(best.spare), w.pinyin);
      if (w.translation) w.unsure.push("translation");
    } else {
      w.translation = shortMeaning(best.entries, w.pinyin);
      if (w.translation) w.added.push("translation");
    }
    return w;
  }

  // Слова нет в словаре — пиньинь как прочитан: кусок, который лучше всех
  // ложится в слоги, если он вообще похож на пиньинь.
  function readablePinyin(pys) {
    var best = "", bestBad = 0.25;
    pys.forEach(function (p) {
      var s = pyNorm(p.zh);
      if (s.length < 2) return;
      var bad = syllables(s).misses / s.length;
      if (bad <= bestBad) {
        bestBad = bad;
        best = p.zh.replace(/[;,.:]+/g, " ").replace(/\s+/g, " ").trim();
      }
    });
    return best;
  }

  // Значение статьи (до трёх синонимов), больше всего похожее на плохо
  // прочитанный перевод. Совсем не похоже — по слову из первых трёх
  // значений («ветер; погода; нравы»): какое из них записано, решит ученик.
  // Слова текста в «сравнительном» виде, от трёх букв.
  function skWords(text) {
    return skeleton(text).split(" ").filter(function (x) { return x.length >= 3; });
  }

  // Насколько значение похоже на прочитанные куски перевода — по словам:
  // каждое слово с фото ищет самое похожее слово значения, оценка — среднее
  // по словам с фото. { score, syn — синоним с самым похожим словом }.
  function meaningSim(m, texts) {
    var best = { score: 0, syn: m.syn[0] };
    texts.forEach(function (t) {
      var words = skWords(t);
      if (!words.length) return;
      var sum = 0, top = 0, topSyn = m.syn[0];
      words.forEach(function (pw) {
        var wordBest = 0;
        m.syn.forEach(function (syn) {
          skWords(syn).forEach(function (sw) {
            var sim = similar(pw, sw);
            if (sim > wordBest) wordBest = sim;
            if (sim > top) {
              top = sim;
              topSyn = syn;
            }
          });
        });
        sum += wordBest;
      });
      var score = sum / words.length;
      if (score > best.score) best = { score: score, syn: topSyn };
    });
    return best;
  }

  function closestMeaning(entries, texts, reading) {
    var best = null, bestSim = 0.4;
    // Слова, похожие на пиньинь этого слова («han;a» у 行家), — не перевод.
    texts = texts.filter(Boolean).map(function (t) {
      return t.split(/\s+/).filter(function (x) {
        return !(reading && similar(pyNorm(x), bare(reading)) >= 0.5);
      }).join(" ");
    });
    entries.forEach(function (e) {
      meanings(e).forEach(function (m) {
        var s = meaningSim(m, texts);
        if (s.score > bestSim) {
          bestSim = s.score;
          best = { m: m, syn: s.syn };
        }
      });
    });
    // Самый похожий синоним — первым: «деталь, мелочь, подробность».
    if (best) return [best.syn].concat(best.m.syn.filter(function (x) { return x !== best.syn; })).slice(0, 3).join(", ");
    var firsts = [], seen = {};
    entries.slice(0, 1).forEach(function (e) {
      meanings(e).forEach(function (m) {
        if (seen[m.sense] || firsts.length >= 3) return;
        if (reading && m.reading && bare(m.reading) !== bare(reading)) return;
        seen[m.sense] = true;
        firsts.push(m.syn[0]);
      });
    });
    return firsts.length ? firsts.join("; ") : shortMeaning(entries, reading);
  }

  // ------------------------------------------------------- строки → слова

  function joinText(tokens, key, sep) {
    return tokens.map(function (t) { return t[key]; }).filter(Boolean).join(sep).replace(/\s+/g, " ").trim();
  }

  // Слово из wordsOf → то, что нужно для сверки, или null, если это не
  // слово: длинное предложение или одиночная помарка без пиньиня и перевода.
  function prepare(w) {
    var chars = w.hanzi.chars;
    var text = w.hanzi.text;
    if (!text || chars.length > MAX_HANZI) return null;
    var minP = Math.min.apply(null, chars.map(function (c) { return c.p; }));
    var py = w.py.concat(w.pyNear);
    if (chars.length === 1 && minP < 0.5 && !py.length && !w.ru.length) return null;
    var own = w.py.concat(w.ru);
    return {
      text: text,
      chars: chars,
      x0: w.hanzi.x0,
      h: w.hanzi.h,
      // Весь текст слова — слева от иероглифов (а не справа, над или под).
      leadOnly: own.length > 0 && !w.pyNear.length && own.every(function (t) { return t.x1 <= w.hanzi.x0 + 0.5 * w.hanzi.h; }),
      minP: minP,
      variants: variants(chars),
      py: py.map(function (t) {
        return { zh: t.zhText.replace(/[\-—–:=]+$/, "").trim(), ru: t.ruText };
      }),
      ruText: cleanRu(joinText(w.ru, "ruText", " ")),
      ruAlt: joinText(w.ru, "zhText", " "),
      hasRu: w.ru.length > 0,
      ruLatinOnly: w.ru.length > 0 && !CYRILLIC.test(joinText(w.ru, "ruText", " ")),
      latinRu: w.ru.filter(function (t) { return !CYRILLIC.test(t.ruText); }).map(function (t) {
        return { zh: t.zhText, ru: t.ruText };
      })
    };
  }

  function clip(w) {
    Object.keys(MAX_LEN).forEach(function (f) {
      w[f] = String(w[f] || "").slice(0, MAX_LEN[f]).trim();
    });
    return w;
  }

  // Откуда поле: 3 — с фото и сверено, 2 — с фото, но неуверенно, 1 — из
  // словаря, 0 — пусто.
  function fieldRank(w, f) {
    if (!w[f]) return 0;
    if (w.added.indexOf(f) >= 0) return 1;
    return w.unsure.indexOf(f) >= 0 ? 2 : 3;
  }

  // Одно и то же слово дважды (переписано ещё раз или есть и на соседней
  // странице) — одна карточка, на месте первой; каждое поле берётся оттуда,
  // где оно надёжнее — лучше всего с фото.
  function dedupe(list) {
    var out = [], seen = {};
    list.forEach(function (w) {
      var first = seen[w.hanzi];
      if (!first) {
        seen[w.hanzi] = w;
        out.push(w);
        return;
      }
      ["pinyin", "translation"].forEach(function (f) {
        if (fieldRank(w, f) <= fieldRank(first, f)) return;
        first[f] = w[f];
        ["added", "unsure"].forEach(function (k) {
          first[k] = first[k].filter(function (x) { return x !== f; });
          if (w[k].indexOf(f) >= 0) first[k].push(f);
        });
      });
      if (w._bare === false) first._bare = false;
    });
    return out;
  }

  // Страница-список (хотя бы у MIN_LISTED слов есть пиньинь или перевод):
  // иероглифы далеко в стороне от колонки слов (дальше STRAY_GAP высот
  // строки), у которых справа ничего нет, — край соседней страницы или
  // упражнение, а не слова для карточек. Строки из одних иероглифов в самой
  // колонке остаются: их пиньинь и перевод могли просто не прочитаться.
  var MIN_LISTED = 3;
  var STRAY_GAP = 4;

  function median(list) {
    var s = list.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[s.length >> 1] : 0;
  }

  function dropStray(words) {
    var listed = words.filter(function (w) { return !w._bare; });
    var out = words;
    if (listed.length >= MIN_LISTED) {
      var x = median(listed.map(function (w) { return w._x0; }));
      var h = median(listed.map(function (w) { return w._h; }));
      out = words.filter(function (w) {
        return !((w._bare || w._leadOnly) && Math.abs(w._x0 - x) > STRAY_GAP * h);
      });
    }
    out.forEach(function (w) {
      delete w._bare;
      delete w._leadOnly;
      delete w._x0;
      delete w._h;
    });
    return out;
  }

  // ------------------------------------------------- поиск кандидатов

  var RESCUE_CHAR_P = 0.3;    // знаки увереннее этого ищутся в словаре
  var RESCUE_ALT_P = 0.1;     // и запасные варианты неуверенных знаков
  var RESCUE_CHARS = 4;
  var RESCUE_MAX = 60;        // кандидатов на слово (статьи догружаются)
  var RESCUE_EACH = 15;       // из одного пересечения «знак × слог»
  var RESCUE_TOP = 15;        // запасной путь: столько самых важных слов со знаком

  // Пиньинь с фото, по которому искать: весь (без тонов) и его первый слог.
  // Сначала то, что лучше ложится в слоги.
  function pinyinKeys(item) {
    var found = [];
    item.py.concat(item.latinRu).forEach(function (p) {
      [p.zh, p.ru].forEach(function (t) {
        var s = pyNorm(t);
        if (s.length < 2) return;
        var syl = syllables(s);
        if (syl.misses > syl.count) return;          // на пиньинь не похоже
        found.push({ keys: [s, syl.first], bad: syl.misses / s.length });
      });
    });
    found.sort(function (x, y) { return x.bad - y.bad; });
    var out = [];
    found.forEach(function (f) {
      f.keys.forEach(function (k) { if (k && out.indexOf(k) < 0) out.push(k); });
    });
    return out.slice(0, 6);
  }

  function searchChars(item) {
    var out = [];
    item.chars.forEach(function (c) {
      if (HANZI.test(c.c) && c.p >= RESCUE_ALT_P) out.push(c.c);
      if (c.p < RESCUE_CHAR_P || c.composed) c.alts.forEach(function (a) { if (HANZI_START.test(a[0]) && a[1] >= RESCUE_ALT_P) out.push(a[0]); });
    });
    return out.filter(function (c, i) { return out.indexOf(c) === i; }).slice(0, RESCUE_CHARS);
  }

  function intersect(a, b) {
    var set = {};
    b.forEach(function (x) { set[x] = true; });
    return a.filter(function (x) { return set[x]; });
  }

  // Номера статей-кандидатов: слова с узнанным знаком, чьё чтение совпало с
  // пиньинем целиком или начинается с прочитанного слога (学 + xue → 学问,
  // 学习…), и слова, где есть два узнанных знака.
  function candidateIds(item, rel, py) {
    var ids = [];
    var chars = searchChars(item);
    // Из каждого пересечения — не больше RESCUE_EACH самых важных слов,
    // чтобы частый знак (人) не вытеснил кандидатов другого (认).
    function take(list) {
      ids = ids.concat(list.slice().sort(function (x, y) { return x - y; }).slice(0, RESCUE_EACH));
    }
    item.keys.forEach(function (k) {
      var hit = py[k] || { first: [], prefix: [] };
      var byPy = hit.first.concat(hit.prefix);
      chars.forEach(function (c) { take(intersect(rel[c] || [], byPy)); });
    });
    for (var i = 0; i < chars.length; i++) {
      for (var j = i + 1; j < chars.length; j++) take(intersect(rel[chars[i]] || [], rel[chars[j]] || []));
    }
    // Слог прочитан неузнаваемо («2wu» вместо zhui): самые употребительные
    // слова с узнанным знаком, выберет пиньинь целиком (追求 из 求).
    if (!ids.length) {
      chars.forEach(function (c) { ids = ids.concat((rel[c] || []).slice(0, RESCUE_TOP)); });
    }
    // Порядок — по надёжности источника (ключи пиньиня уже отсортированы).
    return ids.filter(function (x, k) { return ids.indexOf(x) === k; }).slice(0, RESCUE_MAX);
  }

  // Плохо прочитанным словам — кандидаты из словаря. Ответ: [[{ text,
  // entries }] для каждого слова] (у хорошо прочитанных — пусто).
  function rescue(items, bests) {
    var todo = items.filter(function (it, i) { return weak(it, bests[i]); });
    if (!todo.length) return Promise.resolve(items.map(function () { return []; }));
    var chars = [], keys = [];
    todo.forEach(function (it) {
      it.keys = pinyinKeys(it);
      chars = chars.concat(searchChars(it));
      keys = keys.concat(it.keys);
    });
    var D = window.DictLookup;
    return Promise.all([D.related(chars), D.pinyin(keys)]).then(function (res) {
      var per = todo.map(function (it) { return candidateIds(it, res[0], res[1]); });
      var all = [];
      per.forEach(function (ids) { all = all.concat(ids); });
      return D.entries(all).then(function (list) {
        var byId = {};
        list.forEach(function (e) { byId[e.id] = e; });
        return items.map(function (it) {
          var k = todo.indexOf(it);
          if (k < 0) return [];
          var groups = {};
          per[k].forEach(function (id) {
            var e = byId[id];
            if (!e || !HANZI.test(e[0]) || charList(e[0]).length > MAX_HANZI) return;
            (groups[e[0]] || (groups[e[0]] = [])).push(e);
          });
          return Object.keys(groups).map(function (text) { return { text: text, entries: groups[text] }; });
        });
      });
    }).catch(function (err) {
      if (window.console) console.warn("notebook-ocr: поиск кандидатов не удался", err);
      return items.map(function () { return []; });
    });
  }

  // ------------------------------------------------------------- итог

  function toWords(lines) {
    var tokens = [];
    (lines || []).forEach(function (line) {
      if (line && line.zh && line.box) tokens = tokens.concat(lineTokens(line));
    });
    var items = wordsOf(rowsOf(tokens)).map(prepare).filter(Boolean).slice(0, MAX_WORDS);
    if (!items.length) return Promise.resolve({ words: [], checked: true });
    var all = [];
    items.forEach(function (it) {
      it.variants.forEach(function (v) { all.push(v.text); });
    });
    function build(bests) {
      return dropStray(dedupe(items.map(function (it, i) {
        var w = clip(settleWord(it, bests[i]));
        w._bare = !it.py.length && !it.hasRu;
        w._leadOnly = it.leadOnly;
        w._x0 = it.x0;
        w._h = it.h;
        return w;
      })));
    }
    return window.DictLookup.exact(all).then(function (found) {
      var bests = items.map(function (it) { return pick(it, found); });
      return rescue(items, bests).then(function (extra) {
        bests = items.map(function (it, i) { return extra[i].length ? pick(it, found, extra[i]) : bests[i]; });
        return { words: build(bests), checked: true };
      });
    }, function (err) {
      if (window.console) console.warn("notebook-ocr: словарь не загрузился", err);
      return { words: build(items.map(function () { return null; })), checked: false };
    });
  }

  window.NotebookOCR = {
    read: read,
    cancel: cancel,
    supported: supported,
    _toWords: toWords      // для проверки на готовых строках
  };
})();
