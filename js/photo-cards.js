/* Карточки по фото тетради (раздел «Карточки», экран #photo): фото
   страницы → нейросеть распознаёт слова (задача "notebook-cards" через
   js/ai.js) → ученик проверяет таблицу → слова уходят в новую или готовую
   колоду через window.Flashcards (js/flashcards.js).

   Фото перед отправкой сжимается в браузере: длинная сторона — до
   MAX_SIDE точек, JPEG. Иероглифы на странице тетради при этом читаются, а
   запрос остаётся в пределах сотен килобайт — по мобильному интернету
   уходит быстро. Подключается после js/flashcards.js и js/ai.js. */
(function () {
  "use strict";

  var root = document.querySelector("[data-flashcards]");
  if (!root || !window.Flashcards || !window.AI) return;

  var MAX_SIDE = 1600;
  var QUALITY = 0.82;
  var MAX_CHARS = 2.6 * 1024 * 1024;   // data:-адрес фото; воркер принимает запрос до 3 МБ
  var FIELDS = ["hanzi", "pinyin", "translation"];
  var LABELS = { hanzi: "Иероглифы", pinyin: "Пиньинь", translation: "Перевод" };
  var PLACEHOLDERS = { hanzi: "你好", pinyin: "nǐ hǎo", translation: "здравствуйте" };
  var MAX_LEN = { hanzi: 40, pinyin: 100, translation: 200 };
  var AI_TITLE = "Этого не было на фото — вариант нейросети. Проверьте.";
  var LOADING_HINT = "Обычно это занимает 10–30 секунд.";
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

  var job = null;          // { token, url, image, ctrl } — текущее фото
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

  // JPEG не больше MAX_SIDE по длинной стороне. Если data:-адрес всё равно
  // велик, уменьшаем ещё. Поворот с камеры телефона (EXIF) браузер
  // применяет к картинке сам.
  function compress(image) {
    var side = MAX_SIDE;
    var quality = QUALITY;
    for (var attempt = 0; attempt < 5; attempt++) {
      var scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      var w = Math.max(1, Math.round(image.naturalWidth * scale));
      var h = Math.max(1, Math.round(image.naturalHeight * scale));
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";             // прозрачный PNG — на белом, как бумага
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      var data = canvas.toDataURL("image/jpeg", quality);
      if (data.length <= MAX_CHARS && data.indexOf("data:image/jpeg") === 0) return data;
      side = Math.round(side * 0.8);
      quality = Math.max(0.6, quality - 0.08);
    }
    throw new Error("too large");
  }

  function start(file) {
    stopRequest();
    clearJob();
    var token = {};
    job = { token: token, url: URL.createObjectURL(file), image: null, ctrl: null };
    active = true;
    img.src = job.url;
    setZoom(false);
    setState("loading", "Сжимаю фото…");
    window.Flashcards.openPhoto();
    loadImage(job.url).then(function (image) {
      if (!job || job.token !== token) return;
      job.image = compress(image);
      recognize();
    }).catch(function () {
      if (!job || job.token !== token) return;
      showError("Не получилось открыть фото. Выберите другое — в формате JPEG или PNG.");
    });
  }

  function recognize() {
    var token = job.token;
    var ctrl = window.AbortController ? new AbortController() : null;
    job.ctrl = ctrl;
    setState("loading", "Распознаю слова…");
    var slow = setTimeout(function () {
      $("[data-loading-hint]").textContent = "Ещё немного — нейросеть внимательно читает страницу.";
    }, 30000);
    window.AI.ask("notebook-cards", { image: job.image }, {
      signal: ctrl ? ctrl.signal : undefined,
      timeout: 150000
    }).then(function (result) {
      clearTimeout(slow);
      if (!job || job.token !== token) return;
      job.ctrl = null;
      var found = result && Array.isArray(result.words) ? result.words : [];
      if (found.length) showReview(found, !!result.truncated, false);
      else setState("empty");
    }, function (err) {
      clearTimeout(slow);
      if (!job || job.token !== token) return;
      job.ctrl = null;
      if (err.code !== "aborted") showError(err.message);
    });
  }

  function stopRequest() {
    if (job && job.ctrl) {
      job.ctrl.abort();
      job.ctrl = null;
    }
  }

  function clearJob() {
    if (job && job.url) URL.revokeObjectURL(job.url);
    job = null;
  }

  // Ушли с экрана (кнопкой «Назад»), пока шло распознавание, — запрос
  // останавливаем, а вернувшись, можно начать заново.
  function onLeave() {
    if (window.location.hash === "#photo" || !job || !job.ctrl) return;
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

  function showError(message) {
    $("[data-error-text]").textContent = message;
    $("[data-photo-retry]").hidden = !(job && job.image);
    setState("error");
  }

  function setZoom(on) {
    zoomBtn.classList.toggle("is-zoomed", on);
    zoomBtn.setAttribute("aria-pressed", on ? "true" : "false");
    zoomBtn.setAttribute("aria-label", on ? "Уменьшить фото" : "Показать фото крупнее");
  }

  // ------------------------------------------------------- таблица слов
  function showReview(found, truncated, manual) {
    list.textContent = "";
    found.forEach(function (w) { addRow(w); });
    if (!found.length) addRow({});
    renumber();
    $("[data-ai-legend]").hidden = !found.some(function (w) {
      return Array.isArray(w.added) && w.added.length;
    });
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
      if (Array.isArray(w.added) && w.added.indexOf(f) >= 0) markAi(cell, true);
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

  function markAi(cell, on) {
    var badge = cell.querySelector(".fc-ai-badge");
    cell.classList.toggle("is-ai", on);
    if (on && !badge) {
      badge = el("span", "fc-ai-badge", "ИИ");
      badge.setAttribute("aria-hidden", "true");
      cell.appendChild(badge);
      cell.title = AI_TITLE;
    } else if (!on && badge) {
      cell.removeChild(badge);
      cell.removeAttribute("title");
    }
  }

  // Подписи для экранных дикторов: «Пиньинь, слово 3 — вариант нейросети».
  function renumber() {
    $$(".fc-edit-row").forEach(function (row, i) {
      FIELDS.forEach(function (f) {
        var cell = row.querySelector(".fc-cell-" + f);
        cell.querySelector("input").setAttribute("aria-label", LABELS[f] + ", слово " + (i + 1) +
          (cell.classList.contains("is-ai") ? " — вариант нейросети" : ""));
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
      showReview([], false, true);
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
    if (cell.classList.contains("is-ai")) {
      markAi(cell, false);       // поправили — это уже не догадка нейросети
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
