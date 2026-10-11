import test from "node:test";
import assert from "node:assert/strict";
import { OneBotChaoxing, CX_MENU } from "../lib/onebot-chaoxing-recovered.ts";
import { n as CxError, t as ChaoxingClient } from "../lib/chaoxing-recovered.ts";
import { OneBotDeliveryError } from "../lib/onebot-reply.ts";

function fixture(clearCourseLocations = async () => {}, onSend) {
  const values = new Map();
  const sent = [];
  const course = { courseId: "11", classId: "22", cpi: "33", name: "测试课程" };
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async list({ prefix }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
  };
  const client = { cookies: { _uid: "123" }, async courses() { return [course]; } };
  const bot = new OneBotChaoxing(storage, onSend || (async (...message) => sent.push(message)), () => client,
    undefined, async () => null, clearCourseLocations);
  values.set("cx:account:12345", {
    session: { cookies: client.cookies, courses: [course] }, enabled: true,
    nextAt: Date.now() + 60_000, refreshedAt: Date.now(), cursor: 0,
    failures: 0, receipts: {}, outbox: [], lastStatus: "已连接",
  });
  return { bot, values, sent, course, client };
}

test("recovered menu and list show the original numbered course command", async () => {
  const f = fixture();
  assert.match(CX_MENU, /\/list/);
  assert.match(CX_MENU, /\/pass\+课程序号/);
  assert.equal(await f.bot.command("12345", "/list", false, async () => {}), true);
  assert.match(f.sent.at(-1)[1], /1\. 测试课程/);
  assert.match(f.sent.at(-1)[1], /\/pass\+课程序号/);
});

test("list replies from cache before a slow refresh and avoids duplicate unchanged lists", async () => {
  const f = fixture();
  let release;
  f.client.courses = () => new Promise((resolve) => { release = resolve; });
  const task = f.bot.command("12345", "/list", false, async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.sent[0][1], /上次保存/);
  assert.match(f.sent[0][1], /1\. 测试课程/);
  release([f.course]);
  await task;
  assert.equal(f.sent.length, 1);
});

test("list sends a refreshed list only when the course contents change", async () => {
  const f = fixture();
  f.client.courses = async () => [{ ...f.course, name: "更新后的课程" }];
  await f.bot.command("12345", "/list", false, async () => {});
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0][1], /上次保存/);
  assert.match(f.sent[1][1], /更新后的课程/);
  assert.equal(f.values.get("cx:account:12345").session.courses[0].name, "更新后的课程");
});

test("list recovers when the initial cached read fails", async () => {
  const f = fixture();
  const get = f.bot.storage.get.bind(f.bot.storage);
  let reads = 0;
  f.bot.storage.get = async (...args) => {
    if (++reads === 1) throw new Error("transient storage read failure");
    return get(...args);
  };
  await f.bot.command("12345", "/list", false, async () => {});
  assert.match(f.sent.at(-1)[1], /课程列表（已刷新）/);
  assert.match(f.sent.at(-1)[1], /1\. 测试课程/);
  assert.ok(f.sent.every((entry) => !entry[1].includes("机器人接口超时")));
});

test("list tolerates an invalid saved course without renumbering", async () => {
  const f = fixture();
  f.values.get("cx:account:12345").session.courses = [null, f.course];
  await f.bot.command("12345", "/list", false, async () => {});
  assert.match(f.sent[0][1], /1\. 课程信息待刷新/);
  assert.match(f.sent[0][1], /2\. 测试课程/);
  assert.match(f.sent.at(-1)[1], /1\. 测试课程/);
});

test("list keeps saved courses when the upstream refresh fails", async () => {
  const f = fixture();
  f.client.courses = async () => { throw new CxError("学习通暂不可用"); };
  await f.bot.command("12345", "/list", false, async () => {});
  assert.match(f.sent[0][1], /1\. 测试课程/);
  assert.ok(f.sent.every((entry) => !entry[1].includes("密码未保存")));
  assert.deepEqual(f.values.get("cx:account:12345").session.courses, [f.course]);
});

test("list without a cache reports the course outage without a password warning", async () => {
  const f = fixture();
  f.values.get("cx:account:12345").session.courses = [];
  f.client.courses = async () => { throw new CxError("学习通暂不可用"); };
  await f.bot.command("12345", "/list", false, async () => {});
  assert.match(f.sent.at(-1)[1], /没有可用的课程缓存/);
  assert.doesNotMatch(f.sent.at(-1)[1], /密码未保存/);
});

test("a confirmed login persists without courses and retries discovery later", async () => {
  const calls = [];
  const client = new ChaoxingClient({}, async (input) => {
    const url = String(input);
    calls.push(new URL(url).pathname);
    if (url.includes("loginregister")) return Response.json({ status: false, uid: "123" });
    if (url.includes("fanyalogin")) return Response.json({ status: true }, { headers: { "Set-Cookie": "vc3=session; Path=/" } });
    return new Response("unavailable", { status: 503 });
  });
  const session = await client.login("13800138000", "secret");
  assert.equal(session.courseRefreshPending, true);
  assert.deepEqual(session.courses, []);
  assert.equal(session.cookies.vc3, "session");
  assert.ok(calls.some((path) => path.includes("backclazzdata")));
  assert.ok(!JSON.stringify(session).includes("secret"));
  const f = fixture();
  f.client.login = async () => session;
  await f.bot.command("12345", "/register 13800138000 secret", false, async () => {});
  assert.equal(f.values.get("cx:account:12345").refreshedAt, 0);
  assert.match(f.sent.at(-1)[1], /课程列表暂不可读/);
  assert.ok(!JSON.stringify([...f.values]).includes("secret"));
});

test("an unconfirmed login still fails and is not saved", async () => {
  const client = new ChaoxingClient({}, async (input) => {
    if (String(input).includes("loginregister")) return Response.json({ status: false });
    return Response.json({ status: false });
  });
  await assert.rejects(client.login("13800138000", "wrong"), /登录失败/);
});

test("re-registering the same account preserves an existing video mount", async () => {
  const f = fixture();
  await f.bot.command("12345", "/pass+1", false, async () => {});
  const before = structuredClone(f.values.get("cx:account:12345").video);
  f.client.login = async () => ({ cookies: { _uid: "123", vc3: "new-session" },
    courses: [], courseRefreshPending: true });
  await f.bot.command("12345", "/register 13800138000 secret", false, async () => {});
  const account = f.values.get("cx:account:12345");
  assert.deepEqual(account.video, before);
  assert.deepEqual(account.session.courses, [f.course]);
  assert.equal(account.session.cookies.vc3, "new-session");
  assert.match(f.sent.at(-1)[1], /原有视频挂载进度已保留/);
});

test("failed re-registration leaves the previous account and mount intact", async () => {
  const f = fixture();
  await f.bot.command("12345", "/pass+1", false, async () => {});
  const before = structuredClone(f.values.get("cx:account:12345"));
  f.client.login = async () => { throw new CxError("学习通暂不可用"); };
  await f.bot.command("12345", "/register 13800138000 secret", false, async () => {});
  assert.deepEqual(f.values.get("cx:account:12345"), before);
  assert.match(f.sent.at(-1)[1], /密码未保存/);
});

test("an uncertain QQ delivery is not retried as a generic command error", async () => {
  let sends = 0;
  const f = fixture(async () => {}, async () => { sends++; throw new OneBotDeliveryError(); });
  await assert.rejects(f.bot.command("12345", "/stop", false, async () => {}), OneBotDeliveryError);
  assert.equal(sends, 1);
});

test("pass mounts the selected video course without erasing the existing account", async () => {
  const f = fixture();
  assert.equal(await f.bot.command("12345", "/pass+1", false, async () => {}), true);
  const account = f.values.get("cx:account:12345");
  assert.equal(account.video.course.courseId, "11");
  assert.equal(account.video.course.cpi, "33");
  assert.equal(account.enabled, true);
  assert.equal(account.session.cookies._uid, "123");
  assert.match(f.sent.at(-1)[1], /已挂载：测试课程/);
  assert.equal(f.sent.at(-1)[2], true);
});

test("pass can mount the selected cached course during a course-list outage", async () => {
  const f = fixture();
  f.values.get("cx:account:12345").refreshedAt = 0;
  f.client.courses = async () => { throw new CxError("学习通暂不可用"); };
  await f.bot.command("12345", "/pass+1", false, async () => {});
  const account = f.values.get("cx:account:12345");
  assert.equal(account.video.course.courseId, f.course.courseId);
  assert.equal(account.refreshedAt, 0);
  assert.match(f.sent.at(-1)[1], /已挂载：测试课程/);
});

test("pass rejects an invalid course number and keeps the current mount", async () => {
  const f = fixture();
  await f.bot.command("12345", "/pass+1", false, async () => {});
  const before = structuredClone(f.values.get("cx:account:12345").video);
  await f.bot.command("12345", "/pass+2", false, async () => {});
  assert.deepEqual(f.values.get("cx:account:12345").video, before);
  assert.match(f.sent.at(-1)[1], /课程序号无效/);
});

test("query exposes courses and location updates retry pending sign-ins", async () => {
  const f = fixture();
  const account = f.values.get("cx:account:12345");
  account.receipts = { "activity-1": "需要位置：请设置位置", "activity-2": "签到成功" };
  account.lastActivityAt = Date.now();
  const snapshot = await f.bot.queryByUid("123");
  assert.deepEqual(snapshot.courses, [{ courseId: "11", classId: "22", name: "测试课程" }]);
  assert.equal(await f.bot.locationChangedByUid("123"), true);
  const updated = f.values.get("cx:account:12345");
  assert.deepEqual(updated.receipts, { "activity-2": "签到成功" });
  assert.equal(updated.lastActivityAt, 0);
  assert.ok(updated.nextAt <= Date.now());
});

test("unregister removes per-course locations along with the monitored account", async () => {
  const removed = [];
  const f = fixture(async (uid) => { removed.push(uid); });
  await f.bot.command("12345", "/unregister", false, async () => {});
  assert.deepEqual(removed, ["123"]);
  assert.equal(f.values.has("cx:account:12345"), false);
});
