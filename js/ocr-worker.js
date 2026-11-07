/* Распознавание текста на фото тетради прямо в браузере: без сервера и
   без нейросети в интернете. Работает в отдельном потоке (Web Worker),
   чтобы страница не замирала, пока идёт счёт. Запускает его
   js/notebook-ocr.js, он же разбирает строки на слова.

   Модели — PaddleOCR PP-OCRv5 mobile (Apache 2.0), выполняет их
   onnxruntime-web (MIT). Файлы лежат в репозитории данных словаря
   (chinese-dictionary-data, папка ocr/<версия>/, собирает их
   build/build_ocr.py там же). В первый раз они скачиваются и остаются в
   хранилище браузера (Cache Storage), дальше грузятся с устройства.

   Как читаем фото:
   1. Поиск строк (det.onnx) — карта «здесь текст» по уменьшенному фото,
      из неё прямоугольники строк. Повторяет DBPostProcess из PaddleOCR.
   2. Чтение строк (rec-zh.onnx) — каждая строка вырезается из фото,
      выравнивается и приводится к высоте 48 точек. Модель читает
      иероглифы, пиньинь и латиницу. У каждого знака — уверенность и
      запасные варианты, по ним js/notebook-ocr.js сверяет слово со
      словарём.
   3. Русский (rec-ru.onnx) — китайская модель кириллицу не знает, поэтому
      строки без уверенных иероглифов и текст рядом с иероглифами в той же
      строке («朋友 — друг») читаются ещё и русской моделью.

   Сообщения:
     → { type: "run", id, base, width, height, pixels }  пиксели RGBA (ArrayBuffer)
     ← { type: "progress", id, loaded, total }            скачивание, байты
     ← { type: "stage", id, stage: "detect" | "read", done, total }
     ← { type: "result", id, lines }
     ← { type: "error", id, code, message }                code: "load" | "run"

   Строка в lines: { box: 4 угла [x, y] в пикселях фото (левый верхний, правый
   верхний, правый нижний, левый нижний), zh: чтение китайской моделью,
   ru: [чтения русской моделью частей строки] }. Чтение — { text, score,
   chars: [{ c, p, t0, t1, alts? }], step } (у русских ещё from и to — доли
   ширины строки). Знак c с уверенностью p стоит на шагах t0…t1 модели, шаг —
   доля step ширины прочитанного куска; alts — запасные варианты [знак, p]. */
"use strict";

var CACHE_PREFIX = "notebook-ocr-";

var DET_SIDE = 960;          // длинная сторона фото для поиска строк
var DET_THRESH = 0.3;        // порог карты «здесь текст»
var BOX_THRESH = 0.6;        // средняя уверенность внутри строки
var UNCLIP = 1.5;            // насколько расширить найденную строку
var MIN_SIZE = 3;
var MAX_BOXES = 1000;
var DET_MEAN = [0.485, 0.456, 0.406];   // по каналам B, G, R — как в PaddleOCR
var DET_STD = [0.229, 0.224, 0.225];

var REC_H = 48;              // высота строки для чтения
var REC_MIN_W = 320;         // короче — добивается пустым полем, как при обучении
var REC_MAX_W = 3200;
var REC_BATCH = 6;
var ALTS = 3;                // сколько запасных вариантов знака отдавать

var base = "";
var ort = null;
var models = null;
var loading = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function fail(code, err) {
  var e = err instanceof Error ? err : new Error(String(err));
  if (!e.code) e.code = code;
  return e;
}

// ------------------------------------------------------------ загрузка

function openCache(name) {
  if (!self.caches) return Promise.resolve(null);
  return self.caches.open(name).then(function (cache) {
    // Файлы прежних версий больше не нужны.
    self.caches.keys().then(function (keys) {
      keys.forEach(function (key) {
        if (key.indexOf(CACHE_PREFIX) === 0 && key !== name) self.caches.delete(key);
      });
    }).catch(function () {});
    return cache;
  }).catch(function () {
    return null;    // приватный режим Safari и т. п. — обойдёмся без хранилища
  });
}

// Скачивание с отчётом о байтах. Зависший запрос обрывается, оборванный
// повторяется: мобильная сеть рвёт соединения.
function download(url, onBytes, tries) {
  if (tries === undefined) tries = 3;
  var ctrl = self.AbortController ? new AbortController() : null;
  var timer = null;
  function arm() {
    clearTimeout(timer);
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 30000);
  }
  arm();
  return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
    if (!res.ok) throw fail("load", new Error("HTTP " + res.status + " — " + url));
    if (!res.body || !res.body.getReader) {
      return res.arrayBuffer().then(function (buf) {
        onBytes(buf.byteLength);
        return buf;
      });
    }
    var reader = res.body.getReader();
    var chunks = [];
    var got = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        arm();
        chunks.push(r.value);
        got += r.value.byteLength;
        onBytes(got);
        return pump();
      });
    }
    return pump().then(function () {
      var out = new Uint8Array(got);
      var at = 0;
      chunks.forEach(function (c) {
        out.set(c, at);
        at += c.byteLength;
      });
      return out.buffer;
    });
  }).then(function (buf) {
    clearTimeout(timer);
    return buf;
  }, function (err) {
    clearTimeout(timer);
    onBytes(0);
    if (err.code === "load" || tries <= 1) throw fail("load", err);
    return new Promise(function (resolve) { setTimeout(resolve, 1000); }).then(function () {
      return download(url, onBytes, tries - 1);
    });
  });
}

// Список файлов с размерами — files.json рядом с моделями. Размеры нужны
// для полосы загрузки: сервер отдаёт файлы сжатыми, и Content-Length с
// прочитанными байтами не сходится.
function loadFiles(id) {
  var manifest = base + "files.json";
  var cacheName = CACHE_PREFIX + base.replace(/\/$/, "").split("/").pop();
  return openCache(cacheName).then(function (cache) {
    function fromCache(url) {
      return cache ? cache.match(url).catch(function () { return null; }) : Promise.resolve(null);
    }
    function keep(url, buf, type) {
      if (!cache) return;
      cache.put(url, new Response(buf, { headers: { "Content-Type": type } })).catch(function () {});
    }
    return fromCache(manifest).then(function (hit) {
      if (hit) return hit.json();
      return download(manifest, function () {}).then(function (buf) {
        var info = JSON.parse(new TextDecoder().decode(buf));
        keep(manifest, buf, "application/json");
        return info;
      });
    }).then(function (info) {
      var names = Object.keys(info.files);
      return Promise.all(names.map(function (name) {
        return fromCache(base + name).then(function (hit) {
          return hit ? hit.arrayBuffer() : null;
        });
      })).then(function (cached) {
        var total = 0;
        var done = {};
        names.forEach(function (name, i) {
          if (!cached[i]) total += info.files[name];
        });
        var last = 0;
        function report(force) {
          var loaded = 0;
          for (var k in done) loaded += done[k];
          var now = Date.now();
          if (force || now - last > 150) {
            last = now;
            post({ type: "progress", id: id, loaded: Math.min(loaded, total), total: total });
          }
        }
        if (total) report(true);
        // По одному файлу: на медленной сети параллельные загрузки только
        // мешают друг другу, а полоса растёт ровнее.
        var out = {};
        var chain = Promise.resolve();
        names.forEach(function (name, i) {
          chain = chain.then(function () {
            if (cached[i]) {
              out[name] = cached[i];
              return;
            }
            return download(base + name, function (bytes) {
              done[name] = bytes;
              report(false);
            }).then(function (buf) {
              out[name] = buf;
              keep(base + name, buf, "application/octet-stream");
            });
          });
        });
        return chain.then(function () {
          if (total) report(true);
          return out;
        });
      });
    });
  });
}

function load(id) {
  if (models) return Promise.resolve(models);
  if (loading) return loading;
  loading = loadFiles(id).then(function (files) {
    if (!self.ort) {
      try {
        importScripts(base + "ort.wasm.min.js");
      } catch (e) {
        throw fail("load", e);
      }
    }
    ort = self.ort;
    ort.env.logLevel = "error";
    // Без особых заголовков сервера (GitHub Pages их не ставит) потоки
    // WebAssembly недоступны — считаем в одном.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = files["ort-wasm-simd-threaded.wasm"];
    ort.env.wasm.wasmPaths = { mjs: base + "ort-wasm-simd-threaded.mjs" };
    var opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 };
    var m = {
      zhChars: JSON.parse(new TextDecoder().decode(files["rec-zh.json"])),
      ruChars: JSON.parse(new TextDecoder().decode(files["rec-ru.json"]))
    };
    return ort.InferenceSession.create(new Uint8Array(files["det.onnx"]), opts).then(function (s) {
      m.det = s;
      return ort.InferenceSession.create(new Uint8Array(files["rec-zh.onnx"]), opts);
    }).then(function (s) {
      m.zh = s;
      return ort.InferenceSession.create(new Uint8Array(files["rec-ru.onnx"]), opts);
    }).then(function (s) {
      m.ru = s;
      models = m;
      return m;
    });
  }).catch(function (err) {
    loading = null;
    throw fail("load", err);
  });
  return loading;
}

// ------------------------------------------------------- поиск строк

function detect(img) {
  var W = img.width, H = img.height, px = img.data;
  var ratio = DET_SIDE / Math.max(W, H);
  var dw = Math.max(32, Math.round(W * ratio / 32) * 32);
  var dh = Math.max(32, Math.round(H * ratio / 32) * 32);
  var plane = dw * dh;
  var input = new Float32Array(3 * plane);
  var sx = W / dw, sy = H / dh;
  var scale = [], shift = [];
  for (var ch = 0; ch < 3; ch++) {
    scale[ch] = 1 / (255 * DET_STD[ch]);
    shift[ch] = DET_MEAN[ch] / DET_STD[ch];
  }
  for (var y = 0; y < dh; y++) {
    var fy = Math.max(0, (y + 0.5) * sy - 0.5);
    var y0 = Math.min(fy | 0, H - 1), y1 = Math.min(y0 + 1, H - 1), wy = fy - y0;
    for (var x = 0; x < dw; x++) {
      var fx = Math.max(0, (x + 0.5) * sx - 0.5);
      var x0 = Math.min(fx | 0, W - 1), x1 = Math.min(x0 + 1, W - 1), wx = fx - x0;
      var a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4;
      var o = y * dw + x;
      for (var k = 0; k < 3; k++) {
        var v = (px[a + k] * (1 - wx) + px[b + k] * wx) * (1 - wy) + (px[c + k] * (1 - wx) + px[d + k] * wx) * wy;
        var chan = 2 - k;     // RGBA → BGR
        input[chan * plane + o] = v * scale[chan] - shift[chan];
      }
    }
  }
  var feeds = {};
  feeds[models.det.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, dh, dw]);
  return models.det.run(feeds).then(function (out) {
    var map = out[models.det.outputNames[0]];
    return boxes(map.data, dw, dh, W, H);
  });
}

// Выпуклая оболочка (монотонная цепочка Эндрю).
function hull(points) {
  points.sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
  if (points.length < 3) return points;
  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  var lower = [], upper = [], i;
  for (i = 0; i < points.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) lower.pop();
    lower.push(points[i]);
  }
  for (i = points.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) upper.pop();
    upper.push(points[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Прямоугольник наименьшей площади вокруг точек: оси u (вдоль стороны
// оболочки) и v (поперёк), границы по ним.
function minRect(points) {
  var h = hull(points);
  var best = null;
  if (h.length < 3) {
    var p = h[0], q = h[h.length - 1];
    var len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    var ux0 = len ? (q[0] - p[0]) / len : 1, uy0 = len ? (q[1] - p[1]) / len : 0;
    return rectAlong(h, ux0, uy0);
  }
  for (var i = 0; i < h.length; i++) {
    var a = h[i], b = h[(i + 1) % h.length];
    var ex = b[0] - a[0], ey = b[1] - a[1];
    var l = Math.hypot(ex, ey);
    if (!l) continue;
    var r = rectAlong(h, ex / l, ey / l);
    if (!best || r.w * r.h < best.w * best.h) best = r;
  }
  return best;
}

function rectAlong(points, ux, uy) {
  var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (var k = 0; k < points.length; k++) {
    var u = points[k][0] * ux + points[k][1] * uy;
    var v = -points[k][0] * uy + points[k][1] * ux;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { ux: ux, uy: uy, minU: minU, maxU: maxU, minV: minV, maxV: maxV, w: maxU - minU, h: maxV - minV };
}

function corners(r, pad) {
  var pts = [[r.minU - pad, r.minV - pad], [r.maxU + pad, r.minV - pad], [r.maxU + pad, r.maxV + pad], [r.minU - pad, r.maxV + pad]];
  return pts.map(function (p) {
    return [p[0] * r.ux - p[1] * r.uy, p[0] * r.uy + p[1] * r.ux];
  });
}

// Углы по порядку: левый верхний, правый верхний, правый нижний, левый
// нижний (get_mini_boxes в PaddleOCR).
function order(pts) {
  pts = pts.slice().sort(function (p, q) { return p[0] - q[0]; });
  var tl = pts[0][1] <= pts[1][1] ? pts[0] : pts[1];
  var bl = tl === pts[0] ? pts[1] : pts[0];
  var tr = pts[2][1] <= pts[3][1] ? pts[2] : pts[3];
  var br = tr === pts[2] ? pts[3] : pts[2];
  return [tl, tr, br, bl];
}

// Средняя уверенность карты внутри прямоугольника (box_score_fast).
function score(prob, dw, dh, r) {
  var pts = corners(r, 0);
  var x0 = dw, x1 = 0, y0 = dh, y1 = 0;
  pts.forEach(function (p) {
    x0 = Math.min(x0, Math.floor(p[0]));
    x1 = Math.max(x1, Math.ceil(p[0]));
    y0 = Math.min(y0, Math.floor(p[1]));
    y1 = Math.max(y1, Math.ceil(p[1]));
  });
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(dw - 1, x1); y1 = Math.min(dh - 1, y1);
  var sum = 0, n = 0;
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      var u = x * r.ux + y * r.uy, v = -x * r.uy + y * r.ux;
      if (u < r.minU - 0.5 || u > r.maxU + 0.5 || v < r.minV - 0.5 || v > r.maxV + 0.5) continue;
      sum += prob[y * dw + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Карта → строки. Связные области карты (8 соседей) — кандидаты; у каждой
// оболочка по крайним точкам строк, прямоугольник, проверка уверенности и
// расширение на UNCLIP, как в PaddleOCR.
function boxes(prob, dw, dh, W, H) {
  var n = dw * dh;
  var seen = new Uint8Array(n);
  var stack = new Int32Array(n);
  var rowMin = new Int32Array(dh).fill(dw);
  var rowMax = new Int32Array(dh).fill(-1);
  var out = [];
  var kx = W / dw, ky = H / dh;
  for (var start = 0; start < n && out.length < MAX_BOXES; start++) {
    if (seen[start] || prob[start] <= DET_THRESH) continue;
    var sp = 0, top = dh, bottom = -1;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp) {
      var p = stack[--sp];
      var py = (p / dw) | 0, pxl = p - py * dw;
      if (pxl < rowMin[py]) rowMin[py] = pxl;
      if (pxl > rowMax[py]) rowMax[py] = pxl;
      if (py < top) top = py;
      if (py > bottom) bottom = py;
      for (var dy = -1; dy <= 1; dy++) {
        var ny = py + dy;
        if (ny < 0 || ny >= dh) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var nx = pxl + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= dw) continue;
          var q = ny * dw + nx;
          if (!seen[q] && prob[q] > DET_THRESH) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    var pts = [];
    for (var y = top; y <= bottom; y++) {
      if (rowMax[y] >= 0) {
        pts.push([rowMin[y], y]);
        if (rowMax[y] !== rowMin[y]) pts.push([rowMax[y], y]);
      }
      rowMin[y] = dw;
      rowMax[y] = -1;
    }
    var r = minRect(pts);
    if (Math.min(r.w, r.h) < MIN_SIZE) continue;
    if (score(prob, dw, dh, r) < BOX_THRESH) continue;
    var d = r.w * r.h * UNCLIP / (2 * (r.w + r.h));
    if (Math.min(r.w, r.h) + 2 * d < MIN_SIZE + 2) continue;
    var box = order(corners(r, d)).map(function (pt) {
      return [
        Math.min(W, Math.max(0, Math.round(pt[0] * kx))),
        Math.min(H, Math.max(0, Math.round(pt[1] * ky)))
      ];
    });
    var bw = Math.hypot(box[1][0] - box[0][0], box[1][1] - box[0][1]);
    var bh = Math.hypot(box[3][0] - box[0][0], box[3][1] - box[0][1]);
    if (bw <= 3 || bh <= 3) continue;
    out.push(box);
  }
  return out;
}

// ------------------------------------------------------- чтение строк

// Строка из фото: прямоугольник box выпрямляется в полосу высотой REC_H.
// Высокие узкие строки (вертикальный текст) поворачиваются, как в
// get_rotate_crop_image из PaddleOCR.
function cropInfo(box) {
  var tl = box[0], tr = box[1], br = box[2], bl = box[3];
  var cw = Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), Math.hypot(br[0] - bl[0], br[1] - bl[1]));
  var chh = Math.max(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]), Math.hypot(br[0] - tr[0], br[1] - tr[1]));
  var rotated = chh / Math.max(1, cw) >= 1.5;
  var w = rotated ? chh : cw, h = rotated ? cw : chh;
  return { box: box, rotated: rotated, ratio: w / Math.max(1, h), h: h };
}

// Полоса пишется в dst с позиции at: 3 плоскости REC_H × outW, BGR,
// значения −1…1; справа до outW — нули (как отступ в PaddleOCR).
function fillCrop(img, info, dst, at, outW) {
  var W = img.width, H = img.height, px = img.data;
  var box = info.box, tl = box[0], tr = box[1], bl = box[3];
  var rw = Math.max(1, Math.min(outW, Math.ceil(REC_H * info.ratio)));
  var plane = REC_H * outW;
  var ax = tr[0] - tl[0], ay = tr[1] - tl[1];     // вдоль строки
  var bx = bl[0] - tl[0], by = bl[1] - tl[1];     // поперёк
  var n = Math.max(1, Math.min(3, Math.round(info.h / REC_H)));   // подвыборка при сильном уменьшении
  var inv = 1 / (n * n * 127.5);
  for (var y = 0; y < REC_H; y++) {
    for (var x = 0; x < rw; x++) {
      var sb = 0, sg = 0, sr = 0;
      for (var j = 0; j < n; j++) {
        for (var i = 0; i < n; i++) {
          var s = (x + (i + 0.5) / n) / rw;       // доля по ширине полосы
          var t = (y + (j + 0.5) / n) / REC_H;    // доля по высоте
          var su = info.rotated ? 1 - t : s;
          var sv = info.rotated ? s : t;
          var fx = tl[0] + su * ax + sv * bx - 0.5;
          var fy = tl[1] + su * ay + sv * by - 0.5;
          if (fx < 0) fx = 0; else if (fx > W - 1) fx = W - 1;
          if (fy < 0) fy = 0; else if (fy > H - 1) fy = H - 1;
          var x0 = fx | 0, y0 = fy | 0;
          var x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
          var wx = fx - x0, wy = fy - y0;
          var a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4;
          var w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy), w10 = (1 - wx) * wy, w11 = wx * wy;
          sr += px[a] * w00 + px[b] * w01 + px[c] * w10 + px[d] * w11;
          sg += px[a + 1] * w00 + px[b + 1] * w01 + px[c + 1] * w10 + px[d + 1] * w11;
          sb += px[a + 2] * w00 + px[b + 2] * w01 + px[c + 2] * w10 + px[d + 2] * w11;
        }
      }
      var o = at + y * outW + x;
      dst[o] = sb * inv - 1;
      dst[o + plane] = sg * inv - 1;
      dst[o + 2 * plane] = sr * inv - 1;
    }
  }
}

// CTC: самый вероятный знак на каждом шаге, повторы подряд схлопываются,
// пустой знак (0) убирается. Уверенность знака — лучшая на его отрезке.
// Последний класс — пробел, остальные — по словарю модели.
function ctc(data, dims, chars, b, withAlts) {
  var T = dims[1], C = dims[2];
  var start = b * T * C;
  var list = [], prev = 0, cur = null;
  for (var t = 0; t < T; t++) {
    var o = start + t * C;
    var best = 0, bestP = data[o];
    for (var c = 1; c < C; c++) {
      if (data[o + c] > bestP) {
        bestP = data[o + c];
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      cur = { k: best, p: bestP, t: t, t0: t, t1: t };
      list.push(cur);
    } else if (best !== 0 && cur) {
      cur.t1 = t;
      if (bestP > cur.p) {
        cur.p = bestP;
        cur.t = t;
      }
    }
    prev = best;
  }
  function sym(k) {
    return k <= chars.length ? chars[k - 1] : " ";
  }
  var text = "", sum = 0;
  var out = list.map(function (it) {
    var ch = sym(it.k);
    text += ch;
    sum += it.p;
    var item = { c: ch, p: round(it.p), t0: it.t0, t1: it.t1 };
    if (withAlts) {
      var o = start + it.t * C;
      var top = [];
      for (var c = 1; c < C; c++) {
        var v = data[o + c];
        if (c === it.k || (top.length === ALTS && v <= top[ALTS - 1][1])) continue;
        top.push([c, v]);
        top.sort(function (p, q) { return q[1] - p[1]; });
        if (top.length > ALTS) top.pop();
      }
      item.alts = top.filter(function (p) { return p[1] >= 0.01; }).map(function (p) {
        return [sym(p[0]), round(p[1])];
      });
    }
    return item;
  });
  return { text: text, score: list.length ? round(sum / list.length) : 0, chars: out };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

// Чтение пачками по REC_BATCH строк похожей ширины (сортировка по
// соотношению сторон, как в PaddleOCR). onDone — после каждой пачки.
function readAll(img, infos, session, chars, withAlts, onDone) {
  var orderIdx = infos.map(function (_, i) { return i; }).sort(function (a, b) {
    return infos[a].ratio - infos[b].ratio;
  });
  var results = new Array(infos.length);
  var pos = 0;
  function next() {
    if (pos >= orderIdx.length) return Promise.resolve(results);
    var batch = orderIdx.slice(pos, pos + REC_BATCH);
    pos += batch.length;
    var maxRatio = REC_MIN_W / REC_H;
    batch.forEach(function (i) { maxRatio = Math.max(maxRatio, infos[i].ratio); });
    var outW = Math.min(REC_MAX_W, Math.ceil(REC_H * maxRatio / 8) * 8);
    var size = 3 * REC_H * outW;
    var input = new Float32Array(batch.length * size);
    batch.forEach(function (i, k) { fillCrop(img, infos[i], input, k * size, outW); });
    var feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [batch.length, 3, REC_H, outW]);
    return session.run(feeds).then(function (out) {
      var t = out[session.outputNames[0]];
      batch.forEach(function (i, k) {
        var r = ctc(t.data, t.dims, chars, k, withAlts);
        // Доля ширины строки на один шаг модели: знак с шагами t0…t1
        // стоит на (t0…t1 + 1) × step от левого края строки.
        var rw = Math.max(1, Math.min(outW, Math.ceil(REC_H * infos[i].ratio)));
        r.step = Math.round(outW / t.dims[1] / rw * 10000) / 10000;
        results[i] = r;
      });
      onDone(batch.length);
      return next();
    });
  }
  return next();
}

var HANZI = /[㐀-䶿一-鿿豈-﫿]/;
var NOT_LETTER = /[\s\-—–−_.,:;·•()[\]|\/\\'"«»=~]/;

// Где в строке уверенные иероглифы: первый и последний из них. Один
// неуверенный «иероглиф» не в счёт — так китайская модель бывает читает
// русскую пропись. Без уверенных иероглифов — null.
function hanziSpan(r) {
  var sure = r.chars.filter(function (c) { return HANZI.test(c.c) && c.p >= 0.6; });
  if (!sure.length || (sure.length === 1 && sure[0].p < 0.85)) return null;
  var first = sure[0], last = sure[sure.length - 1];
  return { first: first, last: last };
}

// Граница между иероглифами и соседним текстом — посередине между краями
// знаков (CTC отмечает знак узким пиком, поэтому края приблизительные).
function textOutside(r, span) {
  var parts = [];
  var before = r.chars.filter(function (c) { return c.t1 < span.first.t0 && !NOT_LETTER.test(c.c) && !HANZI.test(c.c); });
  var after = r.chars.filter(function (c) { return c.t0 > span.last.t1 && !NOT_LETTER.test(c.c) && !HANZI.test(c.c); });
  if (before.length >= 2) {
    parts.push({ from: 0, to: Math.min(1, (before[before.length - 1].t1 + 1 + span.first.t0) / 2 * r.step) });
  }
  if (after.length >= 2) {
    parts.push({ from: Math.max(0, (span.last.t1 + 1 + after[0].t0) / 2 * r.step), to: 1 });
  }
  return parts;
}

// Часть строки от доли a до доли b её ширины.
function subBox(box, a, b) {
  function lerp(p, q, t) {
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  }
  return [lerp(box[0], box[1], a), lerp(box[0], box[1], b), lerp(box[3], box[2], b), lerp(box[3], box[2], a)];
}

function run(msg) {
  var img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.pixels) };
  post({ type: "stage", id: msg.id, stage: "detect" });
  return detect(img).then(function (found) {
    var infos = found.map(cropInfo);
    // Сколько строк прочтёт ещё и русская модель, станет ясно после
    // китайской; до того считаем, что примерно столько же.
    var total = 2 * infos.length;
    var done = 0;
    post({ type: "stage", id: msg.id, stage: "read", done: 0, total: total });
    function step(k) {
      done += k;
      post({ type: "stage", id: msg.id, stage: "read", done: Math.min(done, total), total: total });
    }
    return readAll(img, infos, models.zh, models.zhChars, true, step).then(function (zh) {
      // Русская модель — на строки без уверенных иероглифов и на текст
      // рядом с иероглифами («朋友 — друг» одной строкой).
      var jobs = [];
      zh.forEach(function (r, i) {
        var span = hanziSpan(r);
        if (!span) {
          jobs.push({ line: i, from: 0, to: 1, info: infos[i] });
        } else if (!infos[i].rotated) {
          textOutside(r, span).forEach(function (part) {
            if (part.to - part.from < 0.05) return;
            jobs.push({ line: i, from: part.from, to: part.to, info: cropInfo(subBox(infos[i].box, part.from, part.to)) });
          });
        }
      });
      total = infos.length + jobs.length;
      step(0);
      var subInfos = jobs.map(function (j) { return j.info; });
      return readAll(img, subInfos, models.ru, models.ruChars, false, step).then(function (ru) {
        var lines = infos.map(function (info, i) {
          return { box: info.box, zh: zh[i], ru: [] };
        });
        jobs.forEach(function (j, k) {
          var r = ru[k];
          r.from = Math.round(j.from * 10000) / 10000;
          r.to = Math.round(j.to * 10000) / 10000;
          lines[j.line].ru.push(r);
        });
        return lines;
      });
    });
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== "run") return;
  if (msg.base) base = msg.base;
  load(msg.id).then(function () {
    return run(msg).catch(function (err) {
      throw fail("run", err);
    });
  }).then(function (lines) {
    post({ type: "result", id: msg.id, lines: lines });
  }, function (err) {
    post({
      type: "error",
      id: msg.id,
      code: err.code || "run",
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack).slice(0, 2000) : ""
    });
  });
};
