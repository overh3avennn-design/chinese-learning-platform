/* Бургер-меню первого экрана главной (разметка — index.html, стили —
   css/home.css). На широком экране кнопка скрыта и меню видно всегда;
   на узком меню выпадает под шапкой. Закрывается повторным нажатием,
   кликом мимо, клавишей Esc и переходом по пункту. */
(function () {
  "use strict";

  var toggle = document.querySelector(".hm-burger");
  var menu = document.getElementById("hm-menu");
  if (!toggle || !menu) return;

  function setOpen(open) {
    menu.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  }

  toggle.addEventListener("click", function () {
    setOpen(!menu.classList.contains("is-open"));
  });

  menu.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });

  document.addEventListener("click", function (e) {
    if (menu.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !menu.classList.contains("is-open")) return;
    setOpen(false);
    toggle.focus();
  });

  // Окно расширили до десктопа — меню снова в строке, флаг открытия не нужен.
  var wide = window.matchMedia("(min-width: 961px)");
  var onChange = function (e) {
    if (e.matches) setOpen(false);
  };
  if (wide.addEventListener) wide.addEventListener("change", onChange);
  else wide.addListener(onChange);
})();
