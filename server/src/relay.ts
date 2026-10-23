// One phone relay (spec/sphere-api.md section 9): a Durable Object per relay id. It holds the Mac's
// WebSocket and one per paired phone, and passes binary frames between them unchanged and unread:
// each is an envelope the two seal end to end. A phone's frame reaches the Mac behind the phone's
// 32-byte device id; the Mac's goes to the device its first 32 bytes name. Nothing of a frame is
// stored or logged here: only its size counts, against the relay's limits a minute.
// Every minute while a socket is connected it looks again at the relay, its devices and the Mac's
// Obi and token, and closes what was deleted, revoked or has expired; a socket that sent no frame
// and no ping for 2 minutes is closed too. Each socket opens at most 30 times in 10 minutes.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { hex } from "./protocol/crypto.ts";

export const MAX_ENVELOPE_BYTES = 262144;
/** A device id on the Mac's frames: the 32 bytes of its relay token's SHA-256. */
const ID_BYTES = 32;
export const MAX_FRAMES_PER_MINUTE = 3000;
export const MAX_BYTES_PER_MINUTE = 32 * 1024 ** 2;
/** A socket that sent no frame and no ping this long is closed (each side pings every 30 seconds). */
export const IDLE_MS = 2 * 60_000;
export const MAX_OPENS = 30;
const OPENS_WINDOW_MS = 10 * 60_000;
const CHECK_EVERY_MS = 60_000;
const MAC = "mac";

interface Member {
  sphere: string;
  obi: string;
  /** The SHA-256 of the access token the Mac opened with. */
  token: string;
}
interface Attachment {
  /** The phone's device id, or null for the Mac. */
  device: string | null;
  /** When it last sent a frame, in milliseconds (written at most every 10 seconds). */
  last: number;
  /** Closed by the relay, which has already done what its going means. */
  shut?: true;
}

const att = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));

export class PhoneRelay extends DurableObject<Env> {
  // ponytail: the minute's counts live in memory, so a relay woken from hibernation starts its
  // minute again; hibernating takes seconds without a frame, which a flood never leaves.
  private minute = { start: 0, frames: 0, bytes: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives, answered without waking the relay; the alarm reads when each socket last pinged.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const device = request.headers.get("X-Obi-Device");
    const tag = device ?? MAC;
    const now = Date.now();
    const opens = ((await this.ctx.storage.get<number[]>(`opens:${tag}`)) ?? []).filter((t) => t > now - OPENS_WINDOW_MS);
    if (opens.length >= MAX_OPENS) {
      return Response.json({ error: { code: "rate_limited", message: `a socket opens at most ${MAX_OPENS} times in 10 minutes` } }, { status: 429, headers: { "Retry-After": "60" } });
    }
    await this.ctx.storage.put({
      [`opens:${tag}`]: [...opens, now],
      relay: request.headers.get("X-Obi-Relay"),
      offset: Number(request.headers.get("X-Obi-Clock-Offset") ?? 0) || 0,
    });
    if (!device) await this.ctx.storage.put("member", JSON.parse(request.headers.get("X-Obi-Member") ?? "null") as Member | null);
    // One socket each: a new one replaces the earlier, and the Mac's phones see nothing of it.
    for (const old of this.ctx.getWebSockets(tag)) this.shut(old, 4003, "replaced by a new connection", false);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ device, last: now } satisfies Attachment);
    if (device) {
      const macs = this.open(MAC);
      if (macs.length === 0) this.shut(server, 4008, "your Mac isn't connected", false);
      for (const m of macs) m.send(JSON.stringify({ device, peer: "joined" }));
    } else {
      for (const phone of this.phones()) server.send(JSON.stringify({ device: att(phone).device, peer: "joined" }));
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // `ping` never gets here: the auto-response answers it.
    if (typeof message === "string") return this.shut(ws, 4004, "text frames come only from the Sphere, but ping");
    const a = att(ws);
    const max = MAX_ENVELOPE_BYTES + (a.device ? 0 : ID_BYTES);
    if (message.byteLength > max) return this.shut(ws, 1009, `a frame is at most ${max} bytes`);
    const now = Date.now();
    if (now - this.minute.start >= 60_000) this.minute = { start: now, frames: 0, bytes: 0 };
    this.minute.frames += 1;
    this.minute.bytes += message.byteLength;
    if (this.minute.frames > MAX_FRAMES_PER_MINUTE || this.minute.bytes > MAX_BYTES_PER_MINUTE) {
      return this.shut(ws, 4009, "the relay passed its frames or bytes a minute");
    }
    if (now - a.last > 10_000) ws.serializeAttachment({ ...a, last: now });
    if (a.device) {
      const framed = new Uint8Array(ID_BYTES + message.byteLength);
      framed.set(fromHex(a.device));
      framed.set(new Uint8Array(message), ID_BYTES);
      for (const m of this.open(MAC)) m.send(framed);
    } else if (message.byteLength >= ID_BYTES) {
      // For a device that isn't connected: dropped.
      for (const phone of this.open(hex(new Uint8Array(message, 0, ID_BYTES)))) phone.send(message.slice(ID_BYTES));
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    if (!att(ws).shut) this.gone(ws);
  }

  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    const [relay, member, offset] = await Promise.all([
      this.ctx.storage.get<string>("relay"),
      this.ctx.storage.get<Member | null>("member"),
      this.ctx.storage.get<number>("offset"),
    ]);
    const db = this.env.DB;
    const [relays, devices, members, tokens] = await db.batch([
      db.prepare("SELECT 1 AS ok FROM relays WHERE id = ?1").bind(relay ?? ""),
      db.prepare("SELECT token_sha256 FROM relay_devices WHERE relay = ?1").bind(relay ?? ""),
      db.prepare("SELECT status FROM members WHERE sphere = ?1 AND obi = ?2").bind(member?.sphere ?? "", member?.obi ?? ""),
      db.prepare("SELECT revoked, expires_at_s FROM tokens WHERE sha256 = ?1").bind(member?.token ?? ""),
    ]);
    if (relays!.results.length === 0) return this.forget(null);
    const known = new Set((devices!.results as { token_sha256: string }[]).map((d) => d.token_sha256));
    for (const phone of this.phones()) if (!known.has(att(phone).device!)) this.shut(phone, 4001, "this phone was forgotten");
    if (member) {
      // The Worker's clock: a test's own, in the tests.
      const now = Math.floor((Date.now() + (offset ?? 0)) / 1000);
      const status = (members!.results[0] as { status: string } | undefined)?.status;
      const token = tokens!.results[0] as { revoked: number; expires_at_s: number } | undefined;
      for (const m of this.open(MAC)) {
        if (status !== "active" || !token || token.revoked) this.shut(m, 4001, "the Mac's Obi or its token was revoked");
        else if (token.expires_at_s <= now) this.shut(m, 4007, "the Mac's token expired: open the relay again with a new one");
      }
    }
    const at = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const last = Math.max(att(ws).last, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (at - last > IDLE_MS) this.shut(ws, 4006, "no frame and no ping for 2 minutes");
    }
    await this.ctx.storage.setAlarm(Date.now() + CHECK_EVERY_MS);
  }

  /** The Mac forgot a phone (`device`), or deleted the relay (null): their sockets close now. */
  async forget(device: string | null): Promise<void> {
    if (device) return this.open(device).forEach((ws) => this.shut(ws, 4001, "this phone was forgotten"));
    // The phones first, so they're told it was deleted rather than that the Mac left.
    for (const ws of [...this.phones(), ...this.open(MAC)]) this.shut(ws, 4001, "the relay was deleted");
    await this.ctx.storage.deleteAll();
  }

  private open(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private phones(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && att(ws).device !== null);
  }

  /** Closes `ws`, then (with `after`) does what its going means at once. */
  private shut(ws: WebSocket, code: number, reason: string, after = true): void {
    // Closing already: what its going means was done when it was closed.
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.serializeAttachment({ ...att(ws), shut: true });
    ws.close(code, reason);
    if (after) this.gone(ws);
  }

  /** `ws` closed. Unless it was replaced: a phone gone is told to the Mac, the Mac gone closes every phone. */
  private gone(ws: WebSocket): void {
    const { device } = att(ws);
    if (this.open(device ?? MAC).some((s) => s !== ws)) return;
    if (device) for (const m of this.open(MAC)) m.send(JSON.stringify({ device, peer: "left" }));
    else for (const phone of this.phones()) this.shut(phone, 4008, "your Mac isn't connected", false);
  }
}
