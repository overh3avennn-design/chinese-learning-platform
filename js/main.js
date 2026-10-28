/* Весь скрипт сайта одним файлом: заглушки вместо обложек, прелоадер,
   фильмы с Яндекс Диска, кнопка «назад» и форма обратной связи. Шапка —
   отдельный компонент components/site-header. Каждый блок сам проверяет,
   есть ли на странице то, с чем он работает, поэтому файл подключается ко
   всем страницам одинаково.
   Анимаций скролла на сайте нет: колесо, клавиатура и якорные ссылки
   работают нативно, фон под содержимым не движется. */
(function () {
  "use strict";

  // ------------------------------------------- заглушка вместо обложки
  // Обложки материалов (images/previews/) лежат только локально, в git их
  // нет. Если картинка не загрузилась, на её месте та же плашка с
  // расширением файла, что ставит scripts/generate_pages.py, когда обложки
  // нет совсем.
  function initCoverFallback() {
    function fallback(img) {
      var cover = img.closest(".material-cover");
      if (!cover) return;
      // Расширение ставит генератор в data-ext: у ссылки на Яндекс Диск
      // (disk.yandex.ru/i/…) его в адресе нет.
      var ext = cover.getAttribute("data-ext") ||
        (cover.getAttribute("href") || "").split(/[?#]/)[0].split(".").slice(1).pop();
      var span = document.createElement("span");
      span.className = "material-fallback";
      span.textContent = ext ? ext.toUpperCase() : "Файл";
      img.replaceWith(span);
    }

    // Ошибка загрузки не всплывает — ловим её на фазе перехвата.
    document.addEventListener("error", function (e) {
      if (e.target.tagName === "IMG") fallback(e.target);
    }, true);
    // Картинки, которые не загрузились ещё до запуска скрипта.
    Array.prototype.forEach.call(document.querySelectorAll(".material-cover img"), function (img) {
      if (img.complete && !img.naturalWidth) fallback(img);
    });
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

  // ------------------------------------------------- кнопка «назад»
  // Часть разделов открывается двумя путями: с главной библиотеки (блок
  // «Все разделы») и из своего раздела-родителя («Учебники», «Материалы»).
  // В разметке «назад» ведёт к родителю. Карточки на главной библиотеки
  // добавляют к адресу ?from=library — тогда кнопка возвращает в
  // библиотеку. Адрес библиотеки берём из хлебных крошек страницы.
  function initBackLink() {
    if (new URLSearchParams(location.search).get("from") !== "library") return;

    var back = Array.prototype.find.call(document.querySelectorAll(".nav-next a"), function (a) {
      return a.textContent.trim().charAt(0) === "←";
    });
    var library = Array.prototype.find.call(document.querySelectorAll(".breadcrumb a"), function (a) {
      return a.textContent.trim() === "Библиотека";
    });
    if (!back || !library) return;

    back.setAttribute("href", library.getAttribute("href"));
    back.textContent = "← Библиотека";
  }

  // ------------------------------------- форма обратной связи
  // Заявку с support/contacts.html принимает посредник на Cloudflare
  // (worker/telegram-form.js): он сохраняет её и возвращает ссылку на
  // бота с кодом заявки. Ученик открывает бота, жмёт «Старт», и бот
  // пересылает заявку преподавателю вместе с Telegram ученика. Адрес
  // посредника — в data-endpoint формы. Токен бота хранится только у
  // посредника: на странице его увидел бы любой посетитель.
  function initContactForm() {
    var form = document.getElementById("contact-form");
    if (!form) return;

    var endpoint = form.getAttribute("data-endpoint");
    var button = form.querySelector("button[type=submit]");
    var status = form.querySelector(".contact-status");
    var next = form.querySelector(".contact-next");
    var FALLBACK = "Напиши мне напрямую в Telegram: @kski12.";

    function show(text, isError) {
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle("is-error", !!isError);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      next.hidden = true;
      if (!endpoint) {
        show("Форма пока не подключена. " + FALLBACK, true);
        return;
      }

      button.disabled = true;
      show("Отправляю…");
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      })
        .then(function (res) {
          if (!res.ok) throw new Error(res.status);
          return res.json();
        })
        .then(function (data) {
          form.reset();
          status.hidden = true;
          next.querySelector("a").href = data.link;
          next.hidden = false;
        })
        .catch(function () {
          show("Не получилось отправить заявку. " + FALLBACK, true);
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  initCoverFallback();
  initPreloader();
  initYandexFilms();
  initBackLink();
  initContactForm();
})();
