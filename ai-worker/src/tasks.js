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

const CARDS_PROMPT = `Ты распознаёшь фото страницы тетради ученика, который учит китайский. На странице выписаны слова: иероглифы, пиньинь и перевод на русский — иногда не все три. Найди все выписанные слова и выражения и ответь строго одним JSON-объектом, без markdown и пояснений:
{"words": [{"hanzi": "…", "pinyin": "…", "translation": "…", "added": []}]}

Правила:
1. hanzi — иероглифы слова так, как они написаны (упрощённые).
2. pinyin — со знаками тонов (péngyou, nǐ hǎo), не цифрами.
3. translation — перевод с фото, как его записал ученик. Сокращения можно раскрыть, смысл не менять.
4. Если чего-то из трёх на фото нет (например, пиньиня или перевода), впиши свой правильный вариант и добавь название этого поля в "added", например "added": ["pinyin"]. Если всё взято с фото — "added": [].
5. Порядок — как на странице: сверху вниз, а если колонки — по колонкам.
6. Не добавляй слов, которых нет на фото. Зачёркнутое и повторы пропусти. Бери слова и выражения, выписанные для заучивания; длинные предложения из упражнений пропусти.
7. Если китайских слов на фото нет или ничего не разобрать — верни {"words": []}.`;

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
  }
};

const WORD_FIELDS = ["hanzi", "pinyin", "translation"];

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
    if (!CJK.test(word.hanzi)) continue;
    const key = word.hanzi + "|" + word.pinyin;
    if (seen.has(key)) continue;
    seen.add(key);
    word.added = [...new Set(list(w.added))].filter((f) => WORD_FIELDS.includes(f) && word[f]);
    out.push(word);
    if (out.length >= CARDS_MAX_WORDS) break;
  }
  return out;
}
