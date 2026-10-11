interface D1Result<T = unknown> { results: T[]; success: boolean; meta: Record<string, unknown> }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}
interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
interface DurableObjectNamespace<T = unknown> { getByName(name: string): T & Fetcher }
interface DurableObjectState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  waitUntil(promise: Promise<unknown>): void;
}
interface R2Bucket {
  put(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}
declare class WebSocketPair { 0: WebSocket; 1: WebSocket }
interface WebSocket { serializeAttachment(value: unknown): void; deserializeAttachment(): unknown | null }
interface ResponseInit { webSocket?: WebSocket }
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ONEBOT: DurableObjectNamespace<import("./worker/onebot-session").OneBotSession>;
    CHAOXING_WEB: DurableObjectNamespace<import("./worker/chaoxing-web-session").ChaoxingWebSession>;
    ONEBOT_REMINDERS: R2Bucket;
    ASSETS?: Fetcher;
    CHAOXING_RELAY_ORIGIN?: string;
    CHAOXING_RELAY_TOKEN?: string;
    CARD_FONT_ORIGIN?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_SESSION_TOKEN?: string;
    AWS_REGION?: string;
    AWS_S3_BUCKET?: string;
  }
}
declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
  export abstract class DurableObject<WorkerEnv = Cloudflare.Env> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: WorkerEnv;
    constructor(ctx: DurableObjectState, env: WorkerEnv);
  }
}
