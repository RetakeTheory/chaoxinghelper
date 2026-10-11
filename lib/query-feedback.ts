export type QueryToastKind = "info" | "done" | "warning" | "error" | "cancellation";
export type QueryFailureContext = { operation: string; endpoint?: string; method?: string; secrets?: string[] };

export class QueryApiError extends Error {
  readonly status: number;
  readonly trace: string;
  constructor(message: string, response: Response) {
    super(message);
    this.name = "QueryApiError";
    this.status = response.status;
    this.trace = response.headers.get("cf-ray") || response.headers.get("x-request-id") || "";
  }
}

export async function readQueryJson<T>(response: Response): Promise<T> {
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON object");
    return value as T;
  } catch {
    throw new QueryApiError("服务器返回了无法读取的响应，请稍后重试", response);
  }
}

export function redactQueryLog(value: string, secrets: string[] = []) {
  let safe = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[已隐藏]");
    safe = safe.split(encodeURIComponent(secret)).join("[已隐藏]");
  }
  return safe.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [已隐藏]")
    .replace(/\b((?:cookie|set-cookie|authorization)\s*[:=])[^\r\n]*/gi, "$1 [已隐藏]")
    .replace(/((?:["']?(?:password|passwd|pwd|token|secret|session(?:_?id|Confirmation)?|confirmation|vc3|_d|enc|openc)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, "$1[已隐藏]")
    .slice(0, 16_000);
}

export function queryFailure(error: unknown, context: QueryFailureContext, now = Date.now()) {
  const message = redactQueryLog(error instanceof Error ? error.message : typeof error === "string" ? error : "操作未完成，请稍后重试", context.secrets);
  const lines = ["学习补给站 · 错误日志", `时间：${new Date(now).toISOString()}`, `操作：${context.operation}`];
  if (context.endpoint) lines.push(`接口：${context.method || "GET"} ${context.endpoint.split("?")[0]}`);
  if (error instanceof QueryApiError) {
    lines.push(`HTTP 状态：${error.status}`);
    if (error.trace) lines.push(`请求标识：${error.trace}`);
  }
  lines.push(`错误：${message}`);
  return { message, log: redactQueryLog(lines.join("\n"), context.secrets) };
}

export function queryControlFeedback(action: "mount" | "cancel" | "pause" | "resume" | "refresh"): { kind: QueryToastKind; message: string } {
  return {
    mount: { kind: "done" as const, message: "已开始挂载" },
    cancel: { kind: "cancellation" as const, message: "已取消视频挂载" },
    pause: { kind: "warning" as const, message: "已暂停挂载与监听" },
    resume: { kind: "done" as const, message: "已恢复挂载与监听" },
    refresh: { kind: "done" as const, message: "已刷新课程列表" },
  }[action];
}
