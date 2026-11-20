/* Карточки по фото тетради (раздел «Карточки», экран #photo): фото
   страницы → слова читает нейросеть и проверяет их (window.AICards,
   js/ai-cards.js), а когда она недоступна (без VPN) — распознавание прямо
   в браузере со сверкой по словарю (window.NotebookOCR) → ученик
   проверяет таблицу → слова уходят в новую или готовую колоду через
   window.Flashcards (js/flashcards.js).

   Выбрали сразу несколько фото (или добавили кнопкой «+ Ещё фото») — они
   распознаются очередью, по BATCH_PARALLEL одновременно, у каждого фото
   своё состояние и «Повторить» при ошибке, а слова со всех фото
   собираются в одну таблицу и сохраняются в одну колоду. Одно выбранное
   фото идёт прежним путём (start).

   Пометки в таблице: «?» — прочитано неуверенно или нейросеть нашла
   ошибку, «ИИ» — на фото этого не было, дописала нейросеть, «БКРС» —
   взято из словаря. Поправили поле — пометка снимается. Замечание
   нейросети — под словом, с кнопкой «Исправить», если есть вариант.
   Подключается после js/flashcards.js, js/dict-lookup.js,
   js/notebook-ocr.js, js/ai.js и js/ai-cards.js. */
(function () {
  "use strict";

  var root = document.querySelector("[data-flashcards]");
  if (!root || !window.Flashcards || !window.NotebookOCR) return;

  var FIELDS = ["hanzi", "pinyin", "translation"];
  var LABELS = { hanzi: "Иероглифы", pinyin: "Пиньинь", translation: "Перевод" };
  var PLACEHOLDERS = { hanzi: "你好", pinyin: "nǐ hǎo", translation: "здравствуйте" };
  var MAX_LEN = { hanzi: 40, pinyin: 100, translation: 200 };
  var MARKS = {
    unsure: { label: "?", title: "Прочитано неуверенно — сверьте с фото.", say: "прочитано неуверенно" },
    added: { label: "БКРС", title: "Этого не было на фото — взято из словаря БКРС.", say: "взято из словаря" },
    ai: { label: "ИИ", title: "Этого не было на фото — дописала нейросеть.", say: "дописано нейросетью" }
  };
  var AI_HINT = "Обычно это занимает 10–30 секунд.";
  var LOADING_HINT = "Обычно это занимает от 10 секунд до минуты — зависит от телефона и числа строк.";
  var STAGES = {
    detect: "Ищу строки на фото…",
    check: "Сверяю со словарём…",
    "ai-check": "Нейросеть проверяет слова…"
  };
  var DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function $(selector) {
    return root.querySelector(selector);
  }

  function $$(selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

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

  var inputs = {
    camera: $('[data-photo-input="camera"]'),
    pick: $('[data-photo-input="pick"]')
  };
  var img = $("[data-photo-img]");
  var zoomBtn = $("[data-photo-zoom]");
  var list = $("[data-edit-list]");
  var editBox = $("[data-edit]");
  var titleInput = $("[data-new-title]");
  var deckSelect = $("[data-existing]");
  var saveBtn = $("[data-save]");
  var saveError = $("[data-save-error]");

  var job = null;          // { token, url, image, busy } — текущее фото
  var active = false;      // на экране #photo есть что показать

  // «Сфотографировать» — только на телефонах и планшетах: на компьютере
  // capture не работает, и кнопка открыла бы тот же выбор файла.
  var touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  $("[data-photo-camera]").hidden = !touch;
  if (!touch) {
    var pickBtn = $(".fc-photo-cta [data-photo-pick]");
    pickBtn.classList.remove("btn-secondary");
    pickBtn.classList.add("btn-primary");
  }

  // ------------------------------------------------------------- фото
  // add — фото по кнопке «+ Ещё фото»: добавить к словам, что уже есть.
  var adding = false;

  function choose(kind, add) {
    adding = !!add;
    (inputs[kind] || inputs.pick).click();
  }

  // Поле сразу очищается: то же фото, выбранное снова, — тоже событие change.
  // Несколько фото или «+ Ещё фото» — очередь фото (startBatch), одно — как
  // раньше.
  Object.keys(inputs).forEach(function (kind) {
    inputs[kind].addEventListener("change", function () {
      var files = Array.prototype.slice.call(inputs[kind].files || []);
      var add = adding;
      adding = false;
      inputs[kind].value = "";
      if (!files.length) return;
      if (add || files.length > 1) startBatch(files, add);
      else if (files[0]) start(files[0]);
    });
  });

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = reject;
      image.src = url;
    });
  }

  function start(file) {
    stopRequest();
    clearJob();
    clearBatch();
    var token = {};
    job = { token: token, url: URL.createObjectURL(file), image: null, busy: false };
    active = true;
    zoomBtn.hidden = false;
    img.src = job.url;
    setZoom(false);
    setState("loading", "Открываю фото…");
    window.Flashcards.openPhoto();
    loadImage(job.url).then(function (image) {
      if (!job || job.token !== token) return;
      job.image = image;
      recognize();
    }).catch(function () {
      if (!job || job.token !== token) return;
      showError("Не получилось открыть фото. Выберите другое — в формате JPEG или PNG.");
    });
  }

  function mb(bytes) {
    return Math.max(1, Math.round(bytes / 1048576));
  }

  // Что происходит: в первый раз — скачивание распознавателя с процентами,
  // потом поиск строк, чтение строк по одной и сверка со словарём.
  function onStatus(s) {
    // Ждёт очереди к нейросети (лимит запросов в минуту), а дождался —
    // снова прежняя надпись.
    if (s.stage === "ai-wait") {
      if (!s.waiting) {
        if (lastStatus) onStatus(lastStatus);
        return;
      }
      $("[data-loading-text]").textContent = "Жду очереди к нейросети…";
      $("[data-loading-hint]").textContent = "Нейросеть принимает не больше 20 запросов в минуту — фото пойдёт, как только освободится место.";
      return;
    }
    lastStatus = s;
    var text = STAGES[s.stage] || "Распознаю слова…";
    var hint = LOADING_HINT;
    if (s.stage === "download" && s.total) {
      text = "Скачиваю распознаватель — " + Math.min(99, Math.floor(100 * s.loaded / s.total)) + "%";
      hint = "Это нужно только в первый раз (около " + mb(s.total) + " МБ): дальше распознаватель хранится на устройстве.";
    } else if (s.stage === "read" && s.total) {
      // Число строк уточняется по ходу — проценты только растут.
      readPct = Math.max(readPct, Math.min(99, Math.floor(100 * s.done / s.total)));
      text = "Читаю страницу — " + readPct + "%";
    } else if (s.stage === "ai-read") {
      text = "Нейросеть читает страницу" + (s.total > 1 ? " — частей готово: " + s.done + " из " + s.total : "…");
      hint = AI_HINT;
    } else if (s.stage === "ai-check") {
      hint = AI_HINT;
    }
    $("[data-loading-text]").textContent = text;
    $("[data-loading-hint]").textContent = hint;
  }

  var readPct = 0;
  var lastStatus = null;

  function recognize() {
    var token = job.token;
    job.busy = true;
    readPct = 0;
    lastStatus = null;
    setState("loading", "Распознаю слова…");
    engine().read(job.image, {
      onStatus: function (s) {
        if (job && job.token === token && job.busy) onStatus(s);
      }
    }).then(function (result) {
      if (!job || job.token !== token) return;
      job.busy = false;
      var found = result && Array.isArray(result.words) ? result.words : [];
      // Для «+ Ещё фото»: эти слова станут первым фото очереди.
      job.result = { words: found, checked: !result || result.checked !== false, via: (result && result.via) || "local" };
      if (found.length) showReview(found, false, false, result.checked !== false, result.via || "local");
      else setState("empty");
    }, function (err) {
      if (!job || job.token !== token) return;
      job.busy = false;
      if (err.code !== "aborted") showError(err.message, err.code);
    });
  }

  function stopRequest() {
    if (job && job.busy) {
      job.busy = false;
      engine().cancel();
    }
  }

  // Нейросеть с запасным распознаванием в браузере, а без js/ai-cards.js —
  // только в браузере.
  function engine() {
    return window.AICards || window.NotebookOCR;
  }

  function clearJob() {
    if (job && job.url) URL.revokeObjectURL(job.url);
    job = null;
  }

  // Ушли с экрана (кнопкой «Назад»), пока шло распознавание, — оно
  // останавливается, а вернувшись, можно начать заново.
  function onLeave() {
    if (window.location.hash === "#photo") return;
    if (batch) {
      stopBatch();
      return;
    }
    if (!job || !job.busy) return;
    stopRequest();
    showError("Распознавание остановлено. Нажмите «Попробовать ещё раз», чтобы начать снова.");
  }

  window.addEventListener("popstate", onLeave);
  window.addEventListener("hashchange", onLeave);

  // ----------------------------------------------------------- состояния
  function setState(name, text) {
    $$(".fc-photo-state").forEach(function (box) {
      box.hidden = box.getAttribute("data-state") !== name;
    });
    if (name === "loading") {
      $("[data-loading-text]").textContent = text || "Распознаю слова…";
      $("[data-loading-hint]").textContent = LOADING_HINT;
    }
    editBox.hidden = name !== "review";
  }

  // code "unsupported" — браузер не умеет распознавать: повторять незачем,
  // зато можно вписать слова вручную.
  function showError(message, code) {
    var unsupported = code === "unsupported";
    $("[data-error-text]").textContent = message;
    $("[data-photo-retry]").hidden = unsupported || !(job && job.image);
    $("[data-error-manual]").hidden = !unsupported;
    setState("error");
  }

  function setZoom(on) {
    zoomBtn.classList.toggle("is-zoomed", on);
    zoomBtn.setAttribute("aria-pressed", on ? "true" : "false");
    zoomBtn.setAttribute("aria-label", on ? "Уменьшить фото" : "Показать фото крупнее");
  }

  // ------------------------------------------------------- таблица слов
  // checked — пиньинь и перевод сверены со словарём (false — словарь не
  // загрузился, всё как прочитано).
  // via — кто читал фото: "ai" (нейросеть), "mixed" (нейросеть и
  // распознавание в браузере), "local" (только в браузере).
  function showReview(found, truncated, manual, checked, via) {
    list.textContent = "";
    found.forEach(function (w) { addRow(w); });
    if (!found.length) addRow({});
    renumber();
    legend(found, !manual && checked === false, via);
    var notes = found.filter(function (w) { return w.note; }).length;
    $("[data-review-text]").textContent = manual
      ? "Впишите слова: иероглифы, пиньинь и перевод."
      : "Найдено: " + words(found.length) + "." +
        (via === "ai" || via === "mixed" ? " Нейросеть прочитала и проверила их" + (notes ? " — посмотрите замечания под словами." : ".") : "") +
        " Исправьте ошибки, удалите лишнее, добавьте пропущенное." +
        (truncated ? " Страница большая, и часть слов могла не войти — допишите их." : "");
    fillDecks();
    saveError.hidden = true;
    setState("review");
    updateCount();
  }

  // Пояснения пометок, которые есть в словах; unchecked — слова не
  // проверены (via — кто читал фото: от этого зависит, почему).
  function legend(found, unchecked, via) {
    [["unsure", "unsure"], ["added", "added"], ["ai", "aiAdded"]].forEach(function (pair) {
      root.querySelector('[data-legend="' + pair[0] + '"]').hidden = !found.some(function (w) {
        return Array.isArray(w[pair[1]]) && w[pair[1]].length;
      });
    });
    var offline = root.querySelector('[data-legend="offline"]');
    offline.hidden = !unchecked;
    offline.textContent = via && via !== "local"
      ? "Нейросеть не успела проверить слова — проверьте их внимательнее."
      : "Словарь не загрузился — всё взято только с фото, без проверки. Проверьте слова внимательнее.";
  }

  function addRow(w) {
    var row = el("li", "fc-edit-row");
    FIELDS.forEach(function (f) {
      var cell = el("span", "fc-cell fc-cell-" + f);
      var input = el("input", "fc-input");
      input.type = "text";
      input.value = w[f] || "";
      input.maxLength = MAX_LEN[f];
      input.placeholder = PLACEHOLDERS[f];
      input.autocomplete = "off";
      input.setAttribute("data-field", f);
      if (f !== "translation") {
        input.spellcheck = false;
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("autocorrect", "off");
      }
      if (f === "hanzi") input.lang = "zh-CN";
      cell.appendChild(input);
      if (Array.isArray(w.unsure) && w.unsure.indexOf(f) >= 0) mark(cell, "unsure");
      else if (Array.isArray(w.aiAdded) && w.aiAdded.indexOf(f) >= 0) mark(cell, "ai");
      else if (Array.isArray(w.added) && w.added.indexOf(f) >= 0) mark(cell, "added");
      row.appendChild(cell);
    });
    var del = el("button", "fc-edit-del");
    del.type = "button";
    del.title = "Удалить слово";
    del.setAttribute("data-del-row", "");
    del.innerHTML = DELETE_ICON;
    row.appendChild(del);
    if (w.note) row.appendChild(noteBox(w.note, w.suggest || {}));
    list.appendChild(row);
    return row;
  }

  // Замечание нейросети под словом. Есть вариант — кнопка «Исправить»
  // подставляет его в поля (варианты хранятся в data-атрибутах кнопки).
  function noteBox(note, suggest) {
    var box = el("p", "fc-edit-note");
    box.setAttribute("data-note", "");
    box.appendChild(el("span", "fc-edit-note-text", note));
    var fields = FIELDS.filter(function (f) { return suggest[f]; });
    if (fields.length) {
      var btn = el("button", "fc-edit-fix", "Исправить");
      btn.type = "button";
      btn.setAttribute("data-fix", "");
      fields.forEach(function (f) { btn.setAttribute("data-fix-" + f, suggest[f]); });
      btn.title = "Подставить: " + fields.map(function (f) { return suggest[f]; }).join(" · ");
      box.appendChild(btn);
    }
    return box;
  }

  function applyFix(btn) {
    var row = btn.closest(".fc-edit-row");
    FIELDS.forEach(function (f) {
      var v = btn.getAttribute("data-fix-" + f);
      if (!v) return;
      var cell = row.querySelector(".fc-cell-" + f);
      cell.querySelector("input").value = v;
      mark(cell, null);
    });
    var box = btn.closest("[data-note]");
    box.parentNode.removeChild(box);
    renumber();
    updateCount();
  }

  // Пометка поля: "unsure", "added" или null — снять.
  function mark(cell, kind) {
    var badge = cell.querySelector(".fc-mark");
    if (badge) cell.removeChild(badge);
    cell.classList.remove("is-unsure", "is-added", "is-ai");
    cell.removeAttribute("title");
    cell.removeAttribute("data-mark");
    if (!kind) return;
    badge = el("span", "fc-mark is-" + kind, MARKS[kind].label);
    badge.setAttribute("aria-hidden", "true");
    cell.appendChild(badge);
    cell.classList.add("is-" + kind);
    cell.title = MARKS[kind].title;
    cell.setAttribute("data-mark", kind);
  }

  // Строки только этой таблицы: у редактора колоды (js/deck-editor.js)
  // своя таблица с теми же классами.
  function rows() {
    return Array.prototype.slice.call(list.querySelectorAll(".fc-edit-row"));
  }

  // Подписи для экранных дикторов: «Пиньинь, слово 3 — взято из словаря».
  function renumber() {
    rows().forEach(function (row, i) {
      FIELDS.forEach(function (f) {
        var cell = row.querySelector(".fc-cell-" + f);
        var kind = cell.getAttribute("data-mark");
        cell.querySelector("input").setAttribute("aria-label", LABELS[f] + ", слово " + (i + 1) +
          (kind ? " — " + MARKS[kind].say : ""));
      });
      row.querySelector("[data-del-row]").setAttribute("aria-label", "Удалить слово " + (i + 1));
    });
  }

  function readRow(row) {
    var w = {};
    FIELDS.forEach(function (f) {
      w[f] = row.querySelector('[data-field="' + f + '"]').value.replace(/\s+/g, " ").trim();
    });
    return w;
  }

  function filledCount() {
    return rows().filter(function (row) {
      return readRow(row).hanzi;
    }).length;
  }

  // Пока фото в очереди распознаются, сохранять рано: их слова ещё не в таблице.
  function updateCount() {
    var n = filledCount();
    var wait = batchBusy();
    saveBtn.disabled = wait;
    saveBtn.textContent = wait ? "Распознаются фото…" : n ? "Сохранить " + words(n) : "Сохранить";
  }

  // Колоды для «Добавить в колоду»; новая колода по умолчанию называется
  // датой: «Тетрадь · 3 ноября».
  function fillDecks() {
    var decks = window.Flashcards.list();
    deckSelect.textContent = "";
    decks.forEach(function (d) {
      var option = el("option", null, d.title + " · " + words(d.size));
      option.value = d.id;
      deckSelect.appendChild(option);
    });
    var existing = root.querySelector('[data-target][value="existing"]');
    existing.disabled = !decks.length;
    if (!decks.length) root.querySelector('[data-target][value="new"]').checked = true;
    titleInput.value = defaultTitle();
    applyTarget();
  }

  function defaultTitle() {
    var date = "";
    try {
      date = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    } catch (e) {}
    return "Тетрадь" + (date ? " · " + date : "");
  }

  function toExisting() {
    var radio = root.querySelector('[data-target][value="existing"]');
    return radio.checked && !radio.disabled;
  }

  function applyTarget() {
    var existing = toExisting();
    titleInput.disabled = existing;
    deckSelect.disabled = !existing;
  }

  function save() {
    if (batchBusy()) return;
    var found = [];
    var missing = 0;
    rows().forEach(function (row) {
      var w = readRow(row);
      row.classList.remove("is-invalid");
      if (!w.hanzi && !w.pinyin && !w.translation) return;
      if (!w.hanzi) {
        row.classList.add("is-invalid");
        missing++;
        return;
      }
      found.push(w);
    });
    if (missing) {
      showSaveError("Впишите иероглифы в выделенных строках — без них карточка не получится. Лишнюю строку можно удалить крестиком.");
      return;
    }
    if (!found.length) {
      showSaveError("Добавьте хотя бы одно слово.");
      return;
    }
    var target = toExisting() ? { id: deckSelect.value } : { title: titleInput.value.trim() || defaultTitle() };
    var res;
    try {
      res = window.Flashcards.save(target, found);
    } catch (e) {
      showSaveError(e.message);
      return;
    }
    var note = target.id
      ? (res.added ? "Добавлено " + words(res.added) : "Новых слов нет") +
        (res.skipped ? " · ещё " + res.skipped + " уже были в колоде" : "") + "."
      : "Сохранено: " + words(res.added) + ".";
    if (!res.stored) note += " Браузер не дал сохранить надолго — слова пропадут, когда вы закроете страницу.";
    stopRequest();
    clearJob();
    clearBatch();
    active = false;
    window.Flashcards.openDeck(res.id, note);
  }

  function showSaveError(text) {
    saveError.textContent = text;
    saveError.hidden = false;
  }

  // ------------------------------------------------------ несколько фото
  // Фото ждут очереди и распознаются по BATCH_PARALLEL одновременно: одно
  // фото — это уже 3–7 запросов к нейросети, а у воркера предел 20 в минуту
  // (js/ai-cards.js сам держит запросы в этом пределе). Без js/ai-cards.js
  // распознаватель в браузере умеет только одно фото за раз.
  var BATCH_PARALLEL = window.AICards ? 2 : 1;
  var MAX_BATCH = 20;              // больше фото за раз телефон может не потянуть по памяти
  var PREVIEW_SIDE = 1200;         // миниатюра — уменьшенная копия: полные фото держать в памяти дорого
  var BATCH_STATE = { queued: "в очереди", work: "распознаётся…", done: "готово", error: "ошибка" };
  var batchBox = $("[data-batch]");
  var batchList = $("[data-batch-list]");
  // { items: [{ n, url, preview, state, words, checked, via, error, detail, waiting, ctrl, node }],
  //   seq, skipped, decks } — decks: выбор колоды уже заполнен.
  var batch = null;
  var previews = Promise.resolve();   // миниатюры делаются по одной

  function photos(n) {
    return n + " фото";
  }

  function startBatch(files, add) {
    if (!add) {
      stopRequest();
      clearJob();
      clearBatch();
      list.textContent = "";
    }
    if (!batch) {
      batch = { items: [], seq: 0, skipped: 0, decks: false };
      fromSingle();
    }
    var room = Math.max(0, MAX_BATCH - batch.items.length);
    files.slice(0, room).forEach(function (file) {
      var item = newItem(URL.createObjectURL(file));
      queuePreview(item);
    });
    batch.skipped = Math.max(0, files.length - room);
    active = true;
    zoomBtn.hidden = true;
    batchBox.hidden = false;
    $$(".fc-photo-state").forEach(function (box) {
      if (box.getAttribute("data-state") !== "review") box.hidden = true;
    });
    window.Flashcards.openPhoto();
    pump();
  }

  // «+ Ещё фото» после одного фото: его слова, что уже в таблице, — фото 1.
  function fromSingle() {
    if (!job) return;
    stopRequest();
    var item = newItem(job.url);
    job.url = null;                  // адрес фото теперь у очереди
    if (job.result) {
      item.state = "done";
      item.words = job.result.words;
      item.checked = job.result.checked;
      item.via = job.result.via;
      rows().forEach(function (row) { row.setAttribute("data-src", String(item.n)); });
      batch.decks = !editBox.hidden;  // колоду уже выбирали — не сбрасывать
    } else {
      item.state = "error";
      item.error = "не распознано";
    }
    if (job.image) setPreview(item, job.image);
    else queuePreview(item);
    renderItem(item);
    clearJob();
  }

  function newItem(url) {
    var item = {
      n: ++batch.seq, url: url, preview: "", state: "queued", words: [], checked: true, via: "",
      error: "", detail: "", waiting: false, ctrl: null, node: null
    };
    batch.items.push(item);
    batchList.appendChild(itemNode(item));
    renderItem(item);
    return item;
  }

  function itemNode(item) {
    var li = el("li", "fc-batch-item");
    li.setAttribute("data-batch-item", String(item.n));
    var thumb = el("button", "fc-photo-thumb fc-batch-thumb");
    thumb.type = "button";
    thumb.disabled = true;
    thumb.setAttribute("data-batch-zoom", "");
    thumb.setAttribute("aria-pressed", "false");
    thumb.setAttribute("aria-label", "Фото " + item.n + " — показать крупнее");
    var pic = el("img");
    pic.alt = "";
    pic.hidden = true;
    thumb.appendChild(pic);
    var info = el("div", "fc-batch-info");
    info.appendChild(el("span", "fc-batch-name", "Фото " + item.n));
    info.appendChild(el("span", "fc-batch-state"));
    var retry = el("button", "btn btn--outline btn--sm fc-batch-retry", "Повторить");
    retry.type = "button";
    retry.hidden = true;
    retry.setAttribute("data-batch-retry", "");
    retry.setAttribute("aria-label", "Повторить фото " + item.n);
    li.appendChild(thumb);
    li.appendChild(info);
    li.appendChild(retry);
    item.node = li;
    return li;
  }

  function renderItem(item) {
    var node = item.node;
    var state = node.querySelector(".fc-batch-state");
    var waiting = item.state === "work" && item.waiting;
    var text = waiting ? BATCH_STATE.queued : BATCH_STATE[item.state];
    if (item.state === "work" && !waiting && item.detail) text = item.detail;
    if (item.state === "done") text += " · " + (item.words.length ? words(item.words.length) : "слов не нашлось");
    if (item.state === "error" && item.error) text += ": " + item.error;
    state.textContent = "";
    state.className = "fc-batch-state is-" + item.state;
    if (item.state === "work" && !waiting) {
      var spin = el("span", "fc-spinner");
      spin.setAttribute("aria-hidden", "true");
      state.appendChild(spin);
    }
    state.appendChild(el("span", null, text));
    node.querySelector("[data-batch-retry]").hidden = item.state !== "error";
    var thumb = node.querySelector("[data-batch-zoom]");
    var pic = thumb.querySelector("img");
    if (item.preview && !pic.getAttribute("src")) {
      pic.src = item.preview;
      pic.hidden = false;
      thumb.disabled = false;
    }
  }

  // Уменьшенная копия фото для миниатюры (и для сверки слов при увеличении).
  function setPreview(item, image) {
    if (item.preview) return;
    var w0 = image.naturalWidth || image.width;
    var h0 = image.naturalHeight || image.height;
    if (!w0 || !h0) return;
    var k = Math.min(1, PREVIEW_SIDE / Math.max(w0, h0));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * k));
    canvas.height = Math.max(1, Math.round(h0 * k));
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      item.preview = canvas.toDataURL("image/jpeg", 0.8);
    } catch (e) {}
    canvas.width = canvas.height = 0;
    renderItem(item);
  }

  // Миниатюры — сразу, не дожидаясь очереди распознавания, но по одной.
  function queuePreview(item) {
    var mine = batch;
    previews = previews.then(function () {
      if (batch !== mine || item.preview || !item.url) return null;
      return loadImage(item.url).then(function (image) {
        if (batch === mine) setPreview(item, image);
      }, function () {});
    });
  }

  // «ошибка: нет связи…» — сообщение после двоеточия со строчной буквы.
  function lower(text) {
    text = String(text).replace(/\.$/, "");
    return /^[А-ЯЁA-Z][а-яёa-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  }

  function findItem(n) {
    return batch ? batch.items.filter(function (i) { return i.n === n; })[0] || null : null;
  }

  // Запустить следующие фото из очереди, пока заняты не все места.
  function pump() {
    if (!batch) return;
    var working = batch.items.filter(function (i) { return i.state === "work"; }).length;
    batch.items.forEach(function (item) {
      if (working < BATCH_PARALLEL && item.state === "queued") {
        working++;
        work(item);
      }
    });
    updateBatch();
  }

  function work(item) {
    var mine = batch;
    item.state = "work";
    item.error = item.detail = "";
    item.waiting = false;
    item.ctrl = window.AbortController ? new AbortController() : null;
    renderItem(item);
    function current() {
      return batch === mine && item.state === "work";
    }
    loadImage(item.url).then(function (image) {
      if (!current()) return null;
      setPreview(item, image);
      return engine().read(image, {
        parallel: true,
        signal: item.ctrl ? item.ctrl.signal : undefined,
        onStatus: function (s) {
          if (current()) onItemStatus(item, s);
        }
      });
    }, function () {
      var err = new Error("не получилось открыть фото — нужен JPEG или PNG");
      err.code = "image";
      throw err;
    }).then(function (result) {
      if (!current() || !result) return;
      item.words = Array.isArray(result.words) ? result.words : [];
      item.checked = result.checked !== false;
      item.via = result.via || "local";
      item.state = "done";
      appendWords(item);
    }, function (err) {
      if (!current()) return;
      item.state = "error";
      item.error = err && err.code === "aborted" ? "распознавание остановлено" : lower((err && err.message) || "не получилось распознать");
    }).then(function () {
      if (batch !== mine) return;
      item.ctrl = null;
      renderItem(item);
      pump();
    });
  }

  // «в очереди», пока фото ждёт распознавателя в браузере (он занят другим
  // фото) или очереди к нейросети, и проценты, пока скачивается сам
  // распознаватель.
  function onItemStatus(item, s) {
    var waiting = s.stage === "local-wait" || (s.stage === "ai-wait" && !!s.waiting);
    var detail = "";
    if (s.stage === "download" && s.total) {
      detail = "скачиваю распознаватель — " + Math.min(99, Math.floor(100 * s.loaded / s.total)) + "%";
    }
    if (waiting === item.waiting && detail === item.detail) return;
    item.waiting = waiting;
    item.detail = detail;
    renderItem(item);
  }

  // Слова фото — в таблицу в порядке фото (фото распознаются вразнобой):
  // перед первой строкой фото с бо́льшим номером. Строки, дописанные
  // вручную, — без номера фото, они остаются в конце.
  function appendWords(item) {
    var before = null;
    rows().some(function (row) {
      var src = row.getAttribute("data-src");
      if (src === null || Number(src) > item.n) {
        before = row;
        return true;
      }
      return false;
    });
    item.words.forEach(function (w) {
      var row = addRow(w);
      row.setAttribute("data-src", String(item.n));
      if (before) list.insertBefore(row, before);
    });
    renumber();
  }

  function batchBusy() {
    return !!batch && batch.items.some(function (i) { return i.state === "queued" || i.state === "work"; });
  }

  // Итог очереди над списком фото, таблица слов и её подписи.
  function updateBatch() {
    if (!batch) return;
    var count = { queued: 0, work: 0, done: 0, error: 0 };
    var found = [];
    batch.items.forEach(function (i) {
      count[i.state]++;
      if (i.state === "done") found = found.concat(i.words);
    });
    var total = batch.items.length;
    var busy = count.queued + count.work > 0;
    $("[data-batch-text]").textContent = busy
      ? "Распознаю фото: готово " + count.done + " из " + total + "."
      : count.error
        ? "Распознано " + count.done + " из " + photos(total) + "."
        : total > 1 ? "Все " + photos(total) + " распознаны." : "Фото распознано.";
    var hint = busy
      ? "Фото распознаются по очереди, по " + BATCH_PARALLEL + " сразу. Слова со всех фото собираются в одну таблицу ниже."
      : count.error
        ? "Для фото с ошибкой нажмите «Повторить» — или допишите его слова в таблицу сами."
        : "Слова со всех фото — в одной таблице ниже.";
    if (batch.skipped) hint += " За один раз — не больше " + photos(MAX_BATCH) + ", лишние (" + batch.skipped + ") не добавлены.";
    $("[data-batch-hint]").textContent = hint;

    var show = found.length > 0 || !busy;
    if (show && !batch.decks) {
      batch.decks = true;
      fillDecks();
      saveError.hidden = true;
    }
    if (show && !busy && !rows().length) {
      addRow({});
      renumber();
    }
    editBox.hidden = !show;
    $('[data-state="review"]').hidden = !show;
    if (show) {
      var unchecked = batch.items.filter(function (i) { return i.state === "done" && !i.checked; });
      legend(found, unchecked.length > 0, unchecked.some(function (i) { return i.via !== "local"; }) ? "ai" : "local");
      var notes = found.filter(function (w) { return w.note; }).length;
      var ai = batch.items.some(function (i) { return i.state === "done" && (i.via === "ai" || i.via === "mixed"); });
      $("[data-review-text]").textContent = !found.length
        ? count.error
          ? "Слов пока нет: нажмите «Повторить» у фото с ошибкой или впишите слова сами."
          : "На фото не нашлось китайских слов — впишите их сами или выберите другие фото."
        : "Найдено: " + words(found.length) + " на " + photos(count.done) + "." +
          (ai ? " Нейросеть прочитала и проверила их" + (notes ? " — посмотрите замечания под словами." : ".") : "") +
          " Исправьте ошибки, удалите лишнее, добавьте пропущенное." +
          (busy ? " Слова остальных фото добавятся, когда они распознаются." : "") +
          (count.done > 1 ? " Одинаковые слова сохранятся в колоду один раз." : "");
    }
    updateCount();
  }

  // Ушли с экрана — распознавание останавливается; вернувшись, фото можно
  // повторить.
  function stopBatch() {
    if (!batch) return;
    var mine = batch;
    batch.items.forEach(function (item) {
      if (item.state !== "queued" && item.state !== "work") return;
      if (item.ctrl) item.ctrl.abort();
      item.ctrl = null;
      item.state = "error";
      item.error = "распознавание остановлено";
      renderItem(item);
    });
    if (!window.AICards) engine().cancel();
    if (batch === mine) updateBatch();
  }

  function clearBatch() {
    if (!batch) return;
    var busy = batch.items.some(function (i) { return i.state === "work"; });
    batch.items.forEach(function (item) {
      if (item.ctrl) item.ctrl.abort();
      if (item.url) URL.revokeObjectURL(item.url);
    });
    batch = null;
    if (busy && !window.AICards) engine().cancel();
    batchList.textContent = "";
    batchBox.hidden = true;
  }

  // ------------------------------------------------------------- события
  root.addEventListener("click", function (e) {
    if (e.target.closest("[data-photo-camera]")) {
      choose("camera");
      return;
    }
    if (e.target.closest("[data-photo-pick]")) {
      choose("pick");
      return;
    }
    if (e.target.closest("[data-photo-add]")) {
      choose("pick", true);
      return;
    }
    var again = e.target.closest("[data-batch-retry]");
    if (again) {
      var item = findItem(Number(again.closest("[data-batch-item]").getAttribute("data-batch-item")));
      if (item && item.state === "error") {
        item.state = "queued";
        item.error = "";
        renderItem(item);
        pump();
      }
      return;
    }
    var thumb = e.target.closest("[data-batch-zoom]");
    if (thumb) {
      var on = !thumb.classList.contains("is-zoomed");
      thumb.classList.toggle("is-zoomed", on);
      thumb.setAttribute("aria-pressed", on ? "true" : "false");
      return;
    }
    if (e.target.closest("[data-photo-cancel]")) {
      stopRequest();
      clearJob();
      active = false;
      window.history.back();
      return;
    }
    if (e.target.closest("[data-photo-retry]")) {
      if (job && job.image) recognize();
      else choose("pick");
      return;
    }
    if (e.target.closest("[data-photo-manual]")) {
      showReview([], false, true, true);
      var first = list.querySelector("input");
      if (first) first.focus();
      return;
    }
    if (e.target.closest("[data-photo-zoom]")) {
      setZoom(!zoomBtn.classList.contains("is-zoomed"));
      return;
    }
    if (e.target.closest("[data-add-row]")) {
      var row = addRow({});
      renumber();
      row.querySelector("input").focus();
      return;
    }
    var del = e.target.closest("[data-del-row]");
    if (del) {
      var gone = del.closest(".fc-edit-row");
      var next = gone.nextElementSibling || gone.previousElementSibling;
      list.removeChild(gone);
      renumber();
      updateCount();
      (next ? next.querySelector("[data-del-row]") : $("[data-add-row]")).focus();
      return;
    }
    var fix = e.target.closest("[data-fix]");
    if (fix) {
      applyFix(fix);
      return;
    }
    if (e.target.closest("[data-save]")) save();
  });

  list.addEventListener("input", function (e) {
    var cell = e.target.closest(".fc-cell");
    if (!cell) return;
    if (cell.hasAttribute("data-mark")) {
      mark(cell, null);          // поправили — ученик проверил это поле сам
      renumber();
    }
    var row = cell.closest(".fc-edit-row");
    if (row.classList.contains("is-invalid") && readRow(row).hanzi) row.classList.remove("is-invalid");
    updateCount();
  });

  // Enter — к следующему полю, в последнем — новая строка. Пока идёт набор
  // через метод ввода (пиньинь → иероглиф), Enter выбирает иероглиф.
  list.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || !e.target.matches("input")) return;
    e.preventDefault();
    var all = Array.prototype.slice.call(list.querySelectorAll("input"));
    var next = all[all.indexOf(e.target) + 1];
    if (!next) {
      addRow({});
      renumber();
      next = list.lastElementChild.querySelector("input");
    }
    next.focus();
  });

  Array.prototype.forEach.call(root.querySelectorAll("[data-target]"), function (radio) {
    radio.addEventListener("change", applyTarget);
  });

  // Для js/flashcards.js: показывать ли экран #photo.
  window.PhotoCards = {
    active: function () {
      return active;
    }
  };
})();
