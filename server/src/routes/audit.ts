// GET /v0.1/spheres/{sphere}/audit (spec/sphere-api.md section 7).

import { bearer, requireScope } from "../auth.ts";
import { requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { json } from "../http.ts";
import type { AuditEntry } from "../protocol/chain.ts";
import type { Envelope } from "../protocol/envelope.ts";
import { intParam } from "./messages.ts";

export async function audit(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, Math.floor(deps.now() / 1000));
  requireScope(caller, "audit:read");
  const url = new URL(request.url);
  const fromSeq = intParam(url, "from_seq", 1, Number.MAX_SAFE_INTEGER, 1);
  const limit = intParam(url, "limit", 1, 1000, 500);
  // One batch: the page and the head come from the same snapshot.
  const [rows, head] = await env.DB.batch([
    env.DB.prepare("SELECT seq, prev, recorded_at, envelope, hash FROM audit WHERE sphere = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3").bind(sphere.id, fromSeq, limit),
    env.DB.prepare("SELECT head_seq, head_hash FROM spheres WHERE id = ?1").bind(sphere.id),
  ]);
  const entries: AuditEntry[] = (rows!.results as unknown as { seq: number; prev: string; recorded_at: string; envelope: string; hash: string }[]).map((r) => ({
    sphere: sphere.id,
    seq: r.seq,
    prev: r.prev,
    recorded_at: r.recorded_at,
    envelope: JSON.parse(r.envelope) as Envelope,
    hash: r.hash,
  }));
  const h = (head!.results as unknown as { head_seq: number; head_hash: string }[])[0]!;
  return json(200, { sphere: sphere.id, entries, head: { seq: h.head_seq, hash: h.head_hash } });
}
