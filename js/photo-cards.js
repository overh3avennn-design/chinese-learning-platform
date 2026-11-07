/* Карточки по фото тетради (раздел «Карточки», экран #photo): фото
   страницы → слова распознаются прямо в браузере и сверяются со словарём
   (window.NotebookOCR, js/notebook-ocr.js) → ученик проверяет таблицу →
   слова уходят в новую или готовую колоду через window.Flashcards
   (js/flashcards.js). Фото никуда не отправляется.

   Пометки в таблице: «?» — прочитано неуверенно, «БКРС» — на фото этого
   не было, взято из словаря. Поправили поле — пометка снимается.
   Подключается после js/flashcards.js, js/dict-lookup.js и
   js/notebook-ocr.js. */
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
    added: { label: "БКРС", title: "Этого не было на фото — взято из словаря БКРС.", say: "взято из словаря" }
  };
  var LOADING_HINT = "Обычно это занимает от 10 секунд до минуты — зависит от телефона и числа строк.";
  var STAGES = {
    detect: "Ищу строки на фото…",
    check: "Сверяю со словарём…"
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
  function choose(kind) {
    (inputs[kind] || inputs.pick).click();
  }

  // Поле сразу очищается: то же фото, выбранное снова, — тоже событие change.
  Object.keys(inputs).forEach(function (kind) {
    inputs[kind].addEventListener("change", function () {
      var file = inputs[kind].files && inputs[kind].files[0];
      inputs[kind].value = "";
      if (file) start(file);
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
    var token = {};
    job = { token: token, url: URL.createObjectURL(file), image: null, busy: false };
    active = true;
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
    var text = STAGES[s.stage] || "Распознаю слова…";
    var hint = LOADING_HINT;
    if (s.stage === "download" && s.total) {
      text = "Скачиваю распознаватель — " + Math.min(99, Math.floor(100 * s.loaded / s.total)) + "%";
      hint = "Это нужно только в первый раз (около " + mb(s.total) + " МБ): дальше распознаватель хранится на устройстве.";
    } else if (s.stage === "read" && s.total) {
      // Число строк уточняется по ходу — проценты только растут.
      readPct = Math.max(readPct, Math.min(99, Math.floor(100 * s.done / s.total)));
      text = "Читаю страницу — " + readPct + "%";
    }
    $("[data-loading-text]").textContent = text;
    $("[data-loading-hint]").textContent = hint;
  }

  var readPct = 0;

  function recognize() {
    var token = job.token;
    job.busy = true;
    readPct = 0;
    setState("loading", "Распознаю слова…");
    window.NotebookOCR.read(job.image, {
      onStatus: function (s) {
        if (job && job.token === token && job.busy) onStatus(s);
      }
    }).then(function (result) {
      if (!job || job.token !== token) return;
      job.busy = false;
      var found = result && Array.isArray(result.words) ? result.words : [];
      if (found.length) showReview(found, false, false, result.checked !== false);
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
      window.NotebookOCR.cancel();
    }
  }

  function clearJob() {
    if (job && job.url) URL.revokeObjectURL(job.url);
    job = null;
  }

  // Ушли с экрана (кнопкой «Назад»), пока шло распознавание, — оно
  // останавливается, а вернувшись, можно начать заново.
  function onLeave() {
    if (window.location.hash === "#photo" || !job || !job.busy) return;
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
  function showReview(found, truncated, manual, checked) {
    list.textContent = "";
    found.forEach(function (w) { addRow(w); });
    if (!found.length) addRow({});
    renumber();
    ["unsure", "added"].forEach(function (kind) {
      root.querySelector('[data-legend="' + kind + '"]').hidden = !found.some(function (w) {
        return Array.isArray(w[kind]) && w[kind].length;
      });
    });
    root.querySelector('[data-legend="offline"]').hidden = manual || checked !== false;
    $("[data-review-text]").textContent = manual
      ? "Впишите слова: иероглифы, пиньинь и перевод."
      : "Найдено: " + words(found.length) + ". Проверьте их — исправьте ошибки, удалите лишнее, добавьте пропущенное." +
        (truncated ? " Страница большая, и часть слов могла не войти — допишите их." : "");
    fillDecks();
    saveError.hidden = true;
    setState("review");
    updateCount();
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
      else if (Array.isArray(w.added) && w.added.indexOf(f) >= 0) mark(cell, "added");
      row.appendChild(cell);
    });
    var del = el("button", "fc-edit-del");
    del.type = "button";
    del.title = "Удалить слово";
    del.setAttribute("data-del-row", "");
    del.innerHTML = DELETE_ICON;
    row.appendChild(del);
    list.appendChild(row);
    return row;
  }

  // Пометка поля: "unsure", "added" или null — снять.
  function mark(cell, kind) {
    var badge = cell.querySelector(".fc-mark");
    if (badge) cell.removeChild(badge);
    cell.classList.remove("is-unsure", "is-added");
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

  // Подписи для экранных дикторов: «Пиньинь, слово 3 — взято из словаря».
  function renumber() {
    $$(".fc-edit-row").forEach(function (row, i) {
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
    return $$(".fc-edit-row").filter(function (row) {
      return readRow(row).hanzi;
    }).length;
  }

  function updateCount() {
    var n = filledCount();
    saveBtn.textContent = n ? "Сохранить " + words(n) : "Сохранить";
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
    var found = [];
    var missing = 0;
    $$(".fc-edit-row").forEach(function (row) {
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
    active = false;
    window.Flashcards.openDeck(res.id, note);
  }

  function showSaveError(text) {
    saveError.textContent = text;
    saveError.hidden = false;
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
    var all = $$(".fc-edit-list input");
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
