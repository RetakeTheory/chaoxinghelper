import { env } from "cloudflare:workers";
import { readChaoxingQuerySession } from "../../../../lib/chaoxing-query-auth";
import { chaoxingQueryBackend, chaoxingQuerySource } from "../../../../lib/chaoxing-query-backend";

export async function GET(request: Request) {
  const session = await readChaoxingQuerySession(request);
  if (!session) return Response.json({ error: "请先登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  let snapshot;
  try { snapshot = await chaoxingQueryBackend(env, session).queryChaoxingByUid(session.uid); }
  catch { return Response.json({ error: "任务状态暂不可读，请稍后刷新" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  return snapshot
    ? Response.json({ snapshot: { ...snapshot, source: chaoxingQuerySource(session) } }, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "未找到当前账号的挂课记录，请重新登录" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
