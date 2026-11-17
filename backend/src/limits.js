"use strict";

// Лимиты. Числа подобраны с запасом для живого ученика и так, чтобы один
// человек (или скрипт) не мог раздуть счёт за базу.
const LIMITS = {
  maxBodyBytes: 1024 * 1024,        // тело запроса
  maxItemsPerPush: 100,             // строк в одном PUT /cards
  maxRowBytes: 128 * 1024,          // одна колода / прогресс одной колоды
  maxRows: 2000,                    // строк у пользователя, включая удалённые
  maxBytes: 4 * 1024 * 1024,        // всего данных у пользователя
  writesPerDay: 3000,               // PUT /cards в сутки (счётчик в базе)
  pullPageRows: 200,                // строк в одном ответе GET /cards
  pullPageBytes: 1536 * 1024        // и байт (ответ функции — до 3,5 МБ)
};

// Частота запросов — в памяти экземпляра функции (окно в минуту). Экземпляров
// немного (их число ограничено при выкладке), так что это надёжный предохранитель
// от потока запросов, а суточный лимит записей хранится в базе.
const RATES = {
  ip: 120,          // любых запросов с одного IP в минуту
  ipAuth: 20,       // входов и привязок с одного IP в минуту
  user: 60          // запросов одного пользователя в минуту
};

function createRateLimiter(nowFn) {
  const now = nowFn || Date.now;
  const windows = new Map();
  let lastSweep = 0;

  return function hit(key, limit) {
    const t = now();
    const minute = Math.floor(t / 60000);
    if (t - lastSweep > 60000) {
      lastSweep = t;
      for (const [k, w] of windows) if (w.minute !== minute) windows.delete(k);
    }
    let w = windows.get(key);
    if (!w || w.minute !== minute) {
      w = { minute, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > limit) return Math.ceil(((minute + 1) * 60000 - t) / 1000);   // секунд до нового окна
    return 0;
  };
}

module.exports = { LIMITS, RATES, createRateLimiter };
