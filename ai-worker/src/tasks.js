/* Задачи воркера. Сайт присылает только название задачи (task) и её данные
   (data), всё остальное живёт здесь: какой моделью отвечать, системный
   промпт и пределы размера запроса и ответа.

   Как добавить задачу — допишите в TASKS ещё одну запись:

     "my-task": {
       model: "text",              // "text" — QWEN_MODEL, "vision" — QWEN_VISION_MODEL
       maxBodyBytes: 16 * 1024,    // предел размера запроса (по умолчанию 64 КБ)
       maxTokens: 800,             // предел длины ответа нейросети
       temperature: 0.4,
       timeoutMs: 45000,           // сколько ждать нейросеть
       json: false,                // true — просить у модели JSON-объект
       messages(data) {            // проверить data и собрать сообщения
         return [
           { role: "system", content: "…" },
           { role: "user", content: "…" }
         ];
       },
       result(text, answer, data) { … }  // что вернуть сайту; по умолчанию { text }
     }

   Ошибку в данных сообщайте через throw badRequest("понятный текст") — он
   дойдёт до сайта как есть. Вызов с сайта: AI.ask("my-task", { … }) из
   js/ai.js. */
import { badRequest, badAnswer, str, list, CJK, parseJsonAnswer, salvageObjects } from "./util.js";

const CHAT_HISTORY = 12;          // столько последних сообщений диалога видит модель
const CHAT_USER_CHARS = 2000;     // предел одного сообщения ученика
const CHAT_ANSWER_CHARS = 6000;   // предел одного прошлого ответа в истории
const CARDS_MAX_WORDS = 150;

const CHAT_PROMPT = `Ты — ИИ-помощник на сайте для русскоязычных учеников, которые учат китайский язык (уровень HSK 1–4). Ты объясняешь грамматику, слова, иероглифы и культуру Китая.

Как отвечать:
- По-русски, просто и дружелюбно, как хороший преподаватель. Лингвистические термины — только если без них не обойтись, и тогда с пояснением.
- Каждое правило подкрепляй примерами. Пример всегда из трёх частей: иероглифы, пиньинь, перевод — в таком виде: 我吃了饭。 (Wǒ chī le fàn.) — Я поел.
- В примерах бери слова уровня HSK 1–4. Если слово сложнее — переведи его отдельно.
- Пиньинь пиши со знаками тонов (nǐ hǎo), не цифрами. Иероглифы — упрощённые, если ученик не просит традиционные.
- Оформляй ответ в markdown: короткие абзацы, списки, **жирным** — главное. Таблицу используй, только когда сравниваешь несколько вариантов.
- Сразу к делу, без вступлений вроде «Отличный вопрос!».
- Будь кратким: обычно хватает 120–300 слов. Если тема большая — объясни главное и предложи продолжить.
- Пиши только то, в чём уверен: правила — как в учебниках, без придуманных запретов. Если не уверен (редкое значение, спорный факт) — так и скажи.
- Китайские слова пиши иероглифами с пиньинем, не русскими буквами.
- Если вопрос не связан с китайским языком, Китаем или учёбой, вежливо ответь, что помогаешь только с китайским, и предложи вопрос по теме.`;

const EXPLAIN_PROMPT = `Ты объясняешь китайское слово русскоязычному ученику уровня HSK 1–4. Ответь строго одним JSON-объектом, без markdown и пояснений:
{
  "pinyin": "пиньинь слова со знаками тонов",
  "partOfSpeech": "часть речи по-русски: глагол, существительное, прилагательное, наречие, служебное слово…",
  "meaning": "значение по-русски, 1–3 коротких предложения; несколько значений — через «; », главное первым",
  "examples": [
    { "zh": "пример иероглифами", "pinyin": "пиньинь примера", "ru": "перевод примера" }
  ],
  "synonyms": [
    { "word": "близкое по смыслу слово", "pinyin": "его пиньинь", "difference": "чем отличается от объясняемого слова, 1–2 предложения; слова называй иероглифами (知道), а не русскими буквами" }
  ],
  "note": "одно замечание об употреблении, в котором ты уверен (типичная ошибка учеников, устойчивое сочетание), или пустая строка"
}

Правила:
- В examples — 2–3 коротких естественных предложения со словами уровня HSK 1–4.
- В synonyms — до 3 слов, с которыми это слово легко спутать. Если таких нет — пустой массив.
- В difference и note — только общеизвестные правила из учебников. Не придумывай запретов («нельзя сказать…»): сомневаешься — оставь note пустым.
- Пиши по-русски. Китайские слова — иероглифами, не русскими буквами; китайские грамматические термины не используй.
- Пиньинь — со знаками тонов, иероглифы — упрощённые.
- Если у слова несколько значений, а в запросе есть перевод из словаря, объясняй в первую очередь значение из него.
- Не выдумывай: если слово редкое и ты не уверен в значении, так и напиши в meaning.`;

// Фото переписывается как есть, без исправлений: проверяет и дописывает
// отдельная задача check-cards. Сайт присылает страницу полосами (картинки
// больше ~0,25 Мп поставщик Qwen у Polza не успевает обработать).
const CARDS_PROMPT = `Ты переписываешь с фото слова из тетради ученика, который учит китайский. На фото — страница тетради или горизонтальная полоса страницы. Каждое слово занимает строку: иероглифы, пиньинь, перевод на русский. Чего-то может не быть: например, пиньинь и перевод записаны, а место для иероглифов оставлено пустым.

Ответь строго одним JSON-объектом, без markdown и пояснений:
{"words": [{"hanzi": "…", "pinyin": "…", "translation": "…", "unsure": []}]}

Правила:
1. Переписывай только то, что написано. Ничего не исправляй и не дописывай — слова проверят отдельно.
2. hanzi — иероглифы так, как они написаны; если место для иероглифов оставлено пустым (пробел, черта) — "".
3. pinyin — как написан, со знаками тонов (péngyou, nǐ hǎo); если его нет — "".
4. translation — перевод по-русски, как записан; если его нет — "".
5. В "unsure" перечисли поля, которые прочитаны неуверенно (неразборчиво): "hanzi", "pinyin", "translation". Не уверен в иероглифе — всё равно напиши самый похожий и отметь его в unsure.
6. Бери только строки списка слов: с иероглифами или с оставленным для них местом, рядом с другими строками списка. Пометки на полях, мелкие карандашные заметки, отдельные слоги и пиньинь без перевода в стороне от списка пропусти. Строку, срезанную краем фото так, что её не прочитать, тоже пропусти.
7. Порядок — сверху вниз. Не добавляй слов, которых нет на фото. Зачёркнутое пропусти. Заголовки (生词), номера заданий и длинные предложения из упражнений пропусти. Если у края фото видна соседняя страница тетради (обрезанные строки, отдельный список упражнения) — её слова тоже пропусти.
8. Если слов на фото нет — верни {"words": []}.`;

const CHECK_MAX_WORDS = 40;

const CHECK_PROMPT = `Ты проверяешь карточки со словами, которые русскоязычный ученик выписал в тетрадь по китайскому. Слова переписаны с фото, поэтому возможны ошибки чтения. Пустое поле значит, что в тетради этого нет: например, ученик оставил место, чтобы вписать иероглифы нового слова. "unsure" — поля, прочитанные неуверенно.

Для каждого слова по порядку:
1. Пустое поле допиши сам. Иероглифы — по пиньиню с тонами, переводу и тем иероглифам, что есть. Пиньинь — со знаками тонов. Перевод — коротко по-русски, 1–3 значения. Название дописанного поля добавь в "added". Если есть только пиньинь (ни иероглифов, ни перевода), дописывай, только когда по пиньиню с тонами слово однозначно и употребительно; иначе оставь поля пустыми и напиши в "note" "Не удалось понять слово по пиньиню". Не придумывай слова и фразы, которых нет в записи.
2. Проверь, что иероглифы, пиньинь и перевод — одно и то же слово и записаны верно. Если примерно верно — оставь как есть и ничего не пиши: перевод близкий по смыслу, сокращённый или одно из значений слова — верный; пиньинь без тонов, с пробелами или с u вместо ü — верный.
3. Если что-то явно неверно — другое слово, неправильный тон, перевод не того слова, ошибка в иероглифе — поле не меняй. Правильный вариант этого поля запиши в "suggest", а в "note" коротко по-русски объясни, что не так. Например: "Тон: правильно píngjūn" или "Перевод не подходит: 实践 — практика".
4. Если неуверенно прочитанное поле по остальным полям явно прочитано неправильно, правильный вариант тоже в "suggest", а в "note" — "Похоже, прочитано неверно: …".
5. Если слово не понять даже по всем полям — оставь как есть, в "note" напиши "Не удалось проверить".

Ответь строго одним JSON-объектом, без markdown и пояснений, — слова в том же порядке и том же количестве:
{"words": [{"hanzi": "…", "pinyin": "…", "translation": "…", "added": [], "suggest": {}, "note": ""}]}

Пиньинь — со знаками тонов, иероглифы — упрощённые. Не добавляй и не убирай слова. Если всё верно — "suggest": {}, "note": "".`;

export const TASKS = {
  // ИИ-помощник (assistant/index.html). data.messages — диалог:
  // [{ role: "user" | "assistant", content: "…" }], последним — вопрос.
  chat: {
    model: "text",
    maxTokens: 1800,
    temperature: 0.5,
    timeoutMs: 90000,
    messages(data) {
      const history = list(data.messages).slice(-CHAT_HISTORY).map((m) => {
        const assistant = m && m.role === "assistant";
        return {
          role: assistant ? "assistant" : "user",
          content: str(m && m.content, assistant ? CHAT_ANSWER_CHARS : CHAT_USER_CHARS)
        };
      }).filter((m) => m.content);
      while (history.length && history[0].role === "assistant") history.shift();
      if (!history.length || history[history.length - 1].role !== "user") {
        throw badRequest("Напишите вопрос.");
      }
      return [{ role: "system", content: CHAT_PROMPT }, ...history];
    },
    result(text, answer) {
      return { text, truncated: answer.finish === "length" };
    }
  },

  // Объяснение слова (окно слова в словаре). data: { word, pinyin?, gloss? } —
  // пиньинь и перевод из словаря помогают выбрать нужное значение.
  "explain-word": {
    model: "text",
    maxBodyBytes: 4 * 1024,
    maxTokens: 1200,
    temperature: 0.3,
    timeoutMs: 60000,
    json: true,
    messages(data) {
      const word = str(data.word, 30);
      if (!word || !CJK.test(word)) throw badRequest("Нужно слово иероглифами.");
      let ask = "Слово: " + word;
      const pinyin = str(data.pinyin, 60);
      const gloss = str(data.gloss, 300);
      if (pinyin) ask += "\nПиньинь из словаря: " + pinyin;
      if (gloss) ask += "\nПеревод из словаря: " + gloss;
      return [
        { role: "system", content: EXPLAIN_PROMPT },
        { role: "user", content: ask }
      ];
    },
    result(text, answer, data) {
      const o = parseJsonAnswer(text);
      const meaning = str(o && o.meaning, 600);
      if (!meaning) throw badAnswer("explain-word without meaning: " + text.slice(0, 200));
      return {
        word: str(data.word, 30),
        pinyin: str(o.pinyin, 60),
        partOfSpeech: str(o.partOfSpeech, 60),
        meaning,
        examples: list(o.examples).map((e) => ({
          zh: str(e && e.zh, 120),
          pinyin: str(e && e.pinyin, 240),
          ru: str(e && e.ru, 300)
        })).filter((e) => e.zh).slice(0, 3),
        synonyms: list(o.synonyms).map((s) => ({
          word: str(s && s.word, 20),
          pinyin: str(s && s.pinyin, 60),
          difference: str(s && s.difference, 400)
        })).filter((s) => s.word && s.difference && CJK.test(s.word)).slice(0, 3),
        note: str(o.note, 500)
      };
    }
  },

  // Карточки по фото тетради (раздел «Карточки»). data.image — фото,
  // сжатое в браузере, как data:-адрес (JPEG, PNG или WebP в base64).
  "notebook-cards": {
    model: "vision",
    maxBodyBytes: 3 * 1024 * 1024,
    maxTokens: 4000,
    temperature: 0.1,
    timeoutMs: 120000,
    json: true,
    messages(data) {
      const image = typeof data.image === "string" ? data.image : "";
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) {
        throw badRequest("Нужно фото в формате JPEG, PNG или WebP.");
      }
      return [
        { role: "system", content: CARDS_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Распознай слова на этой странице тетради и верни JSON." },
            { type: "image_url", image_url: { url: image, detail: "high" } }
          ]
        }
      ];
    },
    result(text, answer) {
      let raw;
      try {
        const o = parseJsonAnswer(text);
        raw = Array.isArray(o) ? o : list(o && o.words);
      } catch (err) {
        // Ответ оборвался на пределе длины — берём слова, что успели прийти.
        if (answer.finish !== "length") throw err;
        raw = salvageObjects(text);
        if (!raw.length) throw err;
      }
      return { words: cleanWords(raw), truncated: answer.finish === "length" };
    }
  },

  // Проверка слов с фото (после notebook-cards или распознавания в
  // браузере): дописать пустые поля, отметить явные ошибки. data.words —
  // [{ hanzi, pinyin, translation, unsure: [поля] }], до CHECK_MAX_WORDS
  // (больше — сайт присылает частями). Ответ — те же слова по порядку:
  // { hanzi, pinyin, translation, added: [поля], suggest: { поле: вариант },
  // note }.
  "check-cards": {
    model: "text",
    maxBodyBytes: 48 * 1024,
    maxTokens: 6000,
    temperature: 0.1,
    timeoutMs: 90000,
    json: true,
    messages(data) {
      const words = list(data.words).slice(0, CHECK_MAX_WORDS + 1);
      if (!words.length) throw badRequest("Нет слов для проверки.");
      if (words.length > CHECK_MAX_WORDS) throw badRequest("Слишком много слов за раз — не больше " + CHECK_MAX_WORDS + ".");
      const input = words.map((w) => {
        w = w && typeof w === "object" ? w : {};
        return {
          hanzi: str(w.hanzi, 40),
          pinyin: str(w.pinyin, 100),
          translation: str(w.translation, 200),
          unsure: [...new Set(list(w.unsure))].filter((f) => WORD_FIELDS.includes(f))
        };
      });
      return [
        { role: "system", content: CHECK_PROMPT },
        { role: "user", content: "Проверь эти слова и верни JSON:\n" + JSON.stringify({ words: input }) }
      ];
    },
    result(text, answer, data) {
      const sent = list(data.words);
      let raw;
      try {
        const o = parseJsonAnswer(text);
        raw = Array.isArray(o) ? o : list(o && o.words);
      } catch (err) {
        if (answer.finish !== "length") throw err;
        raw = salvageObjects(text);
      }
      // Ответ сверяется со словами по порядку: лишнее отбрасывается, на
      // месте пропавших — слово как было, без проверки.
      return {
        words: sent.map((w, i) => cleanChecked(raw[i], w)),
        checked: Math.min(raw.length, sent.length)
      };
    }
  }
};

const WORD_FIELDS = ["hanzi", "pinyin", "translation"];

// Слова с фото. Строка без иероглифов остаётся, если есть пиньинь: это
// новое слово, для которого ученик оставил место, — его допишет check-cards.
function cleanWords(raw) {
  const seen = new Set();
  const out = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const word = {
      hanzi: str(w.hanzi, 40),
      pinyin: str(w.pinyin, 100),
      translation: str(w.translation, 200)
    };
    if (word.hanzi && !CJK.test(word.hanzi)) word.hanzi = "";
    if (!word.hanzi && !/[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]{2}/i.test(word.pinyin)) continue;
    const key = word.hanzi + "|" + word.pinyin;
    if (seen.has(key)) continue;
    seen.add(key);
    word.unsure = [...new Set(list(w.unsure))].filter((f) => WORD_FIELDS.includes(f) && word[f]);
    // Прежний ответ модели (до проверки отдельной задачей) — поле added.
    word.added = [...new Set(list(w.added))].filter((f) => WORD_FIELDS.includes(f) && word[f]);
    out.push(word);
    if (out.length >= CARDS_MAX_WORDS) break;
  }
  return out;
}

// Проверенное слово: дописанные поля (added) — только те, что были
// пустыми; варианты (suggest) — только для заполненных полей и только
// отличающиеся. Ответа нет — слово как было.
function cleanChecked(w, sent) {
  sent = sent && typeof sent === "object" ? sent : {};
  const before = {
    hanzi: str(sent.hanzi, 40),
    pinyin: str(sent.pinyin, 100),
    translation: str(sent.translation, 200)
  };
  if (!w || typeof w !== "object") return { ...before, added: [], suggest: {}, note: "" };
  const max = { hanzi: 40, pinyin: 100, translation: 200 };
  const out = { added: [], suggest: {}, note: str(w.note, 300) };
  for (const f of WORD_FIELDS) {
    const got = str(w[f], max[f]);
    if (before[f]) {
      out[f] = before[f];                       // заполненное ученик видит как в тетради
    } else {
      out[f] = got;
      if (got) out.added.push(f);
    }
  }
  if (out.hanzi && !CJK.test(out.hanzi)) {
    out.hanzi = before.hanzi;
    out.added = out.added.filter((f) => f !== "hanzi");
  }
  const suggest = w.suggest && typeof w.suggest === "object" ? w.suggest : {};
  for (const f of WORD_FIELDS) {
    const v = str(suggest[f], max[f]);
    if (!v || !before[f] || v === before[f]) continue;
    if (f === "hanzi" && !CJK.test(v)) continue;
    out.suggest[f] = v;
  }
  // Пометка без варианта и без причины не нужна; «не удалось проверить» — нужна.
  if (!Object.keys(out.suggest).length && out.note && !/не удалось|не понят/i.test(out.note)) out.note = "";
  return out;
}
