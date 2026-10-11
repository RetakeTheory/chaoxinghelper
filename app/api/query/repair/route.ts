import { env } from "cloudflare:workers";
import { sameOrigin } from "../../../../lib/admin-email-auth";
import { readChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth";
import { chaoxingQueryBackend, chaoxingQuerySource } from "../../../../lib/chaoxing-query-backend";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403, headers });
  const session = await readChaoxingQuerySession(request);
  if (!session) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const result = await chaoxingQueryBackend(env, session).repairChaoxingByUid(session.uid, session.bot_id);
    const payload = { ...result, snapshot: result.snapshot ? { ...result.snapshot, source: chaoxingQuerySource(session) } : null };
    return Response.json(result.ok ? payload : { ...payload, error: result.message }, {
      status: result.ok ? 200 : 409, headers,
    });
  } catch {
    return Response.json({ error: "自助修复暂时无法提交，请稍后重试" }, { status: 503, headers });
  }
}
