(function () {
  "use strict";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var bg = document.querySelector(".bg-fixed");
  if (!bg) return;

  var current = 0;
  var raf = null;

  function targetProgress() {
    var scrollable = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return 0;
    var p = window.scrollY / scrollable;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function tick() {
    var target = targetProgress();
    current += (target - current) * 0.08;

    var travel = bg.offsetHeight - window.innerHeight;
    var y = -(current * (travel > 0 ? travel : 0));
    bg.style.transform = "translate3d(0, " + y.toFixed(1) + "px, 0)";

    if (Math.abs(target - current) > 0.001) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  }

  function requestTick() {
    if (raf === null) raf = requestAnimationFrame(tick);
  }

  window.addEventListener("scroll", requestTick, { passive: true });
  window.addEventListener("resize", requestTick, { passive: true });
  requestTick();
})();
