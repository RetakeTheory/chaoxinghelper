import { DurableObject } from "cloudflare:workers";
import { OneBotChaoxing } from "../lib/onebot-chaoxing-recovered.ts";
import type { CxStorage } from "../lib/onebot-chaoxing.ts";
import { t as ChaoxingClient, o as budgetedChaoxingFetch } from "../lib/chaoxing-recovered.ts";
import { createChaoxingFetch } from "../lib/chaoxing-relay.ts";
import { getChaoxingCourseLocation, deleteAllChaoxingCourseLocations } from "../lib/chaoxing-course-locations.ts";
import { webChaoxingScope, parseChaoxingWebControl, type ChaoxingAuthenticatedSession, type ChaoxingWebControl } from "../lib/chaoxing-web-types.ts";

type Notice = { id: string; text: string; createdAt: number };
type WebStorage = CxStorage & { setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> };

// Per-account persistent scheduler: neither a QQ connection nor an open browser
// is required. The shared engine retains its existing request budget/queue.
export class ChaoxingWebSession extends DurableObject<Cloudflare.Env> {
  private readonly storage = (this.ctx as unknown as { storage: WebStorage }).storage;
  private readonly request = createChaoxingFetch(this.env);
  private readonly engine = new OneBotChaoxing(this.storage,
    async (_owner: string, text: string) => {
      const notices = await this.storage.get<Notice[]>("web:notices") || [];
      await this.storage.put("web:notices", [{ id: crypto.randomUUID(), text: text.slice(0, 4000), createdAt: Date.now() }, ...notices].slice(0, 50));
    }, (session?: ChaoxingAuthenticatedSession, budget?: { take(): void }) =>
      new ChaoxingClient(session?.cookies, budget ? budgetedChaoxingFetch(this.request, budget) : this.request),
    undefined, (uid: string, courseId: string, classId: string) => getChaoxingCourseLocation(this.env.DB, uid, courseId, classId),
    (uid: string) => deleteAllChaoxingCourseLocations(this.env.DB, uid));
  private dueTask: Promise<void> | null = null;

  private async owns(uid: string) {
    webChaoxingScope(uid);
    const owner = await this.storage.get<string>("web:uid");
    if (owner && owner !== uid) throw new Error("账号任务范围不匹配");
    return !!owner;
  }
  async queryChaoxingByUid(uid: string) {
    if (!await this.owns(uid)) return null;
    const snapshot = await this.engine.queryByUid(uid);
    return snapshot ? { ...snapshot, notices: await this.storage.get<Notice[]>("web:notices") || [] } : null;
  }
  async refreshChaoxingLoginByUid(uid: string, session: ChaoxingAuthenticatedSession, scope?: string) {
    if (scope !== undefined && scope !== webChaoxingScope(uid)) throw new Error("账号任务范围不匹配");
    await this.owns(uid);
    if (session.cookies._uid !== uid) throw new Error("登录账号不匹配");
    await this.engine.acceptAuthenticatedSession(uid, session, uid);
    await this.storage.put("web:uid", uid);
    await this.schedule();
    return this.queryChaoxingByUid(uid);
  }
  async controlChaoxingByUid(uid: string, control: ChaoxingWebControl, scope?: string) {
    if (scope !== undefined && scope !== webChaoxingScope(uid)) throw new Error("账号任务范围不匹配");
    if (!await this.owns(uid) || !parseChaoxingWebControl(control)) throw new Error("操作无效");
    const result = await this.engine.controlByUid(uid, control);
    if (result.ok) await this.schedule();
    return { ...result, snapshot: await this.queryChaoxingByUid(uid) };
  }
  async repairChaoxingByUid(uid: string, scope?: string) {
    if (scope !== undefined && scope !== webChaoxingScope(uid)) throw new Error("账号任务范围不匹配");
    if (!await this.owns(uid)) return { ok: false, message: "请重新登录", snapshot: null };
    const result = await this.engine.repairByUid(uid);
    if (result.ok) await this.schedule();
    return { ...result, snapshot: await this.queryChaoxingByUid(uid) };
  }
  async chaoxingLocationChangedByUid(uid: string, scope?: string) {
    if (scope !== undefined && scope !== webChaoxingScope(uid)) throw new Error("账号任务范围不匹配");
    if (!await this.owns(uid)) return false;
    const found = await this.engine.locationChangedByUid(uid);
    if (found) await this.schedule();
    return found;
  }
  private async schedule() {
    const next = await this.engine.nextAt();
    if (next === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
  async alarm() {
    if (this.dueTask) return this.dueTask;
    const task = this.runDue(); this.dueTask = task;
    try { await task; } finally { this.dueTask = null; }
  }
  private async runDue() {
    try {
      const next = await this.engine.poll();
      if (next === null) await this.storage.deleteAlarm();
      else await this.storage.setAlarm(Math.max(Date.now() + 5000, next));
    } catch {
      console.warn(JSON.stringify({ event: "chaoxing_web_alarm_failed" }));
      await this.storage.setAlarm(Date.now() + 60_000);
    }
  }
}
