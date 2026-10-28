/* Посредник между формой на support/contacts.html и Telegram-ботом.
   Работает как Cloudflare Worker и отвечает на два адреса:

   POST /          — заявка с сайта (имя, тема, сообщение). Воркер кладёт
                     её в KV на сутки под случайным кодом и отвечает
                     ссылкой на бота t.me/<бот>?start=<код>.
   POST /telegram  — вебхук бота. Когда ученик открывает эту ссылку и жмёт
                     «Старт», Telegram присылает сюда «/start <код>» вместе
                     с аккаунтом ученика. Воркер достаёт заявку по коду и
                     пересылает преподавателю уже с Telegram ученика —
                     вводить ник в форме не нужно.

   Токен бота хранится здесь, в секретах воркера, а не на странице, где его
   увидел бы любой посетитель.

   Настройки (wrangler.toml и секреты воркера):
     BOT_TOKEN      — токен бота от @BotFather (секрет);
     WEBHOOK_SECRET — пароль вебхука: Telegram присылает его в заголовке,
                      чужие запросы на /telegram отбрасываются (секрет);
     BOT_USERNAME   — ник бота без @;
     CHAT_ID        — id чата преподавателя, куда слать заявки;
     ALLOWED_ORIGIN — адрес сайта; без него заявки принимаются с любого;
     APPLICATIONS   — KV-хранилище заявок, ждущих «Старта» в боте.

   Вебхук включается один раз запросом к Bot API:
     setWebhook?url=<адрес воркера>/telegram&secret_token=<WEBHOOK_SECRET> */

const SUBJECTS = {
  trial: "Запись на пробное занятие",
  question: "Вопрос о занятиях",
  hsk: "Подготовка к HSK",
  other: "Другое",
};

// Сколько заявка ждёт «Старта» в боте, прежде чем пропасть.
const TTL_SECONDS = 24 * 60 * 60;

const TEXT = {
  done: "Готово, заявка отправлена! Скоро напишу тебе с аккаунта @kski12.",
  expired: "Не нашёл эту заявку: возможно, прошло больше суток. " +
    "Заполни форму на сайте ещё раз или напиши мне напрямую: @kski12.",
  failed: "Не получилось передать заявку. Напиши мне напрямую: @kski12.",
  help: "Привет! Через этого бота приходят заявки на занятия китайским. " +
    "Чтобы записаться, заполни форму на сайте или напиши мне напрямую: @kski12.",
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/telegram") return handleUpdate(request, env);
    return handleForm(request, env);
  },
};

async function handleForm(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const reply = (status, body) => new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: body ? { ...cors, "Content-Type": "application/json" } : cors,
  });

  if (request.method === "OPTIONS") return reply(204);
  if (request.method !== "POST") return reply(405);
  if (env.ALLOWED_ORIGIN && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
    return reply(403);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return reply(400);
  }

  const botLink = `https://t.me/${env.BOT_USERNAME}`;

  // Ловушку в форме заполняют только спам-боты: делаем вид, что всё
  // прошло, но ничего не сохраняем.
  if (data.website) return reply(200, { link: botLink });

  const field = (value, max) => String(value || "").trim().slice(0, max);
  const application = {
    name: field(data.name, 100),
    subject: SUBJECTS[data.subject] || SUBJECTS.other,
    message: field(data.message, 2000),
  };
  if (!application.name || !application.message) return reply(400);

  // 32 шестнадцатеричных знака: в параметр start влезает до 64 символов.
  const code = crypto.randomUUID().replace(/-/g, "");
  await env.APPLICATIONS.put(code, JSON.stringify(application), { expirationTtl: TTL_SECONDS });
  return reply(200, { link: `${botLink}?start=${code}` });
}

async function handleUpdate(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
    return new Response(null, { status: 403 });
  }
  // Telegram повторяет обновление, пока не получит 200, поэтому дальше
  // отвечаем 200 на всё, даже на то, что не обрабатываем.
  const ok = () => new Response(null, { status: 200 });

  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (!msg || !msg.text || msg.chat.type !== "private") return ok();

  const start = msg.text.match(/^\/start(?:\s+(\w+))?/);
  if (!start) {
    // Свои сообщения преподаватель пишет боту не для того, чтобы получить справку.
    if (String(msg.chat.id) !== String(env.CHAT_ID)) await sendMessage(env, msg.chat.id, TEXT.help);
    return ok();
  }

  const code = start[1];
  const saved = code && await env.APPLICATIONS.get(code);
  if (!saved) {
    await sendMessage(env, msg.chat.id, code ? TEXT.expired : TEXT.help);
    return ok();
  }

  const delivered = await sendMessage(env, env.CHAT_ID, formatApplication(JSON.parse(saved), msg.from), true);
  if (delivered) await env.APPLICATIONS.delete(code);
  await sendMessage(env, msg.chat.id, delivered ? TEXT.done : TEXT.failed);
  return ok();
}

// Заявка для преподавателя. Ник ученика берём из его аккаунта; если ника
// нет, ставим ссылку на профиль по id — она открывает чат с учеником.
function formatApplication(application, user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const contact = user.username
    ? "@" + user.username + (fullName ? ` (${escapeHtml(fullName)})` : "")
    : `<a href="tg://user?id=${user.id}">${escapeHtml(fullName || "профиль")}</a> (без ника)`;
  return [
    "<b>Новая заявка с сайта</b>",
    "",
    "Имя: " + escapeHtml(application.name),
    "Telegram: " + contact,
    "Тема: " + escapeHtml(application.subject),
    "",
    escapeHtml(application.message),
  ].join("\n");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendMessage(env, chatId, text, html) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(html && { parse_mode: "HTML" }) }),
  });
  return res.ok;
}
