/* Точный поиск слов в словаре 大БКРС — для «Карточек по фото тетради»:
   по распознанным иероглифам найти пиньинь и значения (js/notebook-ocr.js).

   Данные те же, что у раздела «Словарь» (js/dictionary.js): репозиторий
   chinese-dictionary-data, формат описан в его README. Здесь только
   точное совпадение заголовка: meta.json → файл индекса zh/ с нужным
   ключом (двоичный поиск по первым ключам файлов) → номера статей с этим
   заголовком → файлы статей e/.

   DictLookup.exact(["朋友", …]) → Promise({ "朋友": [статья, …], … })
     Статья — [иероглифы, пиньинь, перевод] или с четвёртым элементом —
     дополнениями сборки ({ a: 1 } — пиньинь подобран автоматически,
     m — машинный перевод), а в поле id — её номер (он же важность: меньше —
     употребительнее), в hsk — слово ли это из HSK. Слова нет в словаре —
     пустой список.
   Для слов, прочитанных с ошибками, — поиск кандидатов:
   DictLookup.related(["学", …]) → Promise({ "学": [номера до 100 самых
     важных статей с этим знаком в заголовке] })
   DictLookup.pinyin(["xuewen", "xue"]) → Promise({ ключ: { first: номера
     статей, где это первое чтение (без тонов), prefix: до 100 статей, чей
     пиньинь так начинается — только у отдельного слога } })
   DictLookup.entries([номера]) → Promise([статья, …])
   DictLookup.dataUrl — адрес данных (там же модели распознавания, ocr/). */
(function () {
  "use strict";

  // Тот же адрес *.github.io, что у сайта. Локальный сервер, который отдаёт
  // оба репозитория рядом (как Pages), отдаёт и данные.
  var DATA_URL = "https://overh3avennn-design.github.io/chinese-dictionary-data/";
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    DATA_URL = location.origin + "/chinese-dictionary-data/";
  }
  var FETCH_TIMEOUT = 10000;
  var FETCH_TRIES = 3;
  var MAX_ENTRIES = 6;      // статей на одно слово (у 了, 行 их несколько)
  var VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  var meta = null;
  var metaPromise = null;
  var files = {};

  // Зависший запрос обрывается, оборванный повторяется; ответ сервера с
  // ошибкой (404 после обновления словаря) не повторяется.
  function getJSON(url, options, triesLeft) {
    if (triesLeft === undefined) triesLeft = FETCH_TRIES - 1;
    var opts = {}, key;
    for (key in options) opts[key] = options[key];
    var ctrl = window.AbortController ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : null;
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        var err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }).then(function (data) {
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
  // ссылается на удалённую версию файлов.
  function loadMeta(fresh) {
    if (!metaPromise || fresh) {
      metaPromise = getJSON(DATA_URL + "meta.json", fresh ? { cache: "reload" } : {}).then(function (m) {
        m.ends = decode(m.e);
        meta = m;
        files = {};
        return m;
      });
      metaPromise.catch(function () { metaPromise = null; });
    }
    return metaPromise;
  }

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
  // младшие вперёд, бит 32 — «дальше ещё».
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
  // <остаток ключа>|список|список…». Ключ → его списки (ещё не раскрытые).
  function parseShard(records) {
    var map = {}, prev = "";
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var bar = rec.indexOf("|", 1);
      var key = prev.slice(0, rec.charCodeAt(0) - 48) + (bar < 0 ? rec.slice(1) : rec.slice(1, bar));
      if (bar >= 0) map[key] = rec.slice(bar + 1).split("|");
      prev = key;
    }
    return map;
  }

  // Индекс пиньиня: ключи с цифрами тонов, файл ищется по ключу без тонов.
  // Слог без тонов → { first: статьи, где это первое чтение (все тона),
  // prefix: до 100 статей, чей пиньинь без тонов начинается так же }.
  function parsePyShard(records) {
    var raw = parseShard(records), map = {};
    Object.keys(raw).forEach(function (key) {
      var bare = key.replace(/[0-9]/g, "");
      var item = map[bare] || (map[bare] = { first: [], prefix: "" });
      if (raw[key][0]) item.first.push(raw[key][0]);
      if (raw[key][2] && !item.prefix) item.prefix = raw[key][2];
    });
    return map;
  }

  function shardNo(firsts, key) {
    var lo = 0, hi = firsts.length - 1, n = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (firsts[mid] <= key) {
        n = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return n;
  }

  function shard(word) {
    return load("zh/" + shardNo(meta.zh, word) + ".json", parseShard);
  }

  function pyShard(bare) {
    return load("py/" + shardNo(meta.py, bare) + ".json", parsePyShard);
  }

  // Статья по номеру. У статьи-массива проставляется id — номер, он же
  // важность слова (меньше — употребительнее).
  function entry(id) {
    var ends = meta.ends, lo = 0, hi = ends.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ends[mid] > id) hi = mid;
      else lo = mid + 1;
    }
    var start = lo ? ends[lo - 1] : 0;
    return load("e/" + lo + ".json").then(function (list) {
      var e = list[id - start];
      if (e) {
        e.id = id;
        e.hsk = id < (meta.hsk || 0);       // первые статьи — слова HSK
      }
      return e;
    });
  }

  function lookupWord(word) {
    return shard(word).then(function (map) {
      var ids = map[word] ? decode(map[word][0]).slice(0, MAX_ENTRIES) : [];
      return Promise.all(ids.map(entry));
    }).then(function (list) {
      return list.filter(function (e) { return e && e[0] === word; });
    });
  }

  function unique(list) {
    var out = [];
    list.forEach(function (x) {
      if (x !== "" && x !== null && x !== undefined && out.indexOf(x) < 0) out.push(x);
    });
    return out;
  }

  // Повтор после 404: словарь обновился, а meta.json в кэше старый.
  function withMeta(run, retried) {
    return loadMeta(false).then(run).catch(function (err) {
      if (err.status === 404 && !retried) {
        return loadMeta(true).then(function () { return withMeta(run, true); });
      }
      throw err;
    });
  }

  function exact(words) {
    var list = unique(words);
    return withMeta(function () {
      return Promise.all(list.map(lookupWord)).then(function (lists) {
        var out = {};
        list.forEach(function (w, i) { out[w] = lists[i]; });
        return out;
      });
    });
  }

  // Знак → номера до 100 самых важных статей, в заголовке которых он есть
  // (学 → 大学, 学习, 学问…).
  function related(chars) {
    var list = unique(chars);
    return withMeta(function () {
      return Promise.all(list.map(function (ch) {
        return shard(ch).then(function (map) { return map[ch] && map[ch][1] ? decode(map[ch][1]) : []; });
      })).then(function (lists) {
        var out = {};
        list.forEach(function (ch, i) { out[ch] = lists[i]; });
        return out;
      });
    });
  }

  // Пиньинь без тонов и пробелов («xuewen», «xue») → { first: номера статей,
  // где это ровно первое чтение, prefix: до 100 статей, чей пиньинь
  // начинается так же (есть только у отдельного слога) }.
  function pinyin(keys) {
    var list = unique(keys);
    return withMeta(function () {
      return Promise.all(list.map(function (key) {
        return pyShard(key).then(function (map) {
          var item = map[key];
          if (!item) return { first: [], prefix: [] };
          var first = [];
          item.first.forEach(function (s) { first = first.concat(decode(s)); });
          return { first: first, prefix: decode(item.prefix) };
        });
      })).then(function (lists) {
        var out = {};
        list.forEach(function (key, i) { out[key] = lists[i]; });
        return out;
      });
    });
  }

  // Статьи по номерам (с полем id), без пропавших.
  function entries(ids) {
    return withMeta(function () {
      return Promise.all(unique(ids).map(entry)).then(function (list) {
        return list.filter(Boolean);
      });
    });
  }

  window.DictLookup = {
    exact: exact,
    related: related,
    pinyin: pinyin,
    entries: entries,
    dataUrl: DATA_URL
  };
})();
