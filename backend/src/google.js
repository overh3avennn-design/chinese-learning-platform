"use strict";

// Проверка Google ID token (то, что Google Identity Services отдаёт сайту в
// response.credential) без сторонних библиотек:
// https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
//  - подпись RS256 одним из открытых ключей Google (JWKS, по kid);
//  - aud — наш GOOGLE_CLIENT_ID;
//  - iss — accounts.google.com или https://accounts.google.com;
//  - exp — не истёк (iat — не из будущего).

const crypto = require("crypto");
const { unauthorized, badRequest } = require("./errors");

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SKEW = 60;                    // секунд допуска на расхождение часов
const MAX_TOKEN = 4096;

function b64urlJson(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch (e) {
    throw unauthorized("bad_token");
  }
}

// Ключи Google меняются раз в несколько дней; держим их, сколько разрешает
// Cache-Control. Неизвестный kid — повод обновить, но не чаще раза в минуту,
// чтобы мусорными токенами нельзя было заставить функцию ходить в Google.
function createJwksCache(fetchImpl) {
  const doFetch = fetchImpl || ((url) => fetch(url));
  let keys = null;
  let expires = 0;
  let lastFetch = 0;
  let pending = null;

  async function load() {
    const res = await doFetch(JWKS_URL);
    if (!res.ok) throw new Error("Google JWKS HTTP " + res.status);
    const body = await res.json();
    const cc = (res.headers && res.headers.get && res.headers.get("cache-control")) || "";
    const m = /max-age=(\d+)/.exec(cc);
    const maxAge = m ? Math.min(Number(m[1]), 24 * 3600) : 3600;
    keys = Array.isArray(body.keys) ? body.keys : [];
    expires = Date.now() + maxAge * 1000;
  }

  async function refresh() {
    lastFetch = Date.now();
    if (!pending) pending = load().finally(() => { pending = null; });
    await pending;
  }

  return async function getKey(kid) {
    if (!keys || Date.now() > expires) await refresh();
    let key = keys.find((k) => k.kid === kid);
    if (!key && Date.now() - lastFetch > 60 * 1000) {
      await refresh();
      key = keys.find((k) => k.kid === kid);
    }
    return key || null;
  };
}

const defaultGetKey = createJwksCache();

async function verifyGoogleIdToken(idToken, opts) {
  const clientId = opts && opts.clientId;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  const getKey = (opts && opts.getKey) || defaultGetKey;
  const now = Math.floor(((opts && opts.now) != null ? opts.now : Date.now()) / 1000);

  if (typeof idToken !== "string" || !idToken || idToken.length > MAX_TOKEN) throw badRequest("bad_token");
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw unauthorized("bad_token");

  const header = b64urlJson(parts[0]);
  // Только RS256: alg "none" и HS256 с открытым ключом вместо секрета —
  // известные подделки JWT.
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") throw unauthorized("bad_token");

  const jwk = await getKey(header.kid);
  if (!jwk || jwk.kty !== "RSA") throw unauthorized("unknown_key");
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch (e) {
    throw unauthorized("unknown_key");
  }
  const signed = Buffer.from(parts[0] + "." + parts[1]);
  const signature = Buffer.from(parts[2], "base64url");
  if (!crypto.verify("RSA-SHA256", signed, publicKey, signature)) throw unauthorized("bad_signature");

  const p = b64urlJson(parts[1]);
  if (!p || typeof p !== "object") throw unauthorized("bad_token");
  if (!ISSUERS.has(p.iss)) throw unauthorized("bad_issuer");
  const audOk = Array.isArray(p.aud) ? p.aud.length === 1 && p.aud[0] === clientId : p.aud === clientId;
  if (!audOk) throw unauthorized("bad_audience");
  if (typeof p.exp !== "number" || p.exp + SKEW < now) throw unauthorized("token_expired");
  if (typeof p.iat === "number" && p.iat - SKEW > now) throw unauthorized("bad_token");
  if (typeof p.sub !== "string" || !/^[0-9A-Za-z_-]{1,255}$/.test(p.sub)) throw unauthorized("bad_token");

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const picture = str(p.picture, 512);
  return {
    googleSub: p.sub,
    name: str(p.name, 128) || str(p.given_name, 64) || "Google",
    photo: /^https:\/\//.test(picture) ? picture : "",
    email: p.email_verified ? str(p.email, 254) : ""
  };
}

module.exports = { verifyGoogleIdToken, createJwksCache, JWKS_URL };
