/* Добавление слова из словаря в собственную колоду. Формат flashcards-user
   и ключ слова совпадают с js/flashcards.js, синхронизацией ведает CloudSync. */
(function () {
  "use strict";
  var key = "flashcards-user";

  function read() {
    var raw = window.localStorage.getItem(key);
    if (raw === null) return { decks: [], extra: {}, folders: [] };
    var data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        (data.decks !== undefined && !Array.isArray(data.decks))) {
      throw new Error("Не удалось прочитать сохранённые колоды.");
    }
    if (!data.decks) data.decks = [];
    if (!Array.isArray(data.folders)) data.folders = [];
    if (!data.extra || typeof data.extra !== "object") data.extra = {};
    return data;
  }

  function write(data) {
    try {
      window.localStorage.setItem(key, JSON.stringify(data));
    } catch (err) {
      throw new Error("Браузеру не удалось сохранить карточку. Проверьте свободное место.");
    }
    if (window.CloudSync) window.CloudSync.changed();
  }

  function list() {
    return read().decks.filter(function (deck) {
      return deck && typeof deck.id === "string" && Array.isArray(deck.words);
    });
  }

  function addWord(target, fields) {
    var data = read();
    var word = {
      hanzi: fields.hanzi.trim(),
      pinyin: fields.pinyin.trim(),
      translation: fields.translation.trim()
    };
    if (!word.hanzi) throw new Error("Введите иероглифы.");
    var deck;
    if (target.id) {
      deck = data.decks.find(function (d) { return d && d.id === target.id; });
      if (!deck || !Array.isArray(deck.words)) throw new Error("Колода больше недоступна. Откройте список заново.");
      if (deck.words.some(function (w) {
        return w && String(w.hanzi || "").trim() === word.hanzi && String(w.pinyin || "").trim() === word.pinyin;
      })) throw new Error("Карточка с такими иероглифами и пиньинем уже есть в колоде.");
    } else {
      var title = target.title.trim().slice(0, 60);
      if (!title) throw new Error("Введите название колоды.");
      var id = "my-" + Date.now().toString(36);
      while (data.decks.some(function (d) { return d && d.id === id; })) id += "x";
      deck = { id: id, title: title, words: [] };
      data.decks.push(deck);
    }
    deck.words.push(word);
    write(data);
    return deck;
  }

  window.OwnDecks = { read: read, write: write, list: list, addWord: addWord };
})();
