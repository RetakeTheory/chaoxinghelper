import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { sqliteD1 } from "./sqlite-d1.mjs";
import { sealQueryLogin } from "../lib/query-login-crypto.ts";
import { secureQueryResponse } from "../lib/query-response-security.ts";
register("./cloudflare-loader.mjs", import.meta.url);
const { env } = await import("cloudflare:workers");
const { issueLoginChallenge, openLoginEnvelope, reserveLoginRate, checkLoginRequest, readLoginBody } = await import("../lib/query-login-guard.ts");
const { cleanupChaoxingQueryAuth } = await import("../lib/chaoxing-query-auth.ts");
const { POST } = await import("../app/api/query/challenge/route.ts");
const origin = "https://query.example.test";
const headers = { origin, "content-type": "application/json", "user-agent": "Synthetic Browser Test", "cf-connecting-ip": "192.0.2.1", "sec-fetch-site": "same-origin" };
const request = (body, cookie = "", extra = {}, path = "login") => new Request(`${origin}/api/query/${path}`, {
  method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const rejectStatus = (promise, status) => assert.rejects(promise, error => { assert.equal(error.status, status); return true; });

test("synthetic login interception/replay and automation-abuse controls never use real accounts", async t => {
  const db = sqliteD1(); env.DB = db;
  const create = async () => {
    const { challenge, cookie } = await issueLoginChallenge(request({}, "", {}, "challenge"));
    const sealed = await sealQueryLogin(challenge, "fictional-student", "fictional-password", origin);
    return { challenge, sealed, cookie: cookie.split(";")[0] };
  };
  try {
    await t.test("one click returns an ephemeral public key, not credentials or a private key", async () => {
      const response = await POST(request({}, "", {}, "challenge"));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.challenge.publicKey.d, undefined);
      assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chaoxing_query_login_challenges").get().n > 0);
    });
    await t.test("captured request body is opaque; missing cookie, changed IP and changed browser cannot use it", async () => {
      const f = await create();
      assert.doesNotMatch(JSON.stringify(f.sealed), /fictional-student|fictional-password/);
      await rejectStatus(openLoginEnvelope(request(f.sealed)), 401);
      await rejectStatus(openLoginEnvelope(request(f.sealed, f.cookie, { "cf-connecting-ip": "192.0.2.2" })), 401);
      await rejectStatus(openLoginEnvelope(request(f.sealed, f.cookie, { "user-agent": "Changed Browser" })), 401);
      assert.deepEqual(await openLoginEnvelope(request(f.sealed, f.cookie)), { account: "fictional-student", password: "fictional-password" });
      await rejectStatus(openLoginEnvelope(request(f.sealed, f.cookie)), 401);
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chaoxing_query_login_challenges WHERE id = ?").get(f.challenge.id).n, 0);
    });
    await t.test("AES authentication rejects modified payloads and consumes their one-use challenge", async () => {
      const f = await create();
      const damaged = { ...f.sealed, ciphertext: (f.sealed.ciphertext[0] === "A" ? "B" : "A") + f.sealed.ciphertext.slice(1) };
      await rejectStatus(openLoginEnvelope(request(damaged, f.cookie)), 400);
      await rejectStatus(openLoginEnvelope(request(f.sealed, f.cookie)), 401);
    });
    await t.test("an interception including every live credential is not guaranteed safe, but only one concurrent copy is admitted", async () => {
      const f = await create();
      const outcomes = await Promise.allSettled([openLoginEnvelope(request(f.sealed, f.cookie)), openLoginEnvelope(request(f.sealed, f.cookie))]);
      assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(o => o.status === "rejected" && o.reason.status === 401).length, 1);
    });
    await t.test("expired challenges, plaintext fallback and public-key private components are rejected", async () => {
      const f = await create();
      db.sqlite.prepare("UPDATE chaoxing_query_login_challenges SET expires_at = 0 WHERE id = ?").run(f.challenge.id);
      await rejectStatus(openLoginEnvelope(request(f.sealed, f.cookie)), 401);
      await rejectStatus(openLoginEnvelope(request({ account: "fictional-student", password: "fictional-password" })), 400);
      await rejectStatus(openLoginEnvelope(request({ ...f.sealed, publicKey: { ...f.sealed.publicKey, d: "forbidden" } }, f.cookie)), 400);
    });
    await t.test("source/risk analysis rejects foreign origins and trusted low-score automation, not client webdriver claims", async () => {
      for (const extra of [{ origin: "https://evil.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "user-agent": "" }, { "user-agent": "curl/8.0" }, { "user-agent": "HeadlessChrome/140.0" }, { "content-type": "text/plain" }])
        assert.throws(() => checkLoginRequest(request({}, "", extra)), error => error.status === 403);
      const lowScore = request({}); Object.defineProperty(lowScore, "cf", { value: { botManagement: { score: 2 } } });
      assert.throws(() => checkLoginRequest(lowScore), error => error.status === 429);
      const good = request({ webdriver: false }); Object.defineProperty(good, "cf", { value: { botManagement: { score: 80 } } });
      assert.doesNotThrow(() => checkLoginRequest(good));
    });
    await t.test("oversized streaming bodies are blocked even without Content-Length", async () => {
      await rejectStatus(readLoginBody(request("x".repeat(5000))), 413);
    });
    await t.test("atomic account limit survives parallel attempts, hashed-only storage, and resets after its window", async () => {
      const results = await Promise.allSettled(Array.from({ length: 9 }, () => reserveLoginRate("synthetic-account-bucket", 6, 900000, 1000000)));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 6);
      assert.equal(results.filter(r => r.status === "rejected" && r.reason.status === 429).length, 3);
      await reserveLoginRate("synthetic-account-bucket", 6, 900000, 1900000);
      assert.doesNotMatch(JSON.stringify(db.sqlite.prepare("SELECT * FROM chaoxing_query_login_attempts").all()), /192\.0\.2|fictional|synthetic-account-bucket/);
    });
    await t.test("scheduled expiry removes unused private keys but preserves active challenges", async () => {
      const f = await create();
      const previous = db.sqlite.prepare("SELECT COUNT(*) AS n FROM chaoxing_query_login_challenges WHERE expires_at = 0").get().n;
      await cleanupChaoxingQueryAuth();
      assert.ok(previous >= 0);
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chaoxing_query_login_challenges WHERE expires_at <= ?").get(Date.now()).n, 0);
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM chaoxing_query_login_challenges WHERE id = ?").get(f.challenge.id).n, 1);
    });
  } finally { delete env.DB; db.sqlite.close(); }
});
test("query-only transport/framing headers preserve session cookies and do not alter other applications", () => {
  const response = Response.json({ ok: true }, { headers: { "Set-Cookie": "cx_query_session=synthetic; HttpOnly; Secure", "cf-ray": "synthetic-trace" } });
  const wrapped = secureQueryResponse(new URL(`${origin}/api/query/session`), response);
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.headers.get("set-cookie"), response.headers.get("set-cookie"));
  assert.equal(wrapped.headers.get("cf-ray"), "synthetic-trace");
  assert.equal(wrapped.headers.get("cache-control"), "no-store");
  assert.equal(wrapped.headers.get("x-frame-options"), "DENY");
  assert.match(wrapped.headers.get("strict-transport-security"), /max-age=/);
  assert.match(wrapped.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(secureQueryResponse(new URL(`${origin}/api/appoint`), response), response);
});
