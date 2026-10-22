// Runner status (spec/sphere-api.md section 6.4; protocol.md section 14): what a member's Mac
// offers, signed by the member's Obi, shown only to the owners it names. It never says whether
// the Mac's owner is at it, and nobody it isn't offered to learns there is one.

import { bearer, requireActor, requireScope, type Caller } from "../auth.ts";
import { getKeys, loadMemberJson, requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { verifyEd25519 } from "../protocol/crypto.ts";
import { CLOCK_SKEW_SECONDS, seconds } from "../protocol/envelope.ts";
import { canonicalBytes, utf8, type JsonObject } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);
export const RUNNER_SIGNING_PREFIX = "obi/0.1 runner_status\n";
const MAX_RUNNER_LIFETIME = 900;

export function runnerSigningInput(status: JsonObject): Uint8Array {
  const { signature: _signature, ...unsigned } = status;
  const prefix = utf8(RUNNER_SIGNING_PREFIX);
  const body = canonicalBytes(unsigned);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/** Whether a runner status is offered to `owner`. */
export const offeredTo = (status: JsonObject, owner: string): boolean =>
  status.for === "*" || (Array.isArray(status.for) && status.for.includes(owner));

/**
 * The runner statuses `caller` may see, by Obi: unexpired, of active members only, signed with
 * the member's current key, and only those offered to the caller's owner, or the caller's owner's own.
 */
export async function visibleRunners(db: D1Database, sphere: string, caller: Caller, now: number, obi?: string): Promise<Map<string, JsonObject>> {
  const base = `SELECT r.obi, r.status, m.owner FROM runner_status r
    JOIN members m ON m.sphere = r.sphere AND m.obi = r.obi AND m.status = 'active'
    JOIN member_keys k ON k.sphere = r.sphere AND k.obi = r.obi AND k.valid_until_seq IS NULL AND k.key_id = json_extract(r.status, '$.key_id')
    WHERE r.sphere = ?1 AND r.expires_at_s > ?2`;
  const rows = await (obi === undefined ? db.prepare(base).bind(sphere, now) : db.prepare(`${base} AND r.obi = ?3`).bind(sphere, now, obi)).all<{
    obi: string;
    status: string;
    owner: string;
  }>();
  const out = new Map<string, JsonObject>();
  for (const r of rows.results) {
    const status = JSON.parse(r.status) as JsonObject;
    if (r.owner === caller.subject || offeredTo(status, caller.subject)) out.set(r.obi, status);
  }
  return out;
}

async function own(request: Request, env: Env, deps: Deps, sphereId: string, obi: string) {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "receive");
  if (requireActor(caller) !== obi) throw apiError("forbidden", `only ${obi} itself publishes its runner status`);
  return { sphere, caller };
}

/** The member with its runner status, as its own Obi sees it. */
async function answer(env: Env, deps: Deps, sphere: string, caller: Caller, obi: string): Promise<Response> {
  const member = await loadMemberJson(env.DB, sphere, obi);
  const runner = (await visibleRunners(env.DB, sphere, caller, nowS(deps), obi)).get(obi);
  return json(200, runner ? { ...member, runner } : member);
}

export async function putRunner(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const { sphere, caller } = await own(request, env, deps, sphereId, obi);
  const body = await readJson(request);
  const errors = schemaErrors("runnerStatus", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match runner-status", errors);
  const status = body as JsonObject;
  if (status.sphere !== sphere.id || status.obi !== obi) throw apiError("bad_request", "the status is for another Sphere or Obi");
  const created = seconds(status.created_at as string);
  const expires = seconds(status.expires_at as string);
  const now = nowS(deps);
  if (created > now + CLOCK_SKEW_SECONDS) throw apiError("bad_request", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
  if (!(expires > now) || !(expires > created) || expires - created > MAX_RUNNER_LIFETIME) {
    throw apiError("bad_request", `expires_at must be after now and at most ${MAX_RUNNER_LIFETIME} seconds after created_at`);
  }
  // Never an older status in place of a newer one (a replay of one the Obi sent before).
  const stored = await env.DB.prepare("SELECT status FROM runner_status WHERE sphere = ?1 AND obi = ?2").bind(sphere.id, obi).first<{ status: string }>();
  if (stored && created < seconds((JSON.parse(stored.status) as { created_at: string }).created_at)) {
    throw apiError("bad_request", "created_at is older than the status it would replace");
  }
  const current = (await getKeys(env.DB, sphere.id, obi)).find((k) => k.valid_until_seq === null);
  if (!current || current.key_id !== status.key_id) throw apiError("unknown_key", `${String(status.key_id)} is not ${obi}'s current key`);
  if (!(await verifyEd25519(current.public_key, runnerSigningInput(status), status.signature as string))) throw apiError("bad_signature", "the signature does not verify");
  await env.DB.prepare(
    "INSERT INTO runner_status (sphere, obi, status, expires_at_s) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (sphere, obi) DO UPDATE SET status = ?3, expires_at_s = ?4",
  ).bind(sphere.id, obi, JSON.stringify(status), expires).run();
  return answer(env, deps, sphere.id, caller, obi);
}

export async function deleteRunner(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const { sphere, caller } = await own(request, env, deps, sphereId, obi);
  await env.DB.prepare("DELETE FROM runner_status WHERE sphere = ?1 AND obi = ?2").bind(sphere.id, obi).run();
  return answer(env, deps, sphere.id, caller, obi);
}
