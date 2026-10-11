import { env } from "cloudflare:workers";
import { getD1 } from "../../../../db/runtime";
import { hashValue, sameOrigin } from "../../../../lib/admin-email-auth";
import { issueChaoxingQuerySession, ensureChaoxingQuerySchema } from "../../../../lib/chaoxing-query-auth";
import { n as CxError, t as ChaoxingClient } from "../../../../lib/chaoxing-recovered";
import { createChaoxingFetch } from "../../../../lib/chaoxing-relay";
import type { ChaoxingAuthenticatedSession } from "../../../../lib/chaoxing-web-types";
import { adoptChaoxingWebLogin } from "../../../../lib/chaoxing-web-login";

const WINDOW_MS = 15 * 60 * 1000;
const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try { return await login(request); }
  catch { return Response.json({ error: "登录服务暂不可用，请稍后重试" }, { status: 503, headers: noStore }); }
}

async function login(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers: noStore });
  if (Number(request.headers.get("content-length") || 0) > 4096) {
    return Response.json({ error: "请求内容过大" }, { status: 413, headers: noStore });
  }
  const parsed: unknown = await request.json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { account?: unknown; password?: unknown } : {};
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (account.length < 3 || account.length > 100 || password.length < 1 || password.length > 128) {
    return Response.json({ error: "账号或密码错误" }, { status: 400, headers: noStore });
  }
  await ensureChaoxingQuerySchema();
  const db = await getD1();
  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = await hashValue(`cx-query:${account.toLocaleLowerCase("zh-CN")}:${ip}`);
  const attempts = await db.prepare("SELECT attempts, window_started_at FROM chaoxing_query_login_attempts WHERE key_hash = ?")
    .bind(key).first<{ attempts: number; window_started_at: number }>();
  if (attempts && now - attempts.window_started_at < WINDOW_MS && attempts.attempts >= 6) {
    return Response.json({ error: "尝试次数过多，请 15 分钟后再试" }, {
      status: 429, headers: { ...noStore, "Retry-After": "900" },
    });
  }

  let uid = "";
  let authenticated: ChaoxingAuthenticatedSession;
  try {
    const client = new ChaoxingClient(undefined, createChaoxingFetch(env));
    authenticated = await client.login(account, password);
    uid = authenticated.cookies._uid || "";
  } catch (error) {
    await db.prepare(`INSERT INTO chaoxing_query_login_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)
      ON CONFLICT(key_hash) DO UPDATE SET attempts = CASE WHEN ? - window_started_at >= ? THEN 1 ELSE attempts + 1 END,
      window_started_at = CASE WHEN ? - window_started_at >= ? THEN ? ELSE window_started_at END`)
      .bind(key, now, now, WINDOW_MS, now, WINDOW_MS, now).run();
    const unavailable = error instanceof CxError && /无法连接|暂不可用|响应超过/.test(error.message);
    return Response.json({ error: unavailable ? "学习通服务暂时不可用，请稍后重试" : "账号或密码错误，或学习通要求额外验证" }, {
      status: unavailable ? 503 : 401, headers: noStore,
    });
  }
  if (!/^\d{1,24}$/.test(uid)) return Response.json({ error: "学习通账号信息异常" }, { status: 502, headers: noStore });
  await db.prepare("DELETE FROM chaoxing_query_login_attempts WHERE key_hash = ?").bind(key).run();
  const { scope, snapshot } = await adoptChaoxingWebLogin(env, db, authenticated);
  const session = await issueChaoxingQuerySession(uid, scope);
  return Response.json({ ok: true, snapshot, sessionConfirmation: session.confirmation }, {
    headers: { ...noStore, "Set-Cookie": session.cookie },
  });
}
