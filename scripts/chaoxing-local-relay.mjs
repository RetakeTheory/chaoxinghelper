import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const ALLOWED_HOSTS = new Set([
  "mobilelearn.chaoxing.com",
  "mooc1-api.chaoxing.com",
  "mooc1.chaoxing.com",
  "mooc1-1.chaoxing.com",
  "mooc1-2.chaoxing.com",
  "mooc2-ans.chaoxing.com",
  "passport2-api.chaoxing.com",
  "passport2.chaoxing.com",
]);
const FORWARDED_REQUEST_HEADERS = [
  "accept", "accept-language", "cache-control", "content-type", "cookie", "pragma", "referer",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "user-agent", "x-requested-with",
];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "location", "set-cookie"];
const MAX_BODY_BYTES = 512 * 1024;

function sameToken(left, right) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function targetUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname)) return null;
    return url;
  } catch { return null; }
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cardSummary(bytes) {
  const text = new TextDecoder().decode(bytes);
  const iframeSummary = () => {
    const iframes = [...text.matchAll(/<iframe\b[^>]*>/gi)].map((match) => {
      const tag = match[0];
      const attribute = (name) => {
        const found = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
        return found?.[2] || "";
      };
      const decoded = attribute("data").replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
      let data = {};
      try { data = JSON.parse(decoded); } catch { data = {}; }
      const around = text.slice(Math.max(0, match.index - 800), Math.min(text.length, match.index + tag.length + 800));
      const classValues = [...around.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gi)].map((value) => value[2]).slice(0, 20);
      return {
        attributes: [...tag.matchAll(/\s([\w:-]+)\s*=/g)].map((value) => value[1]).sort(),
        dataKeys: Object.keys(data || {}).sort(), classValues,
        completionMarkerNearby: /ans-job-finished|job-finished|task-finished/i.test(around),
        completion: Object.fromEntries(["isPassed", "ispassed", "passed", "finished", "completed", "jobFinished", "jobfinished", "jobStatus", "jobstatus", "taskStatus", "taskstatus"]
          .filter((key) => key in (data || {})).map((key) => [key, data[key]])),
      };
    });
    return { parsed: false, iframeCount: iframes.length, iframes: iframes.slice(0, 20) };
  };
  const marker = /\bmArg\s*=/.exec(text);
  if (!marker) return iframeSummary();
  const start = text.indexOf("{", marker.index + marker[0].length);
  if (start < 0) return iframeSummary();
  let depth = 0, quote = "", escaped = false, end = -1;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) return iframeSummary();
  try {
    const root = JSON.parse(text.slice(start, end));
    const attachments = Array.isArray(root?.attachments) ? root.attachments : [];
    const completionKeys = ["isPassed", "ispassed", "passed", "finished", "completed", "jobFinished", "jobfinished", "jobStatus", "jobstatus", "taskStatus", "taskstatus"];
    const completion = (value) => Object.fromEntries(completionKeys.filter((key) => key in (value || {})).map((key) => [key, value[key]]));
    return {
      parsed: true,
      rootKeys: Object.keys(root || {}).sort(),
      defaultKeys: Object.keys(root?.defaults || {}).sort(),
      attachments: attachments.map((item) => ({
        type: String(item?.type || item?.property?.module || item?.property?.type || "").slice(0, 32),
        keys: Object.keys(item || {}).sort(), propertyKeys: Object.keys(item?.property || {}).sort(),
        completion: completion(item), propertyCompletion: completion(item?.property),
        playTime: Number.isFinite(Number(item?.playTime)) ? Number(item.playTime) : null,
      })).slice(0, 20),
    };
  } catch { return iframeSummary(); }
}

function studySummary(bytes) {
  const text = new TextDecoder().decode(bytes);
  const classValues = [...text.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gi)].map((value) => value[2])
    .filter((value) => /finish|passed|job|task|orange|ans-/i.test(value));
  const completionFields = [...text.matchAll(/\b(isPassed|ispassed|passed|finished|completed|jobFinished|jobStatus|taskStatus)\b\s*[:=]\s*(["']?)(true|false|\d+)\2/gi)]
    .map((value) => `${value[1]}=${value[3]}`);
  return {
    finishedMarkerCount: (text.match(/ans-job-finished|job-finished|task-finished/gi) || []).length,
    classValues: [...new Set(classValues)].slice(0, 50),
    completionFields: [...new Set(completionFields)].slice(0, 50),
    hasJobIdMarkup: /\b(?:jobid|jobId|_jobid)\b/i.test(text),
  };
}

function interactionSummary(bytes) {
  let root;
  try { root = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return { parsed: false, questionCount: 0, startTimes: [] }; }
  const queue = [{ value: root, depth: 0 }], visited = new Set();
  const startTimes = [];
  let inspected = 0;
  while (queue.length && inspected++ < 500) {
    const { value, depth } = queue.shift();
    if (depth > 6 || !value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 200)) queue.push({ value: child, depth: depth + 1 });
      continue;
    }
    const resourceId = value.resourceId ?? value.resourceid ?? value.id;
    const startTime = Number(value.startTime ?? value.starttime ?? value.time);
    const validationUrl = value.validationUrl ?? value.validationurl ?? value.validateUrl;
    if (resourceId != null && Number.isFinite(startTime) && validationUrl) startTimes.push(Math.max(0, Math.floor(startTime)));
    for (const key of ["datas", "data", "result", "questions", "questionList", "records"]) {
      const child = value[key];
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return { parsed: true, questionCount: startTimes.length, startTimes: [...new Set(startTimes)].sort((a, b) => a - b).slice(0, 100) };
}

function videoReportSummary(bytes) {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { parsed: true, isPassed: typeof value.isPassed === "boolean" ? value.isPassed : null,
          hasJobLimit: ["boolean", "number", "string"].includes(typeof value.hasJobLimit) ? value.hasJobLimit : null,
          videoTimeLimit: ["boolean", "number", "string"].includes(typeof value.videoTimeLimit) ? value.videoTimeLimit : null,
          responseKeys: Object.keys(value).sort().slice(0, 30) }
      : { parsed: false, isPassed: null, responseKeys: [] };
  } catch {
    return { parsed: false, isPassed: null, responseKeys: [] };
  }
}

export function createChaoxingRelayServer({ token, fetchImpl = fetch, logger = () => {} } = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("CHAOXING_RELAY_TOKEN must contain at least 32 characters");
  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      if (request.url !== "/internal/chaoxing-relay" || !["GET", "POST"].includes(request.method || "")) {
        response.writeHead(404).end();
        return;
      }
      const provided = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!sameToken(provided, token)) {
        logger({ event: "relay_rejected", reason: "authorization" });
        response.writeHead(403).end();
        return;
      }
      const target = targetUrl(String(request.headers["x-chaoxing-target"] || ""));
      if (!target) {
        logger({ event: "relay_rejected", reason: "target" });
        response.writeHead(403).end();
        return;
      }
      const body = request.method === "POST" ? await requestBody(request) : undefined;
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetchImpl(target, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const responseHeaders = {};
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        if (name === "set-cookie") {
          const cookies = upstream.headers.getSetCookie();
          if (cookies.length) responseHeaders[name] = cookies;
        } else {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
      }
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      const isVideoReport = /\/multimedia\/log\//i.test(target.pathname);
      const isKnowledgeCard = /\/knowledge\/cards$/i.test(target.pathname);
      const isStudentStudyAjax = /\/mycourse\/studentstudyAjax$/i.test(target.pathname);
      const isInteractionInit = /\/richvideo\/initdatawithviewer$/i.test(target.pathname);
      const isInteractionAnswer = /\/richvideo\/qv$/i.test(target.pathname);
      const cookieHeader = headers.get("cookie") || "";
      const cookieUid = cookieHeader.match(/(?:^|;\s*)_uid=([^;]+)/)?.[1] || "";
      logger({
        event: "relay_upstream", method: request.method, host: target.hostname, path: target.pathname, status: upstream.status,
        ...(isVideoReport ? {
          report: {
            playingTime: target.searchParams.get("playingTime"), duration: target.searchParams.get("duration"),
            isdrag: target.searchParams.get("isdrag"), view: target.searchParams.get("view"), dtype: target.searchParams.get("dtype"),
            validUserId: /^\d+$/.test(target.searchParams.get("userid") || ""),
            hasEnc: /^[a-f\d]{32}$/i.test(target.searchParams.get("enc") || ""),
            hasOtherInfo: Boolean(target.searchParams.get("otherInfo")),
            matchesCookieUid: Boolean(cookieUid) && cookieUid === target.searchParams.get("userid"),
            playerCookies: ["fanyamoocs", "thirdRegist", "videojs_id"].every((name) => new RegExp(`(?:^|;\\s*)${name}=`).test(cookieHeader)),
            browserHeaders: ["accept-language", "content-type", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]
              .every((name) => headers.has(name)),
            parameters: [...new Set(target.searchParams.keys())].sort(),
            ...(upstream.status === 200 ? videoReportSummary(bytes) : {}),
          },
          ...(upstream.status >= 400 ? { response: new TextDecoder().decode(bytes.slice(0, 2400))
            .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600) } : {}),
          } : {}),
        ...(isKnowledgeCard && upstream.status === 200 ? { card: cardSummary(bytes) } : {}),
        ...(isStudentStudyAjax && upstream.status === 200 ? { study: studySummary(bytes) } : {}),
        ...(isInteractionInit ? { interaction: {
          kind: "init", hasMid: Boolean(target.searchParams.get("mid")), start: target.searchParams.get("start"),
          ...(upstream.status === 200 ? interactionSummary(bytes) : {}),
        } } : {}),
        ...(isInteractionAnswer ? { interaction: {
          kind: "answer", hasResourceId: Boolean(target.searchParams.get("resourceid")),
          hasAnswer: Boolean(target.searchParams.get("answer")), accepted: upstream.status >= 200 && upstream.status < 300,
        } } : {}),
      });
      if (bytes.byteLength > 4 * 1024 * 1024) {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(upstream.status, responseHeaders);
      response.end(bytes);
    } catch (error) {
      logger({ event: "relay_error", reason: error instanceof Error ? error.name : "unknown" });
      response.writeHead(error instanceof RangeError ? 413 : 502).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokenFile = process.env.CHAOXING_RELAY_TOKEN_FILE || new URL("../.chaoxing-relay-token", import.meta.url);
  let token = process.env.CHAOXING_RELAY_TOKEN || "";
  if (!token) {
    try { token = readFileSync(tokenFile, "utf8").trim(); }
    catch {
      token = randomBytes(32).toString("hex");
      writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
  if (process.argv.includes("--print-token")) {
    process.stdout.write(token);
    process.exit(0);
  }
  const port = Number(process.env.CHAOXING_RELAY_PORT || 8788);
  const server = createChaoxingRelayServer({ token, logger: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })) });
  server.listen(port, "127.0.0.1", () => console.log(`Chaoxing relay listening on http://127.0.0.1:${port}`));
}
