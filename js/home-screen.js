/* Предложение «Добавить на главный экран» внутри Telegram Mini App.
   Подключается на странице карточек; js/flashcards.js вызывает
   maybeOfferHomeScreen() в конце колоды — в finishSession(), когда
   показывается экран «Сессия завершена».

   Библиотеку Telegram подгружает js/main.js, и только когда сайт открыт из
   Telegram: в обычном браузере window.Telegram нет, и функция молча
   выходит. Методы главного экрана есть с версии Telegram 8.0.

   Плашка показывается, только если Telegram отвечает 'missed' (ярлык можно
   добавить, но его ещё нет) и предложение не отложено. Срок хранится в
   CloudStorage Telegram под ключом hs_snooze_until: «Не сейчас» — на 14 дней,
   ярлык добавлен — на 10 лет. Касание мимо плашки закрывает её без записи;
   тогда в этот запуск приложения она больше не появится (признак —
   в sessionStorage, как у js/main.js), а в следующий предложим снова. */
(function () {
  "use strict";

  var KEY = "hs_snooze_until";
  var OFFERED = "hs-offered";
  var DAY = 24 * 60 * 60 * 1000;
  var SNOOZE_MS = 14 * DAY;
  var ADDED_MS = 3650 * DAY;            // «на 10 лет вперёд»
  var TEXT = "Добавить приложение на главный экран? Карточки будут открываться в одно касание";

  var subscribed = false;   // на homeScreenAdded подписываемся один раз
  var checking = false;     // ответ Telegram ещё не пришёл — второй раз не спрашиваем
  var offeredHere = false;  // запасной признак, если sessionStorage недоступен
  var bar = null;

  // Telegram.WebApp, если сайт открыт в Telegram версии 8.0 и новее, иначе null.
  function telegram() {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || tg.platform === "unknown") return null;
    if (typeof tg.isVersionAtLeast !== "function" || !tg.isVersionAtLeast("8.0")) return null;
    return tg;
  }

  // Ответы Telegram приходят позже, вне try в maybeOfferHomeScreen.
  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        checking = false;
      }
    };
  }

  function snooze(tg, ms) {
    try {
      tg.CloudStorage.setItem(KEY, String(Date.now() + ms));
    } catch (e) {}
  }

  function wasOffered() {
    if (offeredHere) return true;
    try {
      return sessionStorage.getItem(OFFERED) === "1";
    } catch (e) {
      return false;
    }
  }

  function markOffered() {
    offeredHere = true;
    try {
      sessionStorage.setItem(OFFERED, "1");
    } catch (e) {}
  }

  // ------------------------------------------------------------ плашка
  function hide() {
    if (!bar) return;
    document.removeEventListener("click", onOutside, true);
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  // Касание мимо плашки закрывает её; само касание срабатывает как обычно.
  function onOutside(e) {
    if (bar && !bar.contains(e.target)) hide();
  }

  function button(label, className, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function showBar(tg) {
    bar = document.createElement("div");
    bar.className = "hs-offer";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Добавить на главный экран");

    var text = document.createElement("p");
    text.className = "hs-offer__text";
    text.textContent = TEXT;

    var actions = document.createElement("div");
    actions.className = "hs-offer__actions";
    actions.appendChild(button("Не сейчас", "btn btn-secondary", function () {
      snooze(tg, SNOOZE_MS);
      hide();
    }));
    actions.appendChild(button("Добавить", "btn btn-primary", function () {
      try {
        tg.addToHomeScreen();
      } catch (e) {}
      hide();
    }));

    bar.appendChild(text);
    bar.appendChild(actions);
    document.body.appendChild(bar);
    // Фаза перехвата: касание, после которого появилась плашка, уже прошло
    // и закрыть её не может.
    document.addEventListener("click", onOutside, true);
  }

  // ----------------------------------------------------------- проверка
  window.maybeOfferHomeScreen = function () {
    try {
      var tg = telegram();
      if (!tg) return;

      if (!subscribed) {
        subscribed = true;
        tg.onEvent("homeScreenAdded", safe(function () {
          snooze(tg, ADDED_MS);
          hide();
        }));
      }

      if (bar || checking || wasOffered()) return;
      checking = true;
      tg.checkHomeScreenStatus(safe(function (status) {
        if (status !== "missed") {
          checking = false;
          return;
        }
        tg.CloudStorage.getItem(KEY, safe(function (err, value) {
          checking = false;
          // Срок не прочитался — не показываем: «Не сейчас» не запомнилось бы.
          if (err) return;
          if (Date.now() < (Number(value) || 0)) return;
          if (bar || wasOffered()) return;
          markOffered();
          showBar(tg);
        }));
      }));
    } catch (e) {
      checking = false;
    }
  };
})();
