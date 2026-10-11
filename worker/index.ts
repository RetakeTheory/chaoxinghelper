import handler from "vinext/server/app-router-entry";
import { oneBotTokenHash } from "../lib/onebot-cloudflare";
import { ensureDatabaseSchema } from "../db/runtime";
import { cleanupChaoxingQueryAuth } from "../lib/chaoxing-query-auth";
import { secureQueryResponse } from "../lib/query-response-security";
import { OneBotSession } from "./onebot-session";
import { ChaoxingWebSession } from "./chaoxing-web-session";

export { OneBotSession, ChaoxingWebSession };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/onebot/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      if (!env.DB || !env.ONEBOT) return Response.json({ error: "OneBot 服务尚未配置" }, { status: 503 });
      const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
      if (!provided) return new Response("Unauthorized", { status: 401 });
      await ensureDatabaseSchema();
      const bot = await env.DB.prepare("SELECT bot_id FROM onebot_bots WHERE access_token_hash = ? AND enabled = 1 LIMIT 1")
        .bind(await oneBotTokenHash(provided)).first<{ bot_id: string }>();
      if (!bot) return new Response("Unauthorized", { status: 401 });
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set("x-reshi-onebot-id", bot.bot_id);
      return env.ONEBOT.getByName(bot.bot_id).fetch(new Request(request, { headers }));
    }
    return secureQueryResponse(url, await handler.fetch(request, env, ctx));
  },
  async scheduled(controller: { scheduledTime: number }, env: Cloudflare.Env) {
    await ensureDatabaseSchema();
    const rows = await env.DB.prepare(`SELECT DISTINCT bot_id FROM onebot_scheduled_messages
      WHERE due_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
      UNION SELECT bot_id FROM onebot_bots WHERE enabled = 1 LIMIT 50`)
      .bind(controller.scheduledTime, controller.scheduledTime - 60_000).all<{ bot_id: string }>();
    await Promise.allSettled([cleanupChaoxingQueryAuth(controller.scheduledTime),
      ...(rows.results || []).map(row => env.ONEBOT.getByName(row.bot_id).processDue(row.bot_id, controller.scheduledTime))]);
  },
};
