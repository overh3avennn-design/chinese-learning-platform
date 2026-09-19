(function () {
  "use strict";

  // Keeps the preloader (see css/style.css) up until the hero video has
  // buffered enough to play without stalling, then rewinds it to the
  // first frame and starts it as the cover lifts. On a reload the page
  // therefore never shows a frozen frame from a half-loaded video.
  var root = document.documentElement;
  var video = document.querySelector(".hero-video-media");
  var revealed = false;
  var started = false;

  // Never keep the cover up forever on a slow connection.
  var MAX_WAIT_MS = 6000;

  function reveal() {
    if (revealed) return;
    revealed = true;
    root.classList.remove("is-loading");
  }

  function rewind() {
    try {
      video.currentTime = 0;
    } catch (e) {}
  }

  function start() {
    if (started) return;
    started = true;
    rewind();
    video.addEventListener("playing", reveal, { once: true });
    var playing = video.play();
    // Autoplay blocked (e.g. low-power mode): show the poster instead.
    if (playing && playing.catch) playing.catch(reveal);
  }

  // No video, or it's hidden for reduced motion: nothing to wait for.
  if (!video || getComputedStyle(video).display === "none") {
    reveal();
    return;
  }

  // Hold the autoplay until there's enough data to run smoothly.
  video.pause();
  rewind();

  if (video.readyState >= 4) {
    start();
  } else {
    video.addEventListener("canplaythrough", start, { once: true });
    video.addEventListener("error", reveal, { once: true });
  }

  setTimeout(function () {
    if (revealed) return;
    start();
    reveal();
  }, MAX_WAIT_MS);

  // Coming back via the back/forward cache restores the video wherever it
  // was paused; start it over from the beginning instead.
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    rewind();
    var playing = video.play();
    if (playing && playing.catch) playing.catch(function () {});
  });
})();
