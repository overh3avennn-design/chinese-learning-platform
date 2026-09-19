(function () {
  "use strict";

  // Only the homepage has a hero video; every other page already shows
  // its border-bottom line all the time (see css/style.css). Here we
  // reveal that same line on the homepage too, but only once the fixed
  // header has scrolled past the video — i.e. once it's sitting over
  // the plain background color instead of the wallpaper.
  var header = document.querySelector(".site-header");
  var hero = document.querySelector(".hero-video");
  if (!header || !hero) return;

  var raf = null;

  function sync() {
    raf = null;
    var headerHeight = header.offsetHeight;
    var heroBottom = hero.getBoundingClientRect().bottom;
    header.classList.toggle("is-past-hero", heroBottom <= headerHeight);
  }

  function requestSync() {
    if (raf === null) raf = requestAnimationFrame(sync);
  }

  window.addEventListener("scroll", requestSync, { passive: true });
  window.addEventListener("resize", requestSync, { passive: true });
  sync();
})();
