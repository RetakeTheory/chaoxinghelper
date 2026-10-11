import { sameOrigin } from "../../../../lib/admin-email-auth.ts";
import { confirmChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth.ts";

const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers });
  if (Number(request.headers.get("content-length") || 0) > 512) return Response.json({ error: "请求内容过大" }, { status: 413, headers });
  const body: unknown = await request.json().catch(() => null);
  const confirmation = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { confirmation?: unknown }).confirmation : undefined;
  try {
    if (!await confirmChaoxingQuerySession(request, confirmation)) {
      return Response.json({ error: "本站登录会话未建立或已变化，请重新登录" }, { status: 401, headers });
    }
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ error: "本站会话校验暂不可用，请稍后重试" }, { status: 503, headers });
  }
}
