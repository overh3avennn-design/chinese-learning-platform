/* Раздел «Словарь»: поиск по китайско-русскому словарю 大БКРС.

   Данные — в отдельном репозитории chinese-dictionary-data со своим GitHub
   Pages: meta.json с каталогами и тысячи маленьких JSON-файлов статей и
   индексов (как они устроены — README.md и build/build.py там же). На
   запрос страница грузит один файл индекса и файлы статей, где лежат
   первые результаты, — по мобильному интернету это 1–2 секунды.

   Номер статьи (ID) — её место по важности: слова HSK, потом частые слова,
   в конце редкие термины. Поэтому внутри группы результаты идут по ID. */
(function () {
  "use strict";

  var root = document.querySelector("[data-dictionary]");
  if (!root) return;

  // Тот же адрес *.github.io, что у сайта, — запросы не уходят на чужой
  // домен. Локальный сервер, который отдаёт оба репозитория рядом, как
  // Pages, отдаёт и данные.
  var DATA_URL = "https://overh3avennn-design.github.io/chinese-dictionary-data/";
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    DATA_URL = location.origin + "/chinese-dictionary-data/";
  }
  var FIRST_PAGE = 10;      // столько результатов показывается сразу…
  var FIRST_BATCH = 4;      // …из них столько — первой порцией
  var MORE_PAGE = 20;       // столько добавляет «Показать ещё»
  var TYPE_DELAY = 400;     // пауза в наборе, после которой начинается поиск
  var LINES_SHOWN = 6;      // строк длинной статьи видно до «Показать всю статью»
  var FORMS_MAX = 300;      // сколько форм русского слова (дом → дома, домашний…) брать
  var FETCH_TIMEOUT = 10000; // запрос, молчащий дольше, обрывается и повторяется
  var FETCH_TRIES = 3;      // всего попыток на файл

  var VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\ud840-\ud8bf][\udc00-\udfff]/;
  var CJK_START = /^(?:[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\ud840-\ud8bf][\udc00-\udfff])/;
  var CYRILLIC = /[а-яё]/i;
  // Те же служебные слова, что в build.py: у них в индексе только точные
  // совпадения, поэтому во фразе по ним не ищем.
  var STOPWORDS = toSet("а без бы был была были было быть в во вот все всё всего вы где да для до его ее её ей ему если есть еще ещё же за и из или им их к как ко когда кого который которая которое которые кто ли либо между мы на над не него нее неё нет ни них но о об обо однако он она они оно от по под при про с со так также там то тоже тот ты у уже чем что чтобы чьё чей эта эти это этот я");

  var form = root.querySelector("[data-dict-form]");
  var input = root.querySelector("[data-dict-input]");
  var statusEl = root.querySelector("[data-dict-status]");
  var resultsEl = root.querySelector("[data-dict-results]");
  var moreBtn = root.querySelector("[data-dict-more]");

  // ---------------------------------------------------------------- данные

  var meta = null;
  var metaPromise = null;
  var files = {};

  function toSet(words) {
    var set = {};
    words.split(" ").forEach(function (w) { set[w] = true; });
    return set;
  }

  function json(response) {
    if (!response.ok) {
      var err = new Error("HTTP " + response.status);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  // Мобильная сеть рвёт соединения и подвешивает запросы: зависший запрос
  // обрывается через FETCH_TIMEOUT, оборванный повторяется. Ответ сервера
  // с ошибкой (404 после обновления словаря) не повторяется.
  function getJSON(url, options, triesLeft) {
    if (triesLeft === undefined) triesLeft = FETCH_TRIES - 1;
    var opts = {}, key;
    for (key in options) opts[key] = options[key];
    var ctrl = window.AbortController ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : null;
    return fetch(url, opts).then(json).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (err) {
      clearTimeout(timer);
      if (err.status || triesLeft <= 0) throw err;
      return new Promise(function (resolve) { setTimeout(resolve, 600); }).then(function () {
        return getJSON(url, options, triesLeft - 1);
      });
    });
  }

  // fresh — мимо кэша браузера: после обновления словаря старый meta.json
  // (Pages держит его в кэше 10 минут) ссылается на удалённую версию.
  function loadMeta(fresh) {
    if (!metaPromise || fresh) {
      metaPromise = getJSON(DATA_URL + "meta.json", fresh ? { cache: "reload" } : {})
        .then(function (m) {
          m.ends = decode(m.e);
          meta = m;
          files = {};
          return m;
        });
      metaPromise.catch(function () { metaPromise = null; });
    }
    return metaPromise;
  }

  // Один запрос на файл, даже если он нужен нескольким результатам сразу.
  function load(path, parse) {
    if (!files[path]) {
      var p = getJSON(DATA_URL + meta.base + path);
      if (parse) p = p.then(parse);
      files[path] = p;
      p.catch(function () { if (files[path] === p) delete files[path]; });
    }
    return files[path];
  }

  // Возрастающий список номеров: первый и разности, по 5 бит на символ,
  // младшие вперёд, бит 32 — «дальше ещё» (vlq() в build.py).
  function decode(s) {
    var out = [], prev = 0, n = 0, shift = 0;
    for (var i = 0; s && i < s.length; i++) {
      var v = VLQ.indexOf(s.charAt(i));
      n += (v & 31) << shift;
      if (v & 32) {
        shift += 5;
      } else {
        prev += n;
        out.push(prev);
        n = 0;
        shift = 0;
      }
    }
    return out;
  }

  // Файл индекса — массив строк «<общее начало с предыдущим ключом, 0–9>
  // <остаток ключа>|список|список…».
  function parseShard(records) {
    var keys = [], fields = [], prev = "";
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var bar = rec.indexOf("|", 1);
      var key = prev.slice(0, rec.charCodeAt(0) - 48) + (bar < 0 ? rec.slice(1) : rec.slice(1, bar));
      keys.push(key);
      fields.push(bar < 0 ? [] : rec.slice(bar + 1).split("|"));
      prev = key;
    }
    return { keys: keys, fields: fields };
  }

  function shard(kind, q) {
    var firsts = meta[kind];
    var lo = 0, hi = firsts.length - 1, n = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (firsts[mid] <= q) {
        n = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return load(kind + "/" + n + ".json", parseShard);
  }

  // Первый индекс, где keys[i] >= q.
  function lowerBound(keys, q) {
    var lo = 0, hi = keys.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (keys[mid] < q) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function entry(id) {
    var ends = meta.ends, lo = 0, hi = ends.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ends[mid] > id) hi = mid;
      else lo = mid + 1;
    }
    var start = lo ? ends[lo - 1] : 0;
    return load("e/" + lo + ".json").then(function (list) { return list[id - start]; });
  }

  // Списки номеров → один возрастающий без повторов и без exclude.
  function merge(lists, exclude) {
    var seen = {}, out = [];
    (exclude || []).forEach(function (id) { seen[id] = true; });
    lists.forEach(function (list) {
      list.forEach(function (id) {
        if (!seen[id]) {
          seen[id] = true;
          out.push(id);
        }
      });
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // Точные — по порядку списков (сначала главные значения), без повторов.
  function concat(lists) {
    var seen = {}, out = [];
    lists.forEach(function (list) {
      list.forEach(function (id) {
        if (!seen[id]) {
          seen[id] = true;
          out.push(id);
        }
      });
    });
    return out;
  }

  // --------------------------------------------------------------- пиньинь

  var TONE_MARKS = { "̄": 1, "́": 2, "̌": 3, "̀": 4 };
  var VOWELS = "aeiouv";

  // «shuǐguǒ», «Shuǐ guǒ», «shui3guo3» → «shui3guo3». Повторяет
  // pinyin_key() из build.py — менять обе вместе.
  function pinyinKey(text) {
    var letters = [], tones = [], digits = {}, breaks = {};
    var chars = text.toLowerCase().normalize("NFD");
    for (var c = 0; c < chars.length; c++) {
      var ch = chars.charAt(c);
      if (ch >= "a" && ch <= "z") {
        letters.push(ch);
        tones.push(0);
      } else if (TONE_MARKS[ch]) {
        if (letters.length) tones[tones.length - 1] = TONE_MARKS[ch];
      } else if (ch === "̈" || ch === ":") {
        if (letters.length && letters[letters.length - 1] === "u") letters[letters.length - 1] = "v";
      } else if (ch >= "1" && ch <= "5") {
        if (letters.length) digits[letters.length] = +ch;
        breaks[letters.length] = true;
      } else {
        breaks[letters.length] = true;
      }
    }
    var n = letters.length;
    function joined(i) { return i < n && !breaks[i]; }
    function vowelAt(i) { return joined(i) && VOWELS.indexOf(letters[i]) >= 0; }
    var lastEnd = 0;
    for (var k = 0; k < n; k++) {
      if (!tones[k]) continue;
      var j = k + 1;
      if (joined(j) && "iou".indexOf(letters[j]) >= 0 && !tones[j]) j++;
      if (joined(j)) {
        if (letters[j] === "n") {
          if (joined(j + 1) && letters[j + 1] === "g" && !vowelAt(j + 2)) j += 2;
          else if (!vowelAt(j + 1)) j += 1;
        } else if (letters[j] === "r" && j === k + 1 && letters[k] === "e" &&
                   (k === lastEnd || breaks[k]) && !vowelAt(j + 1)) {
          j += 1;
        }
      }
      if (!(j in digits)) digits[j] = tones[k];
      lastEnd = j;
    }
    var out = "";
    for (var i = 0; i < n; i++) {
      out += letters[i];
      if (digits[i + 1] && digits[i + 1] < 5) out += digits[i + 1];
    }
    return out;
  }

  function plain(key) {
    return key.replace(/\d/g, "");
  }

  // Тона ключа: { позиция в ключе без тонов: цифра }.
  function toneMap(key) {
    var map = {}, n = 0;
    for (var i = 0; i < key.length; i++) {
      var ch = key.charAt(i);
      if (ch >= "0" && ch <= "9") map[n] = ch;
      else n++;
    }
    return map;
  }

  // Тона, которые указаны в запросе, совпадают с тонами ключа; не
  // указанные (shui3guo) подходят любые.
  function tonesFit(queryTones, key) {
    var keyTones = toneMap(key);
    for (var pos in queryTones) {
      if (keyTones[pos] !== queryTones[pos]) return false;
    }
    return true;
  }

  // Ключи чтений статьи — как clean_pinyin() в build.py.
  function entryPinyinKeys(pinyin) {
    var text = pinyin.replace(/\[(p|i)\][\s\S]*?\[\/\1\]/g, " ").replace(/\([^()]*\)/g, " ");
    return text.split(/[,;\/]/).map(pinyinKey).filter(Boolean);
  }

  // ------------------------------------------------------------------ поиск

  // Каждый поиск отдаёт список кандидатов по порядку показа: { id, group }
  // (0 — точные, 1 — частичные) или с функцией group(статья), если группа
  // (или то, подходит ли статья вообще: −1) видна только по самой статье.

  function candidates(exact, partial) {
    return exact.map(function (id) { return { id: id, group: 0 }; })
      .concat(partial.map(function (id) { return { id: id, group: 1 }; }));
  }

  function searchHanzi(q) {
    return shard("zh", q).then(function (s) {
      var i = lowerBound(s.keys, q);
      var exact = [], inside = [];
      if (s.keys[i] === q) {
        exact = decode(s.fields[i][0]);
        inside = decode(s.fields[i][1]);
        i++;
      }
      // Слова, которые начинаются с запроса, стоят в индексе подряд.
      var starts = [];
      for (; i < s.keys.length && s.keys[i].indexOf(q) === 0; i++) starts.push(decode(s.fields[i][0])[0]);
      return candidates(exact, merge([inside, starts], exact));
    });
  }

  function searchPinyin(q) {
    var key = pinyinKey(q);
    if (!key) return Promise.resolve([]);
    var base = plain(key);
    var toned = base !== key;
    var queryTones = toneMap(key);
    return shard("py", base).then(function (s) {
      if (!s.plains) s.plains = s.keys.map(plain);
      var first = [], other = [], longer = [], range = [], n = 0;
      var i = lowerBound(s.plains, base);
      for (; i < s.keys.length && s.plains[i].indexOf(base) === 0 && n < FORMS_MAX; i++) {
        var f = s.fields[i];
        var fits = !toned || tonesFit(queryTones, s.keys[i]);
        if (s.plains[i] === base) {
          if (f[2]) longer = decode(f[2]);
          if (fits) {
            first.push(decode(f[0]));
            other.push(decode(f[1]));
          }
        } else {
          n++;
          if (fits) range.push(decode(f[0]), decode(f[1]));
        }
      }
      // Все слова, которые начинаются так же, оказались в этом файле
      // (и уже проверены по тонам) — готовый список «начинаются так же»
      // не нужен. Он выручает, когда их больше, чем видно здесь (shi, a).
      var complete = n < FORMS_MAX && i < s.keys.length;
      if (complete) longer = [];
      // Сначала основное чтение; у слов HSK и второе (谁 — shéi и shuí)
      // идёт вместе с основными, у редких слов — после них.
      var otherIds = merge(other);
      var hsk = meta.hsk || 0;
      var exact = concat([
        merge(first.concat([otherIds.filter(function (id) { return id < hsk; })])),
        otherIds
      ]);
      var checked = merge(range);
      var list = candidates(exact, merge([longer, checked], exact));
      if (toned && longer.length) {
        // Готовый список «начинаются так же» собран без учёта тонов — у
        // того, чего нет среди проверенных, тона проверяются по статье.
        list.forEach(function (c) {
          if (c.group !== 1 || binaryHas(checked, c.id)) return;
          c.group = function (e) {
            return entryPinyinKeys(e[1]).some(function (k) {
              return plain(k).indexOf(base) === 0 && tonesFit(queryTones, k);
            }) ? 1 : -1;
          };
        });
      }
      return list;
    });
  }

  function ruNorm(text) {
    return text.toLowerCase().replace(/ё/g, "е");
  }

  function searchRussian(q) {
    var words = ruNorm(q).match(/[а-я]+/g) || [];
    if (words.length === 1) return searchRussianWord(words[0]);
    var terms = words.filter(function (w) { return w.length > 1 && !STOPWORDS[w]; });
    if (!terms.length) terms = words;
    return searchRussianPhrase(words.join(" "), terms);
  }

  function searchRussianWord(w) {
    return shard("ru", w).then(function (s) {
      var i = lowerBound(s.keys, w);
      var main = [], exact = [], inText = [];
      if (s.keys[i] === w) {
        main = decode(s.fields[i][0]);
        exact = decode(s.fields[i][1]);
        inText = decode(s.fields[i][2]);
        i++;
      }
      // Другие слова с тем же началом: дом → дома, домашний.
      var forms = [];
      for (var n = 0; i < s.keys.length && s.keys[i].indexOf(w) === 0 && n < FORMS_MAX; i++, n++) {
        s.fields[i].forEach(function (f) { forms.push(decode(f)); });
      }
      var top = concat([main, exact]);
      return candidates(top, merge([inText], top).concat(merge(forms, top.concat(inText))));
    });
  }

  // Фраза: статьи, где есть все слова; точная — если фраза целиком одно из
  // значений перевода.
  function searchRussianPhrase(phrase, terms) {
    return Promise.all(terms.map(function (w) {
      return shard("ru", w).then(function (s) {
        var i = lowerBound(s.keys, w);
        return s.keys[i] === w ? merge(s.fields[i].map(decode)) : [];
      });
    })).then(function (lists) {
      lists.sort(function (a, b) { return a.length - b.length; });
      var ids = lists[0].filter(function (id) {
        return lists.every(function (list) { return binaryHas(list, id); });
      });
      return ids.map(function (id) {
        return { id: id, group: function (e) { return glosses(e[2]).indexOf(phrase) >= 0 ? 0 : 1; } };
      });
    });
  }

  function binaryHas(list, id) {
    var i = lowerBound(list, id);
    return list[i] === id;
  }

  // Значения перевода — как russian_terms() в build.py.
  function glosses(text) {
    var t = ruNorm(text.replace(/\[(p|i)\][\s\S]*?\[\/\1\]/g, " "));
    t = t.replace(/\([^()]*\)/g, " ").replace(/\([^()]*\)/g, " ");
    return t.split(/[;,:\n]/).map(function (g) {
      return g.replace(/^(?:\s*(?:\d+|[а-яa-z]|[ivx]+)[).]\s*)+/, "")
        .replace(/^[\s.!?…\-—–"'«»“”„]+|[\s.!?…\-—–"'«»“”„]+$/g, "")
        .replace(/\s+/g, " ");
    });
  }

  function search(q) {
    if (CJK.test(q)) return searchHanzi(q);
    if (CYRILLIC.test(q)) return searchRussian(q);
    return searchPinyin(q);
  }

  // ----------------------------------------------------------------- показ

  var run = 0;            // номер текущего поиска: ответы старых отбрасываются
  var queue = [];         // кандидаты, которые ещё не показаны
  var groups = [];        // [{ section, list }] — «Точные» и «Частичные»
  var shownQuery = null;
  var typeTimer = null;
  var statusTimer = null;

  function setStatus(text, isError) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.classList.toggle("is-error", !!isError);
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // [p]…[/p] — пометка (гл., см., уст.), [i]…[/i] — комментарий курсивом.
  // Иероглифы после «см.» — ссылка на поиск этого слова.
  function markup(text) {
    return esc(text)
      .replace(/\[p\]/g, '<span class="dict-label">').replace(/\[\/p\]/g, "</span>")
      .replace(/\[i\]/g, '<i class="dict-note">').replace(/\[\/i\]/g, "</i>")
      .replace(/(<span class="dict-label">(?:см\.|то же, что)<\/span>\s*)((?:[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\ud840-\ud8bf][\udc00-\udfff])+)/g,
        function (all, label, word) {
          return label + '<a class="dict-ref" href="?q=' + encodeURIComponent(word) + '" lang="zh-CN">' + word + "</a>";
        });
  }

  function plural(n, forms) {
    var d = n % 10, h = n % 100;
    if (d === 1 && h !== 11) return forms[0];
    if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return forms[1];
    return forms[2];
  }

  // Строка примера: китайская фраза и перевод («煮水 кипятить воду»).
  // Фраза выделяется цветом иероглифов.
  function line(text, extra) {
    var cls = "dict-line" + (extra ? " is-extra" : "");
    if (CJK_START.test(text) && CYRILLIC.test(text)) {
      var cut = text.search(CYRILLIC);
      var lead = text.slice(0, cut);
      // Пометка или скобка, в которой начался перевод, остаётся с ним.
      var mark = lead.search(/\[(p|i)\]|[(（][^)）]*$/);
      if (mark > 0) cut = mark;
      return '<p class="' + cls + ' dict-ex"><span class="dict-ex-zh" lang="zh-CN">' +
        markup(text.slice(0, cut).replace(/[\s\-—–:]+$/, "")) + "</span> " + markup(text.slice(cut).trim()) + "</p>";
    }
    return '<p class="' + cls + '">' + markup(text) + "</p>";
  }

  function renderEntry(e) {
    var li = document.createElement("li");
    li.className = "dict-entry";
    var lines = e[2] ? e[2].split("\n") : [];
    var collapsed = lines.length > LINES_SHOWN + 1;
    var html = '<div class="dict-head"><span class="dict-hanzi" lang="zh-CN">' + esc(e[0]) + "</span>" +
      (e[1] ? '<span class="dict-pinyin">' + markup(e[1]) + "</span>" : "") + "</div>" +
      '<div class="dict-text">' + lines.map(function (t, i) { return line(t, collapsed && i >= LINES_SHOWN); }).join("") + "</div>";
    if (collapsed) {
      var rest = lines.length - LINES_SHOWN;
      html += '<button class="dict-toggle" type="button" aria-expanded="false" data-more="Показать всю статью · ещё ' +
        rest + " " + plural(rest, ["строка", "строки", "строк"]) + '">Показать всю статью · ещё ' + rest + " " +
        plural(rest, ["строка", "строки", "строк"]) + "</button>";
    }
    li.innerHTML = html;
    return li;
  }

  function group(n) {
    if (!groups[n]) {
      var section = document.createElement("section");
      section.className = "dict-group";
      section.innerHTML = '<h2 class="dict-group-title">' + (n ? "Частичные совпадения" : "Точные совпадения") +
        '</h2><ol class="dict-list"></ol>';
      // «Точные» всегда выше «Частичных», даже если появились позже.
      if (n === 0 && groups[1]) resultsEl.insertBefore(section, groups[1].section);
      else resultsEl.appendChild(section);
      groups[n] = { section: section, list: section.querySelector("ol") };
    }
    return groups[n].list;
  }

  // Показывает следующие count кандидатов. Кандидаты, у которых группа
  // видна только по статье, проверяются после загрузки; не подошедшие
  // заменяются следующими.
  function showNext(count, token) {
    var batch = queue.splice(0, count);
    moreBtn.hidden = true;
    return Promise.all(batch.map(function (c) { return entry(c.id); })).catch(function (err) {
      // Не загрузилось — кандидаты возвращаются в очередь, и «Показать
      // ещё» попробует снова.
      if (token === run) {
        queue = batch.concat(queue);
        moreBtn.hidden = false;
      }
      throw err;
    }).then(function (list) {
      if (token !== run) return;
      var shown = 0;
      list.forEach(function (e, k) {
        if (!e) return;
        var g = batch[k].group;
        if (typeof g === "function") g = g(e);
        if (g < 0) return;
        group(g).appendChild(renderEntry(e));
        shown++;
      });
      if (shown < count && queue.length) return showNext(count - shown, token);
      moreBtn.hidden = !queue.length;
      if (!groups[0] && !groups[1]) {
        setStatus("Ничего не нашлось. Попробуйте пиньинь без тонов, другую форму русского слова или меньше иероглифов.");
      }
    });
  }

  function start(q, fresh) {
    q = q.trim().replace(/\s+/g, " ");
    clearTimeout(typeTimer);
    if (q === shownQuery && !fresh) return;
    shownQuery = q;
    var token = ++run;
    queue = [];
    groups = [];
    resultsEl.innerHTML = "";
    moreBtn.hidden = true;
    var url = q ? "?q=" + encodeURIComponent(q) : location.pathname;
    if (url !== location.search) history.replaceState(null, "", url);
    if (!q) {
      setStatus("");
      return;
    }
    setStatus("");
    // «Ищу…» — только если поиск затянулся, чтобы строка не мигала.
    statusTimer = setTimeout(function () { if (token === run) setStatus("Ищу…"); }, 250);
    loadMeta(fresh)
      .then(function () { return search(q); })
      .then(function (list) {
        if (token !== run) return;
        queue = list;
        // Сначала статьи первых результатов, потом остальных: по
        // медленному интернету первые появляются заметно раньше.
        return showNext(FIRST_BATCH, token).then(function () {
          if (token !== run || !queue.length) return;
          if (groups[0] || groups[1]) setStatus("");
          return showNext(FIRST_PAGE - FIRST_BATCH, token);
        }).then(function () {
          if (token === run && (groups[0] || groups[1])) setStatus("");
        });
      })
      .catch(function (err) {
        if (token !== run) return;
        // Словарь обновился, а в кэше старый meta.json: файлы прежней
        // версии уже удалены. Берём свежий и пробуем ещё раз.
        if (err && err.status === 404 && !fresh) return start(q, true);
        // Тот же запрос можно отправить ещё раз кнопкой «Найти».
        shownQuery = null;
        if (groups[0] || groups[1]) {
          setStatus("Часть результатов не загрузилась — нажмите «Показать ещё», чтобы попробовать снова.", true);
        } else {
          setStatus("Не получилось загрузить словарь. Проверьте интернет и попробуйте ещё раз.", true);
        }
      });
  }

  // ---------------------------------------------------------------- события

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    start(input.value);
    // На телефоне клавиатура закрывается и не загораживает результаты.
    if (window.matchMedia("(pointer: coarse)").matches) input.blur();
  });

  input.addEventListener("input", function () {
    clearTimeout(typeTimer);
    var q = input.value.trim();
    // Одна латинская или русская буква — скорее всего, набор ещё идёт.
    if (q.length < 2 && !CJK.test(q)) return;
    typeTimer = setTimeout(function () { start(input.value); }, TYPE_DELAY);
  });

  moreBtn.addEventListener("click", function () {
    moreBtn.hidden = true;
    showNext(MORE_PAGE, run).catch(function () {
      moreBtn.hidden = false;
      setStatus("Не получилось загрузить. Попробуйте ещё раз.", true);
    });
  });

  resultsEl.addEventListener("click", function (e) {
    var toggle = e.target.closest(".dict-toggle");
    if (toggle) {
      var entryEl = toggle.closest(".dict-entry");
      var open = entryEl.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Свернуть" : toggle.getAttribute("data-more");
      if (!open) entryEl.scrollIntoView({ block: "nearest" });
      return;
    }
    var ref = e.target.closest(".dict-ref");
    if (ref) {
      e.preventDefault();
      input.value = ref.textContent;
      history.pushState(null, "", "?q=" + encodeURIComponent(ref.textContent));
      shownQuery = null;
      start(ref.textContent);
      window.scrollTo(0, 0);
    }
  });

  window.addEventListener("popstate", function () {
    var q = new URLSearchParams(location.search).get("q") || "";
    input.value = q;
    start(q);
  });

  // meta.json грузится сразу, пока человек набирает запрос.
  loadMeta().catch(function () {});
  var initial = new URLSearchParams(location.search).get("q");
  if (initial) {
    input.value = initial;
    start(initial);
  }
})();
