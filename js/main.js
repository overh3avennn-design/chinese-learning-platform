/* Весь скрипт сайта одним файлом: меню, линия под шапкой на главной и
   прелоадер. Каждый блок сам проверяет, есть ли на странице то, с чем он
   работает, поэтому файл подключается ко всем страницам одинаково.
   Анимаций скролла на сайте нет: колесо, клавиатура и якорные ссылки
   работают нативно, фон под содержимым не движется. */
(function () {
  "use strict";

  // ------------------------------------------------------------ меню
  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.querySelector(".site-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var isOpen = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    document.addEventListener("click", function (e) {
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  }

  // -------------------------------------------- линия под шапкой (главная)
  // Hero-видео есть только на главной; на остальных страницах линия под
  // шапкой видна всегда (см. css/style.css). Здесь она появляется тогда,
  // когда фиксированная шапка ушла за пределы видео — то есть оказалась
  // над обычным фоном, а не над кадром.
  function initHeaderBorder() {
    var header = document.querySelector(".site-header");
    var hero = document.querySelector(".hero-video");
    if (!header || !hero) return;

    var raf = null;

    function sync() {
      raf = null;
      header.classList.toggle(
        "is-past-hero",
        hero.getBoundingClientRect().bottom <= header.offsetHeight
      );
    }

    function requestSync() {
      if (raf === null) raf = requestAnimationFrame(sync);
    }

    window.addEventListener("scroll", requestSync, { passive: true });
    window.addEventListener("resize", requestSync, { passive: true });
    sync();
  }

  // ------------------------------------------------------- прелоадер
  // Держит заставку (см. css/style.css) до тех пор, пока hero-видео не
  // забуферизуется достаточно, чтобы играть без рывков, затем отматывает
  // его на первый кадр и запускает вместе с уходом заставки. Поэтому при
  // перезагрузке страница никогда не показывает замерший кадр.
  function initPreloader() {
    var root = document.documentElement;
    var video = document.querySelector(".hero-video-media");
    var revealed = false;
    var started = false;

    // Не держать заставку бесконечно на медленном соединении.
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

    function play(onBlocked) {
      var playing = video.play();
      // Автозапуск заблокирован (например, режим энергосбережения).
      if (playing && playing.catch) playing.catch(onBlocked);
    }

    function start() {
      if (started) return;
      started = true;
      rewind();
      video.addEventListener("playing", reveal, { once: true });
      play(reveal);
    }

    // Видео нет или оно скрыто ради prefers-reduced-motion — ждать нечего.
    if (!video || getComputedStyle(video).display === "none") {
      reveal();
      return;
    }

    // Отложить автозапуск, пока не наберётся данных на плавное воспроизведение.
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

    // Возврат через кэш «назад/вперёд» восстанавливает видео там, где его
    // поставили на паузу; вместо этого запускаем его с начала.
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) return;
      rewind();
      play(function () {});
    });
  }

  // ------------------------------------- фильмы с Яндекс Диска (культура)
  // Страница library/culture/films.html: блок с data-yadisk-public хранит
  // публичную ссылку на папку. Список видео берётся из неё при открытии
  // страницы через открытый API Диска (без ключей), вместе с вложенными
  // папками, поэтому новый фильм достаточно положить на Диск. Ссылка на сам
  // файл у Диска временная, её запрашиваем заново в момент запуска.
  function initYandexFilms() {
    var root = document.querySelector("[data-yadisk-public]");
    if (!root) return;

    var API = "https://cloud-api.yandex.net/v1/disk/public/resources";
    var KEY = root.getAttribute("data-yadisk-public");
    var MAX_DEPTH = 3;    // сколько уровней вложенных папок обходить
    var PAGE = 100;       // сколько записей просить у API за раз

    var status = root.querySelector(".film-status");
    var list = root.querySelector(".film-list");
    var player = root.querySelector(".film-player");
    var video = player.querySelector("video");
    var titleEl = player.querySelector(".film-player-title");
    var note = player.querySelector(".film-player-note");
    var current = null;

    function getJSON(params) {
      var query = "public_key=" + encodeURIComponent(KEY);
      Object.keys(params).forEach(function (k) {
        if (k.charAt(0) === "_") return;          // служебные ключи — не в запрос
        query += "&" + k + "=" + encodeURIComponent(params[k]);
      });
      return fetch(API + params._endpoint + "?" + query).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }

    function isVideo(item) {
      return item.type === "file" &&
        (item.media_type === "video" || /^video\//.test(item.mime_type || ""));
    }

    // Все видео папки path и её подпапок (до MAX_DEPTH уровней).
    function collect(path, depth, offset, found) {
      return getJSON({ _endpoint: "", path: path, limit: PAGE, offset: offset,
                       preview_size: "L", preview_crop: "false", sort: "name" })
        .then(function (data) {
          // Ссылка может вести не на папку, а на один файл.
          if (data.type === "file") {
            if (isVideo(data)) found.push(data);
            return found;
          }
          var embedded = data._embedded || { items: [], total: 0 };
          var folders = [];
          embedded.items.forEach(function (item) {
            if (isVideo(item)) found.push(item);
            else if (item.type === "dir" && depth < MAX_DEPTH) folders.push(item.path);
          });
          var chain = Promise.resolve();
          if (offset + embedded.items.length < embedded.total) {
            chain = chain.then(function () {
              return collect(path, depth, offset + PAGE, found);
            });
          }
          folders.forEach(function (sub) {
            chain = chain.then(function () { return collect(sub, depth + 1, 0, found); });
          });
          return chain.then(function () { return found; });
        });
    }

    function folderOf(item) {
      return item.path.replace(/\/[^/]*$/, "") || "/";
    }

    function titleOf(item) {
      return item.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ");
    }

    function sizeOf(bytes) {
      if (!bytes) return "";
      var gb = bytes / 1073741824;
      return gb >= 1 ? gb.toFixed(1).replace(".", ",") + " ГБ"
                     : Math.round(bytes / 1048576) + " МБ";
    }

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function card(item) {
      var btn = el("button", "film-card");
      btn.type = "button";
      var cover = el("span", "film-cover");
      if (item.preview) {
        var img = document.createElement("img");
        img.src = item.preview;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", function () { img.remove(); });
        cover.appendChild(img);
      }
      cover.appendChild(el("span", "film-play", "▶"));
      btn.appendChild(cover);
      var body = el("span", "film-body");
      body.appendChild(el("span", "film-title", titleOf(item)));
      var ext = (item.name.match(/\.([^.]+)$/) || [, ""])[1].toUpperCase();
      body.appendChild(el("span", "film-meta",
        [ext, sizeOf(item.size)].filter(Boolean).join(" · ")));
      btn.appendChild(body);
      btn.addEventListener("click", function () { play(item, btn); });
      return btn;
    }

    function showNote(text, href) {
      note.textContent = text;
      if (href) {
        note.appendChild(document.createTextNode(" "));
        var a = el("a", null, "Скачать файл");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        note.appendChild(a);
      }
      note.hidden = false;
    }

    function play(item, btn) {
      if (current) current.classList.remove("is-active");
      current = btn;
      btn.classList.add("is-active");

      player.hidden = false;
      titleEl.textContent = titleOf(item);
      note.hidden = true;
      video.removeAttribute("src");
      video.poster = item.preview || "";
      player.scrollIntoView({ block: "start" });

      getJSON({ _endpoint: "/download", path: item.path })
        .then(function (data) { return data.href; })
        .catch(function () { return item.file; })   // запасная ссылка из списка
        .then(function (href) {
          if (current !== btn) return;            // пока ждали, выбрали другой
          if (!href) {
            showNote("Яндекс Диск не отдал ссылку на этот фильм.", null);
            return;
          }
          if (item.mime_type && video.canPlayType(item.mime_type) === "") {
            showNote("Браузер может не открыть этот формат видео. Если плеер не запустится —", href);
          }
          video.onerror = function () {
            showNote("Не получилось воспроизвести фильм на сайте. " +
              "Если включён VPN — выключите его и обновите страницу.", href);
          };
          video.src = href;
          var started = video.play();
          if (started && started.catch) started.catch(function () {});
        });
    }

    function render(items) {
      if (!items.length) {
        status.textContent = "В папке пока нет видео.";
        return;
      }
      var byName = function (a, b) {
        return a.name.localeCompare(b.name, "ru", { numeric: true });
      };
      var groups = {};
      var order = [];
      items.forEach(function (item) {
        var key = folderOf(item);
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(item);
      });
      order.sort(function (a, b) { return a.localeCompare(b, "ru", { numeric: true }); });
      order.forEach(function (key) {
        if (order.length > 1) {
          var name = key === "/" ? "Разное" : key.split("/").pop();
          list.appendChild(el("h3", "film-group", name));
        }
        var grid = el("div", "film-grid");
        groups[key].sort(byName).forEach(function (item) { grid.appendChild(card(item)); });
        list.appendChild(grid);
      });
      status.hidden = true;
    }

    collect("/", 0, 0, [])
      .then(render)
      .catch(function () {
        status.textContent = "Не удалось получить список фильмов с Яндекс Диска. " +
          "Если включён VPN — выключите его и обновите страницу: " +
          "через VPN Яндекс не отвечает.";
        status.classList.add("is-error");
      });
  }

  initNav();
  initHeaderBorder();
  initPreloader();
  initYandexFilms();
})();
