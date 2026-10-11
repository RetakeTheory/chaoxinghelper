import { env } from "cloudflare:workers";
import { sameOrigin } from "../../../../lib/admin-email-auth";
import { readChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth";
import { chaoxingQueryBackend, chaoxingQuerySource } from "../../../../lib/chaoxing-query-backend";
import { parseChaoxingWebControl } from "../../../../lib/chaoxing-web-types";
import { n as CxError } from "../../../../lib/chaoxing-recovered";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers });
  if (Number(request.headers.get("content-length") || 0) > 2048) return Response.json({ error: "请求内容过大" }, { status: 413, headers });
  const session = await readChaoxingQuerySession(request);
  if (!session) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const control = parseChaoxingWebControl(await request.json().catch(() => null));
  if (!control) return Response.json({ error: "操作参数无效" }, { status: 400, headers });
  try {
    const result = await chaoxingQueryBackend(env, session).controlChaoxingByUid(session.uid, control, session.bot_id);
    return Response.json({ ...result,
      ...(result.ok ? {} : { error: result.message }),
      snapshot: result.snapshot ? { ...result.snapshot, source: chaoxingQuerySource(session) } : null,
    }, { status: result.ok ? 200 : 409, headers });
  } catch (error) {
    return Response.json({ error: error instanceof CxError ? error.message : "操作暂未完成，请刷新状态后重试" }, { status: 503, headers });
  }
}
