/* Общие мелочи воркера: ошибка с HTTP-статусом и разбор ответов нейросети. */

// Ошибка, которую можно отдать сайту: status — HTTP-статус, code — короткий
// код для программы, message — текст по-русски для человека. detail идёт
// только в лог (там может быть ответ Polza, сайту он не нужен).
export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function badRequest(message, detail) {
  return new HttpError(400, "bad_request", message, detail);
}

export function badAnswer(detail) {
  return new HttpError(502, "bad_ai_response",
    "Нейросеть ответила в неожиданном формате. Попробуйте ещё раз.", detail);
}

// Строка из любого значения: обрезанная по краям и не длиннее max знаков.
export function str(value, max) {
  if (typeof value !== "string") return "";
  const s = value.replace(/\u0000/g, "").trim();
  return max && s.length > max ? s.slice(0, max).trim() : s;
}

export function list(value) {
  return Array.isArray(value) ? value : [];
}

export const CJK = /[㐀-䶿一-鿿豈-﫿]|[\ud840-\ud8bf][\udc00-\udfff]/;

// JSON из ответа модели. Модели иногда оборачивают его в ```json … ``` или
// пишут фразу до и после — берём от первой { или [ до последней } или ].
export function parseJsonAnswer(text) {
  let s = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (start < 0 || end <= start) throw badAnswer("no JSON in answer: " + s.slice(0, 200));
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw badAnswer("invalid JSON: " + err.message + " · " + s.slice(0, 200));
  }
}

// Плоские объекты {…} из оборванного JSON — когда ответ упёрся в предел
// длины и закрывающих скобок нет. Спасает уже распознанное.
export function salvageObjects(text) {
  const out = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    try {
      out.push(JSON.parse(m[0]));
    } catch (err) {}
  }
  return out;
}
