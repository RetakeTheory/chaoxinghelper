import { webChaoxingScope, type ChaoxingAuthenticatedSession } from "./chaoxing-web-types.ts";

export async function adoptChaoxingWebLogin(
  env: Pick<Cloudflare.Env, "CHAOXING_WEB" | "ONEBOT">, db: D1Database, authenticated: ChaoxingAuthenticatedSession,
) {
  const uid = authenticated.cookies._uid;
  const scope = webChaoxingScope(uid);
  const web = env.CHAOXING_WEB.getByName(uid);
  if (await web.queryChaoxingByUid(uid)) {
    const snapshot = await web.refreshChaoxingLoginByUid(uid, authenticated);
    if (!snapshot) throw new Error("账号任务创建失败");
    return { scope, snapshot: { ...snapshot, source: "web" as const } };
  }
  const bots = await db.prepare("SELECT bot_id FROM onebot_bots WHERE enabled = 1 ORDER BY created_at LIMIT 50")
    .all<{ bot_id: string }>();
  for (const bot of bots.results || []) {
    const backend = env.ONEBOT.getByName(bot.bot_id);
    // An unreadable legacy account is not evidence that it does not exist.
    // Fail rather than accidentally fork an already-running mount.
    const existing = await backend.queryChaoxingByUid(uid);
    if (!existing) continue;
    const snapshot = await backend.refreshChaoxingLoginByUid(uid, authenticated, bot.bot_id);
    if (!snapshot) continue;
    return { scope: bot.bot_id, snapshot: { ...snapshot, source: "qq" as const } };
  }
  const snapshot = await web.refreshChaoxingLoginByUid(uid, authenticated);
  if (!snapshot) throw new Error("账号任务创建失败");
  return { scope, snapshot: { ...snapshot, source: "web" as const } };
}
