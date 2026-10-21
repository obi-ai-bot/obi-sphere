// Job channels (spec/sphere-api.md section 6.3; protocol.md section 13): the Worker checks who is
// connecting and to what, then hands the WebSocket to the exchange's ChannelRelay (src/channel.ts),
// which pairs the two sides and forwards their frames without reading them.

import { bearer, requireActor, requireScope, tokenHash } from "../auth.ts";
import { requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError } from "../http.ts";
import { TERMINAL_TYPES, seconds } from "../protocol/envelope.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** Why an exchange's channel may not be open now, or null when it may: it needs its accept, no end, and an unexpired request. */
export async function channelProblem(db: D1Database, sphere: string, correlationId: string, now: number): Promise<string | null> {
  const [requests, replies] = await db.batch([
    db.prepare("SELECT envelope FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND type = 'run_request'").bind(sphere, correlationId),
    db.prepare("SELECT type FROM audit WHERE sphere = ?1 AND in_reply_to = ?2").bind(sphere, correlationId),
  ]);
  const request = (requests!.results as { envelope: string }[])[0];
  if (!request) return "no such run_request";
  const types = (replies!.results as { type: string }[]).map((r) => r.type);
  if (types.some((t) => TERMINAL_TYPES.includes(t))) return "the exchange has ended";
  if (!types.includes("accept")) return "the run_request hasn't been accepted";
  if (!(seconds((JSON.parse(request.envelope) as { expires_at: string }).expires_at) > now)) return "the run_request has expired";
  return null;
}

export async function openChannel(request: Request, env: Env, deps: Deps, sphereId: string, correlationId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "receive");
  const obi = requireActor(caller);
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw apiError("bad_request", "a job channel is a WebSocket: Upgrade: websocket");
  const row = await env.DB.prepare("SELECT from_obi, to_obi FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND type = 'run_request'")
    .bind(sphere.id, correlationId)
    .first<{ from_obi: string; to_obi: string }>();
  if (!row) throw apiError("not_found", `no run_request ${correlationId}`);
  const role = obi === row.from_obi ? "guest" : obi === row.to_obi ? "host" : null;
  if (!role) throw apiError("forbidden", "only the exchange's two Obis open its channel");
  const problem = await channelProblem(env.DB, sphere.id, correlationId, nowS(deps));
  if (problem) throw apiError("conflict", problem);
  const relay = env.CHANNELS.get(env.CHANNELS.idFromName(`${sphere.id}/${correlationId}`));
  // The relay checks this token stays unrevoked (a card rotation or a revocation revokes it).
  const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")![1]!;
  const headers = new Headers({ Upgrade: "websocket", "X-Obi-Token": await tokenHash(token), "X-Obi-Role": role, "X-Obi-Sphere": sphere.id, "X-Obi-Exchange": correlationId, "X-Obi-Guest": row.from_obi, "X-Obi-Host": row.to_obi });
  return relay.fetch("https://channel.internal/", { headers });
}
