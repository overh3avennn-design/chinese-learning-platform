/* Обращения сайта к нейросети Qwen. Всё идёт через Cloudflare Worker
   chinese-ai (папка ai-worker/): там системные промпты, модели, лимиты и
   ключ API. Сайт присылает только название задачи и её данные.

   AI.ask(task, data, { signal, timeout }) → Promise(result)
     Ошибка — Error с полями code и message; message по-русски, его можно
     показывать как есть. code "aborted" — запрос отменили сами.
   AI.explainWord(word, { pinyin, gloss }) → Promise({ word, pinyin,
     partOfSpeech, meaning, examples: [{ zh, pinyin, ru }],
     synonyms: [{ word, pinyin, difference }], note }) — объяснение слова;
     пиньинь и перевод из словаря помогают выбрать нужное значение.
   AI.markdown(text) → HTML ответа нейросети; AI.inline(text) — то же для
     одной строки, AI.text(text) — просто текст. Безопасно: текст сначала
     экранируется целиком, а потом из разметки markdown собираются наши
     теги, так что теги из ответа в страницу не попадают. Китайский текст
     обёрнут в <span class="zh" lang="zh-CN"> — свой шрифт и цвет.

   Подключается до скрипта раздела: <script src="../js/ai.js"></script>. */
(function () {
  "use strict";

  var ENDPOINT = "https://chinese-ai.overh3avennn.workers.dev/";
  var TIMEOUT = 130000;     // воркер ждёт нейросеть до 90–120 с

  function fail(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function ask(task, data, opts) {
    opts = opts || {};
    var ctrl = window.AbortController ? new AbortController() : null;
    var outer = opts.signal;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, opts.timeout || TIMEOUT);

    function onAbort() {
      if (ctrl) ctrl.abort();
    }
    function cleanup() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    }
    if (outer) {
      if (outer.aborted) onAbort();
      else outer.addEventListener("abort", onAbort);
    }

    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: task, data: data || {} }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try {
          body = JSON.parse(text);
        } catch (e) {}
        if (body && body.ok) return body.result;
        if (body && body.error && body.error.message) throw fail(body.error.code || "error", body.error.message);
        throw fail("bad_response", "Сервер ИИ ответил с ошибкой (" + res.status + "). Попробуйте позже.");
      });
    }).then(function (result) {
      cleanup();
      return result;
    }, function (err) {
      cleanup();
      if (err && err.code) throw err;
      if (timedOut) throw fail("timeout", "Нейросеть отвечает слишком долго. Попробуйте ещё раз.");
      if (outer && outer.aborted) throw fail("aborted", "Запрос отменён.");
      throw fail("network", "Нет связи с сервером ИИ. Пока он работает только с VPN — включите VPN и попробуйте ещё раз.");
    });
  }

  // Объяснение слова. Одно и то же слово второй раз не запрашивается, пока
  // открыта страница; неудачный запрос из памяти убирается.
  var explained = {};

  function explainWord(word, opts) {
    word = String(word || "").trim();
    opts = opts || {};
    if (!explained[word]) {
      var p = ask("explain-word", {
        word: word,
        pinyin: opts.pinyin || "",
        gloss: opts.gloss || ""
      }, { timeout: 80000 });
      explained[word] = p;
      p.catch(function () {
        if (explained[word] === p) delete explained[word];
      });
    }
    return explained[word];
  }

  // ------------------------------------------------------------ markdown
  var HANZI = /[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff]/;
  // Иероглифы вместе с китайской пунктуацией (。，！？「」) — одним куском.
  var ZH_RUN = /(?:[　-〿㐀-䶿一-鿿豈-﫿！-･]|[\ud840-\ud8bf][\udc00-\udfff])+/g;
  var LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  var FENCE_RE = /^\s*(```|~~~)/;
  var HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^\s{0,3}>/;
  var TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // В уже экранированном HTML: в тегах иероглифов нет, поэтому замена
  // задевает только текст.
  function zh(html) {
    return html.replace(ZH_RUN, function (run) {
      return HANZI.test(run) ? '<span class="zh" lang="zh-CN">' + run + "</span>" : run;
    });
  }

  function clean(text) {
    return String(text == null ? "" : text).replace(/[\u0000\u0001]/g, "");
  }

  // Строка: `код`, [ссылка](https://…), **жирный**, *курсив*, ~~зачёркнутый~~
  // и перенос <br> (модель ставит его в ячейки таблиц; другой HTML остаётся
  // текстом). Код и ссылки откладываются в slots, чтобы звёздочки внутри них
  // не превратились в разметку.
  function inline(text) {
    var slots = [];
    function keep(html) {
      slots.push(html);
      return "\u0000" + (slots.length - 1) + "\u0000";
    }
    var s = esc(clean(text));
    s = s.replace(/`([^`\n]+)`/g, function (all, code) {
      return keep("<code>" + zh(code) + "</code>");
    });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, function (all, label, url) {
      return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">') + label + keep("</a>");
    });
    s = s.replace(/&lt;br\s*\/?&gt;/gi, function () {
      return keep("<br>");
    });
    s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, "<del>$1</del>");
    s = zh(s);
    return s.replace(/\u0000(\d+)\u0000/g, function (all, i) {
      return slots[+i];
    });
  }

  function indentOf(line) {
    return line.replace(/\t/g, "    ").match(/^ */)[0].length;
  }

  function isTableStart(lines, i) {
    return lines[i].indexOf("|") >= 0 && i + 1 < lines.length &&
      lines[i + 1].indexOf("-") >= 0 && TABLE_SEP_RE.test(lines[i + 1]);
  }

  function isBlockStart(lines, i) {
    var line = lines[i];
    return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
      QUOTE_RE.test(line) || LIST_RE.test(line) || isTableStart(lines, i);
  }

  function cells(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|" && s.charAt(s.length - 2) !== "\\") s = s.slice(0, -1);
    return s.replace(/\\\|/g, "\u0001").split("|").map(function (c) {
      return c.replace(/\u0001/g, "|").trim();
    });
  }

  // Таблица — в обёртке с прокруткой: на телефоне широкая таблица
  // прокручивается сама, а не растягивает страницу.
  function table(head, rows) {
    var html = '<div class="ai-table"><table><thead><tr>';
    head.forEach(function (c) {
      html += "<th>" + inline(c) + "</th>";
    });
    html += "</tr></thead><tbody>";
    rows.forEach(function (row) {
      html += "<tr>";
      head.forEach(function (h, k) {
        html += "<td>" + inline(row[k] || "") + "</td>";
      });
      html += "</tr>";
    });
    return html + "</tbody></table></div>";
  }

  // Список с вложенными списками (по отступу). Пустая строка между пунктами
  // список не обрывает.
  function parseList(lines, i) {
    var first = LIST_RE.exec(lines[i]);
    var base = indentOf(lines[i]);
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    var item = null;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        var next = LIST_RE.exec(lines[j]);
        var nextIndent = indentOf(lines[j]);
        var sameList = next && (nextIndent > base + 1 ||
          (nextIndent >= base && /\d/.test(next[2]) === ordered));
        if (sameList || (!next && nextIndent > base && item)) {
          i = j;
          continue;
        }
        break;
      }
      var m = LIST_RE.exec(line);
      var indent = indentOf(line);
      if (indent < base && !(item && !m && !isBlockStart(lines, i))) break;
      if (m && indent <= base + 1) {
        if (/\d/.test(m[2]) !== ordered) break;
        item = { lines: [m[3]], children: [] };
        items.push(item);
        i++;
      } else if (m && item) {
        var sub = parseList(lines, i);
        item.children.push(sub.html);
        i = sub.next;
      } else if (item && !isBlockStart(lines, i)) {
        item.lines.push(line.trim());
        i++;
      } else {
        break;
      }
    }
    var html = ordered ? "<ol" + (start !== 1 ? ' start="' + start + '"' : "") + ">" : "<ul>";
    items.forEach(function (it) {
      html += "<li>" + it.lines.map(inline).join("<br>") + it.children.join("") + "</li>";
    });
    return { html: html + (ordered ? "</ol>" : "</ul>"), next: i };
  }

  function blocks(lines) {
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      var fence = FENCE_RE.exec(line);
      if (fence) {
        var code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0) code.push(lines[i++]);
        i++;
        out.push("<pre><code>" + zh(esc(code.join("\n"))) + "</code></pre>");
        continue;
      }
      var h = HEADING_RE.exec(line);
      if (h) {
        var tag = h[1].length <= 2 ? "h3" : "h4";
        out.push("<" + tag + ">" + inline(h[2]) + "</" + tag + ">");
        i++;
        continue;
      }
      if (isTableStart(lines, i)) {
        var head = cells(line);
        var rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) rows.push(cells(lines[i++]));
        out.push(table(head, rows));
        continue;
      }
      if (HR_RE.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        var quote = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        out.push("<blockquote>" + blocks(quote) + "</blockquote>");
        continue;
      }
      if (LIST_RE.test(line)) {
        var list = parseList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }
      var para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) para.push(lines[i++].trim());
      out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    }
    return out.join("");
  }

  function markdown(text) {
    return blocks(clean(text).replace(/\r\n?/g, "\n").split("\n"));
  }

  // Простой текст (сообщение ученика): экранирован, переносы строк сохранены
  // через CSS white-space: pre-wrap.
  function plain(text) {
    return zh(esc(clean(text)));
  }

  window.AI = {
    ask: ask,
    explainWord: explainWord,
    markdown: markdown,
    inline: inline,
    text: plain
  };
})();
