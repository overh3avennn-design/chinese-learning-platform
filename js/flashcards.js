/* Раздел «Карточки» (flashcards/index.html): список колод, страница
   колоды со списком слов, изучение карточек и итоги сессии. Подключается только на этой странице, после
   flashcards/decks/index.js.

   Колоды. Каждая колода — файл flashcards/decks/<id>.js с вызовом
   addDeck({ id, title, words }), их список — window.DECK_FILES в
   decks/index.js. Скрипты, а не JSON через fetch: страница открывается и
   прямо с диска (file://), а там fetch к соседним файлам браузер
   запрещает. Тег <script> работает и с диска, и на сайте.

   Свои колоды — те, что ученик собрал из фото тетради (js/photo-cards.js),
   и слова, которые он добавил с фото в готовые колоды. Лежат в localStorage
   этого браузера (ключ flashcards-user) в том же формате, что и файлы, и
   проходят ту же проверку cleanDeck — поэтому свайпы и прогресс работают
   с ними так же. Свою колоду можно скачать файлом для decks/.

   Папки — несколько колод вместе. Папки сайта (их видят все) задаёт
   window.DECK_FOLDERS в decks/index.js, свои папки ученик собирает на
   странице и хранит рядом со своими колодами (flashcards-user, поле
   folders). Колода может лежать в нескольких папках и при этом остаётся в
   общем списке колод. Папку учат целиком: слова всех её колод
   вперемешку, а ответ записывается в прогресс самих колод — отдельного
   прогресса у папки нет.

   Прогресс — три статуса слова: новое, изучается, выучено. «Знаю» —
   слово выучено, «Не знаю» — изучается и уходит в конец текущей сессии,
   пока его не узнают. «Учить карточки» берёт только невыученные слова,
   изучаемые — первыми. Прогресс лежит в localStorage, по ключу на колоду. */
(function () {
  "use strict";

  var root = document.querySelector("[data-flashcards]");
  if (!root) return;

  var DECK_DIR = "decks/";
  var STORAGE_PREFIX = "flashcards:";
  var FLY_MS = 280;

  function $(selector) {
    return root.querySelector(selector);
  }

  var views = {
    list: $('[data-view="list"]'),
    deck: $('[data-view="deck"]'),
    study: $('[data-view="study"]'),
    result: $('[data-view="result"]'),
    done: $('[data-view="done"]'),
    photo: $('[data-view="photo"]'),
    folder: $('[data-view="folder"]'),
    edit: $('[data-view="folder-edit"]')
  };

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function plural(n, forms) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  function words(n) {
    return n + " " + plural(n, ["слово", "слова", "слов"]);
  }

  function deckCount(n) {
    return n + " " + plural(n, ["колода", "колоды", "колод"]);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  // ------------------------------------------------------------ хранилище
  // Любое обращение к localStorage может бросить исключение (инкогнито,
  // запрет cookies, переполнение), поэтому всё в try/catch. Если хранилище
  // недоступно, прогресс живёт в memory, пока открыта страница.
  var memory = {};

  function storageFailed() {
    $("[data-storage-note]").hidden = false;
  }

  function loadProgress(deckId) {
    var data = memory[deckId];
    try {
      var raw = window.localStorage.getItem(STORAGE_PREFIX + deckId);
      if (raw) data = JSON.parse(raw);
    } catch (e) {
      if (!(e instanceof SyntaxError)) storageFailed();
    }
    if (!data || typeof data !== "object") data = {};

    var saved = data.words && typeof data.words === "object" ? data.words : {};
    var progress = { words: {} };
    var migrated = data.session !== undefined;
    Object.keys(saved).forEach(function (key) {
      var status = cleanStatus(saved[key]);
      if (status) progress.words[key] = status;
      if (status !== saved[key]) migrated = true;
    });
    // Прогресс в старом формате сразу переписываем в новый.
    if (migrated) saveProgress(deckId, progress);
    return progress;
  }

  // Статус из сохранённой записи. Старый формат (система Лейтнера) —
  // { box: 1–5, due }: коробка 1 — «изучается», 2–5 — «выучено».
  function cleanStatus(r) {
    if (r === "learning" || r === "learned") return r;
    if (r && typeof r === "object") return (Math.round(r.box) || 1) > 1 ? "learned" : "learning";
    return null;
  }

  function saveProgress(deckId, progress) {
    memory[deckId] = progress;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + deckId, JSON.stringify(progress));
    } catch (e) {
      storageFailed();
    }
  }

  function resetProgress(deckId) {
    delete memory[deckId];
    try {
      window.localStorage.removeItem(STORAGE_PREFIX + deckId);
    } catch (e) {
      storageFailed();
    }
  }

  // Слово узнаётся по иероглифу и пиньиню: перевод можно поправить, не
  // потеряв прогресс.
  function wordKey(word) {
    return word.hanzi + "|" + word.pinyin;
  }

  // ------------------------------------------------------- наборы слов
  // Учат колоду или папку — набор из нескольких колод. У набора список
  // слов (слово, которое есть в нескольких колодах папки, — один раз) и
  // owners: ключ слова → id колод, где оно есть. Прогресс хранится по
  // колодам; byDeck — { id колоды: прогресс } всех колод набора.
  function makeSet(kind, id, title, deckList) {
    var list = [];
    var owners = {};
    deckList.forEach(function (deck) {
      deck.words.forEach(function (w) {
        var key = wordKey(w);
        if (!owners[key]) {
          owners[key] = [];
          list.push(w);
        }
        if (owners[key].indexOf(deck.id) === -1) owners[key].push(deck.id);
      });
    });
    return { kind: kind, id: id, title: title, decks: deckList, words: list, owners: owners };
  }

  function deckSet(deck) {
    return makeSet("deck", deck.id, deck.title, [deck]);
  }

  function loadSetProgress(set) {
    var byDeck = {};
    set.decks.forEach(function (d) {
      byDeck[d.id] = loadProgress(d.id);
    });
    return byDeck;
  }

  // В сессии сначала изучаемые слова, потом новые, потом выученные (они
  // бывают, когда колоду проходят целиком); внутри статуса — вперемешку.
  var STATUS_ORDER = { learning: 0, "new": 1, learned: 2 };

  // «Новое» — на слово ещё ни разу не отвечали (записи нет). Если слово в
  // нескольких колодах папки, его статус — наименее выученный из них:
  // выученное в одной колоде, но новое в другой, попадёт в «Учить папку».
  function wordStatus(set, byDeck, word) {
    var key = wordKey(word);
    var best = "learned";
    var owners = set.owners[key] || [];
    owners.forEach(function (id) {
      var status = byDeck[id].words[key] || "new";
      if (STATUS_ORDER[status] < STATUS_ORDER[best]) best = status;
    });
    return owners.length ? best : "new";
  }

  // Статусы слова в каждой его колоде — чтобы «Предыдущая карточка» вернула
  // каждой колоде её собственный (undefined — слово было новым).
  function ownerStatuses(set, byDeck, word) {
    var key = wordKey(word);
    var statuses = {};
    set.owners[key].forEach(function (id) {
      statuses[id] = byDeck[id].words[key];
    });
    return statuses;
  }

  // status — один статус для всех колод слова или { id колоды: статус };
  // пустой статус — слово снова новое.
  function setWordStatus(set, byDeck, word, status) {
    var key = wordKey(word);
    set.owners[key].forEach(function (id) {
      var s = status && typeof status === "object" ? status[id] : status;
      if (s) byDeck[id].words[key] = s;
      else delete byDeck[id].words[key];
      saveProgress(id, byDeck[id]);
    });
  }

  function learnedCount(set, byDeck) {
    return set.words.filter(function (w) {
      return wordStatus(set, byDeck, w) === "learned";
    }).length;
  }

  function learningWords(set) {
    var byDeck = loadSetProgress(set);
    return set.words.filter(function (w) {
      return wordStatus(set, byDeck, w) === "learning";
    });
  }

  function unlearnedWords(set) {
    var byDeck = loadSetProgress(set);
    return set.words.filter(function (w) {
      return wordStatus(set, byDeck, w) !== "learned";
    });
  }

  function byStatus(set, list, byDeck) {
    return shuffle(list.slice()).sort(function (a, b) {
      return STATUS_ORDER[wordStatus(set, byDeck, a)] - STATUS_ORDER[wordStatus(set, byDeck, b)];
    });
  }

  // --------------------------------------------------------------- колоды
  var decks = [];
  var deckById = {};
  var errors = [];

  function cleanWords(list) {
    var clean = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (w) {
      if (!w || typeof w.hanzi !== "string" || !w.hanzi.trim()) return;
      var word = {
        hanzi: w.hanzi.trim(),
        pinyin: typeof w.pinyin === "string" ? w.pinyin.trim() : "",
        translation: typeof w.translation === "string" ? w.translation.trim() : ""
      };
      if (seen[wordKey(word)]) return;     // повтор слова в колоде
      seen[wordKey(word)] = true;
      clean.push(word);
    });
    return clean;
  }

  function cleanDeck(raw, file) {
    if (!raw || typeof raw !== "object") return null;
    var id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : file.replace(/\.js$/, "");
    return {
      id: id,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
      words: cleanWords(raw.words),
      file: file
    };
  }

  // Колода сама называет себя вызовом addDeck; какой файл её принёс,
  // видно по document.currentScript — так колоды встают в порядке списка.
  var loaded = {};

  window.addDeck = function (raw) {
    var script = document.currentScript;
    var file = script ? script.getAttribute("data-deck-file") : "";
    loaded[file] = raw;
  };

  function loadDecks(done) {
    var files = Array.isArray(window.DECK_FILES) ? window.DECK_FILES : [];
    files = files.map(function (f) {
      f = String(f).trim();
      return /\.js$/.test(f) ? f : f + ".js";
    });
    if (!files.length) {
      done(files);
      return;
    }
    var left = files.length;
    files.forEach(function (file) {
      var script = document.createElement("script");
      script.src = DECK_DIR + file;
      script.setAttribute("data-deck-file", file);
      script.onload = script.onerror = function (event) {
        if (event.type === "error") loaded[file] = false;
        if (--left === 0) done(files);
      };
      document.body.appendChild(script);
    });
  }

  function collectDecks(files) {
    files.forEach(function (file) {
      var raw = loaded[file];
      if (raw === false) {
        errors.push("Файл decks/" + file + " не найден — проверьте имя в decks/index.js.");
        return;
      }
      var deck = cleanDeck(raw, file);
      if (!deck) {
        errors.push("В файле decks/" + file + " не нашлось колоды — проверьте запятые, " +
          "кавычки и скобки вокруг addDeck({ … }).");
        return;
      }
      if (deckById[deck.id]) {
        errors.push("Колода с id «" + deck.id + "» уже есть (" + deckById[deck.id].file +
          "), файл decks/" + file + " пропущен — у каждой колоды свой id.");
        return;
      }
      if (!deck.words.length) {
        errors.push("В колоде «" + deck.title + "» (decks/" + file + ") нет ни одного слова.");
        return;
      }
      deckById[deck.id] = deck;
      decks.push(deck);
    });
  }

  // ---------------------------------------------------------- свои колоды
  // { decks: [{ id, title, words }], extra: { id готовой колоды: [слово, …] },
  //   folders: [{ id, title, decks: [id колоды, …] }] }.
  // Если localStorage недоступен, всё живёт в userData, пока открыта страница.
  var USER_KEY = "flashcards-user";
  var userData = null;

  function loadUser() {
    if (userData) return userData;
    var data = null;
    try {
      data = JSON.parse(window.localStorage.getItem(USER_KEY) || "null");
    } catch (e) {
      if (!(e instanceof SyntaxError)) storageFailed();
    }
    userData = {
      decks: data && Array.isArray(data.decks) ? data.decks : [],
      extra: data && data.extra && typeof data.extra === "object" ? data.extra : {},
      folders: data && Array.isArray(data.folders) ? data.folders : []
    };
    return userData;
  }

  function saveUser() {
    try {
      window.localStorage.setItem(USER_KEY, JSON.stringify(userData));
      return true;
    } catch (e) {
      storageFailed();
      return false;
    }
  }

  function plainWords(list) {
    return list.map(function (w) {
      return { hanzi: w.hanzi, pinyin: w.pinyin, translation: w.translation };
    });
  }

  // Слова с фото — в конец готовых колод, свои колоды — в общий список с
  // пометкой own. Колода с занятым id (такой файл появился в decks/)
  // пропускается.
  function collectOwnDecks() {
    var user = loadUser();
    Object.keys(user.extra).forEach(function (id) {
      var deck = deckById[id];
      if (!deck || deck.own) return;
      deck.fileWords = deck.words;
      deck.words = cleanWords(deck.words.concat(user.extra[id]));
      deck.extra = deck.words.length - deck.fileWords.length;
    });
    user.decks.forEach(function (raw) {
      var deck = cleanDeck(raw, "");
      if (!deck || !deck.id || deckById[deck.id] || !deck.words.length) return;
      deck.own = true;
      deckById[deck.id] = deck;
      decks.push(deck);
    });
  }

  // Сохранение слов с фото. target — { title } для новой колоды или { id }
  // для готовой. Повторы слов, которые уже есть в колоде, пропускаются.
  function saveWords(target, list) {
    var user = loadUser();
    var words = cleanWords(list);
    if (!words.length) throw new Error("Нет ни одного слова с иероглифами.");
    var deck;
    var added = words;
    if (target.id) {
      deck = deckById[target.id];
      if (!deck) throw new Error("Такой колоды больше нет — выберите другую.");
      var have = {};
      deck.words.forEach(function (w) { have[wordKey(w)] = true; });
      added = words.filter(function (w) { return !have[wordKey(w)]; });
      if (deck.own) {
        user.decks.forEach(function (d) {
          if (d.id === deck.id) d.words = plainWords(cleanWords(d.words).concat(added));
        });
      } else {
        user.extra[deck.id] = plainWords(cleanWords(user.extra[deck.id]).concat(added));
        if (!deck.fileWords) deck.fileWords = deck.words;
        deck.extra = (deck.extra || 0) + added.length;
      }
      deck.words = deck.words.concat(added);
    } else {
      var id = "my-" + Date.now().toString(36);
      while (deckById[id]) id += "x";
      var raw = { id: id, title: String(target.title || "").trim() || id, words: plainWords(words) };
      user.decks.push(raw);
      deck = cleanDeck(raw, "");
      deck.own = true;
      deckById[id] = deck;
      decks.push(deck);
    }
    return { id: deck.id, added: added.length, skipped: words.length - added.length, stored: saveUser() };
  }

  // Удалённая колода уходит и из своих папок (сами папки остаются).
  function deleteOwnDeck(deck) {
    var user = loadUser();
    user.decks = user.decks.filter(function (d) { return d.id !== deck.id; });
    folders.forEach(function (f) {
      if (f.own) f.decks = f.decks.filter(function (id) { return id !== deck.id; });
    });
    storeFolders();       // он же сохраняет user целиком
    delete deckById[deck.id];
    decks = decks.filter(function (d) { return d !== deck; });
    resetProgress(deck.id);
  }

  function removeExtra(deck) {
    var user = loadUser();
    delete user.extra[deck.id];
    saveUser();
    if (deck.fileWords) deck.words = deck.fileWords;
    deck.extra = 0;
  }

  // ---------------------------------------------------------------- папки
  // Папка — { id, title, decks: [id колоды, …], own }. own — своя папка
  // ученика: её можно изменить и удалить. В decks хранятся и id колод,
  // которых сейчас нет (файл не загрузился), — показываются только те, что
  // есть, а когда колода вернётся, она снова окажется в папке.
  var folders = [];
  var folderById = {};

  function cleanFolder(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) return null;
    var ids = [];
    (Array.isArray(raw.decks) ? raw.decks : []).forEach(function (d) {
      d = String(d).trim();
      if (d && ids.indexOf(d) === -1) ids.push(d);
    });
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    return { id: id, title: title || "Папка", decks: ids };
  }

  function folderDecks(folder) {
    return folder.decks.map(function (id) { return deckById[id]; }).filter(Boolean);
  }

  function folderSet(folder) {
    return makeSet("folder", folder.id, folder.title, folderDecks(folder));
  }

  // Папки, где лежит колода (кроме skip — папки, которую сейчас меняют).
  function foldersOf(deck, skip) {
    return folders.filter(function (f) {
      return f !== skip && f.decks.indexOf(deck.id) !== -1;
    });
  }

  // Сначала папки сайта — с проверкой, как у файлов колод, — потом свои.
  function collectFolders() {
    var site = Array.isArray(window.DECK_FOLDERS) ? window.DECK_FOLDERS : [];
    site.forEach(function (raw, i) {
      var folder = cleanFolder(raw);
      if (!folder) {
        errors.push("Папка №" + (i + 1) + " в decks/index.js без id — у каждой папки должен быть свой id.");
        return;
      }
      if (folderById[folder.id]) {
        errors.push("Папка с id «" + folder.id + "» в decks/index.js повторяется — вторая пропущена.");
        return;
      }
      folder.decks.forEach(function (id) {
        if (!deckById[id]) {
          errors.push("В папке «" + folder.title + "» указана колода «" + id +
            "», а колоды с таким id нет — проверьте DECK_FOLDERS в decks/index.js.");
        }
      });
      folderById[folder.id] = folder;
      folders.push(folder);
    });
    loadUser().folders.forEach(function (raw) {
      var folder = cleanFolder(raw);
      if (!folder || folderById[folder.id]) return;
      folder.own = true;
      folderById[folder.id] = folder;
      folders.push(folder);
    });
  }

  // Свои папки — в flashcards-user в порядке создания.
  function storeFolders() {
    loadUser().folders = folders.filter(function (f) { return f.own; }).map(function (f) {
      return { id: f.id, title: f.title, decks: f.decks.slice() };
    });
    return saveUser();
  }

  // folder — своя папка, которую меняют, или null — новая.
  function saveFolder(folder, title, ids) {
    if (!folder) {
      var id = "folder-" + Date.now().toString(36);
      while (folderById[id]) id += "x";
      folder = { id: id, title: "", decks: [], own: true };
      folderById[id] = folder;
      folders.push(folder);
    }
    folder.title = title;
    folder.decks = ids;
    return { folder: folder, stored: storeFolders() };
  }

  function deleteFolder(folder) {
    folders = folders.filter(function (f) { return f !== folder; });
    delete folderById[folder.id];
    storeFolders();
  }

  // Файл колоды для flashcards/decks/ — тот же вид, что у готовых колод.
  function deckFile(deck) {
    var rows = deck.words.map(function (w) {
      return '    { "hanzi": ' + JSON.stringify(w.hanzi) + ', "pinyin": ' + JSON.stringify(w.pinyin) +
        ', "translation": ' + JSON.stringify(w.translation) + " }";
    });
    return "/* Колода раздела «Карточки». Внутри addDeck( … ) — обычный JSON:\n" +
      "   id (латиницей, совпадает с именем файла), title и список слов.\n" +
      "   Прогресс ученика хранится по id, поэтому после публикации id лучше не\n" +
      "   менять — иначе прогресс по колоде начнётся заново. */\n" +
      "addDeck({\n" +
      '  "id": ' + JSON.stringify(deck.id) + ",\n" +
      '  "title": ' + JSON.stringify(deck.title) + ",\n" +
      '  "words": [\n' + rows.join(",\n") + "\n  ]\n" +
      "});\n";
  }

  function downloadDeck(deck) {
    var blob = new Blob([deckFile(deck)], { type: "text/javascript;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = deck.id + ".js";
    document.body.appendChild(a);
    a.click();
    a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------------------------------------------------- экраны
  var currentView = null;

  function show(name) {
    Object.keys(views).forEach(function (key) {
      views[key].hidden = key !== name;
    });
    currentView = name;
    window.scrollTo(0, 0);
  }

  function progressBar(bar, done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    bar.querySelector("span").style.width = pct + "%";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(done));
    bar.setAttribute("aria-label", "Выучено " + done + " из " + total);
    bar.classList.toggle("is-done", total > 0 && done === total);
  }

  function learnedText(set, learned) {
    var total = set.words.length;
    if (!total) return "Слов пока нет";
    if (learned < total) return "Выучено " + learned + " из " + total;
    return (set.kind === "folder" ? "Папка выучена" : "Колода выучена") + " ✓";
  }

  // Плашка колоды или папки: название-ссылка, размер, полоса прогресса.
  function setCard(set, href, size) {
    var byDeck = loadSetProgress(set);
    var learned = learnedCount(set, byDeck);
    var card = el("article", "card fc-deck");
    var h3 = el("h3");
    var link = el("a", null, set.title);
    link.href = href;
    h3.appendChild(link);
    card.appendChild(h3);
    card.appendChild(el("p", null, size));

    var bar = el("div", "fc-progress");
    bar.appendChild(el("span"));
    progressBar(bar, learned, set.words.length);
    card.appendChild(bar);
    card.appendChild(el("p", "card-meta", learnedText(set, learned)));
    return card;
  }

  function deckCard(deck) {
    return setCard(deckSet(deck), deckHash(deck.id), words(deck.words.length));
  }

  var FOLDER_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 ' +
    '2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';

  // У папки — значок, число колод и их названия; плашка «стопкой».
  function folderCard(folder) {
    var set = folderSet(folder);
    var size = set.decks.length
      ? deckCount(set.decks.length) + " · " + words(set.words.length)
      : "Пока без колод";
    var card = setCard(set, folderHash(folder.id), size);
    card.classList.add("fc-folder");
    var icon = el("span", "fc-folder-icon");
    icon.innerHTML = FOLDER_ICON;
    card.querySelector("h3").insertBefore(icon, card.querySelector("h3 a"));
    if (set.decks.length) {
      var names = el("p", "fc-folder-decks", set.decks.map(function (d) { return d.title; }).join(" · "));
      card.insertBefore(names, card.querySelector(".fc-progress"));
    }
    return card;
  }

  // Последняя плашка в «Папках» — создать новую.
  function newFolderCard() {
    var card = el("article", "card is-empty fc-folder-new");
    var h3 = el("h3");
    var link = el("a", null, "+ Новая папка");
    link.href = "#new-folder";
    h3.appendChild(link);
    card.appendChild(h3);
    card.appendChild(el("p", null, "Соберите несколько колод вместе"));
    return card;
  }

  // Папки: свои (новые первыми), потом папки сайта. Колоды из папок
  // остаются и в сетках ниже; свои колоды — отдельной сеткой «Мои колоды»,
  // новые первыми.
  function renderList() {
    var grid = $("[data-deck-grid]");
    var ownGrid = $("[data-own-grid]");
    var folderGrid = $("[data-folder-list]");
    var status = $("[data-deck-status]");
    var errorBox = $("[data-deck-errors]");
    var ownCount = 0;
    grid.textContent = "";
    ownGrid.textContent = "";
    folderGrid.textContent = "";

    var ownFolders = folders.filter(function (f) { return f.own; }).reverse();
    ownFolders.concat(folders.filter(function (f) { return !f.own; })).forEach(function (f) {
      folderGrid.appendChild(folderCard(f));
    });
    folderGrid.appendChild(newFolderCard());
    $("[data-folder-hint]").hidden = folders.length > 0;

    decks.forEach(function (deck) {
      var card = deckCard(deck);
      if (deck.own) {
        ownGrid.insertBefore(card, ownGrid.firstChild);
        ownCount++;
      } else {
        grid.appendChild(card);
      }
    });

    $("[data-own-decks]").hidden = !ownCount;
    status.hidden = decks.length > ownCount;
    status.textContent = "Колод пока нет.";

    errorBox.textContent = "";
    errors.forEach(function (text) {
      errorBox.appendChild(el("p", null, text));
    });
    errorBox.hidden = !errors.length;
  }

  // ---------------------------------------------------------- озвучка
  var synth = window.speechSynthesis;
  var canSpeak = !!(synth && window.SpeechSynthesisUtterance);
  var zhVoice = null;
  var speakBtn = $("[data-speak]");

  function pickVoice() {
    var voices = synth.getVoices() || [];
    zhVoice = voices.filter(function (v) { return /^zh[-_]CN/i.test(v.lang); })[0] ||
      voices.filter(function (v) { return /^(zh|cmn)/i.test(v.lang); })[0] || null;
    // Пустой список — голоса ещё грузятся (или браузер их не перечисляет):
    // кнопку оставляем, речь всё равно запросим с lang = zh-CN. Если голоса
    // есть, но китайского среди них нет, кнопка ничего бы не сказала.
    speakBtn.hidden = voices.length > 0 && !zhVoice;
    root.classList.toggle("fc-no-voice", speakBtn.hidden);
  }

  function speak(text) {
    if (!canSpeak || !text) return;
    try {
      synth.cancel();
      var utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      if (zhVoice) utterance.voice = zhVoice;
      utterance.rate = 0.85;
      synth.speak(utterance);
    } catch (e) {}
  }

  // Кнопки озвучки в строках страницы колоды прячет класс fc-no-voice —
  // по тем же правилам, что кнопку в режиме изучения.
  root.classList.toggle("fc-no-voice", !canSpeak);

  if (canSpeak) {
    pickVoice();
    if (synth.addEventListener) synth.addEventListener("voiceschanged", pickVoice);
    else synth.onvoiceschanged = pickVoice;
  }

  // ------------------------------------------------- страница колоды
  // Сводка прогресса, кнопки «Учить» и список слов. «Спрятать перевод»
  // прячет пиньинь и переводы, тап по строке показывает их у этого слова; выбор
  // запоминается в браузере (не вышло — живёт, пока открыта страница).
  var STATUS_LABEL = { "new": "новое", learning: "изучается", learned: "выучено" };
  var HIDE_KEY = "flashcards-ui:hide-translation";
  var hideTranslation = false;
  var deckOnPage = null;
  var savedNote = null;     // «Сохранено: …» — один раз, после сохранения слов с фото
  var wordList = $("[data-word-list]");
  var hideToggle = $("[data-hide-translation]");

  try {
    hideTranslation = window.localStorage.getItem(HIDE_KEY) === "1";
  } catch (e) {}
  hideToggle.checked = hideTranslation;

  function wordRow(word, status) {
    var li = el("li", "fc-word");
    var hanzi = el("span", "fc-word-hanzi", word.hanzi);
    hanzi.lang = "zh-CN";
    // Число знаков — по нему CSS уменьшает шрифт слов длиннее 5 знаков.
    hanzi.style.setProperty("--fc-hanzi-len", word.hanzi.length);
    li.appendChild(hanzi);

    var text = el("div", "fc-word-text");
    text.appendChild(el("span", "fc-word-pinyin", word.pinyin));
    text.appendChild(el("span", "fc-word-translation", word.translation));
    var badge = el("span", "fc-word-status is-" + status);
    var dot = el("span", "fc-dot is-" + status);
    dot.setAttribute("aria-hidden", "true");
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(STATUS_LABEL[status]));
    text.appendChild(badge);
    li.appendChild(text);

    var say = el("button", "fc-speak fc-word-speak");
    say.type = "button";
    say.title = "Озвучить";
    say.setAttribute("data-say", word.hanzi);
    say.setAttribute("aria-label", "Озвучить " + word.hanzi);
    say.innerHTML = speakBtn.innerHTML;     // тот же значок, что в изучении
    li.appendChild(say);
    return li;
  }

  function setRevealed(row, revealed) {
    var tr = row.querySelector(".fc-word-translation");
    row.classList.toggle("is-revealed", revealed);
    if (hideTranslation && !revealed) tr.setAttribute("aria-label", "Показать пиньинь и перевод");
    else tr.removeAttribute("aria-label");
  }

  function applyHide() {
    wordList.classList.toggle("is-hiding", hideTranslation);
    $("[data-hide-hint]").hidden = !hideTranslation;
    Array.prototype.forEach.call(wordList.querySelectorAll(".fc-word"), function (row) {
      var tr = row.querySelector(".fc-word-translation");
      if (hideTranslation) {
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
      } else {
        tr.removeAttribute("tabindex");
        tr.removeAttribute("role");
      }
      setRevealed(row, false);
    });
  }

  // Сводка на странице колоды или папки (view): сколько слов в каждом
  // статусе, полоса прогресса и доступность кнопок «Учить».
  function renderSummary(view, set, byDeck) {
    var count = { "new": 0, learning: 0, learned: 0 };
    set.words.forEach(function (w) {
      count[wordStatus(set, byDeck, w)]++;
    });
    Object.keys(count).forEach(function (status) {
      view.querySelector('[data-count="' + status + '"]').textContent = count[status];
    });
    progressBar(view.querySelector("[data-deck-progress]"), count.learned, set.words.length);
    view.querySelector("[data-deck-learned]").textContent = learnedText(set, count.learned);
    view.querySelector('[data-learn="due"]').disabled = !set.words.length;
    view.querySelector('[data-learn="missed"]').disabled = !count.learning;
  }

  // «Сохранено: …» / «Папка создана» — один раз, на следующем показе страницы.
  function showNote(node) {
    node.textContent = savedNote || "";
    node.hidden = !savedNote;
    savedNote = null;
  }

  function renderDeck(deck) {
    var set = deckSet(deck);
    var byDeck = loadSetProgress(set);

    wordList.textContent = "";
    deck.words.forEach(function (w) {
      wordList.appendChild(wordRow(w, wordStatus(set, byDeck, w)));
    });
    applyHide();

    $("[data-deck-name]").textContent = deck.title;
    $("[data-deck-size]").textContent = words(deck.words.length);
    renderSummary(views.deck, set, byDeck);

    // Своя колода: где хранится, скачать файл, удалить. Готовая колода со
    // словами с фото: сколько их и как убрать.
    $("[data-own]").hidden = !deck.own && !deck.extra;
    $("[data-own-text]").textContent = deck.own
      ? "Колода собрана по фото и хранится в этом браузере — на другом устройстве её не будет. " +
        "Файл колоды можно скачать: отправить преподавателю или добавить на сайт."
      : words(deck.extra || 0) + " добавлено по фото — они есть только в этом браузере.";
    $("[data-own-download]").hidden = !deck.own;
    $("[data-own-delete]").textContent = deck.own ? "Удалить колоду" : "Убрать добавленные слова";
    showNote($("[data-saved-note]"));
  }

  // ------------------------------------------------- страница папки
  // Как у колоды: сводка и «Учить», только вместо слов — колоды папки.
  // Своя папка — ещё «Изменить» и «Удалить».
  function renderFolder(folder) {
    var view = views.folder;
    var set = folderSet(folder);
    var byDeck = loadSetProgress(set);
    var grid = view.querySelector("[data-folder-grid]");

    view.querySelector("[data-folder-name]").textContent = folder.title;
    view.querySelector("[data-folder-size]").textContent = set.decks.length
      ? deckCount(set.decks.length) + " · " + words(set.words.length)
      : "Пока без колод";
    renderSummary(view, set, byDeck);

    grid.textContent = "";
    set.decks.forEach(function (deck) {
      grid.appendChild(deckCard(deck));
    });
    view.querySelector("[data-folder-empty]").hidden = set.decks.length > 0;

    view.querySelector("[data-folder-own]").hidden = !folder.own;
    view.querySelector("[data-folder-edit]").setAttribute("href", folderHash(folder.id, "edit"));
    showNote(view.querySelector("[data-folder-note]"));
  }

  // ------------------------------------------------- редактор папки
  // #new-folder — новая папка, #folder=<id>&edit — своя папка. Название и
  // колоды галочками; у колоды подписано, в каких папках она уже лежит.
  var editing = null;      // папка в редакторе; null — новая
  var editForm = views.edit.querySelector("[data-folder-form]");
  var editTitle = views.edit.querySelector("[data-folder-title]");
  var pickList = views.edit.querySelector("[data-pick-list]");
  var editError = views.edit.querySelector("[data-folder-error]");

  function pickRow(deck, checked) {
    var li = el("li");
    var label = el("label", "fc-pick-row");
    var box = el("input");
    box.type = "checkbox";
    box.value = deck.id;
    box.checked = checked;
    label.appendChild(box);
    var text = el("span", "fc-pick-text");
    text.appendChild(el("span", "fc-pick-title", deck.title));
    var meta = [words(deck.words.length)];
    if (deck.own) meta.push("моя колода");
    var inFolders = foldersOf(deck, editing).map(function (f) { return "«" + f.title + "»"; });
    if (inFolders.length) meta.push((inFolders.length > 1 ? "в папках " : "в папке ") + inFolders.join(", "));
    text.appendChild(el("span", "fc-pick-meta", meta.join(" · ")));
    label.appendChild(text);
    li.appendChild(label);
    return li;
  }

  function pickedIds() {
    return Array.prototype.filter.call(pickList.querySelectorAll("input"), function (box) {
      return box.checked;
    }).map(function (box) { return box.value; });
  }

  // Отмеченные строки подсвечиваются классом (не :has — его нет в старых
  // браузерах телефонов), рядом с «Колоды» — сколько выбрано.
  function updatePicked() {
    Array.prototype.forEach.call(pickList.querySelectorAll(".fc-pick-row"), function (row) {
      row.classList.toggle("is-checked", row.querySelector("input").checked);
    });
    var n = pickedIds().length;
    views.edit.querySelector("[data-pick-count]").textContent = n ? "выбрано " + n : "";
  }

  function setEditError(text) {
    editError.textContent = text || "";
    editError.hidden = !text;
  }

  function openEditor(folder) {
    var view = views.edit;
    editing = folder || null;
    var back = folder ? folderHash(folder.id) : "";
    Array.prototype.forEach.call(view.querySelectorAll("[data-back]"), function (node) {
      node.setAttribute("data-back", back);
      node.setAttribute("href", back || "#");
    });
    view.querySelector("[data-edit-title]").textContent = folder ? "Изменить папку" : "Новая папка";
    view.querySelector("[data-folder-save]").textContent = folder ? "Сохранить" : "Создать папку";
    view.querySelector("[data-folder-delete-line]").hidden = !folder;
    editTitle.value = folder ? folder.title : "";

    // Свои колоды (новые первыми) — сверху, как в списке.
    var own = decks.filter(function (d) { return d.own; }).reverse();
    pickList.textContent = "";
    own.concat(decks.filter(function (d) { return !d.own; })).forEach(function (deck) {
      pickList.appendChild(pickRow(deck, !!folder && folder.decks.indexOf(deck.id) !== -1));
    });
    view.querySelector("[data-pick-empty]").hidden = decks.length > 0;
    setEditError("");
    updatePicked();
    document.title = (folder ? "Изменить папку" : "Новая папка") + " — Карточки — Китайский язык";
    show("edit");
  }

  pickList.addEventListener("change", function () {
    updatePicked();
    if (pickedIds().length) setEditError("");
  });

  editForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var title = editTitle.value.trim().slice(0, 60);
    var ids = pickedIds();
    if (!title) {
      setEditError("Напишите название папки.");
      editTitle.focus();
      return;
    }
    if (!ids.length) {
      setEditError("Отметьте хотя бы одну колоду.");
      return;
    }
    // Колоды, которых сейчас нет в списке (файл не загрузился), остаются в папке.
    if (editing) {
      editing.decks.forEach(function (id) {
        if (!deckById[id] && ids.indexOf(id) === -1) ids.push(id);
      });
    }
    var wasNew = !editing;
    var res = saveFolder(editing, title, ids);
    savedNote = (wasNew ? "Папка создана." : "Папка сохранена.") + (res.stored ? ""
      : " Но браузер не даёт её запомнить — она пропадёт, когда закроете страницу.");
    editing = null;
    // Новая — вместо записи #new-folder в истории; изменённая — назад к ней.
    if (wasNew) navigate(folderHash(res.folder.id), true);
    else goBack(folderHash(res.folder.id));
  });

  hideToggle.addEventListener("change", function () {
    hideTranslation = hideToggle.checked;
    try {
      window.localStorage.setItem(HIDE_KEY, hideTranslation ? "1" : "0");
    } catch (e) {}
    applyHide();
  });

  wordList.addEventListener("keydown", function (e) {
    if (!hideTranslation || !e.target.classList.contains("fc-word-translation")) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      var row = e.target.closest(".fc-word");
      setRevealed(row, !row.classList.contains("is-revealed"));
    }
  });

  // ---------------------------------------------------------- сессия
  var card = $("[data-card]");
  var stage = $("[data-stage]");
  var tintKnow = card.querySelector(".fc-tint.is-know");
  var tintMiss = card.querySelector(".fc-tint.is-miss");
  var undoBtn = $("[data-undo]");
  var resultUndoBtn = $("[data-undo-result]");
  var session = null;
  var busy = false;      // карточка улетает — новые ответы не принимаем

  // Слово «колода» в подписях итогов и «Колода выучена»: у папки — «папка»
  // в том же падеже (форма для папки — в атрибуте data-folder-word).
  var kindWords = Array.prototype.map.call(root.querySelectorAll("[data-folder-word]"), function (node) {
    return { node: node, deck: node.textContent, folder: node.getAttribute("data-folder-word") };
  });

  function setKindWords(kind) {
    kindWords.forEach(function (k) {
      k.node.textContent = kind === "folder" ? k.folder : k.deck;
    });
  }

  // set — колода или папка (см. makeSet); list — слова сессии:
  // невыученные, все или незнакомые из прошлой сессии.
  function startSession(set, list) {
    var byDeck = loadSetProgress(set);
    session = {
      set: set,
      byDeck: byDeck,
      queue: byStatus(set, list, byDeck),
      size: list.length,
      know: 0,
      miss: 0,
      missed: [],
      history: []         // состояние перед каждым ответом — для «Предыдущей карточки»
    };

    $("[data-deck-title]").textContent = set.title;
    document.title = set.title + " — Карточки — Китайский язык";
    setKindWords(set.kind);
    show("study");
    showCard();
  }

  function updateCounter() {
    $("[data-left]").textContent = session.queue.length;
    $("[data-know]").textContent = session.know;
    $("[data-miss]").textContent = session.miss;
    undoBtn.disabled = !session.history.length;
    resultUndoBtn.hidden = !session.history.length;
  }

  function setFlipped(flipped, animate) {
    if (!animate) card.classList.add("no-anim");
    card.classList.toggle("is-flipped", flipped);
    card.setAttribute("aria-label", flipped
      ? "Обратная сторона: " + session.queue[0].pinyin + " — " + session.queue[0].translation
      : "Карточка. Нажмите, чтобы перевернуть");
    if (!animate) {
      void card.offsetWidth;               // применить без перехода
      card.classList.remove("no-anim");
    }
  }

  // enter — класс анимации появления: is-entering (следующая карточка) или
  // is-coming-back (вернулась «Предыдущая карточка»).
  function showCard(enter) {
    updateCounter();
    if (!session.queue.length) {
      finishSession();
      return;
    }
    var word = session.queue[0];
    var front = $("[data-front-hanzi]");
    front.textContent = word.hanzi;
    front.classList.toggle("is-long", word.hanzi.length > 2);
    front.classList.toggle("is-xlong", word.hanzi.length > 4);
    $("[data-back-hanzi]").textContent = word.hanzi;
    $("[data-pinyin]").textContent = word.pinyin;
    $("[data-translation]").textContent = word.translation;

    resetDrag(false);
    setFlipped(false, false);
    stage.classList.toggle("has-more", session.queue.length > 1);
    card.classList.remove("is-entering", "is-coming-back");
    if (enter && !reduceMotion) {
      void card.offsetWidth;
      card.classList.add(enter);
    }
    busy = false;
  }

  function flip() {
    if (!session || busy || currentView !== "study") return;
    setFlipped(!card.classList.contains("is-flipped"), !reduceMotion);
  }

  function answer(known) {
    var word = session.queue[0];
    session.history.push({
      queue: session.queue.slice(),
      know: session.know,
      miss: session.miss,
      missed: session.missed.slice(),
      statuses: ownerStatuses(session.set, session.byDeck, word),
      known: known
    });
    session.queue.shift();

    if (known) {
      session.know++;
    } else {
      session.miss++;
      session.queue.push(word);
      if (session.missed.indexOf(word) === -1) session.missed.push(word);
    }
    setWordStatus(session.set, session.byDeck, word, known ? "learned" : "learning");
    showCard("is-entering");
  }

  // «Предыдущая карточка»: отменяет последний ответ — очередь, счётчики и
  // статус слова становятся как до него. Работает и с экрана итогов, если
  // промахнулись на последней карточке.
  function undo() {
    if (!session || busy || !session.history.length) return;
    if (currentView !== "study" && currentView !== "result") return;
    var step = session.history.pop();
    session.queue = step.queue;
    session.know = step.know;
    session.miss = step.miss;
    session.missed = step.missed;
    setWordStatus(session.set, session.byDeck, step.queue[0], step.statuses);

    if (currentView !== "study") show("study");
    // Карточка прилетает с той стороны, куда её смахнули.
    card.style.setProperty("--fc-from", step.known ? 1 : -1);
    showCard("is-coming-back");
  }

  // Карточка улетает в сторону ответа, затем — следующая.
  function commit(known) {
    if (!session || busy || currentView !== "study" || !session.queue.length) return;
    busy = true;
    if (reduceMotion) {
      answer(known);
      return;
    }
    var dir = known ? 1 : -1;
    var distance = Math.max(window.innerWidth, 600);
    tint(dir, 1);
    card.classList.remove("is-dragging", "is-entering", "is-coming-back");
    card.classList.add("is-flying");
    card.style.transform = "translate(" + dir * distance + "px, " + drag.dy + "px) rotate(" + dir * 28 + "deg)";
    setTimeout(function () {
      card.classList.remove("is-flying");
      answer(known);
    }, FLY_MS);
  }

  // «Выучено» на экране итогов.
  function renderLearned(set, byDeck) {
    var total = set.words.length;
    var learned = learnedCount(set, byDeck);
    $("[data-result-learned]").textContent = learned + " / " + total;
    progressBar($("[data-result-progress]"), learned, total);
  }

  function finishSession() {
    var set = session.set;
    var missed = session.missed.length;
    busy = false;          // последняя карточка улетела — иначе не сработает «Вернуться к последней»

    $("[data-result-deck]").textContent = set.title;
    $("[data-result-summary]").textContent = set.title + " · " + words(session.size) + " в сессии";
    $("[data-result-first]").textContent = session.size - missed;
    $("[data-result-missed]").textContent = missed;
    renderLearned(set, session.byDeck);

    var list = $("[data-missed-list]");
    list.textContent = "";
    session.missed.forEach(function (w) {
      var li = el("li");
      var hanzi = el("span", "fc-missed-hanzi", w.hanzi);
      hanzi.lang = "zh-CN";
      li.appendChild(hanzi);
      li.appendChild(el("span", "fc-missed-pinyin", w.pinyin));
      li.appendChild(el("span", "fc-missed-translation", w.translation));
      list.appendChild(li);
    });
    $("[data-missed-block]").hidden = !missed;
    $('[data-again="missed"]').hidden = !missed;
    $("[data-reset-done]").hidden = true;
    show("result");
  }

  // -------------------------------------------------------- свайп
  // Pointer Events: одинаково для пальца и мыши. touch-action: pan-y у
  // карточки (см. css/style.css) оставляет странице вертикальную прокрутку,
  // а горизонтальный жест отдаёт сюда.
  var drag = { id: null, x: 0, y: 0, dx: 0, dy: 0, moved: false, lastX: 0, lastT: 0, v: 0 };
  var suppressClickUntil = 0;

  function tint(dir, amount) {
    tintKnow.style.opacity = dir > 0 ? amount : 0;
    tintMiss.style.opacity = dir < 0 ? amount : 0;
  }

  function threshold() {
    return Math.min(120, stage.clientWidth * 0.3);
  }

  function resetDrag(animate) {
    drag.id = null;
    drag.dx = drag.dy = 0;
    drag.moved = false;
    card.classList.remove("is-dragging");
    card.classList.toggle("is-returning", !!animate && !reduceMotion);
    card.style.transform = "";
    tint(0, 0);
  }

  card.addEventListener("transitionend", function (e) {
    if (e.target === card && e.propertyName === "transform") card.classList.remove("is-returning");
  });

  card.addEventListener("pointerdown", function (e) {
    if (busy || drag.id !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.id = e.pointerId;
    drag.x = drag.lastX = e.clientX;
    drag.y = e.clientY;
    drag.lastT = performance.now();
    drag.v = 0;
    drag.moved = false;
    try { card.setPointerCapture(e.pointerId); } catch (err) {}
  });

  card.addEventListener("pointermove", function (e) {
    if (e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(drag.dx) < 8) return;
      drag.moved = true;
      card.classList.remove("is-returning", "is-entering", "is-coming-back");
      card.classList.add("is-dragging");
    }
    var now = performance.now();
    if (now > drag.lastT) {
      drag.v = (e.clientX - drag.lastX) / (now - drag.lastT);
      drag.lastX = e.clientX;
      drag.lastT = now;
    }
    var rotate = Math.max(-18, Math.min(18, drag.dx * 0.06));
    card.style.transform = "translate(" + drag.dx + "px, " + drag.dy * 0.25 + "px) rotate(" + rotate + "deg)";
    tint(drag.dx, Math.min(1, Math.abs(drag.dx) / threshold()));
  });

  function endDrag(e, cancelled) {
    if (e.pointerId !== drag.id) return;
    drag.id = null;
    if (!drag.moved) return;               // это был тап — перевернёт click
    suppressClickUntil = performance.now() + 400;
    var dx = drag.dx;
    var fast = Math.abs(drag.v) > 0.6 && Math.abs(dx) > 40 && (drag.v > 0) === (dx > 0);
    if (!cancelled && (Math.abs(dx) >= threshold() || fast)) {
      drag.dy *= 0.25;
      commit(dx > 0);
    } else {
      resetDrag(true);                      // слабый свайп — карточка на место
    }
  }

  card.addEventListener("pointerup", function (e) { endDrag(e, false); });
  card.addEventListener("pointercancel", function (e) { endDrag(e, true); });
  card.addEventListener("lostpointercapture", function (e) { endDrag(e, true); });

  card.addEventListener("click", function () {
    if (performance.now() < suppressClickUntil) return;
    flip();
  });

  card.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      flip();
    }
  });

  card.addEventListener("dragstart", function (e) { e.preventDefault(); });

  // ----------------------------------------------- кнопки и клавиатура
  root.addEventListener("click", function (e) {
    // Переходы внутри раздела. Клик с модификатором (новая вкладка и т. п.)
    // браузер обрабатывает сам.
    var plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    var backLink = e.target.closest("[data-back]");
    if (backLink && plain) {
      e.preventDefault();
      goBack(backLink.getAttribute("data-back"));
      return;
    }
    var hashLink = e.target.closest('a[href^="#"]');
    if (hashLink && plain) {
      e.preventDefault();
      var href = hashLink.getAttribute("href");
      navigate(href === "#" ? "" : href);
      return;
    }
    var learnBtn = e.target.closest("[data-learn]");
    if (learnBtn && (deckOnPage || folderOnPage)) {
      var mode = learnBtn.getAttribute("data-learn");
      navigate(deckOnPage ? deckHash(deckOnPage.id, mode) : folderHash(folderOnPage.id, mode));
      return;
    }
    // «Удалить папку» — на странице папки и в редакторе. Колоды остаются.
    var folderToDelete = folderOnPage || editing;
    if (e.target.closest("[data-folder-delete]") && folderToDelete && folderToDelete.own) {
      if (!window.confirm("Удалить папку «" + folderToDelete.title + "»?\n" +
          "Колоды из неё не удалятся и останутся в списке.")) return;
      deleteFolder(folderToDelete);
      editing = null;
      goBack("");
      return;
    }
    var sayBtn = e.target.closest("[data-say]");
    if (sayBtn) {
      speak(sayBtn.getAttribute("data-say"));
      return;
    }
    if (e.target.closest("[data-own-download]") && deckOnPage) {
      downloadDeck(deckOnPage);
      return;
    }
    if (e.target.closest("[data-own-delete]") && deckOnPage) {
      var own = deckOnPage;
      if (own.own) {
        if (!window.confirm("Удалить колоду «" + own.title + "»?\nСлова и прогресс по ней пропадут.")) return;
        deleteOwnDeck(own);
        navigate("", true);
      } else {
        if (!window.confirm("Убрать из колоды «" + own.title + "» слова, добавленные по фото?")) return;
        removeExtra(own);
        renderDeck(own);
      }
      return;
    }
    var row = e.target.closest(".fc-word");
    if (row && hideTranslation) {
      setRevealed(row, !row.classList.contains("is-revealed"));
      return;
    }

    var answerBtn = e.target.closest("[data-answer]");
    if (answerBtn) {
      drag.dy = 0;
      commit(answerBtn.getAttribute("data-answer") === "know");
      return;
    }
    if (e.target.closest("[data-speak]")) {
      if (session && session.queue.length) speak(session.queue[0].hanzi);
      return;
    }
    if (e.target.closest("[data-undo]")) {
      undo();
      return;
    }
    var again = e.target.closest("[data-again]");
    if (again && session) {
      startSession(session.set, again.getAttribute("data-again") === "all"
        ? session.set.words
        : session.missed.slice());
      return;
    }
    // У папки сбрасывается прогресс всех её колод.
    if (e.target.closest("[data-reset]") && session) {
      var set = session.set;
      if (!window.confirm(set.kind === "folder"
          ? "Сбросить прогресс всех колод папки «" + set.title + "»?\nВсе их слова снова станут новыми."
          : "Сбросить прогресс колоды «" + set.title + "»?\nВсе слова снова станут новыми.")) return;
      set.decks.forEach(function (d) { resetProgress(d.id); });
      session.byDeck = loadSetProgress(set);
      // Отменять ответы после сброса незачем: вернули бы статусы, которых уже нет.
      session.history = [];
      resultUndoBtn.hidden = true;
      renderLearned(set, session.byDeck);
      $("[data-reset-done]").hidden = false;
    }
  });

  document.addEventListener("keydown", function (e) {
    if (currentView !== "study" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft" || e.key === "Left") {
      e.preventDefault();
      drag.dy = 0;
      commit(false);
    } else if (e.key === "ArrowRight" || e.key === "Right") {
      e.preventDefault();
      drag.dy = 0;
      commit(true);
    } else if (e.key === " " || e.key === "Spacebar") {
      // Пробел всегда переворачивает — даже когда фокус на кнопке «Знаю»,
      // которую он иначе нажал бы.
      e.preventDefault();
      if (!e.repeat) flip();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (!e.repeat) undo();
    }
  });

  document.addEventListener("keyup", function (e) {
    if (currentView === "study" && (e.key === " " || e.key === "Spacebar")) e.preventDefault();
  });

  // ------------------------------------------------------------ адрес
  // Без адреса — список, #deck=<id> — страница колоды, #deck=<id>&learn —
  // изучение невыученных слов (&learn=missed — только слов со статусом
  // «изучается», &learn=all — всей колоды). У папок то же самое с
  // #folder=<id>, плюс #folder=<id>&edit — изменить свою папку и
  // #new-folder — создать. Так работает кнопка «Назад» в браузере и можно
  // дать ученику ссылку сразу на колоду или папку.
  //
  // Переход внутри раздела запоминает в истории, откуда пришли (fcFrom).
  // Тогда «← Назад» на странице — это шаг назад по истории, как у кнопки
  // браузера, и повторов в истории не копится. Если прийти было неоткуда
  // (открыли по ссылке), «← Назад» подменяет текущую запись. Подмена
  // записи сохраняет её fcFrom: после «Сохранить» новая страница встаёт
  // на место старой, и «Назад» с неё ведёт туда же, куда вёл бы со старой.
  var baseTitle = document.title;
  var routedHash = null;
  var folderOnPage = null;

  // mode: "due"/true — невыученные слова, "missed", "all", "edit".
  function itemHash(kind, id, mode) {
    var hash = "#" + kind + "=" + encodeURIComponent(id);
    if (mode === "missed" || mode === "all") hash += "&learn=" + mode;
    else if (mode === "edit") hash += "&edit";
    else if (mode) hash += "&learn";
    return hash;
  }

  function deckHash(id, mode) {
    return itemHash("deck", id, mode);
  }

  function folderHash(id, mode) {
    return itemHash("folder", id, mode);
  }

  function navigate(hash, replace) {
    var url = hash || window.location.pathname + window.location.search;
    try {
      if (replace) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState({ fcFrom: window.location.hash }, "", url);
    } catch (e) {
      // История недоступна (бывает у страниц с диска) — обычная смена адреса,
      // дальше всё сделает hashchange.
      if (replace) window.location.replace(hash || "#");
      else window.location.hash = hash;
      return;
    }
    route();
  }

  function goBack(hash) {
    var state = window.history.state;
    if (state && state.fcFrom === hash) window.history.back();
    else navigate(hash, true);
  }

  // Ссылки «назад к колоде» на экранах изучения, итогов и «Колода выучена».
  function setBackLinks(set) {
    var hash = itemHash(set.kind, set.id);
    Array.prototype.forEach.call(root.querySelectorAll("[data-back-deck]"), function (node) {
      node.setAttribute("href", hash);
      node.setAttribute("data-back", hash);
    });
  }

  // «← Назад» со страницы колоды: в папку, если пришли из неё, иначе к списку.
  function setDeckBack(deck) {
    var state = window.history.state;
    var from = state && typeof state.fcFrom === "string" ? state.fcFrom : "";
    var m = /^#folder=([^&]+)$/.exec(from);
    var folder = null;
    try {
      folder = m ? folderById[decodeURIComponent(m[1])] : null;
    } catch (e) {}
    var back = folder && folder.decks.indexOf(deck.id) !== -1 ? from : "";
    var link = views.deck.querySelector("[data-back]");
    link.setAttribute("data-back", back);
    link.setAttribute("href", back || "#");
  }

  function route() {
    routedHash = window.location.hash;
    var match = /^#(deck|folder)=([^&]+)(?:&(learn|edit)(?:=(\w+))?)?$/.exec(routedHash);
    var id = null;
    try {
      id = match ? decodeURIComponent(match[2]) : null;
    } catch (e) {}
    var deck = id && match[1] === "deck" ? deckById[id] : null;
    var folder = id && match[1] === "folder" ? folderById[id] : null;
    var set = deck ? deckSet(deck) : folder ? folderSet(folder) : null;
    var mode = match ? match[3] : null;
    editing = null;

    // Учить нечего: невыученных слов нет — экран «Колода выучена»,
    // незнакомых нет — страница колоды (папки).
    var allLearned = false;
    if (set && mode === "learn") {
      var learn = match[4];
      var list = learn === "missed" ? learningWords(set)
        : learn === "all" ? set.words
        : unlearnedWords(set);
      if (list.length) {
        deckOnPage = folderOnPage = null;
        setBackLinks(set);
        startSession(set, list);
        return;
      }
      allLearned = learn !== "missed" && set.words.length > 0;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    session = null;
    busy = false;
    deckOnPage = folderOnPage = null;
    // #photo — проверка слов с фото (js/photo-cards.js). Без фото в работе
    // (например, страницу перезагрузили) показывать нечего — к списку.
    if (routedHash === "#photo") {
      if (window.PhotoCards && window.PhotoCards.active()) {
        document.title = "Карточки по фото — Карточки — Китайский язык";
        show("photo");
      } else {
        navigate("", true);
      }
      return;
    }
    // Редактор — только для своих папок; папку сайта откроет её страница.
    if (routedHash === "#new-folder" || (folder && folder.own && mode === "edit")) {
      openEditor(folder);
      return;
    }
    if (set) {
      deckOnPage = deck;
      folderOnPage = folder;
      document.title = set.title + " — Карточки — Китайский язык";
      if (allLearned) {
        setBackLinks(set);
        setKindWords(set.kind);
        $("[data-done-deck]").textContent = set.title;
        show("done");
        return;
      }
      if (deck) {
        setDeckBack(deck);
        renderDeck(deck);
        show("deck");
      } else {
        renderFolder(folder);
        show("folder");
      }
      return;
    }
    document.title = baseTitle;
    renderList();
    show("list");
  }

  // Шаг по истории присылает и popstate, и hashchange — разбираем адрес
  // один раз, иначе сессия изучения начнётся дважды.
  function onAddressChange() {
    if (window.location.hash !== routedHash) route();
  }

  window.addEventListener("hashchange", onAddressChange);
  window.addEventListener("popstate", onAddressChange);

  // Для js/photo-cards.js: список колод, сохранение слов и переходы. Сам
  // он не знает, как устроены колоды и адреса раздела.
  window.Flashcards = {
    list: function () {
      return decks.map(function (d) {
        return { id: d.id, title: d.title, size: d.words.length, own: !!d.own };
      });
    },
    save: saveWords,
    openPhoto: function () {
      if (window.location.hash === "#photo") route();
      else navigate("#photo");
    },
    // Сохранили — на страницу колоды вместо записи #photo в истории.
    openDeck: function (id, note) {
      savedNote = note || null;
      navigate(deckHash(id), true);
    }
  };

  loadDecks(function (files) {
    collectDecks(files);
    collectOwnDecks();
    collectFolders();
    route();
  });
})();
