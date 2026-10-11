import { QueryApiError, readQueryJson } from "./query-feedback.ts";

export async function verifyQueryLoginSession(confirmation: unknown, request: typeof fetch = fetch) {
  if (typeof confirmation !== "string" || !/^[a-f0-9]{64}$/.test(confirmation)) {
    throw new Error("登录响应缺少会话校验信息，请刷新网站后重新登录");
  }
  const response = await request("/api/query/session", {
    method: "POST", credentials: "include", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }),
  });
  const result = await readQueryJson<{ ok?: boolean; error?: string }>(response);
  if (response.status === 401) {
    throw new QueryApiError("浏览器未建立本次本站登录会话。请使用系统浏览器打开本站，允许 Cookie 后重新登录；已有后台任务不会因此停止。", response);
  }
  if (!response.ok || result.ok !== true) throw new QueryApiError(result.error || "本站会话校验失败，请稍后重试", response);
}
