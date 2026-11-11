/* Общая шапка сайта (тема v2): логотип, меню, Telegram и «записаться на
   урок». На телефоне (до 960px) меню — нижняя панель разделов: её скрипт
   вставляет сразу после шапки, а что когда видно, решают стили
   (header.css).

   Подключается на каждой странице двумя строками: стили в <head>
       <link rel="stylesheet" href="…/components/site-header/header.css">
   и этот скрипт первой строкой <body>
       <script src="…/components/site-header/header.js"></script>
   Скрипт сразу вставляет разметку на своё место, поэтому шапка есть уже на
   первом кадре. Путь к корню сайта берётся из адреса самого скрипта: ссылки
   верны на любой глубине вложенности и при открытии через file://, а fetch
   не нужен. */
(function () {
  "use strict";

  // Пути — от корня сайта. Тот же список лежит в content.json ("nav").
  var NAV = [
    { label: "главная", href: "index.html" },
    { label: "библиотека", href: "library/index.html" },
    { label: "словарь", href: "dictionary/index.html" },
    { label: "карточки", href: "flashcards/index.html" },
    { label: "ИИ-помощник", href: "assistant/index.html" },
    { label: "контакты", href: "support/contacts.html" }
  ];
  var CTA_HREF = "support/contacts.html";
  var TELEGRAM_URL = "https://t.me/easily_chinesly";

  // Нижняя панель телефона: пять главных разделов. «Контактов» в ней нет —
  // на них ведут блок «занятия» на главной и подвал, а Telegram остаётся в
  // шапке. Иконки — содержимое <svg viewBox="0 0 24 24">.
  var TABS = [
    { label: "главная", href: "index.html",
      icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>' },
    { label: "библиотека", href: "library/index.html",
      icon: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>' },
    { label: "словарь", href: "dictionary/index.html",
      icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>' },
    { label: "карточки", href: "flashcards/index.html",
      icon: '<rect x="8" y="3" width="13" height="15" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>' },
    { label: "ИИ", href: "assistant/index.html",
      icon: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>' }
  ];

  var script = document.currentScript;
  var SCRIPT_PATH = /components\/site-header\/header\.js(?:[?#].*)?$/;
  // "../../" — путь от страницы к корню сайта, им начинаются ссылки шапки.
  var prefix = script.getAttribute("src").replace(SCRIPT_PATH, "");
  // "library/hsk-3/index.html" — путь страницы от корня сайта.
  var rootUrl = script.src.replace(SCRIPT_PATH, "");
  var pageUrl = location.href.replace(/[?#].*$/, "");
  var page = pageUrl.indexOf(rootUrl) === 0 ? pageUrl.slice(rootUrl.length) : "";

  var isHome = page === "" || page === "index.html";

  // «Главная» отмечена только на главной. Пункт, ведущий на index.html
  // папки, — на всех страницах этой папки (library/hsk-3/ → «библиотека»).
  // Остальные — только на своей странице.
  function current(href) {
    if (href === "index.html") return isHome ? "page" : null;
    if (page === href) return "page";
    var section = href.replace(/index\.html$/, "");
    if (section !== href && page.indexOf(section) === 0) return "true";
    return null;
  }

  function svg(size, body) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  var ICON_TELEGRAM = svg(20, '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/>');
  var ICON_ARROW = svg(18, '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>');

  var links = NAV.map(function (item) {
    var state = current(item.href);
    return '<a class="site-header__link" href="' + prefix + item.href + '"' +
      (state ? ' aria-current="' + state + '"' : "") + ">" + item.label + "</a>";
  }).join("");

  var tabs = TABS.map(function (tab) {
    var state = current(tab.href);
    return '<a class="site-tabbar__link" href="' + prefix + tab.href + '"' +
      (state ? ' aria-current="' + state + '"' : "") + ">" +
      '<svg class="site-tabbar__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      tab.icon + "</svg>" + tab.label + "</a>";
  }).join("");

  // «записаться на урок» ведёт на «Контакты», а на самих «Контактах» —
  // сразу в Telegram.
  var onContacts = page === CTA_HREF;
  var cta = '<a class="site-header__cta" href="' + (onContacts ? TELEGRAM_URL : prefix + CTA_HREF) + '"' +
    (onContacts ? ' target="_blank" rel="noopener"' : "") + ">записаться на урок" + ICON_ARROW + "</a>";

  var html =
    '<header class="site-header">' +
      '<a class="site-header__logo" href="' + prefix + 'index.html" aria-label="chineasy — на главную">' +
        '<span class="site-header__seal" lang="zh-CN" aria-hidden="true">中</span>' +
        '<span class="site-header__name">chineasy.</span>' +
      "</a>" +
      '<nav class="site-header__nav" aria-label="Основное меню">' + links + "</nav>" +
      '<a class="site-header__icon" href="' + TELEGRAM_URL + '" target="_blank" rel="noopener" aria-label="Написать в Telegram">' +
        ICON_TELEGRAM +
      "</a>" +
      cta +
    "</header>" +
    // Панель — соседом шапки: на широком окне её не видно (header.css).
    '<nav class="site-tabbar" aria-label="Разделы сайта">' + tabs + "</nav>";

  script.insertAdjacentHTML("afterend", html);
})();
