import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { normalizeChaoxingLocation, chaoxingLocationIssue } from "../lib/chaoxing-location.ts";
import { ChaoxingClient } from "../lib/chaoxing-client.ts";
import { t as RecoveredClient } from "../lib/chaoxing-recovered.ts";
import { createChaoxingFetch } from "../lib/chaoxing-relay.ts";
import { getChaoxingCourseLocation, listChaoxingCourseLocations, saveChaoxingCourseLocation } from "../lib/chaoxing-course-locations.ts";

const activity = { id: "99", courseId: "11", classId: "22", name: "定位签到", otherId: 4 };
const baseLocation = { latitude: 31.050123456, longitude: 121.220987654, address: "教学楼 A&B + 1301 门口" };
function device(now, overrides = {}) {
  return { ...baseLocation, source: "device", coordinateSystem: "wgs84", accuracyMeters: 23,
    capturedAt: now, maxAgeSeconds: 300, maxAccuracyMeters: 100, ...overrides };
}

test("device capture validates measured quality and age, while map picks have no measured accuracy", () => {
  const now = Date.now();
  assert.equal(chaoxingLocationIssue(device(now), now), null);
  assert.match(chaoxingLocationIssue(device(now - 300_001), now), /已过期/);
  assert.match(chaoxingLocationIssue(device(now, { accuracyMeters: 250 }), now), /超过允许/);
  assert.throws(() => normalizeChaoxingLocation(device(now + 60_001), now), /采集时间无效/);
  assert.throws(() => normalizeChaoxingLocation(device(now, { accuracyMeters: null }), now), /缺少/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, source: "map", accuracyMeters: 1 }, now), /地图选点/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, source: ["map"] }, now), /来源无效/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, longitude: NaN }), /经度无效/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, address: " " }), /位置名称/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, address: "教学楼\u0000" }), /位置名称/);
  assert.throws(() => normalizeChaoxingLocation({ ...baseLocation, source: "device", coordinateSystem: "unspecified" }), /WGS84/);
  assert.throws(() => normalizeChaoxingLocation(device(now, { maxAgeSeconds: NaN })), /有效期/);
  assert.equal(normalizeChaoxingLocation(baseLocation).source, "legacy");
});

for (const Client of [ChaoxingClient, RecoveredClient]) {
  test(`${Client.name}: complete sign sequence carries current identity and page context through the relay`, async () => {
    const calls = [];
    const relay = createChaoxingFetch({ CHAOXING_RELAY_ORIGIN: "https://relay.example.cn", CHAOXING_RELAY_TOKEN: "x".repeat(32) },
      async (input, init) => {
        const request = new Request(input, init);
        const target = new URL(request.headers.get("x-chaoxing-target"));
        calls.push({ target, request });
        if (target.pathname.includes("getPPTActiveInfo")) return Response.json({ data: { otherId: 4, ifphoto: 0 } });
        if (target.pathname.endsWith("preSign")) return new Response("page", { headers: { "Set-Cookie": "fid=456; Path=/" } });
        if (target.pathname.endsWith("analysis")) return new Response("code='+'challenge'");
        return new Response(target.pathname.endsWith("stuSignajax") ? "success" : "ok");
      });
    const client = new Client({ _uid: "123", fid: "0", vc3: "test-session" }, relay);
    assert.equal(await client.sign(activity, device(Date.now())), "签到成功");
    assert.deepEqual(calls.map((call) => call.target.pathname), [
      "/v2/apis/active/getPPTActiveInfo", "/newsign/preSign", "/pptSign/analysis", "/pptSign/analysis2", "/pptSign/stuSignajax",
    ]);
    const final = calls.at(-1);
    assert.equal(final.request.method, "GET");
    assert.deepEqual(Object.fromEntries(final.target.searchParams), {
      activeId: "99", uid: "123", clientip: "", appType: "15", fid: "456",
      latitude: "31.0501235", longitude: "121.2209877", address: baseLocation.address, ifTiJiao: "1",
    });
    assert.equal(final.request.headers.get("referer"), calls[1].target.href);
    assert.equal(final.request.headers.get("x-requested-with"), "XMLHttpRequest");
    assert.match(final.request.headers.get("cookie"), /fid=456/);
    assert.equal(final.target.searchParams.has("accuracyMeters"), false);
    assert.equal(final.target.searchParams.has("capturedAt"), false);
  });

  test(`${Client.name}: stale device capture stops before preSign and does not submit`, async () => {
    let requests = 0;
    const client = new Client({ _uid: "123" }, async () => {
      requests++;
      return Response.json({ data: { otherId: 4, ifphoto: 0 } });
    });
    assert.match(await client.sign(activity, device(Date.now() - 600_000)), /^需要位置：.*已过期/);
    assert.equal(requests, 1);
  });

  test(`${Client.name}: a changed account during preSign never signs for the replacement UID`, async () => {
    const requests = [];
    const client = new Client({ _uid: "123" }, async (url) => {
      requests.push(String(url));
      if (String(url).includes("getPPTActiveInfo")) return Response.json({ data: { otherId: 4, ifphoto: 0 } });
      return new Response("ok", { headers: { "Set-Cookie": "_uid=999; Path=/" } });
    });
    await assert.rejects(client.sign(activity, baseLocation), /登录账号发生变化/);
    assert.ok(requests.every((url) => !url.includes("stuSignajax")));
  });

  test(`${Client.name}: a location that expires during preparation cannot be submitted`, async () => {
    const location = device(Date.now());
    const requests = [];
    const client = new Client({ _uid: "123" }, async (url) => {
      requests.push(String(url));
      if (String(url).includes("getPPTActiveInfo")) return Response.json({ data: { otherId: 4, ifphoto: 0 } });
      if (String(url).includes("/analysis?")) location.capturedAt = Date.now() - 600_000;
      return new Response("ok");
    });
    assert.match(await client.sign(activity, location), /^需要位置：.*已过期/);
    assert.ok(requests.every((url) => !url.includes("stuSignajax")));
  });

  test(`${Client.name}: final attendance submission has no automatic network replay`, async () => {
    let submissions = 0;
    const client = new Client({ _uid: "123" }, async (url) => {
      if (String(url).includes("getPPTActiveInfo")) return Response.json({ data: { otherId: 4, ifphoto: 0 } });
      if (String(url).includes("stuSignajax")) { submissions++; throw new Error("response lost"); }
      return new Response("ok");
    });
    await assert.rejects(client.sign(activity, baseLocation));
    assert.equal(submissions, 1);
  });
}

test("attendance GET does not replay through a second channel after uncertain relay failure", async () => {
  const calls = [];
  const relay = createChaoxingFetch({ CHAOXING_RELAY_ORIGIN: "https://relay.example.cn", CHAOXING_RELAY_TOKEN: "x".repeat(32) },
    async (url) => { calls.push(String(url)); throw new Error("connection lost after upstream accepted request"); });
  await assert.rejects(relay("https://mobilelearn.chaoxing.com/pptSign/stuSignajax?activeId=99"));
  assert.equal(calls.length, 1);
});

function d1(sqlite) {
  return { prepare(sql) {
    const statement = (args = []) => ({ bind: (...values) => statement(values),
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    });
    return statement();
  } };
}

test("D1 migrates existing locations without losing coordinates and isolates configuration by account and course", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE chaoxing_course_locations (uid TEXT, course_id TEXT, class_id TEXT,
    latitude REAL, longitude REAL, address TEXT, updated_at INTEGER, PRIMARY KEY(uid, course_id, class_id));
    INSERT INTO chaoxing_course_locations VALUES ('123', '11', '22', 31.1, 121.2, '原位置', 100);`);
  const db = d1(sqlite);
  const old = await getChaoxingCourseLocation(db, "123", "11", "22");
  assert.equal(old.latitude, 31.1);
  assert.equal(old.longitude, 121.2);
  assert.equal(old.source, "legacy");
  const config = device(Date.now());
  await saveChaoxingCourseLocation(db, "123", { ...config, courseId: "11", classId: "22" });
  const saved = await getChaoxingCourseLocation(db, "123", "11", "22");
  assert.equal(saved.accuracyMeters, 23);
  assert.equal(saved.capturedAt, config.capturedAt);
  assert.equal(saved.source, "device");
  assert.deepEqual(await listChaoxingCourseLocations(db, "999"), []);
  assert.equal(await getChaoxingCourseLocation(db, "123", "11", "23"), null);
});
