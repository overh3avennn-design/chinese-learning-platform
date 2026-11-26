-- Таблицы API (YDB). Применяет scripts/migrate.js при каждой выкладке:
-- IF NOT EXISTS — существующие таблицы не трогаются. Менять колонки
-- существующей таблицы — отдельной миграцией (ALTER TABLE), не здесь.
-- Statements separated by ";" at end of line.

-- Пользователи. Вход Telegram — telegram_id, вход Google — google_sub; у
-- одного пользователя может быть оба (привязка в меню аккаунта).
-- rev — номер последнего изменения его карточек; rows_count/bytes_total —
-- сколько у него строк и байт; quota_day/quota_writes — счётчик записей за
-- сутки (UTC). Время — Timestamp, остальные отметки времени — мс (Uint64).
CREATE TABLE IF NOT EXISTS users (
  id Utf8 NOT NULL,
  telegram_id Int64,
  google_sub Utf8,
  name Utf8,
  photo_url Utf8,
  created_at Timestamp,
  rev Uint64,
  rows_count Uint32,
  bytes_total Uint64,
  quota_day Uint32,
  quota_writes Uint32,
  PRIMARY KEY (id),
  INDEX idx_telegram GLOBAL SYNC ON (telegram_id),
  INDEX idx_google GLOBAL SYNC ON (google_sub)
);

-- Карточки: одна строка — одна колода (deck:<id>), свои слова в колоде
-- сайта (extra:<id>), папки (folders) или прогресс колоды (progress:<id>).
-- data — JSON-текст; удалённая строка остаётся с deleted = true, чтобы
-- удаление дошло до других устройств. Ключ начинается с user_id: все строки
-- пользователя лежат рядом, чужие не читаются.
CREATE TABLE IF NOT EXISTS cards (
  user_id Utf8 NOT NULL,
  id Utf8 NOT NULL,
  data Utf8,
  deleted Bool,
  updated_at Uint64,
  size Uint32,
  rev Uint64,
  PRIMARY KEY (user_id, id)
);

-- Владельцы общих папок: строка есть, пока у пользователя есть хотя бы одна
-- папка с отметкой «общая» (её пишет сервер, когда пользователь сохраняет
-- папки). По ней GET /public находит общие папки, не перебирая все карточки.
CREATE TABLE IF NOT EXISTS public_owners (
  user_id Utf8 NOT NULL,
  updated_at Uint64,
  PRIMARY KEY (user_id)
);

-- История помощника. При откате приложения таблица сохраняется.
CREATE TABLE IF NOT EXISTS chat_history (
  user_id Utf8 NOT NULL,
  data Utf8,
  PRIMARY KEY (user_id)
);
