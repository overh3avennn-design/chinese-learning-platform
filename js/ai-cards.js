/* Карточки по фото тетради через нейросеть (js/ai.js → воркер chinese-ai),
   а без неё — распознаванием в браузере (js/notebook-ocr.js). Вызывает
   js/photo-cards.js; подключается после js/ai.js и js/notebook-ocr.js.

   AICards.read(image, { onStatus }) → Promise({ words, via, checked })
     words — [{ hanzi, pinyin, translation, added, aiAdded, unsure, note,
     suggest }]: added — взято из словаря БКРС (распознавание в браузере),
     aiAdded — дописала нейросеть (на фото этого не было), unsure —
     прочитано неуверенно, note — замечание нейросети (что не так),
     suggest — { поле: правильный вариант } для кнопки «Исправить».
     via — "ai" (фото прочитала нейросеть), "mixed" (часть полос — в
     браузере), "local" (всё в браузере). checked — слова проверены
     нейросетью (или, без неё, словарём).
     onStatus({ stage, done, total }) — "ai-read" (полосы), "ai-check",
     и стадии js/notebook-ocr.js при распознавании в браузере.
   AICards.cancel() — остановить.

   Как идёт работа:
   1. Сервер ИИ отвечает (AI.reachable)? Нет — всё в браузере, как раньше.
   2. Фото режется на горизонтальные полосы с перекрытием — каждая не больше
      MAX_PIXELS: картинки крупнее поставщик Qwen у Polza не успевает
      обработать (ошибка 520 через 40 с). Полосы читаются одновременно,
      нейросеть переписывает их как есть (задача notebook-cards).
   3. Полосы, которые не прочитались, распознаются в браузере; не
      прочиталась ни одна — вся страница в браузере.
   4. Слова из полос объединяются (перекрытия дают повторы), и нейросеть
      проверяет их отдельным текстовым запросом (check-cards): дописывает
      пустые поля (например, иероглифы по пиньиню и переводу), похожее на
      правду оставляет, явные ошибки отмечает замечанием и вариантом. */
(function () {
  "use strict";

  var STRIP_WIDTH = 640;        // ширина полосы, точек
  var MAX_PIXELS = 220000;      // точек в полосе: больше Polza не успевает
  var OVERLAP = 0.25;           // доля высоты полосы, общая с соседней
  var MAX_STRIPS = 6;
  var QUALITY = 0.85;
  // Polza отвечает неровно: обычно за 6–11 с, но бывает 40–55 с или ошибка
  // 520 на 40-й секунде. Поэтому полоса, не пришедшая за HEDGE_AFTER,
  // отправляется ещё раз — уменьшенной, и берётся первый ответ.
  var READ_TIMEOUT = 60000;
  var HEDGE_AFTER = 18000;
  var HEDGE_TIMEOUT = 45000;
  var HEDGE_SCALE = 0.8;
  var CHECK_TIMEOUT = 95000;
  var CHECK_BATCH = 40;         // слов в одном запросе проверки (предел воркера)
  var REACH_TIMEOUT = 8000;     // сервер ИИ отвечает? (через VPN бывает медленно)
  var FIELDS = ["hanzi", "pinyin", "translation"];

  var run = null;               // { ctrl, stopped } — текущая работа

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  // ------------------------------------------------------------- полосы

  // Фото → полосы во всю ширину сверху вниз: { canvas, url }. Высота полосы
  // такая, чтобы в ней было не больше MAX_PIXELS точек.
  function strips(image) {
    var w0 = image.naturalWidth || image.width;
    var h0 = image.naturalHeight || image.height;
    if (!w0 || !h0) return [];
    var width = Math.min(STRIP_WIDTH, w0);
    var stripH = Math.floor(MAX_PIXELS / width);
    var fullH = Math.round(h0 * width / w0);
    var step = Math.max(1, Math.floor(stripH * (1 - OVERLAP)));
    var count = fullH <= stripH ? 1 : Math.ceil((fullH - stripH) / step) + 1;
    // Очень длинное фото (скриншот) — уже, чтобы полос было не больше MAX_STRIPS.
    if (count > MAX_STRIPS) {
      var k = (stripH + (MAX_STRIPS - 1) * step) / fullH;
      width = Math.max(320, Math.floor(width * k));
      stripH = Math.floor(MAX_PIXELS / width);
      fullH = Math.round(h0 * width / w0);
      step = Math.max(1, Math.floor(stripH * (1 - OVERLAP)));
      count = fullH <= stripH ? 1 : Math.min(MAX_STRIPS, Math.ceil((fullH - stripH) / step) + 1);
    }
    var out = [];
    for (var i = 0; i < count; i++) {
      var top = i === count - 1 ? Math.max(0, fullH - stripH) : i * step;
      var h = Math.min(stripH, fullH - top);
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, h);
      ctx.imageSmoothingQuality = "high";
      // Кусок исходного фото с той же долей высоты.
      ctx.drawImage(image, 0, top * h0 / fullH, w0, h * h0 / fullH, 0, 0, width, h);
      out.push({ canvas: canvas, url: canvas.toDataURL("image/jpeg", QUALITY) });
    }
    return out;
  }

  // Первый успешный из двух запросов: main сразу, spare — если main не
  // ответил за HEDGE_AFTER или упал раньше. Оба упали — ошибка main.
  function hedged(main, spare) {
    return new Promise(function (resolve, reject) {
      var failed = 0, started = 1, firstErr = null, settled = false, timer;
      function ok(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
      function bad(err) {
        if (settled) return;
        if (err && err.code === "aborted") {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        if (!firstErr) firstErr = err;
        failed++;
        if (started === 1) startSpare();
        else if (failed >= 2) {
          settled = true;
          reject(firstErr);
        }
      }
      function startSpare() {
        if (started > 1 || settled) return;
        started = 2;
        clearTimeout(timer);
        try {
          spare().then(ok, bad);
        } catch (e) {
          bad(e);
        }
      }
      main().then(ok, bad);
      timer = setTimeout(startSpare, HEDGE_AFTER);
    });
  }

  // Полоса поменьше (для повтора) — data:-адрес JPEG.
  function shrink(canvas, k) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(canvas.width * k));
    c.height = Math.max(1, Math.round(canvas.height * k));
    var ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", QUALITY);
  }

  // ----------------------------------------------------------- слова

  function bare(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z]/g, "");
  }

  function key(w) {
    return w.hanzi ? "h:" + w.hanzi : "p:" + bare(w.pinyin);
  }

  function filled(w) {
    return FIELDS.filter(function (f) { return w[f]; }).length;
  }

  // Похожесть строк 0…1 по расстоянию Левенштейна.
  function similar(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    var prev = [], cur, i, j;
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

  // Одна и та же строка, прочитанная в двух соседних полосах по-разному
  // (巷子 «переулок» и 样子 «персона»): иероглифов столько же, хоть один
  // совпал на своём месте, и похожи пиньинь или перевод.
  function sameLine(a, b) {
    if (key(a) === key(b)) return true;
    var ha = Array.from(a.hanzi), hb = Array.from(b.hanzi);
    if (!ha.length || ha.length !== hb.length) return false;
    var common = ha.some(function (c, i) { return c === hb[i]; });
    return common && (similar(bare(a.pinyin), bare(b.pinyin)) >= 0.6 ||
      similar(a.translation.toLowerCase(), b.translation.toLowerCase()) >= 0.6);
  }

  // Насколько прочтение надёжно: заполненные поля, минус неуверенные, плюс
  // удалённость от края полосы (у края строка бывает срезана).
  function quality(w) {
    return 2 * filled(w) - (w.unsure ? w.unsure.length : 0) + w._central;
  }

  // Слова всех полос по порядку, без повторов из перекрытий. Из двух
  // прочтений одной строки — более надёжное. Повторы ищутся среди
  // последних слов предыдущей полосы и первых слов следующей (перекрытие —
  // четверть высоты полосы) и точные — по всей странице.
  function merge(lists) {
    var out = [], index = {};
    lists.forEach(function (list, s) {
      var n = list.length;
      list.forEach(function (w, i) {
        if (!w.hanzi && !bare(w.pinyin)) return;
        // Ближе к середине полосы — надёжнее (0…1).
        w._central = n > 1 ? Math.min(i, n - 1 - i) / ((n - 1) / 2) : 1;
        w._strip = s;
        var k = key(w);
        var at = index[k];
        if (at === undefined && s > 0 && i < Math.ceil(n * 0.5)) {
          for (var j = out.length - 1; j >= 0 && out[j]._strip >= s - 1; j--) {
            if (out[j]._strip === s - 1 && sameLine(out[j], w)) {
              at = j;
              break;
            }
          }
        }
        if (at === undefined) {
          index[k] = out.length;
          out.push(w);
        } else if (quality(w) > quality(out[at])) {
          index[k] = at;
          out[at] = w;
        }
      });
    });
    out.forEach(function (w) {
      delete w._central;
      delete w._strip;
    });
    return out;
  }

  // ------------------------------------------------------------ чтение

  function stopped() {
    if (!run || run.stopped) throw fail("aborted", "Распознавание остановлено.");
  }

  function ask(task, data, timeout) {
    return window.AI.ask(task, data, { signal: run.ctrl ? run.ctrl.signal : undefined, timeout: timeout });
  }

  // Слово нейросети с фото → общий вид. added в ответе — поля, которые
  // нейросеть дописала сама (так отвечал воркер до задачи check-cards).
  function fromAI(w) {
    return {
      hanzi: w.hanzi || "",
      pinyin: w.pinyin || "",
      translation: w.translation || "",
      added: [],
      aiAdded: Array.isArray(w.added) ? w.added.slice() : [],
      unsure: Array.isArray(w.unsure) ? w.unsure.slice() : []
    };
  }

  // Слово распознавания в браузере → общий вид (added — из словаря).
  function fromLocal(w) {
    return {
      hanzi: w.hanzi || "",
      pinyin: w.pinyin || "",
      translation: w.translation || "",
      added: (w.added || []).slice(),
      unsure: (w.unsure || []).slice()
    };
  }

  function local(image, status) {
    return window.NotebookOCR.read(image, { onStatus: status }).then(function (res) {
      return { words: res.words.map(fromLocal), checked: res.checked };
    });
  }

  // Полосы → нейросеть одновременно; не прочитанные — в браузере по одной
  // (распознаватель в браузере работает с одной картинкой за раз).
  function readStrips(image, status) {
    var parts = strips(image);
    if (!parts.length) return Promise.reject(fail("image", "Не получилось открыть фото."));
    var done = 0;
    status({ stage: "ai-read", done: 0, total: parts.length });
    function once(url, timeout) {
      return ask("notebook-cards", { image: url }, timeout).then(function (res) {
        return { ok: true, words: (res && res.words || []).map(fromAI) };
      });
    }
    return Promise.all(parts.map(function (part) {
      return hedged(function () { return once(part.url, READ_TIMEOUT); },
        function () { return once(shrink(part.canvas, HEDGE_SCALE), HEDGE_TIMEOUT); }
      ).then(function (r) {
        status({ stage: "ai-read", done: ++done, total: parts.length });
        return r;
      }, function (err) {
        if (err.code === "aborted") throw err;
        if (window.console) console.warn("ai-cards: полоса не прочиталась", err.code, err.message);
        return { ok: false };
      });
    })).then(function (results) {
      stopped();
      var bad = results.filter(function (r) { return !r.ok; }).length;
      if (bad === results.length) {
        return local(image, status).then(function (res) {
          return { words: res.words, via: "local", localChecked: res.checked };
        });
      }
      var chain = Promise.resolve();
      results.forEach(function (r, i) {
        if (r.ok) return;
        chain = chain.then(function () {
          stopped();
          return local(parts[i].canvas, status).then(function (res) { r.words = res.words; }, function (err) {
            if (err.code === "aborted") throw err;
            r.words = [];                  // эту полосу не прочитать — допишет ученик
          });
        });
      });
      return chain.then(function () {
        return { words: merge(results.map(function (r) { return r.words || []; })), via: bad ? "mixed" : "ai" };
      });
    });
  }

  // ---------------------------------------------------------- проверка

  // Слова → нейросеть частями по CHECK_BATCH. Ответ — проверенные слова
  // по порядку; часть не проверилась — её слова как были (checked: false).
  function check(words, status) {
    status({ stage: "ai-check" });
    var batches = [];
    for (var i = 0; i < words.length; i += CHECK_BATCH) batches.push(words.slice(i, i + CHECK_BATCH));
    var allOk = true;
    return Promise.all(batches.map(function (batch) {
      var data = batch.map(function (w) {
        return { hanzi: w.hanzi, pinyin: w.pinyin, translation: w.translation, unsure: w.unsure };
      });
      return ask("check-cards", { words: data }, CHECK_TIMEOUT).then(function (res) {
        var got = res && res.words || [];
        if (!(res && res.checked >= batch.length)) allOk = false;
        return batch.map(function (w, k) { return withCheck(w, got[k]); });
      }, function (err) {
        if (err.code === "aborted") throw err;
        if (window.console) console.warn("ai-cards: проверка не удалась", err.code, err.message);
        allOk = false;
        return batch;
      });
    })).then(function (parts) {
      var out = [];
      parts.forEach(function (p) { out = out.concat(p); });
      return { words: out, checked: allOk };
    });
  }

  // Слово + ответ проверки: дописанное нейросетью (aiAdded), замечание и
  // варианты. Поле с вариантом — под сомнением.
  function withCheck(w, c) {
    if (!c) return w;
    var out = {
      hanzi: w.hanzi,
      pinyin: w.pinyin,
      translation: w.translation,
      added: w.added.slice(),
      aiAdded: (w.aiAdded || []).slice(),
      unsure: w.unsure.slice(),
      note: c.note || "",
      suggest: {}
    };
    FIELDS.forEach(function (f) {
      if (!out[f] && c[f]) {
        out[f] = c[f];
        out.aiAdded.push(f);
      }
      if (c.suggest && c.suggest[f] && c.suggest[f] !== out[f]) {
        out.suggest[f] = c.suggest[f];
        if (out.unsure.indexOf(f) < 0) out.unsure.push(f);
      }
    });
    // В тетради был только пиньинь: иероглифы — догадка по звучанию, а у
    // китайских слов много омофонов.
    if (out.aiAdded.indexOf("hanzi") >= 0 && !w.translation) {
      if (out.unsure.indexOf("hanzi") < 0) out.unsure.push("hanzi");
      if (!out.note) out.note = "Слово угадано только по пиньиню — сверьте с тетрадью.";
    }
    return out;
  }

  // Общий вид для js/photo-cards.js: у каждого слова все поля.
  function finish(w) {
    return {
      hanzi: w.hanzi,
      pinyin: w.pinyin,
      translation: w.translation,
      added: w.added || [],
      aiAdded: w.aiAdded || [],
      unsure: w.unsure || [],
      note: w.note || "",
      suggest: w.suggest || {}
    };
  }

  // ---------------------------------------------------------------- итог

  function cancel() {
    if (!run) return;
    run.stopped = true;
    if (run.ctrl) run.ctrl.abort();
    run = null;
    window.NotebookOCR.cancel();
  }

  function read(image, opts) {
    opts = opts || {};
    var status = typeof opts.onStatus === "function" ? opts.onStatus : function () {};
    cancel();
    var me = run = { ctrl: window.AbortController ? new AbortController() : null, stopped: false };
    function mine(fn) {
      return function (x) {
        if (run !== me || me.stopped) throw fail("aborted", "Распознавание остановлено.");
        return fn(x);
      };
    }
    var reachable = window.AI && window.AI.reachable ? window.AI.reachable(REACH_TIMEOUT) : Promise.resolve(false);
    return reachable.then(mine(function (ok) {
      // Без ИИ — как раньше: в браузере, со сверкой по словарю.
      if (!ok) {
        return local(image, status).then(mine(function (res) {
          return { words: res.words.map(finish), via: "local", checked: res.checked };
        }));
      }
      return readStrips(image, status).then(mine(function (res) {
        // Нейросеть не нашла ни слова — бывает и сбой, поэтому второе
        // мнение распознавания в браузере (если оно тут работает).
        if (!res.words.length && res.via !== "local" && window.NotebookOCR.supported()) {
          return local(image, status).then(function (l) {
            return { words: l.words, via: "local", localChecked: l.checked };
          });
        }
        return res;
      })).then(mine(function (res) {
        if (!res.words.length) return { words: [], via: res.via, checked: true };
        return check(res.words, status).then(mine(function (c) {
          return { words: c.words.map(finish), via: res.via, checked: c.checked || !!res.localChecked };
        }));
      }));
    })).then(function (result) {
      if (run === me) run = null;
      return result;
    }, function (err) {
      if (run === me) run = null;
      throw err;
    });
  }

  window.AICards = { read: read, cancel: cancel, _strips: strips, _merge: merge };
})();
