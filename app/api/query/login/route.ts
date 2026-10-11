import { env } from "cloudflare:workers";
import { getD1 } from "../../../../db/runtime";
import { issueChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth";
import { LoginGuardError, loginGuardResponse, loginSecurityHeaders, openLoginEnvelope, reserveLoginRate } from "../../../../lib/query-login-guard";
import { n as CxError, t as ChaoxingClient } from "../../../../lib/chaoxing-recovered";
import { createChaoxingFetch } from "../../../../lib/chaoxing-relay";
import type { ChaoxingAuthenticatedSession } from "../../../../lib/chaoxing-web-types";
import { adoptChaoxingWebLogin } from "../../../../lib/chaoxing-web-login";

const noStore = loginSecurityHeaders;

export async function POST(request: Request) {
  try { return await login(request); }
  catch (error) { return error instanceof LoginGuardError ? loginGuardResponse(error) : Response.json({ error: "登录服务暂不可用，请稍后重试" }, { status: 503, headers: noStore }); }
}

async function login(request: Request) {
  const { account, password } = await openLoginEnvelope(request);
  await reserveLoginRate(`account:${account.toLocaleLowerCase("zh-CN")}`, 6, 15 * 60_000);
  const db = await getD1();

  let uid = "";
  let authenticated: ChaoxingAuthenticatedSession;
  try {
    const client = new ChaoxingClient(undefined, createChaoxingFetch(env));
    authenticated = await client.login(account, password);
    uid = authenticated.cookies._uid || "";
  } catch (error) {
    const unavailable = error instanceof CxError && /无法连接|暂不可用|响应超过/.test(error.message);
    return Response.json({ error: unavailable ? "学习通服务暂时不可用，请稍后重试" : "账号或密码错误，或学习通要求额外验证" }, {
      status: unavailable ? 503 : 401, headers: noStore,
    });
  }
  if (!/^\d{1,24}$/.test(uid)) return Response.json({ error: "学习通账号信息异常" }, { status: 502, headers: noStore });
  const { scope, snapshot } = await adoptChaoxingWebLogin(env, db, authenticated);
  const session = await issueChaoxingQuerySession(uid, scope);
  return Response.json({ ok: true, snapshot, sessionConfirmation: session.confirmation }, {
    headers: { ...noStore, "Set-Cookie": session.cookie },
  });
}
