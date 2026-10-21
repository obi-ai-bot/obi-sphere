// One job channel's relay (spec/sphere-api.md section 6.3): a Durable Object per run_request
// exchange. It pairs the guest's and the host's WebSocket and forwards each binary frame to the
// other side, unchanged and unread: the frames are encrypted end to end (protocol.md section 13).
// Its own text frames say when the other side joins or leaves. Every 5 seconds while a side is
// connected it looks again at the exchange, the two members and the tokens each side opened with,
// and closes both sides once the exchange has ended, its request has expired, either Obi was
// revoked or either side's token was; a side alone for 10 minutes, or a channel with no frame for
// 5, is closed too. A side opens at most 30 times in 10 minutes.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { channelProblem } from "./routes/channels.ts";

export const MAX_FRAME_BYTES = 262144;
export const MAX_CHANNEL_BYTES = 8 * 1024 ** 3;
const CHECK_EVERY_MS = 5000;
/** A side alone this long, its other side never joining, is closed. */
export const ALONE_MS = 10 * 60_000;
/** Both sides there and no frame this long (each side pings every 30 seconds): closed. */
export const IDLE_MS = 5 * 60_000;
/** The most a side opens in `OPENS_WINDOW_MS`. */
export const MAX_OPENS = 30;
const OPENS_WINDOW_MS = 10 * 60_000;
/** How often the byte count is written down, so a relay woken from hibernation still counts. */
const PERSIST_EVERY = 4 * 1024 ** 2;

type Role = "guest" | "host";
interface Meta {
  sphere: string;
  exchange: string;
  guest: string;
  host: string;
}

export class ChannelRelay extends DurableObject<Env> {
  private bytes: number | null = null;
  private persisted = 0;
  private lastSaved = 0;

  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("X-Obi-Role") as Role;
    const now = Date.now();
    const opens = ((await this.ctx.storage.get<number[]>(`opens:${role}`)) ?? []).filter((t) => t > now - OPENS_WINDOW_MS);
    if (opens.length >= MAX_OPENS) {
      return Response.json({ error: { code: "rate_limited", message: `a side opens its channel at most ${MAX_OPENS} times in 10 minutes` } }, { status: 429, headers: { "Retry-After": "60" } });
    }
    await this.ctx.storage.put(`opens:${role}`, [...opens, now]);
    await this.ctx.storage.put(`token:${role}`, request.headers.get("X-Obi-Token"));
    const meta: Meta = {
      sphere: request.headers.get("X-Obi-Sphere")!,
      exchange: request.headers.get("X-Obi-Exchange")!,
      guest: request.headers.get("X-Obi-Guest")!,
      host: request.headers.get("X-Obi-Host")!,
    };
    await this.ctx.storage.put("meta", meta);
    // One connection per side: a new one replaces the earlier.
    for (const old of this.ctx.getWebSockets(role)) old.close(4003, "replaced by a new connection");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    if (this.ctx.getWebSockets(other(role)).length > 0) {
      this.announce("joined");
      await this.ctx.storage.delete("alone");
      await this.ctx.storage.put("last", now);
    } else if ((await this.ctx.storage.get("alone")) === undefined) await this.ctx.storage.put("alone", now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") return ws.close(4004, "text frames come only from the Sphere");
    if (message.byteLength > MAX_FRAME_BYTES) return ws.close(1009, `a frame is at most ${MAX_FRAME_BYTES} bytes`);
    this.bytes ??= (await this.ctx.storage.get<number>("bytes")) ?? 0;
    this.bytes += message.byteLength;
    if (this.bytes > MAX_CHANNEL_BYTES) return this.closeAll(4002, "the channel carried its 8 GiB");
    if (this.bytes - this.persisted >= PERSIST_EVERY) {
      this.persisted = this.bytes;
      await this.ctx.storage.put("bytes", this.bytes);
    }
    // When it last carried a frame, written down at most once a minute.
    const now = Date.now();
    if (now - this.lastSaved > 60_000) {
      this.lastSaved = now;
      await this.ctx.storage.put("last", now);
    }
    // Sent while the other side isn't there: dropped. Its next join starts a new handshake.
    for (const peer of this.ctx.getWebSockets(other(roleOf(this.ctx, ws)))) peer.send(message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const role = roleOf(this.ctx, ws);
    // Still there: a replaced connection closing doesn't mean the side left.
    if (this.ctx.getWebSockets(role).some((s) => s !== ws)) return;
    for (const peer of this.ctx.getWebSockets(other(role))) peer.send(JSON.stringify({ peer: "left" }));
    if (this.ctx.getWebSockets(other(role)).length > 0) await this.ctx.storage.put("alone", Date.now());
  }

  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta) return this.closeAll(4001, "the channel has no exchange");
    const now = Math.floor(Date.now() / 1000);
    const problem = await channelProblem(this.env.DB, meta.sphere, meta.exchange, now);
    const active = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE sphere = ?1 AND obi IN (?2, ?3) AND status = 'active'")
      .bind(meta.sphere, meta.guest, meta.host)
      .first<{ n: number }>();
    if (problem) return this.closeAll(4001, problem);
    if ((active?.n ?? 0) < 2) return this.closeAll(4001, "an Obi of the exchange was revoked");
    const tokens = await this.ctx.storage.get<string>(["token:guest", "token:host"]);
    const hashes = [...tokens.values()].filter((t): t is string => typeof t === "string");
    const live = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE sphere = ?1 AND revoked = 0 AND sha256 IN (${hashes.map((_, i) => `?${i + 2}`).join(", ") || "NULL"})`)
      .bind(meta.sphere, ...hashes)
      .first<{ n: number }>();
    if ((live?.n ?? 0) < hashes.length) return this.closeAll(4001, "a side's token was revoked");
    const both = this.ctx.getWebSockets("guest").length > 0 && this.ctx.getWebSockets("host").length > 0;
    const at = Date.now();
    const alone = await this.ctx.storage.get<number>("alone");
    if (!both && alone !== undefined && at - alone > ALONE_MS) return this.closeAll(4005, "the other side didn't join within 10 minutes");
    const last = await this.ctx.storage.get<number>("last");
    if (both && last !== undefined && at - last > IDLE_MS) return this.closeAll(4006, "no frame for 5 minutes");
    await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
  }

  private announce(what: "joined" | "left"): void {
    for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ peer: what }));
  }

  private closeAll(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) ws.close(code, reason.slice(0, 120));
  }
}

const other = (role: Role): Role => (role === "guest" ? "host" : "guest");
const roleOf = (ctx: DurableObjectState, ws: WebSocket): Role => ctx.getTags(ws)[0] as Role;
