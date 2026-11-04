/* Прослойка между сайтом и нейросетью Qwen (через Polza.ai).

   Сайт шлёт POST на корень воркера с JSON { task: "chat", data: { … } } —
   название задачи и её данные. Модель, системный промпт и пределы каждой
   задачи — в src/tasks.js; ключ API — только в секретах Cloudflare
   (QWEN_API_KEY), сайт его никогда не видит.

   Ответ: { ok: true, result } или { ok: false, error: { code, message } } с
   подходящим HTTP-статусом; message — по-русски, сайт показывает его как
   есть. GET / — проверка, что воркер жив (нейросеть не вызывает).

   Каждый запрос пишет в лог одну строку JSON: задача, модель, время,
   токены и стоимость в рублях, а при ошибке — её причина. */
import { TASKS } from "./tasks.js";
import { HttpError } from "./util.js";

const DEFAULT_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ANSWER_CHARS = 20000;
// Самый большой запрос из всех задач — больше не читаем вовсе.
const MAX_BODY_BYTES = Math.max(DEFAULT_BODY_BYTES,
  ...Object.values(TASKS).map((t) => t.maxBodyBytes || 0));

export default {
  async fetch(request, env) {
    const started = Date.now();
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env).includes(origin);
    const cors = allowed ? { "Access-Control-Allow-Origin": origin } : {};
    const log = { task: null, origin: origin || null, ray: request.headers.get("cf-ray") };

    try {
      if (request.method === "OPTIONS") {
        if (!allowed) throw forbidden(origin);
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin"
          }
        });
      }

      const url = new URL(request.url);
      if (url.pathname !== "/") throw new HttpError(404, "not_found", "Такого адреса нет.");
      if (request.method === "GET") {
        return json({
          ok: true,
          service: "chinese-ai",
          tasks: Object.keys(TASKS),
          ready: Boolean(env.QWEN_API_KEY && env.QWEN_MODEL && env.QWEN_BASE_URL)
        }, 200, cors);
      }
      if (request.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Нужен POST-запрос.");
      }
      if (!allowed) throw forbidden(origin);

      if (env.RATE_LIMITER) {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          throw new HttpError(429, "rate_limited",
            "Слишком много запросов подряд. Подождите минуту и попробуйте снова.", "worker rate limit");
        }
      }

      const body = await readBody(request, MAX_BODY_BYTES);
      let input;
      try {
        input = JSON.parse(body.text);
      } catch (err) {
        throw new HttpError(400, "bad_request", "Запрос не в формате JSON.", err.message);
      }
      const name = input && typeof input.task === "string" ? input.task : "";
      const task = Object.prototype.hasOwnProperty.call(TASKS, name) ? TASKS[name] : null;
      if (!task) throw new HttpError(400, "unknown_task", "Неизвестная задача.", "task: " + name.slice(0, 40));
      log.task = name;
      if (body.size > (task.maxBodyBytes || DEFAULT_BODY_BYTES)) throw tooLarge(task.model === "vision");

      const data = input.data && typeof input.data === "object" ? input.data : {};
      const messages = task.messages(data);
      const answer = await askQwen(env, task, messages, log);
      const result = task.result ? task.result(answer.text, answer, data) : { text: answer.text };

      console.log(JSON.stringify({ event: "ai_ok", ...log, status: 200, ms: Date.now() - started }));
      return json({ ok: true, result }, 200, cors);
    } catch (err) {
      const e = err instanceof HttpError ? err
        : new HttpError(500, "internal", "Внутренняя ошибка сервиса. Попробуйте позже.");
      console.error(JSON.stringify({
        event: "ai_error",
        ...log,
        status: e.status,
        code: e.code,
        detail: e.detail || (err instanceof HttpError ? undefined : String(err && err.stack || err)),
        ms: Date.now() - started
      }));
      return json({ ok: false, error: { code: e.code, message: e.message } }, e.status, cors);
    }
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function forbidden(origin) {
  return new HttpError(403, "origin_not_allowed", "Запросы с этого адреса не принимаются.",
    "origin: " + (origin || "(нет)"));
}

function tooLarge(photo) {
  return new HttpError(413, "too_large", photo
    ? "Фото слишком большое. Попробуйте другое или сфотографируйте заново."
    : "Слишком длинный запрос. Сократите текст.");
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin"
    }
  });
}

// Тело запроса, но не больше limit байт: длинное обрывается на чтении, а не
// после того, как всё уже в памяти. Больше общего предела бывают только
// фото, поэтому и ошибка — про фото.
async function readBody(request, limit) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > limit) throw tooLarge(true);
  if (!request.body) return { text: "", size: 0 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(true);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), size };
}

// Рассуждения модели (QWEN_REASONING, QWEN_VISION_REASONING): none — выключить,
// low / medium / high — уровень. Выключаем явным enabled: false: effort "none"
// Polza отдаёт провайдеру как есть, а модель без такого уровня может его не понять.
function reasoningParams(value) {
  return value === "none" ? { enabled: false } : { effort: value };
}

// Запрос к Polza (OpenAI-совместимый /chat/completions). Сбой на стороне
// провайдера (502/503, обрыв связи) повторяется один раз: за запрос с
// ошибкой Polza денег не берёт.
async function askQwen(env, task, messages, log) {
  const vision = task.model === "vision";
  const model = vision ? env.QWEN_VISION_MODEL : env.QWEN_MODEL;
  log.model = model || null;
  if (!env.QWEN_API_KEY || !model || !env.QWEN_BASE_URL) {
    throw new HttpError(503, "not_configured", "ИИ пока не настроен. Попробуйте позже.",
      "missing QWEN_API_KEY, QWEN_BASE_URL or model variable");
  }

  const payload = {
    model,
    messages,
    max_tokens: task.maxTokens || 1000,
    temperature: task.temperature !== undefined ? task.temperature : 0.5
  };
  if (task.json) payload.response_format = { type: "json_object" };
  const reasoning = vision ? env.QWEN_VISION_REASONING : env.QWEN_REASONING;
  if (reasoning) payload.reasoning = reasoningParams(reasoning);

  const url = String(env.QWEN_BASE_URL).replace(/\/+$/, "") + "/chat/completions";
  const timeout = task.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let res;
  let raw;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.QWEN_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
      });
      raw = await res.text();
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new HttpError(504, "timeout", "Нейросеть отвечает слишком долго. Попробуйте ещё раз.",
          "upstream timeout after " + timeout + " ms");
      }
      if (attempt < 2 && deadline - Date.now() > 15000) continue;
      throw new HttpError(502, "upstream_unreachable", "Не получилось связаться с нейросетью. Попробуйте ещё раз.",
        "fetch failed: " + String(err && err.message || err));
    }
    if ((res.status === 502 || res.status === 503) && attempt < 2 && deadline - Date.now() > 15000) {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    break;
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {}
  if (!res.ok || !data || data.error) throw upstreamError(res, data, raw);

  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  let text = typeof content === "string" ? content.trim() : "";
  const usage = data.usage || {};
  log.finish = choice && choice.finish_reason || null;
  log.tokensIn = usage.prompt_tokens;
  log.tokensOut = usage.completion_tokens;
  log.reasoningTokens = usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens;
  log.costRub = usage.cost_rub !== undefined ? usage.cost_rub : usage.cost;
  if (!text) {
    throw new HttpError(502, "empty_answer", "Нейросеть вернула пустой ответ. Попробуйте ещё раз.",
      "empty content, finish_reason: " + log.finish);
  }
  if (text.length > MAX_ANSWER_CHARS) text = text.slice(0, MAX_ANSWER_CHARS);
  return { text, finish: log.finish, usage };
}

// Ошибка Polza → понятный ответ сайту. Подробности (код Polza, текст,
// trace_id для поддержки) — только в лог.
function upstreamError(res, data, raw) {
  const err = data && data.error || {};
  const detail = "polza " + res.status + " " + (err.code || "") + ": " +
    String(err.message || raw || "").slice(0, 300) +
    (err.metadata && err.metadata.raw ? " · raw: " + String(err.metadata.raw).slice(0, 200) : "") +
    (data && data.trace_id ? " · trace_id: " + data.trace_id : "");
  switch (res.status) {
    case 400:
      return new HttpError(502, "upstream_bad_request",
        "Нейросеть не смогла обработать запрос. Попробуйте ещё раз или измените его.", detail);
    case 408:
    case 504:
      return new HttpError(504, "timeout", "Нейросеть отвечает слишком долго. Попробуйте ещё раз.", detail);
    case 413:
      return new HttpError(413, "too_large", "Запрос слишком большой для нейросети.", detail);
    case 429:
      return new HttpError(429, "rate_limited",
        "Нейросеть сейчас перегружена. Подождите минуту и попробуйте снова.", detail);
    case 401:
    case 402:
    case 403:
      // 401 — ключ неверный, 402 — кончились деньги или лимит ключа,
      // 403 — запрещено (в том числе модерацией).
      return new HttpError(503, "ai_unavailable", "ИИ временно недоступен. Попробуйте позже.", detail);
    default:
      return new HttpError(502, "upstream_error",
        "Нейросеть временно недоступна. Попробуйте через минуту.", detail);
  }
}
