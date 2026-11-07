/* Редактор своей колоды (раздел «Карточки», экраны #new-deck и
   #deck=<id>&edit): название и таблица слов — иероглифы, пиньинь, перевод.
   Таблица выглядит как у слов с фото (js/photo-cards.js) — те же классы,
   но свои атрибуты data-deck-*, чтобы обработчики экрана фото её не
   трогали.

   Помогает вписывать слова: по иероглифам подставляет пиньинь и перевод
   из словаря БКРС (window.DictLookup, перевод — NotebookOCR.shortMeaning,
   как у слов с фото) — только в пустые поля и с пометкой «БКРС»; поле,
   которое ученик поправил сам, больше не меняется. Цифры тонов в пиньине
   («ni3 hao3») становятся значками («nǐ hǎo»), когда поле теряет фокус.

   Подключается до js/flashcards.js: тот при разборе адреса вызывает
   DeckEditor.open(колода | null) и показывает экран, а сохраняет и
   удаляет колоду через window.Flashcards. */
(function () {
  "use strict";

  var view = document.querySelector('[data-flashcards] [data-view="deck-edit"]');
  if (!view) return;

  var FIELDS = ["hanzi", "pinyin", "translation"];
  var LABELS = { hanzi: "Иероглифы", pinyin: "Пиньинь", translation: "Перевод" };
  var PLACEHOLDERS = { hanzi: "你好", pinyin: "nǐ hǎo", translation: "здравствуйте" };
  var MAX_LEN = { hanzi: 40, pinyin: 100, translation: 200 };
  var START_ROWS = 3;          // пустых строк у новой колоды
  var LOOKUP_DELAY = 400;      // мс после набора иероглифов — и запрос к словарю
  var HANZI = /[㐀-䶿一-鿿豈-﫿]/;
  var AUTO_TITLE = "Подставлено из словаря БКРС — проверьте.";
  var DELETE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  var form = view.querySelector("[data-deck-form]");
  var nameInput = view.querySelector("[data-deck-name-input]");
  var list = view.querySelector("[data-deck-rows]");
  var errorBox = view.querySelector("[data-deck-error]");

  var editingId = null;        // своя колода в редакторе; null — новая
  var editingTitle = "";
  var timer = null;            // отложенный запрос к словарю
  var lookups = 0;             // номер последнего запроса: ответы на старые пропускаются

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

  function rows() {
    return Array.prototype.slice.call(list.querySelectorAll(".fc-edit-row"));
  }

  function cell(row, field) {
    return row.querySelector(".fc-cell-" + field);
  }

  // ------------------------------------------------------ строки таблицы
  function addRow(w) {
    var row = el("li", "fc-edit-row");
    FIELDS.forEach(function (f) {
      var box = el("span", "fc-cell fc-cell-" + f);
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
      box.appendChild(input);
      row.appendChild(box);
    });
    var del = el("button", "fc-edit-del");
    del.type = "button";
    del.title = "Удалить слово";
    del.setAttribute("data-deck-del-row", "");
    del.innerHTML = DELETE_ICON;
    row.appendChild(del);
    list.appendChild(row);
    return row;
  }

  function readRow(row) {
    var w = {};
    FIELDS.forEach(function (f) {
      w[f] = row.querySelector('[data-field="' + f + '"]').value.replace(/\s+/g, " ").trim();
    });
    return w;
  }

  // Поле из словаря — с пометкой «БКРС», как у слов с фото; on = false — снять.
  function setAuto(box, on) {
    var badge = box.querySelector(".fc-mark");
    if (badge) box.removeChild(badge);
    box.classList.toggle("is-added", on);
    if (on) {
      badge = el("span", "fc-mark is-added", "БКРС");
      badge.setAttribute("aria-hidden", "true");
      box.appendChild(badge);
      box.title = AUTO_TITLE;
      box.setAttribute("data-auto", "");
    } else {
      box.removeAttribute("title");
      box.removeAttribute("data-auto");
    }
  }

  // Подписи для экранных дикторов: «Пиньинь, слово 3 — из словаря».
  function renumber() {
    rows().forEach(function (row, i) {
      FIELDS.forEach(function (f) {
        var box = cell(row, f);
        box.querySelector("input").setAttribute("aria-label", LABELS[f] + ", слово " + (i + 1) +
          (box.hasAttribute("data-auto") ? " — из словаря" : ""));
      });
      row.querySelector("[data-deck-del-row]").setAttribute("aria-label", "Удалить слово " + (i + 1));
    });
  }

  // ------------------------------------------------------- цифры тонов
  var TONES = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", "ü": "ǖǘǚǜ" };

  // Слог с цифрой тона — со значком: «hao3» → «hǎo», «nv3» и «nu:3» → «nǚ».
  // Значок — над a или e, в «ou» — над o, иначе над последней гласной;
  // 5 и 0 — лёгкий тон: цифра просто убирается.
  function markTone(syllable, tone) {
    var s = syllable.replace(/u:|v/g, "ü").replace(/U:|V/g, "Ü");
    if (tone < 1 || tone > 4) return s;
    var low = s.toLowerCase();
    var at = low.search(/[ae]/);
    if (at < 0) at = low.indexOf("ou");
    for (var k = low.length - 1; at < 0 && k >= 0; k--) {
      if ("iouü".indexOf(low.charAt(k)) >= 0) at = k;
    }
    var mark = TONES[low.charAt(at)].charAt(tone - 1);
    if (s.charAt(at) !== low.charAt(at)) mark = mark.toUpperCase();
    return s.slice(0, at) + mark + s.slice(at + 1);
  }

  // Слоги без гласной («mp3») не трогаем.
  function toneDigits(text) {
    return text.replace(/([A-Za-zÜü:]+)([0-5])/g, function (all, syllable, tone) {
      return /[aeiouüv]/i.test(syllable) ? markTone(syllable, Number(tone)) : all;
    });
  }

  // --------------------------------------------------- подсказки словаря
  // Пиньинь — первое чтение самой употребительной статьи (статьи приходят
  // по важности), перевод — значение для этого чтения, как у слов с фото;
  // нет русского — машинный перевод сборки словаря (поле m).
  function fromDictionary(entries) {
    var main = entries.filter(function (e) { return String(e[1] || "").trim(); })[0];
    if (!main) return { pinyin: "", translation: "" };
    var reading = String(main[1]).split(/\s*[,;]\s*/)[0];
    var ocr = window.NotebookOCR;
    var translation = ocr && ocr.shortMeaning ? ocr.shortMeaning(entries, reading) : "";
    if (!translation && main[3] && main[3].m) translation = String(main[3].m).split(/[\n;]/)[0].trim();
    return { pinyin: reading, translation: translation.slice(0, MAX_LEN.translation) };
  }

  // Подставлять можно в пустое поле и в подставленное раньше (иероглифы с
  // тех пор поменялись); поле, которое ученик вписал или поправил, — нельзя.
  function canFill(row, f) {
    var box = cell(row, f);
    return !box.querySelector("input").value.trim() || box.hasAttribute("data-auto");
  }

  // Поле, где сейчас курсор, подставленное выделяется: начали печатать —
  // своё заменит подсказку, а не допишется к ней.
  function fill(row, f, value) {
    var box = cell(row, f);
    var input = box.querySelector("input");
    input.value = value;
    setAuto(box, !!value);
    if (value && input === document.activeElement) input.select();
  }

  // Слово ищется целиком, без пробелов. Ответ на устаревший запрос
  // (иероглифы с тех пор снова поправили) пропускается; словарь не
  // загрузился — поля остаются как есть, их впишут сами.
  function lookup(row) {
    clearTimeout(timer);
    var key = readRow(row).hanzi.replace(/\s+/g, "");
    if (row.getAttribute("data-key") === key) return;
    row.setAttribute("data-key", key);
    var id = String(++lookups);
    row.setAttribute("data-lookup", id);
    if (!HANZI.test(key) || !window.DictLookup) {
      ["pinyin", "translation"].forEach(function (f) {
        if (cell(row, f).hasAttribute("data-auto")) fill(row, f, "");
      });
      renumber();
      return;
    }
    if (!canFill(row, "pinyin") && !canFill(row, "translation")) return;
    window.DictLookup.exact([key]).then(function (found) {
      if (row.getAttribute("data-lookup") !== id || !list.contains(row)) return;
      var hint = fromDictionary((found && found[key]) || []);
      ["pinyin", "translation"].forEach(function (f) {
        if (canFill(row, f)) fill(row, f, hint[f]);
      });
      renumber();
    }, function () {});
  }

  function schedule(row) {
    clearTimeout(timer);
    timer = setTimeout(function () { lookup(row); }, LOOKUP_DELAY);
  }

  // ------------------------------------------------------------- экран
  function setError(text) {
    errorBox.textContent = text || "";
    errorBox.hidden = !text;
  }

  // deck — { id, title, words } своей колоды или null — новая.
  function open(deck) {
    clearTimeout(timer);
    editingId = deck ? deck.id : null;
    editingTitle = deck ? deck.title : "";
    view.querySelector("[data-deck-edit-title]").textContent = deck ? "Изменить колоду" : "Новая колода";
    view.querySelector("[data-deck-save]").textContent = deck ? "Сохранить" : "Создать колоду";
    view.querySelector("[data-deck-delete-line]").hidden = !deck;
    nameInput.value = editingTitle;
    list.textContent = "";
    (deck ? deck.words : []).forEach(function (w) {
      addRow(w).setAttribute("data-key", String(w.hanzi || "").replace(/\s+/g, ""));
    });
    while (list.children.length < (deck ? 1 : START_ROWS)) addRow({});
    renumber();
    setError("");
  }

  view.addEventListener("click", function (e) {
    if (e.target.closest("[data-deck-add-row]")) {
      var added = addRow({});
      renumber();
      added.querySelector("input").focus();
      return;
    }
    var del = e.target.closest("[data-deck-del-row]");
    if (del) {
      var gone = del.closest(".fc-edit-row");
      var next = gone.nextElementSibling || gone.previousElementSibling;
      list.removeChild(gone);
      // Последнюю строку не оставляем пустым местом — вместо неё пустая.
      var target = next ? next.querySelector("[data-deck-del-row]") : addRow({}).querySelector("input");
      renumber();
      target.focus();
      return;
    }
    if (e.target.closest("[data-deck-delete]") && editingId && window.Flashcards) {
      if (!window.confirm("Удалить колоду «" + editingTitle + "»?\nСлова и прогресс по ней пропадут.")) return;
      var id = editingId;
      editingId = null;
      window.Flashcards.deleteDeck(id);
    }
  });

  list.addEventListener("input", function (e) {
    var box = e.target.closest(".fc-cell");
    if (!box) return;
    var row = box.closest(".fc-edit-row");
    if (box.hasAttribute("data-auto")) {      // поправили подставленное — теперь поле ученика
      setAuto(box, false);
      renumber();
    }
    if (row.classList.contains("is-invalid") && readRow(row).hanzi) row.classList.remove("is-invalid");
    if (box.classList.contains("fc-cell-hanzi") && !e.isComposing) schedule(row);
  });

  // Набор через метод ввода (пиньинь → иероглиф): слово готово, когда
  // выбран иероглиф.
  list.addEventListener("compositionend", function (e) {
    var box = e.target.closest(".fc-cell-hanzi");
    if (box) schedule(box.closest(".fc-edit-row"));
  });

  // Ушли из поля: иероглифы — сразу к словарю, пиньинь — цифры в значки.
  list.addEventListener("change", function (e) {
    var f = e.target.getAttribute("data-field");
    if (f === "hanzi") lookup(e.target.closest(".fc-edit-row"));
    if (f === "pinyin") {
      var marked = toneDigits(e.target.value);
      if (marked !== e.target.value) e.target.value = marked;
    }
  });

  // Enter — к следующему полю, в последнем — новая строка; в названии —
  // к первому слову. Пока идёт набор через метод ввода, Enter выбирает иероглиф.
  view.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    if (e.target === nameInput) {
      e.preventDefault();
      list.querySelector("input").focus();
      return;
    }
    if (!list.contains(e.target) || !e.target.matches("input")) return;
    e.preventDefault();
    var all = Array.prototype.slice.call(list.querySelectorAll("input"));
    var next = all[all.indexOf(e.target) + 1];
    if (!next) {
      next = addRow({}).querySelector("input");
      renumber();
    }
    next.focus();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var title = nameInput.value.replace(/\s+/g, " ").trim();
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
      w.pinyin = toneDigits(w.pinyin);
      found.push(w);
    });
    if (!title) {
      setError("Напишите название колоды.");
      nameInput.focus();
      return;
    }
    if (missing) {
      setError("Впишите иероглифы в выделенных строках — без них карточка не получится. Лишнюю строку можно удалить крестиком.");
      return;
    }
    if (!found.length) {
      setError("Добавьте хотя бы одно слово.");
      list.querySelector("input").focus();
      return;
    }
    if (!window.Flashcards) return;
    var res;
    try {
      res = window.Flashcards.saveDeck(editingId, title, found);
    } catch (err) {
      setError(err.message);
      return;
    }
    var wasNew = !editingId;
    var note = (wasNew ? "Колода создана: " : "Колода сохранена: ") + words(res.size) + "." +
      (res.stored ? "" : " Но браузер не даёт её запомнить — она пропадёт, когда закроете страницу.");
    editingId = null;
    window.Flashcards.openDeck(res.id, note, !wasNew);
  });

  window.DeckEditor = { open: open };
})();
