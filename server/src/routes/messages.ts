// Send, deliveries and acknowledgements (spec/sphere-api.md section 6). The Sphere checks every
// message before relaying it and never changes one: what it records and delivers is the value the
// sender signed. Text fields are data: nothing here reads them beyond the schema.

import { bearer, requireActor, requireScope } from "../auth.ts";
import { SPHERE_COLUMNS, guardedWrite, requireSphere, withRetries, type KeyRow, type MemberRow, type PolicyRule, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { ring, rung } from "../doorbell.ts";
import { apiError, json, parseBody, readBody } from "../http.ts";
import { cardParams, type AgentCard } from "../protocol/card.ts";
import { entryHash } from "../protocol/chain.ts";
import { uuid } from "../protocol/crypto.ts";
import {
  CLOCK_SKEW_SECONDS, checkEnvelopeShape, exchangeMessage, exchangeProblem, isRequestType, requestRepo, seconds, timestamp, verifyEnvelopeSignature,
  type Envelope, type ExchangeMessage,
} from "../protocol/envelope.ts";
import { canonicalize } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { policyAllows } from "./policy.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

interface AuditRow {
  seq: number;
  recorded_at: string;
  envelope: string;
  hash: string;
  msg_id: string;
  type: string;
  from_obi: string;
  to_obi: string;
  in_reply_to: string | null;
  result_for: string | null;
}

const rowMessage = (r: AuditRow): ExchangeMessage => ({ type: r.type, from: r.from_obi, to: r.to_obi, result_for: r.result_for ?? undefined });
const sendAnswer = (r: Pick<AuditRow, "msg_id" | "seq" | "hash" | "recorded_at">) => ({ id: r.msg_id, seq: r.seq, entry_hash: r.hash, recorded_at: r.recorded_at });

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/messages, checks 1 to 13 of section 6.1, in that order.

export async function send(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  // 1. A valid token for this Sphere, with an actor.
  const caller = await bearer(request, env, sphere0, nowS(deps));
  if (caller.actor === null) throw apiError("unauthorized", "sending needs an Obi's token (one with an actor)");
  // 2 and 3. At most 131,072 bytes, JSON with no duplicate member names.
  const value = parseBody(await readBody(request), "invalid_envelope");
  // 4. protocol.md section 10, checks 1 to 3.
  const shape = checkEnvelopeShape(value);
  if (!shape.ok) throw apiError(shape.code as "payload_too_large" | "invalid_envelope", shape.message);
  const env_ = shape.envelope;
  // 5. This Sphere.
  if (env_.sphere !== sphere0.id) throw apiError("wrong_sphere", `the message is for ${env_.sphere}, not ${sphere0.id}`);
  // 6. From the token's actor.
  if (env_.from !== caller.actor) throw apiError("forbidden", `the token acts for ${caller.actor}, not ${env_.from}`);
  // 7. The scope for its type.
  const request_ = isRequestType(env_.type);
  if (request_) requireScope(caller, `send:${env_.type}` as "send:review_request");
  else requireScope(caller, "reply");
  const canonical = canonicalize(env_);

  // The signature is checked once per key: a retry after losing a turn to another write (db.ts,
  // withRetries) doesn't check it again unless the sender's current key changed meanwhile.
  const signatureOk = new Map<string, boolean>();
  const reply = request_ ? null : env_.in_reply_to!;

  return withRetries(async () => {
    // Everything the checks read, in one transaction: one consistent snapshot, one round trip.
    const reads = await env.DB.batch([
      env.DB.prepare(`SELECT ${SPHERE_COLUMNS} FROM spheres WHERE id = ?1`).bind(sphere0.id),
      env.DB.prepare("SELECT * FROM audit WHERE sphere = ?1 AND msg_id = ?2").bind(sphere0.id, env_.id),
      env.DB.prepare("SELECT * FROM member_keys WHERE sphere = ?1 AND obi = ?2 ORDER BY valid_from_seq, rowid").bind(sphere0.id, env_.from),
      env.DB.prepare("SELECT * FROM members WHERE sphere = ?1 AND obi = ?2").bind(sphere0.id, env_.to),
      env.DB.prepare("SELECT * FROM members WHERE sphere = ?1 AND obi = ?2").bind(sphere0.id, env_.from),
      ...(reply === null
        ? []
        : [
            env.DB.prepare("SELECT * FROM audit WHERE sphere = ?1 AND msg_id = ?2").bind(sphere0.id, reply),
            env.DB.prepare("SELECT * FROM audit WHERE sphere = ?1 AND in_reply_to = ?2 ORDER BY seq").bind(sphere0.id, reply),
          ]),
    ]);
    const rows = <T,>(i: number) => reads[i]!.results as unknown as T[];
    const sphere = rows<SphereRow>(0)[0];
    if (!sphere) throw apiError("not_found", `no Sphere ${sphere0.id}`);
    // 8. A retry of a recorded message answers what its first send answered; another message
    // with the same id is a duplicate.
    const recorded = rows<AuditRow>(1)[0];
    if (recorded) {
      if (recorded.envelope === canonical) return json(200, sendAnswer(recorded));
      throw apiError("duplicate", `a different message with id ${env_.id} was relayed before`);
    }
    // 9. The sender's current key, and its signature.
    const current = rows<KeyRow>(2).find((k) => k.valid_until_seq === null);
    if (!current || current.key_id !== env_.key_id) throw apiError("unknown_key", `${env_.key_id} is not ${env_.from}'s current key`);
    if (!signatureOk.has(current.public_key)) signatureOk.set(current.public_key, await verifyEnvelopeSignature(env_, current.public_key));
    if (!signatureOk.get(current.public_key)) throw apiError("bad_signature", "the signature does not verify");
    // 10. Not expired, not from the future. The Sphere's clock never goes back along the chain.
    const now = Math.max(nowS(deps), sphere.head_recorded_at_s ?? 0);
    if (!(seconds(env_.expires_at) > now)) throw apiError("expired", `the message expired at ${env_.expires_at}`);
    if (seconds(env_.created_at) > now + CLOCK_SKEW_SECONDS) throw apiError("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
    // 11. The recipient.
    const to = rows<MemberRow>(3)[0];
    if (!to) throw apiError("unknown_recipient", `${env_.to} is not a member`);
    if (to.status !== "active") throw apiError("recipient_revoked", `${env_.to} was revoked`);
    const toCard = cardParams(JSON.parse(to.card) as AgentCard);
    if (request_ && !toCard.accepts.includes(env_.type)) throw apiError("policy_denied", `${env_.to}'s card doesn't accept ${env_.type}`);
    // Sealed for the recipient's current seal key, and never in the clear between two Obis that
    // both seal (protocol.md section 9.1): the Sphere checks whose key, and can't read what's sealed.
    if (env_.seal && env_.seal.key_id !== toCard.seal_key_id) throw apiError("invalid_envelope", `sealed for ${env_.seal.key_id}, not ${env_.to}'s seal key`);
    if (!env_.seal && toCard.seal_key_id && cardParams(JSON.parse(rows<MemberRow>(4)[0]!.card) as AgentCard).seal_key_id) {
      throw apiError("not_sealed", `${env_.from} and ${env_.to} both seal: its words go sealed for ${toCard.seal_key_id}`);
    }
    // 12. The policy for a request; the exchange rules for a reply.
    if (request_) {
      const from = rows<MemberRow>(4)[0]!;
      if (!policyAllows(JSON.parse(sphere.policy_rules) as PolicyRule[], from.owner, to.owner, env_.type, requestRepo(env_))) throw apiError("policy_denied", "no policy rule allows this request");
    } else {
      const req = rows<AuditRow>(5)[0];
      const problem = exchangeProblem(exchangeMessage(env_), req && rowMessage(req), rows<AuditRow>(6).map(rowMessage));
      if (problem) throw apiError("bad_reply", problem);
    }
    // 13. Record: the audit entry and the delivery, in one transaction.
    const seq = sphere.head_seq + 1;
    const recordedAt = timestamp(now);
    const hash = await entryHash({ sphere: sphere.id, seq, prev: sphere.head_hash, recorded_at: recordedAt, envelope: env_ });
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("UPDATE spheres SET head_seq = ?1, head_hash = ?2, head_recorded_at_s = ?3 WHERE id = ?4").bind(seq, hash, now, sphere.id),
      env.DB.prepare(
        `INSERT INTO audit (sphere, seq, prev, recorded_at, envelope, hash, msg_id, type, from_obi, to_obi, in_reply_to, result_for)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        sphere.id, seq, sphere.head_hash, recordedAt, canonical, hash, env_.id, env_.type, env_.from, env_.to, env_.in_reply_to ?? null,
        env_.type === "result" ? (env_.body.for as string) : null,
      ),
      env.DB.prepare("INSERT INTO deliveries (id, sphere, to_obi, seq, expires_at_s, state) VALUES (?1, ?2, ?3, ?4, ?5, 'queued')").bind(
        uuid(), sphere.id, env_.to, seq, seconds(env_.expires_at),
      ),
    ]);
    if (!written) return null;
    await ring(env, sphere.id, env_.to);
    return json(202, sendAnswer({ msg_id: env_.id, seq, hash, recorded_at: recordedAt }));
  }, deps.retryBudgetMs);
}

// ---------------------------------------------------------------------------------------------
// GET /v0.1/spheres/{sphere}/deliveries?limit=&wait=

/** A decimal integer query parameter in [min, max], `fallback` when absent; else 400 bad_request. */
export function intParam(url: URL, name: string, min: number, max: number, fallback: number): number {
  const all = url.searchParams.getAll(name);
  if (all.length === 0) return fallback;
  if (all.length > 1) throw apiError("bad_request", `${name} is given more than once`);
  const text = all[0]!;
  if (!/^[0-9]{1,16}$/.test(text)) throw apiError("bad_request", `${name} must be a decimal integer from ${min} to ${max}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw apiError("bad_request", `${name} must be a decimal integer from ${min} to ${max}`);
  return n;
}

export async function deliveries(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "receive");
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 1, 100, 50);
  const wait = intParam(url, "wait", 0, 25, 0);
  // `wait` is real time spent holding the request, not the Sphere's protocol clock.
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const now = nowS(deps);
    const [, rows] = await env.DB.batch([
      env.DB.prepare("UPDATE deliveries SET state = 'dropped' WHERE sphere = ?1 AND to_obi = ?2 AND state = 'queued' AND expires_at_s <= ?3").bind(sphere.id, obi, now),
      env.DB.prepare(
        `SELECT d.id, d.seq, a.recorded_at, a.envelope FROM deliveries d JOIN audit a ON a.sphere = d.sphere AND a.seq = d.seq
          WHERE d.sphere = ?1 AND d.to_obi = ?2 AND d.state = 'queued' AND d.expires_at_s > ?3 ORDER BY d.seq LIMIT ?4`,
      ).bind(sphere.id, obi, now, limit),
    ]);
    const list = (rows!.results as unknown as { id: string; seq: number; recorded_at: string; envelope: string }[]).map((r) => ({
      delivery_id: r.id,
      seq: r.seq,
      relayed_at: r.recorded_at,
      envelope: JSON.parse(r.envelope) as Envelope,
    }));
    if (list.length || Date.now() >= deadline) return json(200, { deliveries: list });
    // Nothing queued: wait for a send to this Obi to ring (src/doorbell.ts), then look again.
    await rung(env, sphere.id, obi, deadline - Date.now());
  }
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/deliveries/ack

export async function ack(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "receive");
  const body = parseBody(await readBody(request), "bad_request");
  const errors = schemaErrors("ackRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match ack.request", errors);
  const ids = (body as unknown as { delivery_ids: string[] }).delivery_ids;
  const now = nowS(deps);
  // D1 binds at most 100 parameters per statement: acknowledge in chunks, in one transaction.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const results = await env.DB.batch(
    chunks.map((chunk) =>
      env.DB.prepare(
        `UPDATE deliveries SET state = 'acked' WHERE sphere = ?1 AND to_obi = ?2 AND state = 'queued' AND expires_at_s > ?3
            AND id IN (${chunk.map((_, i) => `?${i + 4}`).join(", ")})`,
      ).bind(sphere.id, obi, now, ...chunk),
    ),
  );
  return json(200, { acked: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) });
}

