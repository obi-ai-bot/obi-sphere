// The phone relay (spec/sphere-api.md section 9): a Mac registers a relay and the SHA-256 of each
// paired phone's relay token; the Worker checks who opens a relay socket, then hands it to the
// relay's PhoneRelay (src/relay.ts), which passes the sealed frames between the Mac and its phones
// without reading them.

import { bearer, requireActor, requireScope, tokenHash } from "../auth.ts";
import { constraintFailure, unforeseen } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json } from "../http.ts";
import { keyIdOf } from "../protocol/crypto.ts";
import { CLOCK_SKEW_SECONDS } from "../protocol/envelope.ts";
import { parseJwt, verifyJws } from "../protocol/jws.ts";
import { matches } from "../protocol/schemas.ts";

/** The most relays one Mac (an Obi, or a key) owns. */
export const MAX_RELAYS = 4;
/** The most phones one relay has. */
export const MAX_DEVICES = 16;
const ASSERTION_MAX_SECONDS = 300;
const RELAY_ID = /^[A-Za-z0-9_-]{22,43}$/;
const DEVICE = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~-]{1,512})$/;

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** A Mac: the relay owner it is (`<sphere>/<obi>`, or a key id), and for a member what its relay checks while it's connected. */
interface Mac {
  owner: string;
  member: { sphere: string; obi: string; token: string } | null;
}

function relayId(id: string): string {
  if (!RELAY_ID.test(id)) throw apiError("bad_request", "a relay id is 22 to 43 base64url characters");
  return id;
}

function deviceId(id: string): string {
  if (!DEVICE.test(id)) throw apiError("bad_request", "a device is the lower-case hex SHA-256 of its relay token");
  return id;
}

/** The Mac behind the request: an Obi's access token, or (on `owner_keys`) a relay assertion for `relay`. */
async function mac(request: Request, env: Env, deps: Deps, relay: string): Promise<Mac> {
  const value = BEARER.exec(request.headers.get("Authorization") ?? "")?.[1];
  const jws = value === undefined ? null : parseJwt(value);
  if (!jws) {
    const caller = await bearer(request, env, null, nowS(deps));
    const obi = requireActor(caller);
    requireScope(caller, "receive");
    return { owner: `${caller.sphere}/${obi}`, member: { sphere: caller.sphere, obi, token: await tokenHash(value!) } };
  }
  if (env.RELAY_OWNERS !== "owner_keys") throw apiError("forbidden", "this Sphere server relays only for its members' Macs");
  const c = jws.claims as { iss: string; aud: string; iat: number; exp: number; jti: string };
  const now = nowS(deps);
  const ok = matches("relayAssertionClaims", c) && c.aud === `obi-sphere:relay:${relay}` && c.iat <= now + CLOCK_SKEW_SECONDS && c.exp > now
    && c.exp > c.iat && c.exp - c.iat <= ASSERTION_MAX_SECONDS && jws.header.kid === (await keyIdOf(c.iss)) && (await verifyJws(jws, c.iss));
  if (!ok) throw apiError("unauthorized", "the relay assertion doesn't pass");
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM used_jtis WHERE exp_s < ?1").bind(now),
      // Not a Sphere's: kept apart from every Sphere's by the empty sphere and the prefix.
      env.DB.prepare("INSERT INTO used_jtis (sphere, iss, jti, exp_s) VALUES ('', ?1, ?2, ?3)").bind(`relay:${jws.header.kid}`, c.jti, c.exp),
    ]);
  } catch (e) {
    if (constraintFailure(e)?.startsWith("UNIQUE constraint failed: used_jtis.")) throw apiError("unauthorized", "this relay assertion was used before");
    unforeseen(e, "using a relay assertion");
  }
  return { owner: jws.header.kid, member: null };
}

const ownerOf = (env: Env, relay: string) => env.DB.prepare("SELECT owner FROM relays WHERE id = ?1").bind(relay).first<{ owner: string }>().then((r) => r?.owner ?? null);

async function ownRelay(env: Env, relay: string, m: Mac): Promise<void> {
  const owner = await ownerOf(env, relay);
  if (owner === null) throw apiError("not_found", "no such relay");
  if (owner !== m.owner) throw apiError("forbidden", "this relay is another Mac's");
}

async function answer(env: Env, relay: string, status: number): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT token_sha256 FROM relay_devices WHERE relay = ?1 ORDER BY token_sha256").bind(relay).all<{ token_sha256: string }>();
  return json(status, { relay, devices: results.map((r) => r.token_sha256) });
}

const stub = (env: Env, relay: string) => env.RELAYS.get(env.RELAYS.idFromName(relay));

export async function putRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(id);
  const m = await mac(request, env, deps, relay);
  // One statement, so two at once can't pass the limit.
  const made = await env.DB.prepare("INSERT OR IGNORE INTO relays (id, owner, created_at_s) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM relays WHERE owner = ?2) < ?4")
    .bind(relay, m.owner, nowS(deps), MAX_RELAYS)
    .run();
  if (made.meta.changes > 0) return answer(env, relay, 201);
  const owner = await ownerOf(env, relay);
  if (owner === null) throw apiError("rate_limited", `a Mac owns at most ${MAX_RELAYS} relays: delete one first`);
  if (owner !== m.owner) throw apiError("conflict", "this relay id is another Mac's");
  return answer(env, relay, 200);
}

export async function deleteRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(id);
  await ownRelay(env, relay, await mac(request, env, deps, relay));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relay_devices WHERE relay = ?1").bind(relay),
    env.DB.prepare("DELETE FROM relays WHERE id = ?1").bind(relay),
  ]);
  await stub(env, relay).forget(null);
  return new Response(null, { status: 204 });
}

export async function putDevice(request: Request, env: Env, deps: Deps, id: string, device: string): Promise<Response> {
  const relay = relayId(id);
  const token = deviceId(device);
  await ownRelay(env, relay, await mac(request, env, deps, relay));
  const added = await env.DB.prepare(
    "INSERT OR IGNORE INTO relay_devices (relay, token_sha256, added_at_s) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM relay_devices WHERE relay = ?1) < ?4",
  ).bind(relay, token, nowS(deps), MAX_DEVICES).run();
  if (added.meta.changes > 0) return answer(env, relay, 201);
  const has = await env.DB.prepare("SELECT 1 AS has FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, token).first();
  if (!has) throw apiError("rate_limited", `a relay has at most ${MAX_DEVICES} devices: forget one first`);
  return answer(env, relay, 200);
}

export async function deleteDevice(request: Request, env: Env, deps: Deps, id: string, device: string): Promise<Response> {
  const relay = relayId(id);
  const token = deviceId(device);
  await ownRelay(env, relay, await mac(request, env, deps, relay));
  const gone = await env.DB.prepare("DELETE FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, token).run();
  if (gone.meta.changes === 0) throw apiError("not_found", "the relay has no such device");
  await stub(env, relay).forget(token);
  return new Response(null, { status: 204 });
}

/** `GET /v0.1/relay/{relay}`, a WebSocket: a phone with its relay token, or the relay's Mac. */
export async function openRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(id);
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw apiError("bad_request", "a relay is a WebSocket: Upgrade: websocket");
  const value = BEARER.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (value === undefined) throw apiError("unauthorized", "a relay token or the Mac's credential is needed: Authorization: Bearer <…>");
  // The Worker's clock, as the relay's alarms read it (zero apart in production; a test's own clock otherwise).
  const headers = new Headers({ Upgrade: "websocket", "X-Obi-Relay": relay, "X-Obi-Clock-Offset": String(deps.now() - Date.now()) });
  const hash = await tokenHash(value);
  const phone = await env.DB.prepare("SELECT 1 AS phone FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, hash).first();
  if (phone) headers.set("X-Obi-Device", hash);
  else {
    const m = await mac(request, env, deps, relay);
    await ownRelay(env, relay, m);
    if (m.member) headers.set("X-Obi-Member", JSON.stringify(m.member));
  }
  return stub(env, relay).fetch("https://relay.internal/", { headers });
}
