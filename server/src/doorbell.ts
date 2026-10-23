// What wakes a deliveries long poll (spec/sphere-api.md section 6.2): one Doorbell per Obi in a
// Sphere. A poll that finds its queue empty waits on a WebSocket to its Obi's Doorbell instead of
// reading D1 again and again, and a send rings the recipient's Doorbell once its delivery is
// recorded. The Doorbell holds its WebSockets with the Hibernation API, so a waiting poll costs no
// D1 reads, next to no CPU, and no Durable Object duration (docs/run-your-own.md, "The plan").

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export class Doorbell extends DurableObject<Env> {
  /**
   * Rung since a poll last opened: the next one reads D1 again at once. That covers a send landing
   * between a poll's read and its open; at worst it costs one more read.
   * ponytail: in memory, so a Doorbell evicted between a ring and the next open loses it; that poll
   * then reads D1 when its `wait` ends: late, never lost.
   */
  private rung = false;

  override fetch(): Response {
    if (this.rung) {
      this.rung = false;
      return new Response(null, { status: 204 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  ring(): void {
    this.rung = true;
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "rung");
  }
}

const doorbell = (env: Env, sphere: string, obi: string) => env.DOORBELLS.get(env.DOORBELLS.idFromName(`${sphere}/${obi}`));

/** Wakes `obi`'s waiting long polls. A ring that fails only makes them wait out their `wait`. */
export const ring = (env: Env, sphere: string, obi: string): Promise<void> =>
  doorbell(env, sphere, obi)
    .ring()
    .catch(() => {});

/** Resolves when `obi`'s Doorbell rings, or after `ms`. */
export async function rung(env: Env, sphere: string, obi: string, ms: number): Promise<void> {
  const ws = (await doorbell(env, sphere, obi).fetch("https://doorbell.internal/", { headers: { Upgrade: "websocket" } })).webSocket;
  if (!ws) return;
  ws.accept();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.addEventListener("close", done);
    ws.addEventListener("error", done);
  });
  try {
    ws.close(1000, "done");
  } catch {}
}
