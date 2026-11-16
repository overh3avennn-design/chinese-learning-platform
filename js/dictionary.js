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
  var MORE_PAGE = 20;       // столько добавляет «показать ещё»
  var TYPE_DELAY = 400;     // пауза в наборе, после которой начинается поиск
  var LINES_SHOWN = 6;      // строк длинной статьи видно до «Показать всю статью»
  var FORMS_MAX = 300;      // сколько форм русского слова (дом → дома, домашний…) брать
  var FETCH_TIMEOUT = 10000; // запрос, молчащий дольше, обрывается и повторяется
  var FETCH_TRIES = 3;      // всего попыток на файл
  var PARSE_MAX = 10;       // самое длинное слово (в знаках) при разборе предложения
  var TILE_GLOSS = 30;      // до стольких знаков обрезается перевод на плашке

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

  // Номер файла индекса, где должен лежать ключ q.
  function shardNo(kind, q) {
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
    return n;
  }

  function shard(kind, q) {
    return load(kind + "/" + shardNo(kind, q) + ".json", parseShard);
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

  // ------------------------------------------------------ дополнения сайта

  // Свои статьи сверх БКРС (js/dict-extra.js): слово → статья с пометкой
  // x в дополнениях (e[3]) и ключи её пиньиня. Их мало, поэтому ищутся
  // простым перебором и идут первыми среди точных совпадений.
  var extras = (window.DictExtra || []).map(function (e) {
    var item = [e[0], e[1], e[2], { x: 1 }];
    return { entry: item, keys: entryPinyinKeys(e[1]), len: Array.from(e[0]).length };
  });

  function extraByWord(word) {
    for (var i = 0; i < extras.length; i++) {
      if (extras[i].entry[0] === word) return extras[i].entry;
    }
    return null;
  }

  // Кандидаты из дополнений впереди найденных в словаре: fit(дополнение)
  // → 0 (точное), 1 (частичное) или −1 (не подходит).
  function withExtras(list, fit) {
    var exact = [], partial = [];
    extras.forEach(function (x) {
      var g = fit(x);
      if (g === 0) exact.push({ entry: x.entry, group: 0 });
      else if (g === 1) partial.push({ entry: x.entry, group: 1 });
    });
    if (!exact.length && !partial.length) return list;
    var n = 0;
    while (n < list.length && list[n].group === 0) n++;
    return exact.concat(list.slice(0, n), partial, list.slice(n));
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
      return withExtras(candidates(exact, merge([inside, starts], exact)), function (x) {
        return x.entry[0] === q ? 0 : x.entry[0].indexOf(q) >= 0 ? 1 : -1;
      });
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
      // Дополнения: то же чтение — точное, начинается так же — частичное.
      return withExtras(list, function (x) {
        var g = -1;
        x.keys.forEach(function (k) {
          if (plain(k).indexOf(base) !== 0 || (toned && !tonesFit(queryTones, k))) return;
          if (plain(k) === base) g = 0;
          else if (g < 0) g = 1;
        });
        return g;
      });
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

  // -------------------------------------------------- разбор предложения

  // Словарь не лежит в памяти целиком (3,4 млн статей), поэтому вместо
  // одного большого Map — те же файлы индекса zh/: заголовки в них
  // отсортированы, слово ищется двоичным поиском, а каждый файл грузится
  // и разбирается один раз (load) и дальше берётся из памяти.

  // Самое длинное слово словаря, которое начинается со знака chars[i] и
  // не выходит за end: { len, ids, all } или null; all — номера статей
  // и более коротких слов с этого места, по длине. Перебор длин 1, 2, 3…
  // обрывается, как только в индексе нет ни одного заголовка с таким
  // началом, — обычно хватает одного-двух файлов на знак.
  function longestAt(chars, i, end) {
    var best = null, all = {};
    function step(len) {
      if (i + len > end || len > PARSE_MAX) return Promise.resolve(best);
      var word = chars.slice(i, i + len).join("");
      var no = shardNo("zh", word);
      return load("zh/" + no + ".json", parseShard).then(function (s) {
        var k = lowerBound(s.keys, word);
        if (s.keys[k] === word) {
          var ids = decode(s.fields[k][0]);
          if (ids.length) {
            all[len] = ids;
            best = { len: len, ids: ids, all: all };
          }
          k++;
        }
        // Следующий заголовок по алфавиту (он может быть первым в
        // следующем файле) — начинается ли он с этого же слова?
        var next = k < s.keys.length ? s.keys[k] : meta.zh[no + 1];
        if (!next || next.indexOf(word) !== 0) return best;
        return step(len + 1);
      });
    }
    return step(1).then(function (found) {
      // Слово из дополнений сайта, если оно не короче найденного в словаре.
      extras.forEach(function (x) {
        if (i + x.len > end || (found && found.len > x.len)) return;
        if (chars.slice(i, i + x.len).join("") !== x.entry[0]) return;
        all[x.len] = [0];
        found = { len: x.len, ids: [0], all: all, entry: x.entry };
      });
      return found;
    });
  }

  // Жадная разбивка слева направо: на каждом месте — самое длинное слово
  // словаря, нет такого — один иероглиф отдельным куском. Знаки
  // препинания, цифры, латиница и пробелы в словаре не ищутся.
  // Одна поправка к жадности: если последний знак слова начинает другое
  // слово, которое важнее (номер статьи меньше), а слово без этого знака
  // тоже есть в словаре, знак отдаётся следующему слову:
  // 图书馆学|习 → 图书馆|学习, 很有|意思 → 很|有意思.
  // → Promise([{ text, ids }]): ids — номера статей слова, [] — иероглифа
  // нет в словаре, null — не иероглифы (выводятся как есть).
  function segment(text) {
    var chars = Array.from(text);
    var han = chars.map(function (ch) { return CJK_START.test(ch); });
    // Конец сплошного ряда иероглифов для каждого места.
    var ends = [], end = chars.length;
    for (var i = chars.length - 1; i >= 0; i--) {
      if (!han[i]) end = i;
      ends[i] = end;
    }
    // Все места ищутся сразу: файлы индекса грузятся параллельно.
    return Promise.all(chars.map(function (ch, j) {
      return han[j] ? longestAt(chars, j, ends[j]) : null;
    })).then(function (found) {
      var parts = [], pos = 0;
      while (pos < chars.length) {
        if (!han[pos]) {
          var from = pos;
          while (pos < chars.length && !han[pos]) pos++;
          parts.push({ text: chars.slice(from, pos).join(""), ids: null });
        } else if (found[pos]) {
          var w = found[pos], len = w.len, ids = w.ids;
          var next = len > 1 ? found[pos + len - 1] : null;
          if (next && next.len > 1 && next.ids[0] < ids[0] && w.all[len - 1]) {
            len--;
            ids = w.all[len];
          }
          var text = chars.slice(pos, pos + len).join("");
          parts.push({ text: text, ids: ids, entry: extraByWord(text) });
          pos += len;
        } else {
          parts.push({ text: chars[pos], ids: [] });
          pos++;
        }
      }
      return parts;
    });
  }

  // Разбивка и статьи её слов (у слова с несколькими статьями — самая
  // важная). В консоль — сама разбивка: «我 | 今天 | 去 | …».
  function parseSentence(text) {
    return segment(text).then(function (parts) {
      if (window.console) {
        console.log("Разбор по словам: " + parts.map(function (p) {
          return p.ids && !p.ids.length ? p.text + " (нет в словаре)" : p.text.trim();
        }).filter(Boolean).join(" | "));
      }
      return Promise.all(parts.map(function (p) {
        return p.entry || (p.ids && p.ids.length ? entry(p.ids[0]) : null);
      })).then(function (entries) {
        parts.forEach(function (p, i) { p.entry = entries[i] || null; });
        return { text: text, parts: parts };
      });
    });
  }

  function hanziCount(text) {
    return Array.from(text).filter(function (ch) { return CJK_START.test(ch); }).length;
  }

  function search(q) {
    // Иероглифы: целиком есть в словаре — обычная статья. Нет, а знаков
    // больше одного — разбор предложения по словам (list.parse); слова,
    // которые начинаются с запроса, остаются ниже «частичными».
    if (CJK.test(q)) {
      return searchHanzi(q).then(function (list) {
        if ((list.length && list[0].group === 0) || hanziCount(q) < 2) return list;
        return parseSentence(q).then(function (parse) {
          list.parse = parse;
          return list;
        });
      });
    }
    if (CYRILLIC.test(q)) return searchRussian(q);
    return searchPinyin(q);
  }

  // ----------------------------------------------------------------- показ

  var run = 0;            // номер текущего поиска: ответы старых отбрасываются
  var queue = [];         // кандидаты, которые ещё не показаны
  var groups = [];        // [{ section, list }] — «Точные» и «Частичные»
  var parseShown = false; // на странице разбор предложения
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

  // e[3] — дополнения сборки к статье БКРС (build.py, enrich): a — пиньинь
  // подобран автоматически, m — машинный перевод, w — ID слов для «по
  // словам» у статей без русского перевода.
  var AUTO_PINYIN = "Пиньинь подобран автоматически и может быть неточным";

  var ICON_ARROW = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
  var ICON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var ICON_AI = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';

  // Статья словаря в одном из двух видов. main — крупная карточка точного
  // совпадения: иероглифы, пиньинь, текст статьи, кнопки «разобрать
  // иероглиф» и «ИИ: объяснить», рядом блок «написание» (его наполняет
  // fillWriting). Иначе — строка списка: иероглифы | пиньинь | короткое
  // значение | «статья» (раскрывает полный текст) | стрелка.
  function renderEntry(e, main) {
    var node = document.createElement(main ? "article" : "li");
    node.className = "dict-entry " + (main ? "dict-main" : "dict-row");
    var extra = e[3] || {};
    var lines = e[2] ? e[2].split("\n") : [];
    var collapsed = main && lines.length > LINES_SHOWN + 1;
    // Перевод БКРС не на русском (китайское толкование, английский): сверху
    // машинный перевод или «по словам», сам текст статьи — бледнее.
    var foreign = !CYRILLIC.test(e[2] || "");
    var lead = "";
    if (extra.m) {
      lead = '<p class="dict-line dict-mt"><span class="dict-tag">машинный перевод</span> ' + esc(extra.m) + "</p>";
    } else if (foreign) {
      lead = '<p class="dict-line dict-no-ru">Русского перевода в словаре нет' +
        (extra.w ? '<span class="dict-words"></span>' : "") + "</p>";
    }
    // Статья с иероглифами в заголовке открывает окно слова: разбор
    // иероглифов, порядок черт, письмо (js/hanzi-window.js).
    var card = window.HanziWindow && CJK.test(e[0]);
    if (card) {
      node.className += " has-card";
      node.dictEntry = e;
    }
    // Длина слова в знаках — от неё зависит размер иероглифов.
    var len = Math.min(Array.from(e[0]).length, 9);
    var hanzi = '<span class="dict-hanzi is-len-' + len + '" lang="zh-CN">' + esc(e[0]) + "</span>";
    var pinyin = '<span class="dict-pinyin' + (extra.a ? ' is-auto" title="' + AUTO_PINYIN : "") + '">' +
      (e[1] ? markup(e[1]) + (extra.a ? '<span class="dict-auto">авто</span>' : "") : "") + "</span>" +
      (extra.x && main ? '<span class="dict-tag" title="Статьи нет в БКРС — её добавил сайт">дополнение сайта</span>' : "");
    var article = lines.map(function (t, i) { return line(t, collapsed && i >= LINES_SHOWN); }).join("");
    var html;

    if (main) {
      var toggle = "";
      if (collapsed) {
        var rest = lines.length - LINES_SHOWN;
        var more = "показать всю статью · ещё " + rest + " " + plural(rest, ["строка", "строки", "строк"]);
        toggle = '<button class="dict-toggle" type="button" aria-expanded="false" data-more="' + more + '">' + more + "</button>";
      }
      // «ИИ: объяснить» — то же окно слова, но сразу с объяснением от
      // нейросети (js/ai.js; если он не подключён, кнопки нет).
      var actions = !card ? "" : '<div class="dict-main__actions">' +
        '<button class="btn btn--sm btn--outline dict-card-btn" type="button" aria-label="Разбор иероглифов: ' + esc(e[0]) +
          '"><span>разобрать<span class="wide-only"> иероглиф</span></span></button>' +
        (window.AI ? '<button class="btn btn--sm btn--outline dict-card-btn dict-explain-btn" type="button" aria-label="Объяснить слово: ' +
          esc(e[0]) + '">' + ICON_AI + "ИИ: объяснить</button>" +
          '<span class="dict-main__vpn wide-only">ИИ пока работает с VPN</span>' : "") + "</div>";
      html = '<div class="dict-main__word">' + hanzi +
        '<div class="dict-main__body">' +
          '<div class="dict-main__top">' + pinyin + '<span class="tag">точное совпадение</span></div>' +
          '<div class="dict-text' + (foreign ? " is-foreign" : "") + '">' + lead + article + "</div>" +
          toggle +
          '<p class="dict-main__meta" hidden></p>' +
          actions +
        "</div></div>" +
        (card ? '<div class="dict-main__writing wide-only" hidden>' +
          '<div class="dict-main__writing-head"><h3>написание</h3><span>порядок черт</span></div>' +
          '<div class="dict-writing"></div></div>' : "");
    } else {
      // Короткое значение — как в окне слова; у статей без русского
      // перевода вместо него машинный перевод или «по словам».
      var gloss = window.HanziWindow ? window.HanziWindow.gloss(e, 2) : "";
      var summary = lead || '<p class="dict-line dict-gloss">' + esc(gloss || lines[0] || "") + "</p>";
      // «статья» — полный текст под строкой; у статьи в одну строку он
      // совпадает с коротким значением, и кнопки нет.
      var full = lines.length > 1 || !!lead;
      html = '<div class="dict-head">' + hanzi + pinyin + "</div>" +
        '<div class="dict-text' + (foreign ? " is-foreign" : "") + '">' + summary + "</div>" +
        (full ? '<button class="dict-toggle dict-row__more" type="button" aria-expanded="false" aria-label="Показать всю статью: ' +
          esc(e[0]) + '"><span>статья</span>' + ICON_DOWN + "</button>" : '<span class="dict-row__more"></span>') +
        (card ? '<button class="dict-card-btn dict-row__open" type="button" aria-label="Разбор иероглифов: ' + esc(e[0]) + '">' +
          ICON_ARROW + "</button>" : '<span class="dict-row__open"></span>') +
        (full ? '<div class="dict-article' + (foreign ? " is-foreign" : "") + '">' + article + "</div>" : "");
    }
    node.innerHTML = html;
    if (extra.w && !extra.m) fillWords(node.querySelector(".dict-words"), extra.w);
    return node;
  }

  // Блок «написание» у точного совпадения: порядок черт в клетках 田字格 и
  // строки о ключе и составе — их рисует js/hanzi-window.js по тем же
  // данным, что в окне слова. Он же отдаёт строку «4 черты · ключ 水».
  function fillWriting(node, e) {
    var host = node.querySelector(".dict-writing");
    if (!host || !window.HanziWindow || !window.HanziWindow.writing) return;
    window.HanziWindow.writing(host, e[0]).then(function (info) {
      if (!info) return;
      node.querySelector(".dict-main__writing").hidden = false;
      var meta = node.querySelector(".dict-main__meta");
      meta.innerHTML = info.meta;
      meta.hidden = !info.meta;
    }).catch(function () {});
  }

  // «По словам: 工业 — промышленность · 管 — труба» — значения слов, из
  // которых состоит заголовок, из их собственных статей.
  function fillWords(el, ids) {
    Promise.all(ids.slice(0, 6).map(function (id) {
      return entry(id).catch(function () { return null; });
    })).then(function (list) {
      var parts = list.filter(Boolean).map(function (w) {
        var g = window.HanziWindow ? window.HanziWindow.gloss(w, 1) : "";
        if (g.length > 48) g = g.slice(0, 46).replace(/[\s,;]+$/, "") + "…";
        return '<a class="dict-ref" href="?q=' + encodeURIComponent(w[0]) + '" lang="zh-CN">' + esc(w[0]) + "</a>" +
          (g ? " — " + esc(g) : "");
      });
      if (parts.length) el.innerHTML = ". По словам: " + parts.join(" · ");
    });
  }

  // Первое чтение статьи без пометок: «hǎo, hào» → «hǎo».
  function firstPinyin(pinyin) {
    return (pinyin || "").replace(/\[(p|i)\][\s\S]*?\[\/\1\]/g, " ").replace(/\([^()]*\)/g, " ")
      .split(/[,;\/]/)[0].replace(/\s+/g, " ").trim();
  }

  // Перевод для плашки: первое значение статьи, не длиннее TILE_GLOSS.
  function tileGloss(e) {
    var g = window.HanziWindow ? window.HanziWindow.gloss(e, 3) : (e[2] || "").split("\n")[0];
    // Первое значение с русским текстом: у 他 статья начинается с «I, tā».
    var items = g.split(";").map(function (t) { return t.trim(); }).filter(Boolean);
    g = items.filter(function (t) { return CYRILLIC.test(t); })[0] || items[0] || "";
    if (g.length > TILE_GLOSS) g = g.slice(0, TILE_GLOSS - 1).replace(/[\s,;.:(\-—–]+$/, "") + "…";
    return g;
  }

  // Разбор предложения: исходный текст, ряд плашек (пиньинь, слово,
  // короткий перевод) и место под статью. Нажатие на плашку раскрывает
  // под рядом полную статью слова — ту же карточку, что у точного
  // совпадения. Кнопка перевода пока выключена: позже к ней подключится
  // нейросеть.
  function showParse(parse) {
    var section = document.createElement("section");
    section.className = "dict-parse";
    section.setAttribute("aria-label", "Разбор предложения по словам");
    section.innerHTML =
      '<div class="dict-parse__head">' +
        '<p class="dict-parse__source" lang="zh-CN">' + esc(parse.text) + "</p>" +
        '<p class="dict-parse__note">Разбор по словам (автоматический, может ошибаться)</p>' +
      "</div>" +
      '<div class="dict-parse__tiles"></div>' +
      '<div class="dict-parse__entry" hidden></div>' +
      '<div class="dict-parse__foot">' +
        '<button class="btn btn--outline" type="button" disabled>перевести предложение целиком</button>' +
        '<span class="tag">скоро</span>' +
      "</div>";
    var tiles = section.querySelector(".dict-parse__tiles");
    parse.parts.forEach(function (p) {
      var tile;
      if (!p.ids) {
        // Знаки препинания, цифры, латиница — как есть; пробелы не нужны.
        if (!p.text.trim()) return;
        tile = document.createElement("span");
        tile.className = "dict-parse__plain";
        tile.textContent = p.text.trim();
      } else if (!p.entry) {
        tile = document.createElement("div");
        tile.className = "dict-tile is-unknown";
        tile.innerHTML = '<span class="dict-tile__py">&nbsp;</span>' +
          '<span class="dict-tile__zh" lang="zh-CN">' + esc(p.text) + "</span>" +
          '<span class="dict-tile__ru">нет в словаре</span>';
      } else {
        tile = document.createElement("button");
        tile.type = "button";
        tile.className = "dict-tile";
        tile.setAttribute("aria-expanded", "false");
        tile.dictEntry = p.entry;
        tile.innerHTML = '<span class="dict-tile__py" lang="zh-Latn">' + (esc(firstPinyin(p.entry[1])) || "&nbsp;") + "</span>" +
          '<span class="dict-tile__zh" lang="zh-CN">' + esc(p.text) + "</span>" +
          '<span class="dict-tile__ru">' + (esc(tileGloss(p.entry)) || "—") + "</span>";
      }
      tiles.appendChild(tile);
    });
    resultsEl.appendChild(section);
    parseShown = true;
  }

  // Нажатие на плашку: статья слова под рядом плашек; повторное — убрать.
  function toggleTile(tile) {
    var section = tile.closest(".dict-parse");
    var slot = section.querySelector(".dict-parse__entry");
    var wasOpen = tile.classList.contains("is-open");
    Array.prototype.forEach.call(section.querySelectorAll(".dict-tile.is-open"), function (t) {
      t.classList.remove("is-open");
      t.setAttribute("aria-expanded", "false");
    });
    slot.textContent = "";
    slot.hidden = wasOpen;
    if (wasOpen) return;
    tile.classList.add("is-open");
    tile.setAttribute("aria-expanded", "true");
    var card = renderEntry(tile.dictEntry, true);
    slot.appendChild(card);
    fillWriting(card, tile.dictEntry);
    slot.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Группа выдачи: 0 — точные совпадения, 1 — частичные. У точных первое
  // идёт крупной карточкой (main), остальные — строками в рамке «ещё
  // точные совпадения»; частичные — строками в рамке «частичные
  // совпадения». Над выдачей — подпись «результаты · запрос».
  function group(n) {
    if (!groups[n]) {
      if (!resultsEl.querySelector(".dict-results-label")) {
        var label = document.createElement("div");
        label.className = "section-label dict-results-label";
        label.innerHTML = '<h2>результаты · <span class="dict-results-label__q">' + esc(shownQuery || "") + "</span></h2>" +
          '<span class="dict-results-label__line" aria-hidden="true"></span>' +
          '<span class="dict-results-label__note">сначала точные совпадения, потом частичные</span>';
        resultsEl.insertBefore(label, resultsEl.firstChild);
      }
      var section = document.createElement("section");
      section.className = "dict-group " + (n ? "is-partial" : "is-exact");
      section.innerHTML = (n ? "" : '<div class="dict-main-slot"></div>') +
        '<div class="dict-box"' + (n ? "" : " hidden") + '><h3 class="dict-box__title">' +
        (n ? "частичные совпадения" : "ещё точные совпадения") + '</h3><ol class="dict-list"></ol></div>';
      // «Точные» всегда выше «Частичных», даже если появились позже.
      if (n === 0 && groups[1]) resultsEl.insertBefore(section, groups[1].section);
      else resultsEl.appendChild(section);
      groups[n] = {
        section: section,
        list: section.querySelector("ol"),
        box: section.querySelector(".dict-box"),
        main: section.querySelector(".dict-main-slot")
      };
    }
    return groups[n];
  }

  // Показывает следующие count кандидатов. Кандидаты, у которых группа
  // видна только по статье, проверяются после загрузки; не подошедшие
  // заменяются следующими.
  function showNext(count, token) {
    var batch = queue.splice(0, count);
    moreBtn.hidden = true;
    return Promise.all(batch.map(function (c) { return c.entry || entry(c.id); })).catch(function (err) {
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
        var target = group(g);
        if (target.main && !target.main.firstChild) {
          // Первое точное совпадение — крупно, с блоком «написание».
          var card = renderEntry(e, true);
          target.main.appendChild(card);
          fillWriting(card, e);
        } else {
          target.list.appendChild(renderEntry(e, false));
          target.box.hidden = false;
        }
        shown++;
      });
      if (shown < count && queue.length) return showNext(count - shown, token);
      moreBtn.hidden = !queue.length;
      if (!groups[0] && !groups[1] && !parseShown) {
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
    parseShown = false;
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
        if (list.parse) {
          showParse(list.parse);
          setStatus("");
        }
        // Сначала статьи первых результатов, потом остальных: по
        // медленному интернету первые появляются заметно раньше.
        return showNext(FIRST_BATCH, token).then(function () {
          if (token !== run || !queue.length) return;
          if (groups[0] || groups[1] || parseShown) setStatus("");
          return showNext(FIRST_PAGE - FIRST_BATCH, token);
        }).then(function () {
          if (token === run && (groups[0] || groups[1] || parseShown)) setStatus("");
        });
      })
      .catch(function (err) {
        if (token !== run) return;
        // Словарь обновился, а в кэше старый meta.json: файлы прежней
        // версии уже удалены. Берём свежий и пробуем ещё раз.
        if (err && err.status === 404 && !fresh) return start(q, true);
        // Тот же запрос можно отправить ещё раз кнопкой «найти».
        shownQuery = null;
        if (groups[0] || groups[1] || parseShown) {
          setStatus("Часть результатов не загрузилась — нажмите «показать ещё», чтобы попробовать снова.", true);
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
    var tile = e.target.closest("button.dict-tile");
    if (tile) {
      toggleTile(tile);
      return;
    }
    var toggle = e.target.closest(".dict-toggle");
    if (toggle) {
      var entryEl = toggle.closest(".dict-entry");
      var open = entryEl.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // У строки списка кнопка «статья» со стрелкой — подпись не меняется.
      if (toggle.hasAttribute("data-more")) toggle.textContent = open ? "свернуть" : toggle.getAttribute("data-more");
      if (!open) entryEl.scrollIntoView({ block: "nearest" });
      return;
    }
    var ref = e.target.closest(".dict-ref");
    if (ref) {
      e.preventDefault();
      searchFor(ref.textContent);
      return;
    }
    // Нажатие на статью — окно слова. Кроме ссылок, кнопок и случая, когда
    // в статье выделяют текст, чтобы скопировать.
    var item = e.target.closest(".dict-entry.has-card");
    if (!item) return;
    var cardBtn = e.target.closest(".dict-card-btn");
    if (!cardBtn && e.target.closest("a, button")) return;
    var sel = window.getSelection && window.getSelection();
    if (!cardBtn && sel && !sel.isCollapsed && item.contains(sel.anchorNode)) return;
    window.HanziWindow.open({
      word: item.dictEntry[0],
      entry: item.dictEntry,
      lookup: lookupWord,
      search: searchFor,
      explain: !!(cardBtn && cardBtn.classList.contains("dict-explain-btn")),
      returnFocus: cardBtn || item.querySelector(".dict-card-btn:not(.dict-explain-btn)")
    });
  });

  // Новый поиск ссылкой: из «см. …» в статье или из окна слова. replace —
  // заменить текущую запись истории (окно слова оставило там свою).
  function searchFor(q, replace) {
    input.value = q;
    history[replace ? "replaceState" : "pushState"](null, "", "?q=" + encodeURIComponent(q));
    shownQuery = null;
    start(q);
    window.scrollTo(0, 0);
  }

  // Статья, у которой заголовок — ровно эти иероглифы (самая важная из
  // нескольких), или null. Для значений иероглифов и их частей в окне слова.
  function lookupWord(word) {
    var own = extraByWord(word);
    if (own) return Promise.resolve(own);
    return loadMeta()
      .then(function () { return shard("zh", word); })
      .then(function (s) {
        var i = lowerBound(s.keys, word);
        if (s.keys[i] !== word) return null;
        var ids = decode(s.fields[i][0]);
        return ids.length ? entry(ids[0]) : null;
      });
  }

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
