// The audit chain (spec/sphere-api.md section 7): entry hashes, and the verification of 7.1.

import { keyIdOrNull, sha256Hex } from "./crypto.ts";
import { canonicalBytes, utf8 } from "./json.ts";
import { schemaErrors } from "./schemas.ts";
import {
  CLOCK_SKEW_SECONDS, OK, exchangeMessage, exchangeProblem, fail, followUpProblem, isReplyType, isRequestType, keyValidAt, seconds, semanticProblems,
  verifyEnvelopeSignature, type DirectoryKey, type Envelope, type Verdict,
} from "./envelope.ts";

export const AUDIT_HASH_PREFIX = "obi/0.1 audit\n";
export const ZERO_HASH = "0".repeat(64);

export interface AuditEntry {
  sphere: string;
  seq: number;
  prev: string;
  recorded_at: string;
  envelope: Envelope;
  hash: string;
}

/** Lower-case hex SHA-256 of "obi/0.1 audit\n" + the JCS form of the entry without `hash`. */
export async function entryHash(entry: Omit<AuditEntry, "hash"> & { hash?: string }): Promise<string> {
  const { hash: _hash, ...rest } = entry;
  const prefix = utf8(AUDIT_HASH_PREFIX);
  const body = canonicalBytes(rest);
  const input = new Uint8Array(prefix.length + body.length);
  input.set(prefix);
  input.set(body, prefix.length);
  return sha256Hex(input);
}

/** sphere-api.md section 7.1, from seq 1, with every member's key history. */
export async function verifyChain(chain: unknown, ctx: { keys: Record<string, DirectoryKey> }): Promise<Verdict> {
  const c = chain as { sphere?: unknown; entries?: unknown };
  if (!c || typeof c.sphere !== "string" || !Array.isArray(c.entries)) return fail("bad_request", "a chain is {sphere, entries}");
  let prev = ZERO_HASH;
  let lastTime = -Infinity;
  const byId = new Map<string, Envelope>();
  const keys = ctx.keys ?? {};
  for (const [i, value] of c.entries.entries()) {
    const at = `entry ${i + 1}`;
    const errors = schemaErrors("auditEntry", value, 3);
    if (errors.length) return fail("invalid_envelope", `${at}: ${errors.join("; ")}`);
    const entry = value as AuditEntry;
    if (entry.seq !== i + 1) return fail("conflict", `${at}: seq is ${entry.seq}`);
    if (entry.sphere !== c.sphere) return fail("wrong_sphere", `${at}: sphere ${entry.sphere}`);
    if (entry.prev !== prev) return fail("conflict", `${at}: prev does not link to the entry before`);
    if ((await entryHash(entry)) !== entry.hash) return fail("conflict", `${at}: hash does not match its content`);
    const time = seconds(entry.recorded_at);
    if (time < lastTime) return fail("conflict", `${at}: recorded_at goes back in time`);
    lastTime = time;
    const env = entry.envelope;
    const problems = semanticProblems(env);
    if (problems.length) return fail("invalid_envelope", `${at}: ${problems.join("; ")}`);
    if (env.sphere !== c.sphere) return fail("wrong_sphere", `${at}: envelope for ${env.sphere}`);
    if (seconds(env.created_at) > time + CLOCK_SKEW_SECONDS) return fail("clock_skew", `${at}: created after it was recorded`);
    if (!(seconds(env.expires_at) > time)) return fail("expired", `${at}: recorded after it expired`);
    const key = Object.hasOwn(keys, env.key_id) ? keys[env.key_id] : undefined;
    if (!key || key.obi !== env.from || (await keyIdOrNull(key.public_key)) !== env.key_id) return fail("unknown_key", `${at}: ${env.key_id} is not a key of ${env.from}`);
    if (!keyValidAt(key, entry.seq)) return fail("unknown_key", `${at}: ${env.key_id} was not valid at seq ${entry.seq}`);
    if (!(await verifyEnvelopeSignature(env, key.public_key))) return fail("bad_signature", `${at}: the sender's signature does not verify`);
    if (byId.has(env.id)) return fail("duplicate", `${at}: ${env.id} is in the chain twice`);
    if (isReplyType(env.type)) {
      const request = byId.get(env.in_reply_to!);
      const earlier = [...byId.values()].filter((e) => isReplyType(e.type) && e.in_reply_to === env.in_reply_to);
      const problem = exchangeProblem(exchangeMessage(env), request && exchangeMessage(request), earlier.map(exchangeMessage));
      if (problem) return fail("bad_reply", `${at}: ${problem}`);
    }
    const followUp = isRequestType(env.type) ? followUpProblem(env, byId.get(env.body.follows as string)) : null;
    if (followUp) return fail("bad_reply", `${at}: ${followUp}`);
    byId.set(env.id, env);
    prev = entry.hash;
  }
  return OK;
}
