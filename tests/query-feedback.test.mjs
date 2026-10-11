import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { QueryApiError, queryFailure, readQueryJson, redactQueryLog, queryControlFeedback } from "../lib/query-feedback.ts";

test("operation feedback distinguishes done, pause, and cancellation", () => {
  assert.deepEqual(queryControlFeedback("mount"), { kind: "done", message: "已开始挂载" });
  assert.equal(queryControlFeedback("pause").kind, "warning");
  assert.equal(queryControlFeedback("resume").kind, "done");
  assert.equal(queryControlFeedback("cancel").kind, "cancellation");
  assert.equal(queryControlFeedback("refresh").kind, "done");
});

test("error logs preserve actual time, operation, HTTP status and request trace without query credentials", () => {
  const response = new Response(null, { status: 503, headers: { "cf-ray": "trace-id" } });
  const error = new QueryApiError("中转暂不可用", response);
  const result = queryFailure(error, { operation: "开始挂载", endpoint: "/api/query/control?token=private", method: "POST" }, 1_000);
  assert.match(result.log, /1970-01-01T00:00:01.000Z/);
  assert.match(result.log, /POST \/api\/query\/control/);
  assert.match(result.log, /HTTP 状态：503/);
  assert.match(result.log, /请求标识：trace-id/);
  assert.match(result.log, /中转暂不可用/);
  assert.doesNotMatch(result.log, /private|token=/);
});

test("copyable and displayed errors redact supplied login details, bearer tokens, and pasted credential fields", () => {
  const source = 'phone=13812345678, pass=MyPass! Cookie: something\nCookie: vc3=private-cookie\nAuthorization: Bearer secret-auth\n{"password":"private-password","token":"secret-token"}\nenc=private-enc&openc=private-openc\nsession_id=private-session';
  const result = queryFailure(new Error(source), { operation: "登录", secrets: ["13812345678", "MyPass!"] });
  for (const secret of ["13812345678", "MyPass!", "private-cookie", "secret-auth", "private-password", "secret-token", "private-enc", "private-openc", "private-session"]) {
    assert.ok(!result.message.includes(secret), secret);
    assert.ok(!result.log.includes(secret), secret);
  }
  assert.ok(redactQueryLog("x".repeat(20_000)).length <= 16_000);
  assert.doesNotMatch(redactQueryLog("%E5%AF%86%E7%A0%81", ["密码"]), /%E5/);
  assert.doesNotMatch(redactQueryLog("错误：Authorization: Basic private-auth\n诊断 Cookie: private-cookie"), /private-auth|private-cookie/);
  assert.doesNotMatch(redactQueryLog('sessionConfirmation=private-proof\n{"confirmation":"private-check"}'), /private-proof|private-check/);
});

test("unreadable upstream replies are reported with status rather than raw HTML or response contents", async () => {
  const response = new Response("<html>gateway failure with private-cookie</html>", { status: 502 });
  await assert.rejects(readQueryJson(response), (error) => {
    assert.ok(error instanceof QueryApiError);
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes("private-cookie"));
    return true;
  });
  await assert.rejects(readQueryJson(new Response("null")), QueryApiError);
  assert.deepEqual(await readQueryJson(new Response('{"ok":true}')), { ok: true });
});

test("query dialogs and feedback are in-page, keyboard accessible, and use the requested pastel palette", async () => {
  const page = await readFile(new URL("../app/query/page.tsx", import.meta.url), "utf8");
  const location = await readFile(new URL("../app/query/CourseLocationSettings.tsx", import.meta.url), "utf8");
  const feedback = await readFile(new URL("../app/query/QueryFeedback.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/query/query.css", import.meta.url), "utf8");
  assert.doesNotMatch(page + location + feedback, /(?:window|globalThis)\.(?:alert|confirm|prompt)\(/);
  assert.match(feedback, /aria-modal="true"/);
  assert.match(feedback, /inert=\{!!dialog\}/);
  assert.match(feedback, /event.key === "Escape"/);
  assert.match(feedback, /event.key !== "Tab"/);
  assert.match(feedback, /navigator.clipboard.writeText\(safe\)/);
  assert.match(feedback, /logRef.current\?\.select\(\)/);
  assert.match(feedback, /可补充粘贴日志.*发送给管理员/);
  assert.match(css, /\.cx-query-toasts\{[^}]*top:[^}]*left:50%/);
  assert.match(css, /feedback-bg:#eaf3ff/);
  assert.match(css, /\.cx-query-toast.done\{--feedback-bg:#eaf7ed/);
  assert.match(css, /\.cx-query-toast.warning\{--feedback-bg:#fff7dc/);
  assert.match(css, /\.cx-query-toast.error,\.cx-query-toast.cancellation\{--feedback-bg:#fff0f0/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(page, /fingerprint !== lastRefreshError.current/);
});

test("query motion keeps dialogs inert through exit and protects a newer dialog from old completion", async () => {
  const feedback = await readFile(new URL("../app/query/QueryFeedback.tsx", import.meta.url), "utf8");
  assert.match(feedback, /if \(closingRef.current\) return/);
  assert.match(feedback, /setDialog\(\(current\) => current \? \{ \.\.\.current, leaving: true \}/);
  assert.match(feedback, /current\?\.id === id && current.leaving \? null : current/);
  assert.match(feedback, /prefers-reduced-motion: reduce/);
  assert.match(feedback, /setTimeout\(\(\) => dismiss\(toast.id\), 3000\)/);
  assert.doesNotMatch(feedback, /setPaused|onPointerEnter|onPointerLeave/);
  assert.match(feedback, /disabled=\{leaving\}/);
});

test("progress animates only actual snapshot values and page entry does not remount on refresh", async () => {
  const page = await readFile(new URL("../app/query/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/query/query.css", import.meta.url), "utf8");
  assert.match(page, /key="dashboard"/);
  assert.doesNotMatch(page, /key=\{refreshedAt\}/);
  assert.match(page, /scaleX\(\$\{totalProgress \/ 100\}\)/);
  assert.match(page, /scaleX\(\$\{currentProgress \/ 100\}\)/);
  assert.match(css, /transform-origin:left center;transition:transform/);
  assert.match(css, /\.cx-query-toast-slot.leaving\{grid-template-rows:0fr/);
  assert.match(css, /animation:none!important;transition:none!important/);
  assert.match(css, /@media\(hover:hover\) and \(pointer:fine\)/);
});
