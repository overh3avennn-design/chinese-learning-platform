/* Окно добавления карточки из результата поиска. */
(function () {
  "use strict";
  var dialog = document.querySelector("[data-dict-card-dialog]");
  var form = dialog.querySelector("form");
  var fields = form.elements;
  var save = form.querySelector('[type="submit"]');
  var cancel = form.querySelector("[data-dict-card-close]");
  var message = form.querySelector("[data-dict-card-status]");
  var current = null;
  var watching = false;

  function watchAccount() {
    if (watching || !window.Account) return;
    watching = true;
    window.Account.onChange(function (session) {
      if (current && (session && session.user.id || null) !== current.userId) close();
    });
  }
  window.addEventListener("load", watchAccount);

  function owner() {
    var user = window.Account && window.Account.user();
    var stored = JSON.parse(window.localStorage.getItem("account") || "null");
    var storedId = stored && stored.user && stored.user.id;
    if ((user && user.id || null) !== (storedId || null)) {
      throw new Error("Аккаунт изменился. Обновите страницу.");
    }
    return storedId || null;
  }

  function assertOwner(view) {
    if (owner() !== view.userId) throw new Error("Аккаунт изменился. Откройте окно заново.");
  }

  function report(text) {
    message.textContent = text;
  }

  function toggleTitle() {
    var creating = fields.deck.value === "";
    form.querySelector("[data-dict-new-title]").hidden = !creating;
    fields.deckTitle.required = creating;
  }

  function close() {
    var view = current;
    current = null;
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
    if (view && view.trigger.isConnected) view.trigger.focus();
  }

  async function open(trigger, word) {
    if (dialog.open) return;
    var view = { trigger: trigger, word: word };
    current = view;
    fields.deck.textContent = "";
    fields.deckTitle.value = "";
    form.querySelector("[data-card-word]").textContent = word.hanzi;
    form.querySelector("[data-card-pinyin]").textContent = word.pinyin;
    form.querySelector("[data-card-translation]").textContent = word.translation;
    save.disabled = true;
    fields.deck.disabled = true;
    cancel.textContent = "Отмена";
    form.querySelector("[data-dict-new-title]").hidden = true;
    report("Загружаем колоды…");
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    try {
      view.userId = owner();
      watchAccount();
      if (view.userId) {
        await window.CloudSync.syncNow();
        if (current !== view) return;
        assertOwner(view);
        if (["idle", "quota"].indexOf(window.CloudSync.status()) < 0) {
          throw new Error("Не удалось загрузить ваши колоды. Проверьте связь и откройте окно снова.");
        }
      }
      window.OwnDecks.list().forEach(function (d) {
        fields.deck.add(new Option(d.title || d.id, d.id));
      });
      fields.deck.add(new Option("Создать новую колоду", ""));
      fields.deck.disabled = false;
      toggleTitle();
      save.disabled = false;
      report("");
      if (fields.deck.value) fields.deck.focus();
      else fields.deckTitle.focus();
    } catch (err) {
      if (current === view) report(err.message || "Не удалось прочитать колоды.");
    }
  }

  fields.deck.addEventListener("change", toggleTitle);
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", function (event) { event.preventDefault(); close(); });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var view = current;
    if (!view || save.disabled) return;
    save.disabled = true;
    try {
      assertOwner(view);
      var target = { id: fields.deck.value, title: fields.deckTitle.value };
      var word = view.word;
      var deck = window.OwnDecks.addWord(target, word);
    } catch (err) {
      report(err.message || "Не удалось сохранить карточку.");
      save.disabled = false;
      return;
    }
    cancel.textContent = "Готово";
    if (!view.userId) {
      report("Карточка добавлена в колоду «" + deck.title + "» на этом устройстве.");
      cancel.focus();
      return;
    }
    report("Карточка добавлена на устройстве. Сохраняем в аккаунте…");
    try {
      await window.CloudSync.syncNow();
      if (current !== view) return;
      assertOwner(view);
      var saved = window.OwnDecks.list().find(function (d) { return d.id === deck.id; });
      if (!saved || !saved.words.some(function (w) {
        return w.hanzi === word.hanzi.trim() && w.pinyin === word.pinyin.trim();
      })) {
        report("Колода изменилась на другом устройстве. Откройте окно заново и проверьте карточку.");
      } else if (window.CloudSync.status() === "idle") {
        report("Карточка сохранена в вашей колоде «" + deck.title + "».");
      } else {
        report("Карточка добавлена на устройстве. Сохранение в аккаунте пока не подтверждено.");
      }
    } catch (err) {
      if (current === view) report(err.message || "Не удалось подтвердить синхронизацию.");
    }
    if (current === view) cancel.focus();
  });

  window.addEventListener("storage", function (event) {
    if (current && (event.key === "account" || event.key === null)) {
      try { assertOwner(current); } catch (err) { close(); }
    }
  });
  window.DictionaryCardDialog = { open: open };
})();
