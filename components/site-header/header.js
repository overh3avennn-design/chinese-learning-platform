/* Общая шапка сайта: логотип, меню, Telegram и — только на главной — кнопка
   «Записаться на урок».

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

  // Пути — от корня сайта. Тот же список лежит в content.json ("nav"),
  // оттуда генератор страниц берёт ссылки футера.
  var NAV = [
    { label: "Главная", href: "index.html" },
    { label: "Библиотека", href: "library/index.html" },
    { label: "Карточки", href: "flashcards/index.html" },
    { label: "ИИ-помощник", href: "assistant/index.html" },
    { label: "Преподаватель", href: "support/teacher.html" },
    { label: "Контакты", href: "support/contacts.html" }
  ];
  var CTA_HREF = "support/contacts.html";
  var TELEGRAM_URL = "https://t.me/kski12";

  // До какой ширины окна меню, Telegram и кнопка спрятаны в бургер. Строка
  // с шестью пунктами занимает ~895px из колонки 920px, поэтому бургер
  // держится, пока колонка не вырастет до полной ширины. На главной
  // строке нужно место ещё и под кнопку записи.
  var COMPACT_MAX = 960;
  var COMPACT_MAX_HOME = 1150;
  // На сколько пикселей прокрутить страницу, чтобы шапка получила фон.
  var SCROLLED_AFTER = 4;
  // Сколько пикселей подряд прокрутить вверх, чтобы спрятанная шапка вернулась.
  var SHOW_AFTER = 10;

  var script = document.currentScript;
  var SCRIPT_PATH = /components\/site-header\/header\.js(?:[?#].*)?$/;
  // "../../" — путь от страницы к корню сайта, им начинаются ссылки шапки.
  var prefix = script.getAttribute("src").replace(SCRIPT_PATH, "");
  // "library/hsk-3/index.html" — путь страницы от корня сайта.
  var rootUrl = script.src.replace(SCRIPT_PATH, "");
  var pageUrl = location.href.replace(/[?#].*$/, "");
  var page = pageUrl.indexOf(rootUrl) === 0 ? pageUrl.slice(rootUrl.length) : "";

  // Кнопка «Записаться на урок» есть только на главной (класс
  // site-header--cta). Она стоит справа от Telegram, за краем колонки
  // шапки, поэтому всё остальное на главной там же, где на других
  // страницах: при переходе в раздел кнопка просто пропадает.
  var isHome = page === "" || page === "index.html";

  // «Главная» горит только на главной. Пункт, ведущий на index.html папки, —
  // на всех страницах этой папки (library/hsk-3/ → «Библиотека»).
  // Остальные — только на своей странице.
  function current(href) {
    if (href === "index.html") return isHome ? "page" : null;
    if (page === href) return "page";
    var section = href.replace(/index\.html$/, "");
    if (section !== href && page.indexOf(section) === 0) return "true";
    return null;
  }

  var ICON_TELEGRAM = '<svg class="site-header__tg-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 3.5 2.8 10.7c-.8.3-.8 1.4 0 1.7l4.7 1.6 1.8 5.6c.2.7 1.1.9 1.6.4l2.7-2.6 4.9 3.6c.6.4 1.4.1 1.6-.6L22.9 5c.2-1-.6-1.8-1.4-1.5Z"/><path d="m7.5 14 11-7.5-8.3 9.2"/></svg>';
  var ICON_OPEN = '<svg class="site-header__burger-open" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var ICON_CLOSE = '<svg class="site-header__burger-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var items = NAV.map(function (item) {
    var state = current(item.href);
    return '<li class="site-header__item"><a class="site-header__link" href="' + prefix + item.href + '"' +
      (state ? ' aria-current="' + state + '"' : "") + ">" + item.label + "</a></li>";
  }).join("");

  // На широком окне .site-header__menu не рисуется (display: contents) и
  // меню с правой частью стоят прямо в строке шапки; в режиме бургера это
  // выпадающая панель. Подпись «Написать в Telegram» видна только в панели
  // страниц без кнопки записи, в остальных случаях это имя иконки для
  // экранных дикторов.
  var html =
    '<header class="site-header' + (isHome ? " site-header--cta" : "") + '">' +
      '<div class="site-header__bar">' +
        '<a class="site-header__logo" href="' + prefix + 'index.html">' +
          '<span class="site-header__logo-mark" lang="zh-CN" aria-hidden="true">中</span>' +
          '<span class="site-header__logo-text">Китайский язык</span>' +
        "</a>" +
        '<div class="site-header__menu" id="site-header-menu">' +
          '<nav class="site-header__nav" aria-label="Основное меню">' +
            '<ul class="site-header__list">' + items + "</ul>" +
          "</nav>" +
          '<div class="site-header__actions">' +
            '<span class="site-header__divider" aria-hidden="true"></span>' +
            '<a class="site-header__tg" href="' + TELEGRAM_URL + '" target="_blank" rel="noopener">' +
              ICON_TELEGRAM + '<span class="site-header__tg-text">Написать в Telegram</span>' +
            "</a>" +
            (isHome ? '<a class="site-header__cta" href="' + prefix + CTA_HREF + '">Записаться на урок</a>' : "") +
          "</div>" +
        "</div>" +
        '<button class="site-header__burger" type="button" aria-controls="site-header-menu" aria-expanded="false" aria-label="Открыть меню">' +
          ICON_OPEN + ICON_CLOSE +
        "</button>" +
      "</div>" +
    "</header>";

  script.insertAdjacentHTML("afterend", html);

  var header = script.nextElementSibling;
  var menu = header.querySelector(".site-header__menu");
  var burger = header.querySelector(".site-header__burger");

  // ------------------------------------------------------------ бургер
  function isOpen() {
    return header.classList.contains("is-open");
  }

  function setOpen(open) {
    header.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", open ? "true" : "false");
    burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  }

  burger.addEventListener("click", function () {
    setOpen(!isOpen());
  });

  menu.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });

  document.addEventListener("click", function (e) {
    if (!isOpen() || menu.contains(e.target) || burger.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !isOpen()) return;
    setOpen(false);
    burger.focus();
  });

  // Окно уже границы — шапка в режиме бургера; расширили обратно — меню
  // снова в строке, а открытая панель закрывается.
  var compact = window.matchMedia("(max-width: " + (isHome ? COMPACT_MAX_HOME : COMPACT_MAX) + "px)");

  function syncCompact() {
    header.classList.toggle("site-header--compact", compact.matches);
    if (!compact.matches) setOpen(false);
  }

  if (compact.addEventListener) compact.addEventListener("change", syncCompact);
  else compact.addListener(syncCompact);
  syncCompact();

  // ---------------------------------------------------------- прокрутка
  // Страницу прокрутили — у шапки появляется фон. При прокрутке вниз шапка
  // уезжает за верх окна, при небольшой прокрутке вверх (SHOW_AFTER
  // пикселей подряд) возвращается. У самого верха страницы, при открытом
  // меню и когда в шапку приходит фокус с клавиатуры она видна всегда.
  var lastY = scrollTop();
  var upDistance = 0;
  var raf = null;

  // Позиция без «резинки» iOS: за края страницы не выходит.
  function scrollTop() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return Math.min(Math.max(window.pageYOffset, 0), Math.max(max, 0));
  }

  function setHidden(hidden) {
    header.classList.toggle("is-hidden", hidden);
  }

  function syncScroll() {
    raf = null;
    var y = scrollTop();
    var dy = y - lastY;
    lastY = y;
    header.classList.toggle("is-scrolled", y > SCROLLED_AFTER);
    if (y <= header.offsetHeight || isOpen()) {
      upDistance = 0;
      setHidden(false);
    } else if (dy > 0) {
      upDistance = 0;
      setHidden(true);
    } else if (dy < 0) {
      upDistance -= dy;
      if (upDistance >= SHOW_AFTER) setHidden(false);
    }
  }

  // Фокус в шапке. Показывая элемент с фокусом, браузер прокручивает
  // страницу к месту закреплённой шапки — в самое начало документа: Chrome
  // ещё до focusin, другие браузеры могут после. Поэтому до конца кадра
  // страница держится там, где была при последней обработанной прокрутке
  // (lastY), — и в focusin, и в обработчике scroll, который срабатывает до
  // отрисовки. Если в очереди уже есть прокрутка пользователя, lastY
  // устарел, и страницу не трогаем.
  var holdY = null;

  function hold() {
    if (holdY !== null && scrollTop() !== holdY) window.scrollTo(0, holdY);
  }

  header.addEventListener("focusin", function () {
    setHidden(false);
    if (raf !== null) return;
    holdY = lastY;
    hold();
    requestAnimationFrame(function () {
      holdY = null;
    });
  });

  window.addEventListener("scroll", function () {
    hold();
    if (raf === null) raf = requestAnimationFrame(syncScroll);
  }, { passive: true });
  syncScroll();
})();
