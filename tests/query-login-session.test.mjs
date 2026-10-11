import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { verifyQueryLoginSession } from "../lib/query-login-session.ts";
import { QueryApiError } from "../lib/query-feedback.ts";
import { sqliteD1 } from "./sqlite-d1.mjs";
register("./cloudflare-loader.mjs", import.meta.url);
const { env } = await import("cloudflare:workers");
const { issueChaoxingQuerySession, readChaoxingQuerySession } = await import("../lib/chaoxing-query-auth.ts");
const { POST } = await import("../app/api/query/session/route.ts");

test("client confirms the new HttpOnly session with credentials before allowing dashboard entry", async () => {
  const proof = "a".repeat(64);
  await verifyQueryLoginSession(proof, async (url, init) => {
    assert.equal(url, "/api/query/session");
    assert.equal(init.credentials, "include");
    assert.equal(init.cache, "no-store");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { confirmation: proof });
    return Response.json({ ok: true });
  });
  await assert.rejects(verifyQueryLoginSession(proof, async () => Response.json({ error: "请先登录" }, { status: 401 })), error => {
    assert.ok(error instanceof QueryApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Cookie/);
    return true;
  });
  await assert.rejects(verifyQueryLoginSession(undefined, async () => { throw new Error("must not request without proof"); }), /校验信息/);
  await assert.rejects(verifyQueryLoginSession(proof, async () => Response.json({ error: "暂不可用" }, { status: 503 })), /暂不可用/);
  await assert.rejects(verifyQueryLoginSession(proof, async () => Response.json({ ok: false })), /校验失败/);
});

test("session confirmation rejects missing, expired, and previous-account cookies without exposing credentials", async () => {
  const db = sqliteD1();
  const sqlite = db.sqlite;
  env.DB = db;
  try {
    const first = await issueChaoxingQuerySession("123", "web:123");
    const second = await issueChaoxingQuerySession("456", "web:456");
    const cookie = first.cookie.split(";")[0];
    const token = cookie.split("=")[1];
    assert.notEqual(first.confirmation, token);
    assert.ok(!JSON.stringify(first.confirmation).includes(token));
    const request = (confirmation, actualCookie = cookie, origin = "https://query.example.com") => new Request("https://query.example.com/api/query/session", {
      method: "POST", headers: { "content-type": "application/json", origin, ...(actualCookie ? { cookie: actualCookie } : {}) }, body: JSON.stringify({ confirmation }),
    });
    const verified = await POST(request(first.confirmation));
    assert.equal(verified.status, 200);
    assert.equal(verified.headers.get("cache-control"), "no-store");
    assert.deepEqual(await verified.json(), { ok: true });
    assert.equal((await POST(request(first.confirmation, ""))).status, 401);
    assert.equal((await POST(request(second.confirmation))).status, 401, "an old valid cookie is not proof of the current login");
    assert.equal((await POST(request(first.confirmation, second.cookie.split(";")[0]))).status, 401);
    assert.equal((await POST(request(first.confirmation, `cx_query_session=${first.confirmation}`))).status, 401, "the confirmation itself cannot authenticate");
    assert.equal((await POST(request(first.confirmation, cookie, "https://evil.example"))).status, 403);
    assert.equal((await POST(request("bad-proof"))).status, 401);
    assert.deepEqual({ ...await readChaoxingQuerySession(request(first.confirmation)) }, { uid: "123", bot_id: "web:123" });
    sqlite.prepare("UPDATE chaoxing_query_sessions SET expires_at = 0 WHERE uid = ?").run("123");
    assert.equal((await POST(request(first.confirmation))).status, 401);
  } finally { delete env.DB; sqlite.close(); }
});
