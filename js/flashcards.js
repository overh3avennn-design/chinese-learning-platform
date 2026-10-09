/* Раздел «Карточки» (flashcards/index.html): список колод, страница
   колоды со списком слов, изучение карточек и итоги сессии. Подключается только на этой странице, после
   flashcards/decks/index.js.

   Колоды. Каждая колода — файл flashcards/decks/<id>.js с вызовом
   addDeck({ id, title, words }), их список — window.DECK_FILES в
   decks/index.js. Скрипты, а не JSON через fetch: страница открывается и
   прямо с диска (file://), а там fetch к соседним файлам браузер
   запрещает. Тег <script> работает и с диска, и на сайте.

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
    done: $('[data-view="done"]')
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

  // «Новое» — на слово ещё ни разу не отвечали (записи нет).
  function wordStatus(progress, word) {
    return progress.words[wordKey(word)] || "new";
  }

  function learnedCount(deck, progress) {
    return deck.words.filter(function (w) {
      return wordStatus(progress, w) === "learned";
    }).length;
  }

  function learningWords(deck) {
    var progress = loadProgress(deck.id);
    return deck.words.filter(function (w) {
      return wordStatus(progress, w) === "learning";
    });
  }

  function unlearnedWords(deck) {
    var progress = loadProgress(deck.id);
    return deck.words.filter(function (w) {
      return wordStatus(progress, w) !== "learned";
    });
  }

  // В сессии сначала изучаемые слова, потом новые, потом выученные (они
  // бывают, когда колоду проходят целиком); внутри статуса — вперемешку.
  var STATUS_ORDER = { learning: 0, "new": 1, learned: 2 };

  function byStatus(list, progress) {
    return shuffle(list.slice()).sort(function (a, b) {
      return STATUS_ORDER[wordStatus(progress, a)] - STATUS_ORDER[wordStatus(progress, b)];
    });
  }

  // --------------------------------------------------------------- колоды
  var decks = [];
  var deckById = {};
  var errors = [];

  function cleanDeck(raw, file) {
    if (!raw || typeof raw !== "object") return null;
    var id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : file.replace(/\.js$/, "");
    var list = Array.isArray(raw.words) ? raw.words : [];
    var clean = [];
    var seen = {};
    list.forEach(function (w) {
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
    return {
      id: id,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
      words: clean,
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

  function renderList() {
    var grid = $("[data-deck-grid]");
    var status = $("[data-deck-status]");
    var errorBox = $("[data-deck-errors]");
    grid.textContent = "";

    decks.forEach(function (deck) {
      var progress = loadProgress(deck.id);
      var learned = learnedCount(deck, progress);
      var total = deck.words.length;

      var card = el("article", "card fc-deck");
      var h3 = el("h3");
      var link = el("a", null, deck.title);
      link.href = "#deck=" + encodeURIComponent(deck.id);
      h3.appendChild(link);
      card.appendChild(h3);
      card.appendChild(el("p", null, words(total)));

      var bar = el("div", "fc-progress");
      bar.appendChild(el("span"));
      progressBar(bar, learned, total);
      card.appendChild(bar);

      card.appendChild(el("p", "card-meta", learned === total
        ? "Колода выучена ✓"
        : "Выучено " + learned + " из " + total));
      grid.appendChild(card);
    });

    status.hidden = decks.length > 0;
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
  // Сводка прогресса, кнопки «Учить» и список слов. «Скрыть перевод»
  // прячет переводы, тап по строке показывает перевод этого слова; выбор
  // запоминается в браузере (не вышло — живёт, пока открыта страница).
  var STATUS_LABEL = { "new": "новое", learning: "изучается", learned: "выучено" };
  var HIDE_KEY = "flashcards-ui:hide-translation";
  var hideTranslation = false;
  var deckOnPage = null;
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
    if (hideTranslation && !revealed) tr.setAttribute("aria-label", "Показать перевод");
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

  function renderDeck(deck) {
    var progress = loadProgress(deck.id);
    var total = deck.words.length;
    var count = { "new": 0, learning: 0, learned: 0 };

    wordList.textContent = "";
    deck.words.forEach(function (w) {
      var status = wordStatus(progress, w);
      count[status]++;
      wordList.appendChild(wordRow(w, status));
    });
    applyHide();

    $("[data-deck-name]").textContent = deck.title;
    $("[data-deck-size]").textContent = words(total);
    Object.keys(count).forEach(function (status) {
      $('[data-count="' + status + '"]').textContent = count[status];
    });
    progressBar($("[data-deck-progress]"), count.learned, total);
    $("[data-deck-learned]").textContent = count.learned === total
      ? "Колода выучена ✓"
      : "Выучено " + count.learned + " из " + total;
    $('[data-learn="missed"]').disabled = !count.learning;
  }

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
  var session = null;
  var busy = false;      // карточка улетает — новые ответы не принимаем

  // list — слова сессии: невыученные, вся колода или незнакомые из
  // прошлой сессии.
  function startSession(deck, list) {
    var progress = loadProgress(deck.id);
    session = {
      deck: deck,
      progress: progress,
      queue: byStatus(list, progress),
      size: list.length,
      know: 0,
      miss: 0,
      missed: []
    };

    $("[data-deck-title]").textContent = deck.title;
    document.title = deck.title + " — Карточки — Китайский язык";
    show("study");
    showCard(false);
  }

  function updateCounter() {
    $("[data-left]").textContent = session.queue.length;
    $("[data-know]").textContent = session.know;
    $("[data-miss]").textContent = session.miss;
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
    if (enter && !reduceMotion) {
      card.classList.remove("is-entering");
      void card.offsetWidth;
      card.classList.add("is-entering");
    }
    busy = false;
  }

  function flip() {
    if (!session || busy || currentView !== "study") return;
    setFlipped(!card.classList.contains("is-flipped"), !reduceMotion);
  }

  function answer(known) {
    var word = session.queue.shift();
    var progress = session.progress;

    if (known) {
      progress.words[wordKey(word)] = "learned";
      session.know++;
    } else {
      progress.words[wordKey(word)] = "learning";
      session.miss++;
      session.queue.push(word);
      if (session.missed.indexOf(word) === -1) session.missed.push(word);
    }
    saveProgress(session.deck.id, progress);
    showCard(true);
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
    card.classList.remove("is-dragging", "is-entering");
    card.classList.add("is-flying");
    card.style.transform = "translate(" + dir * distance + "px, " + drag.dy + "px) rotate(" + dir * 28 + "deg)";
    setTimeout(function () {
      card.classList.remove("is-flying");
      answer(known);
    }, FLY_MS);
  }

  // «Выучено» на экране итогов.
  function renderLearned(deck, progress) {
    var total = deck.words.length;
    var learned = learnedCount(deck, progress);
    $("[data-result-learned]").textContent = learned + " / " + total;
    progressBar($("[data-result-progress]"), learned, total);
  }

  function finishSession() {
    var deck = session.deck;
    var missed = session.missed.length;

    $("[data-result-deck]").textContent = deck.title;
    $("[data-result-summary]").textContent = deck.title + " · " + words(session.size) + " в сессии";
    $("[data-result-first]").textContent = session.size - missed;
    $("[data-result-missed]").textContent = missed;
    renderLearned(deck, session.progress);

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
      card.classList.remove("is-returning", "is-entering");
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
    if (learnBtn && deckOnPage) {
      navigate(deckHash(deckOnPage.id, learnBtn.getAttribute("data-learn")));
      return;
    }
    var sayBtn = e.target.closest("[data-say]");
    if (sayBtn) {
      speak(sayBtn.getAttribute("data-say"));
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
    var again = e.target.closest("[data-again]");
    if (again && session) {
      startSession(session.deck, again.getAttribute("data-again") === "all"
        ? session.deck.words
        : session.missed.slice());
      return;
    }
    if (e.target.closest("[data-reset]") && session) {
      var deck = session.deck;
      if (!window.confirm("Сбросить прогресс колоды «" + deck.title + "»?\n" +
          "Все слова снова станут новыми.")) return;
      resetProgress(deck.id);
      session.progress = loadProgress(deck.id);
      renderLearned(deck, session.progress);
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
    }
  });

  document.addEventListener("keyup", function (e) {
    if (currentView === "study" && (e.key === " " || e.key === "Spacebar")) e.preventDefault();
  });

  // ------------------------------------------------------------ адрес
  // Без адреса — список, #deck=<id> — страница колоды, #deck=<id>&learn —
  // изучение невыученных слов (&learn=missed — только слов со статусом
  // «изучается», &learn=all — всей колоды). Так
  // работает кнопка «Назад» в браузере и можно дать ученику ссылку сразу
  // на колоду.
  //
  // Переход внутри раздела запоминает в истории, откуда пришли (fcFrom).
  // Тогда «← Назад» на странице — это шаг назад по истории, как у кнопки
  // браузера, и повторов в истории не копится. Если прийти было неоткуда
  // (открыли по ссылке), «← Назад» подменяет текущую запись.
  var baseTitle = document.title;
  var routedHash = null;

  function deckHash(id, learn) {
    var hash = "#deck=" + encodeURIComponent(id);
    if (learn === "missed" || learn === "all") hash += "&learn=" + learn;
    else if (learn) hash += "&learn";
    return hash;
  }

  function navigate(hash, replace) {
    var url = hash || window.location.pathname + window.location.search;
    try {
      if (replace) window.history.replaceState(null, "", url);
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

  function setBackLinks(deck) {
    var hash = deckHash(deck.id);
    Array.prototype.forEach.call(root.querySelectorAll("[data-back-deck]"), function (node) {
      node.setAttribute("href", hash);
      node.setAttribute("data-back", hash);
    });
  }

  function route() {
    routedHash = window.location.hash;
    var match = /^#deck=([^&]+)(&learn(?:=(\w+))?)?$/.exec(routedHash);
    var id = null;
    try {
      id = match ? decodeURIComponent(match[1]) : null;
    } catch (e) {}
    var deck = id && deckById[id];

    // Учить нечего: невыученных слов нет — экран «Колода выучена»,
    // незнакомых нет — страница колоды.
    var allLearned = false;
    if (deck && match[2]) {
      var learn = match[3];
      var list = learn === "missed" ? learningWords(deck)
        : learn === "all" ? deck.words
        : unlearnedWords(deck);
      if (list.length) {
        deckOnPage = null;
        setBackLinks(deck);
        startSession(deck, list);
        return;
      }
      allLearned = learn !== "missed";
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    session = null;
    busy = false;
    if (deck) {
      deckOnPage = deck;
      document.title = deck.title + " — Карточки — Китайский язык";
      if (allLearned) {
        setBackLinks(deck);
        $("[data-done-deck]").textContent = deck.title;
        show("done");
        return;
      }
      renderDeck(deck);
      show("deck");
      return;
    }
    deckOnPage = null;
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

  loadDecks(function (files) {
    collectDecks(files);
    route();
  });
})();
