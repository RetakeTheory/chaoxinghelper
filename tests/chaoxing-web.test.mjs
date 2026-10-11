import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { OneBotChaoxing } from "../lib/onebot-chaoxing-recovered.ts";
import { parseChaoxingWebControl, webChaoxingScope } from "../lib/chaoxing-web-types.ts";
import { chaoxingQueryBackend } from "../lib/chaoxing-query-backend.ts";
import { adoptChaoxingWebLogin } from "../lib/chaoxing-web-login.ts";
register("./cloudflare-loader.mjs", import.meta.url);
const { ChaoxingWebSession } = await import("../worker/chaoxing-web-session.ts");

const course = { courseId: "11", classId: "22", cpi: "33", name: "测试课程" };
const another = { courseId: "44", classId: "55", cpi: "66", name: "另一门课" };
const session = { cookies: { _uid: "123", vc3: "test-session" }, courses: [course, another] };
test("query uses restrained anime copy without romantic wording or feature footnotes", async () => {
  const page = await readFile(new URL("../app/query/page.tsx", import.meta.url), "utf8");
  const location = await readFile(new URL("../app/query/CourseLocationSettings.tsx", import.meta.url), "utf8");
  assert.match(page, /学习补给站/);
  assert.match(page, /今日任务看板/);
  assert.match(page, /挂载所选课程/);
  assert.match(page, /暂停监听与挂载/);
  assert.match(page, /退出登录/);
  assert.doesNotMatch(page, /无需在 QQ Bot 注册|独立网站后台|退出网页仅退出登录|视频挂载仅处理|cx-query-privacy/);
  assert.doesNotMatch(location, /沿用 QQ Bot 的默认位置|保存前请核对位置名称|未提供设备测得精度/);
  assert.doesNotMatch(page + location, /♡|陪你|我们的|碰面|同桌|靠在一起/);
  assert.match(location, /使用设备当前位置/);
});
function storage() {
  const values = new Map();
  let alarm = null;
  return { values, get alarm() { return alarm; },
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async list({ prefix }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async setAlarm(time) { alarm = time; }, async deleteAlarm() { alarm = null; },
  };
}
function fixture() {
  const saved = storage();
  const client = { cookies: session.cookies, async courses() { return [another, course]; } };
  const engine = new OneBotChaoxing(saved, async () => { throw new Error("structured controls must not send QQ messages"); }, () => client);
  return { saved, engine, client };
}
test("multi-course queue is account-scoped, idempotent, persistent and never interrupts a running video", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  f.saved.values.get("cx:account:123").video.current = { name: "active", playingTime: 120, duration: 600, lastTickAt: Date.now() };
  const original = structuredClone(f.saved.values.get("cx:account:123").video);
  const enqueue = { action: "enqueue", courseId: "44", classId: "55" };
  assert.ok((await f.engine.controlByUid("123", enqueue)).ok);
  assert.ok((await f.engine.controlByUid("123", enqueue)).ok);
  assert.deepEqual(f.saved.values.get("cx:account:123").video, original);
  assert.equal((await f.engine.queryByUid("123")).courseQueue.length, 1);
  assert.equal((await f.engine.controlByUid("999", enqueue)).ok, false);
  assert.equal((await f.engine.controlByUid("123", { ...enqueue, courseId: "999" })).ok, false);
  await f.engine.controlByUid("123", { action: "pause" });
  await f.engine.acceptAuthenticatedSession("123", session, "123");
  assert.equal(f.saved.values.get("cx:account:123").enabled, false);
  assert.equal((await f.engine.queryByUid("123")).courseQueue.length, 1);
  const restored = new OneBotChaoxing(f.saved, async () => {}, () => f.client);
  await restored.controlByUid("123", { action: "resume" });
  const state = await f.saved.get("cx:account:123");
  await restored.completeVideoMount("123", state, "当前课程扫描确认已完成");
  assert.equal(state.video.course.courseId, "44");
  assert.equal(state.video.current, undefined);
  assert.equal(state.video.completed, 0);
  assert.equal(state.courseQueue.length, 0);
  assert.notEqual(state.video.queueId, original.queueId);
});
test("enqueue while paused does not resume; failed course cannot advance the pending queue", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "pause" });
  await f.engine.controlByUid("123", { action: "enqueue", courseId: "11", classId: "22" });
  let state = await f.saved.get("cx:account:123");
  assert.equal(state.video, undefined); assert.equal(state.enabled, false);
  assert.equal(f.engine.startNextCourse(state), false);
  await f.engine.controlByUid("123", { action: "resume" });
  state = await f.saved.get("cx:account:123");
  assert.equal(f.engine.startNextCourse(state), true);
  assert.equal(state.video.course.courseId, "11");
  state.enabled = false; state.courseQueue = [another];
  assert.equal(f.engine.startNextCourse(state), false);
  assert.equal(state.courseQueue.length, 1);
});
test("remove/cancel queue, ten-course cap and unavailable next course preserve other accounts", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  await f.engine.controlByUid("123", { action: "enqueue", courseId: "44", classId: "55" });
  const active = structuredClone(f.saved.values.get("cx:account:123").video);
  await f.engine.controlByUid("123", { action: "dequeue", courseId: "44", classId: "55" });
  assert.deepEqual(f.saved.values.get("cx:account:123").video, active);
  const state = f.saved.values.get("cx:account:123");
  state.courseQueue = Array.from({ length: 10 }, (_, i) => ({ courseId: String(100 + i), classId: "1", cpi: "1" }));
  assert.equal((await f.engine.controlByUid("123", { action: "enqueue", courseId: "44", classId: "55" })).ok, false);
  state.video = undefined;
  assert.equal(f.engine.startNextCourse(state), false);
  assert.equal(state.enabled, false); assert.equal(state.courseQueue.length, 10);
  await f.engine.controlByUid("123", { action: "cancel" });
  assert.deepEqual(f.saved.values.get("cx:account:123").courseQueue, []);
});
test("web controls whitelist actions and stable course IDs, never arbitrary commands or caller UID", () => {
  for (const value of [null, [], { action: "register", password: "x" }, { action: "mount", courseId: "x", classId: "22" }, { action: "mount", courseId: "11", classId: "22", replace: "false" }]) {
    assert.equal(parseChaoxingWebControl(value), null);
  }
  assert.deepEqual(parseChaoxingWebControl({ action: "mount", courseId: "11", classId: "22", uid: "999", command: "/pass+2" }),
    { action: "mount", courseId: "11", classId: "22", replace: false });
  assert.throws(() => webChaoxingScope("123/other"));
});
test("direct web session creates an account without any QQ registration and returns no credentials", async () => {
  const f = fixture();
  const snapshot = await f.engine.acceptAuthenticatedSession("123", { ...session, password: "must-not-persist" }, "123");
  assert.equal(snapshot.courseCount, 2);
  assert.equal(snapshot.enabled, true);
  assert.ok(!JSON.stringify(snapshot).includes("test-session"));
  assert.ok(!JSON.stringify([...f.saved.values]).includes("must-not-persist"));
  await assert.rejects(f.engine.acceptAuthenticatedSession("123", { ...session, cookies: { _uid: "999" } }, "123"));
});
test("relogin preserves paused mount, queues, history, and old courses during discovery outage", async () => {
  const f = fixture();
  await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  await f.engine.controlByUid("123", { action: "pause" });
  const before = structuredClone(f.saved.values.get("cx:account:123"));
  before.receipts = { "99": "签到成功" };
  f.saved.values.set("cx:account:123", before);
  await f.engine.acceptAuthenticatedSession("123", { cookies: { _uid: "123", vc3: "renewed" }, courses: [], courseRefreshPending: true }, "123");
  const after = f.saved.values.get("cx:account:123");
  assert.equal(after.enabled, false);
  assert.deepEqual(after.video, before.video);
  assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.session.courses, session.courses);
  assert.equal(after.session.cookies.vc3, "renewed");
});
test("course refresh reordering cannot change selected course; duplicate mount preserves progress", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "refresh" });
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  const account = f.saved.values.get("cx:account:123");
  assert.equal(account.video.course.courseId, "11");
  account.video.completed = 3;
  account.video.current = { playingTime: 42, duration: 300, lastTickAt: 10 };
  const before = structuredClone(account.video);
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  assert.deepEqual(f.saved.values.get("cx:account:123").video, before);
  const denied = await f.engine.controlByUid("123", { action: "mount", courseId: "999", classId: "22", replace: true });
  assert.equal(denied.ok, false);
  assert.deepEqual(f.saved.values.get("cx:account:123").video, before);
});
test("switching course requires explicit replace; cancelling only deletes that video queue", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  const old = f.saved.values.get("cx:account:123").video;
  const queueKey = `cx:video-queue:123:${old.queueId}:000000`;
  f.saved.values.set(queueKey, { jobId: "1" });
  f.saved.values.set("cx:video-queue:other:unrelated:000000", { jobId: "2" });
  assert.equal((await f.engine.controlByUid("123", { action: "mount", courseId: "44", classId: "55" })).requiresReplace, true);
  assert.equal(f.saved.values.has(queueKey), true);
  assert.equal((await f.engine.controlByUid("123", { action: "mount", courseId: "44", classId: "55", replace: true })).ok, true);
  assert.equal(f.saved.values.has(queueKey), false);
  await f.engine.controlByUid("123", { action: "cancel" });
  const account = f.saved.values.get("cx:account:123");
  assert.equal(account.video, undefined); assert.equal(account.enabled, true);
  assert.equal(f.saved.values.has("cx:video-queue:other:unrelated:000000"), true);
});
test("resume does not credit paused wall-clock time as video playback", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  await f.engine.controlByUid("123", { action: "mount", courseId: "11", classId: "22" });
  f.saved.values.get("cx:account:123").video.current = { playingTime: 42, duration: 300, lastTickAt: 10 };
  await f.engine.controlByUid("123", { action: "pause" });
  await f.engine.controlByUid("123", { action: "resume" });
  const video = f.saved.values.get("cx:account:123").video;
  assert.equal(video.current.playingTime, 42);
  assert.ok(video.current.lastTickAt >= Date.now() - 1000);
});
test("login without a bot creates independent scope; existing QQ tasks are not copied", async () => {
  for (const legacy of [false, true]) {
    const calls = [];
    const web = { async queryChaoxingByUid() { return null; }, async refreshChaoxingLoginByUid() { calls.push("web"); return { courseCount: 2 }; } };
    const bot = { async queryChaoxingByUid() { return legacy ? { mount: { completed: 3 } } : null; },
      async refreshChaoxingLoginByUid(uid, value, botId) { assert.equal(uid, "123"); assert.equal(botId, "12345"); assert.equal(value, session); calls.push("qq"); return { mount: { completed: 3 } }; } };
    const env = { CHAOXING_WEB: { getByName: () => web }, ONEBOT: { getByName: () => bot } };
    const db = { prepare: () => ({ all: async () => ({ results: legacy ? [{ bot_id: "12345" }] : [] }) }) };
    const result = await adoptChaoxingWebLogin(env, db, session);
    assert.equal(result.scope, legacy ? "12345" : "web:123");
    assert.deepEqual(calls, legacy ? ["qq"] : ["web"]);
    assert.equal(chaoxingQueryBackend(env, { uid: "123", bot_id: result.scope }), legacy ? bot : web);
    assert.throws(() => chaoxingQueryBackend(env, { uid: "123", bot_id: "web:999" }));
  }
});
test("existing independent login never scans QQ or forks a second scheduler", async () => {
  const web = { async queryChaoxingByUid() { return { enabled: false }; }, async refreshChaoxingLoginByUid() { return { enabled: false }; } };
  const env = { CHAOXING_WEB: { getByName: () => web }, ONEBOT: { getByName() { throw new Error("must not use QQ"); } } };
  const result = await adoptChaoxingWebLogin(env, { prepare() { throw new Error("must not scan bots"); } }, session);
  assert.equal(result.snapshot.enabled, false); assert.equal(result.snapshot.source, "web");
});
test("an unreadable existing QQ backend does not create a duplicate independent scheduler", async () => {
  let created = false;
  const web = { async queryChaoxingByUid() { return null; }, async refreshChaoxingLoginByUid() { created = true; } };
  const bot = { async queryChaoxingByUid() { throw new Error("temporarily unavailable"); } };
  const env = { CHAOXING_WEB: { getByName: () => web }, ONEBOT: { getByName: () => bot } };
  await assert.rejects(adoptChaoxingWebLogin(env, { prepare: () => ({ all: async () => ({ results: [{ bot_id: "12345" }] }) }) }, session));
  assert.equal(created, false);
});
test("a course refresh cannot replace the current account with another upstream UID", async () => {
  const f = fixture(); await f.engine.acceptAuthenticatedSession("123", session, "123");
  const before = structuredClone(f.saved.values.get("cx:account:123"));
  f.client.cookies = { _uid: "999" };
  await assert.rejects(f.engine.controlByUid("123", { action: "refresh" }), /登录账号发生变化/);
  assert.deepEqual(f.saved.values.get("cx:account:123"), before);
});
test("independent durable scheduler survives reload, drains notices without QQ and rejects another UID", async () => {
  const saved = storage();
  const web = new ChaoxingWebSession({ storage: saved }, {});
  assert.equal(await web.queryChaoxingByUid("123"), null);
  const snapshot = await web.refreshChaoxingLoginByUid("123", session);
  assert.equal(snapshot.courseCount, 2); assert.ok(saved.alarm > Date.now());
  saved.values.get("cx:account:123").outbox = ["任务通知"];
  saved.values.get("cx:account:123").enabled = false;
  saved.values.get("cx:account:123").nextAt = 0;
  const resumed = new ChaoxingWebSession({ storage: saved }, {});
  await resumed.alarm();
  assert.equal(saved.alarm, null);
  assert.equal((await resumed.queryChaoxingByUid("123")).notices[0].text, "任务通知");
  await assert.rejects(resumed.queryChaoxingByUid("999"), /范围不匹配/);
  await resumed.controlChaoxingByUid("123", { action: "resume" }, "web:123");
  assert.ok(saved.alarm > Date.now());
});
