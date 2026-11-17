"use strict";

// Ошибка, которую можно показать клиенту: HTTP-код и короткий код причины.
// Всё остальное (сбой базы, ошибка в коде) уходит клиенту как 500 без
// подробностей, а подробности — в лог функции.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const unauthorized = (code) => new HttpError(401, code || "unauthorized");
const badRequest = (code) => new HttpError(400, code || "bad_request");

module.exports = { HttpError, unauthorized, badRequest };
