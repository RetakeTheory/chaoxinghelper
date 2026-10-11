import { getD1 } from "../db/runtime.ts";
import { hashValue, randomToken } from "./admin-email-auth.ts";
import { ensureChaoxingQuerySchema } from "./chaoxing-query-auth.ts";
import { decodeBase64url, loginContext, loginEncryptionKey, publicLoginKey } from "./query-login-crypto.ts";
import type { LoginChallenge, SealedLogin } from "./query-login-crypto.ts";

const BINDING_COOKIE = "cx_login_binding";
const TTL = 3 * 60_000;
export class LoginGuardError extends Error {
  status: number;
  retryAfter: number;
  constructor(message: string, status = 403, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export const loginSecurityHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
export function loginGuardResponse(error: unknown) {
  const guard = error instanceof LoginGuardError ? error : new LoginGuardError("登录验证服务暂不可用，请稍后重试", 503);
  return Response.json({ error: guard.message }, { status: guard.status, headers: { ...loginSecurityHeaders,
    ...(guard.retryAfter ? { "Retry-After": String(guard.retryAfter) } : {}) } });
}
export function checkLoginRequest(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new LoginGuardError("请通过 HTTPS 登录");
  if (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")
    throw new LoginGuardError("请求来源无效，请在本站重新登录");
  if (!request.headers.get("user-agent") || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))
    throw new LoginGuardError("请使用支持安全验证的浏览器登录");
  // This is only a coarse, bypassable abuse signal, not browser attestation.
  if (/\b(?:curl|wget|python-requests|python-httpx|go-http-client|node-fetch|headlesschrome|playwright|puppeteer)\b/i.test(request.headers.get("user-agent") || ""))
    throw new LoginGuardError("当前请求风险较高，请使用正常浏览器重试");
  // Only a platform-provided score is trusted. Client webdriver/timing/device
  // claims are spoofable and must never constitute proof of humanity.
  const cf = (request as Request & { cf?: { botManagement?: { score?: number } } }).cf;
  const score = cf?.botManagement?.score;
  if (typeof score === "number" && score >= 1 && score <= 5) throw new LoginGuardError("当前请求风险较高，请稍后在浏览器重试", 429, 60);
}
export async function readLoginBody(request: Request, maxBytes = 4096): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) throw new LoginGuardError("请求内容过大", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new LoginGuardError("请求内容无效", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new LoginGuardError("请求内容过大", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new LoginGuardError("请求内容无效", 400); }
}
async function requestBinding(request: Request, token: string) {
  return hashValue(`cx-login-bind:v1:${new URL(request.url).origin}:${token}:${request.headers.get("cf-connecting-ip") || "unknown"}:${request.headers.get("user-agent") || ""}`);
}
export async function reserveLoginRate(bucket: string, limit: number, windowMs: number, now = Date.now()) {
  await ensureChaoxingQuerySchema();
  const db = await getD1();
  // One atomic statement reserves a slot BEFORE expensive/upstream work.
  const result = await db.prepare(`INSERT INTO chaoxing_query_login_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)
    ON CONFLICT(key_hash) DO UPDATE SET attempts = CASE WHEN ? - window_started_at >= ? THEN 1 ELSE attempts + 1 END,
    window_started_at = CASE WHEN ? - window_started_at >= ? THEN ? ELSE window_started_at END
    WHERE ? - window_started_at >= ? OR attempts < ? RETURNING attempts`)
    .bind(await hashValue(bucket), now, now, windowMs, now, windowMs, now, now, windowMs, limit).first();
  if (!result) throw new LoginGuardError("尝试次数过多，请稍后再试", 429, Math.ceil(windowMs / 1000));
}
export async function issueLoginChallenge(request: Request): Promise<{ challenge: LoginChallenge; cookie: string }> {
  checkLoginRequest(request);
  await readLoginBody(request, 128);
  await reserveLoginRate(`challenge-ip:${request.headers.get("cf-connecting-ip") || "unknown"}`, 120, 10 * 60_000);
  const now = Date.now();
  const db = await getD1();
  await db.batch([
    db.prepare("DELETE FROM chaoxing_query_login_challenges WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM chaoxing_query_login_attempts WHERE window_started_at < ?").bind(now - 24 * 60 * 60_000),
  ]);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const id = randomToken(32), binding = randomToken(32);
  await db.prepare("INSERT INTO chaoxing_query_login_challenges (id, binding_hash, private_key, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, await requestBinding(request, binding), JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), now + TTL).run();
  return { challenge: { id, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), expiresAt: now + TTL },
    cookie: `${BINDING_COOKIE}=${binding}; Path=/api/query; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL / 1000}` };
}
export async function openLoginEnvelope(request: Request) {
  checkLoginRequest(request);
  await reserveLoginRate(`login-ip:${request.headers.get("cf-connecting-ip") || "unknown"}`, 60, 15 * 60_000);
  const value = await readLoginBody(request);
  const envelope = value as SealedLogin;
  if (!value || typeof value !== "object" || Array.isArray(value) || envelope.version !== 1 ||
    typeof envelope.id !== "string" || !/^[a-f0-9]{64}$/.test(envelope.id) || !publicLoginKey(envelope.publicKey) ||
    typeof envelope.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) ||
    typeof envelope.ciphertext !== "string" || envelope.ciphertext.length < 24 || envelope.ciphertext.length > 2048)
    throw new LoginGuardError("请先点击验证，再提交加密登录请求", 400);
  const binding = (request.headers.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${BINDING_COOKIE}=`))?.slice(BINDING_COOKIE.length + 1);
  if (!binding || !/^[a-f0-9]{64}$/.test(binding)) throw new LoginGuardError("浏览器未保留验证会话，请允许本站 Cookie 后重新验证", 401);
  const db = await getD1();
  // Atomic consume: concurrent copies of the same packet cannot both proceed.
  const row = await db.prepare("DELETE FROM chaoxing_query_login_challenges WHERE id = ? AND binding_hash = ? AND expires_at > ? RETURNING private_key")
    .bind(envelope.id, await requestBinding(request, binding), Date.now()).first<{ private_key: string }>();
  if (!row) throw new LoginGuardError("验证已过期或已使用，请重新点击验证", 401);
  try {
    const privateKey = await crypto.subtle.importKey("jwk", JSON.parse(row.private_key), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const key = await loginEncryptionKey(privateKey, envelope.publicKey, envelope.id, new URL(request.url).origin);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64url(envelope.iv),
      additionalData: loginContext(envelope.id, new URL(request.url).origin), tagLength: 128 }, key, decodeBase64url(envelope.ciphertext));
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body.account !== "string" || typeof body.password !== "string") throw new Error("invalid");
      const account = body.account.trim(), password = body.password;
      if (account.length < 3 || account.length > 100 || password.length < 1 || password.length > 128) throw new Error("invalid");
      return { account, password };
    } finally { new Uint8Array(bytes).fill(0); }
  } catch { throw new LoginGuardError("加密请求校验失败，请重新点击验证", 400); }
}
