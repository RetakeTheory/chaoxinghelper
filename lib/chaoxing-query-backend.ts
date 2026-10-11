import { webChaoxingScope } from "./chaoxing-web-types.ts";

export type ChaoxingQuerySession = { uid: string; bot_id: string };
export function chaoxingQueryBackend(env: Pick<Cloudflare.Env, "ONEBOT" | "CHAOXING_WEB">, session: ChaoxingQuerySession) {
  if (session.bot_id === webChaoxingScope(session.uid)) return env.CHAOXING_WEB.getByName(session.uid);
  if (!/^\d{5,20}$/.test(session.bot_id)) throw new Error("账号任务范围无效");
  return env.ONEBOT.getByName(session.bot_id);
}
export function chaoxingQuerySource(session: ChaoxingQuerySession) {
  return session.bot_id === webChaoxingScope(session.uid) ? "web" : "qq";
}
