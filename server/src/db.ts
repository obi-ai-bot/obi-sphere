// D1 access: the rows, how a member is shown, and guarded writes.
//
// A guarded write is one D1 batch (one transaction) that first moves the Sphere's `rev` on, but
// only if it is still the value the writer read, and then makes its change. When another writer
// got there first, the batch fails as a whole and nothing changes; the caller reads again and
// redoes its checks. So every change that a send depends on (the chain's head, members, keys,
// the policy) is checked and made as if alone.

import { INTERNAL_MESSAGE, apiError, rateLimited } from "./http.ts";
import type { AgentCard } from "./protocol/card.ts";
import { uuid } from "./protocol/crypto.ts";

export interface SphereRow {
  id: string;
  name: string;
  admin_owner: string;
  created_at: string;
  policy_version: number;
  policy_rules: string;
  policy_updated_at: string;
  head_seq: number;
  head_hash: string;
  head_recorded_at_s: number | null;
  rev: number;
}

export interface OwnerRow {
  sphere: string;
  owner: string;
  owner_key: string;
  owner_key_id: string;
}

export interface MemberRow {
  sphere: string;
  obi: string;
  owner: string;
  status: "active" | "revoked";
  joined_at: string;
  revoked_at: string | null;
  card: string;
  card_seq: number;
}

export interface KeyRow {
  sphere: string;
  key_id: string;
  obi: string;
  public_key: string;
  valid_from_seq: number;
  valid_until_seq: number | null;
}

export interface PolicyRule {
  id: string;
  from_owner: string;
  to_owner: string;
  actions: string[];
  repos: string[];
}

export const getSphere = (db: D1Database, id: string): Promise<SphereRow | null> =>
  db.prepare("SELECT * FROM spheres WHERE id = ?1").bind(id).first<SphereRow>();

export async function requireSphere(db: D1Database, id: string): Promise<SphereRow> {
  const sphere = await getSphere(db, id);
  if (!sphere) throw apiError("not_found", `no Sphere ${id}`);
  return sphere;
}

export const getOwner = (db: D1Database, sphere: string, owner: string): Promise<OwnerRow | null> =>
  db.prepare("SELECT * FROM owners WHERE sphere = ?1 AND owner = ?2").bind(sphere, owner).first<OwnerRow>();

export const getMember = (db: D1Database, sphere: string, obi: string): Promise<MemberRow | null> =>
  db.prepare("SELECT * FROM members WHERE sphere = ?1 AND obi = ?2").bind(sphere, obi).first<MemberRow>();

export async function getKeys(db: D1Database, sphere: string, obi: string): Promise<KeyRow[]> {
  const r = await db.prepare("SELECT * FROM member_keys WHERE sphere = ?1 AND obi = ?2 ORDER BY valid_from_seq, rowid").bind(sphere, obi).all<KeyRow>();
  return r.results;
}

/** The member as the API answers it (member.schema.json): `revoked_at` only once revoked. */
export function memberJson(member: MemberRow, owner: OwnerRow, keys: KeyRow[]): Record<string, unknown> {
  return {
    obi: member.obi,
    owner: member.owner,
    owner_key: owner.owner_key,
    owner_key_id: owner.owner_key_id,
    status: member.status,
    joined_at: member.joined_at,
    ...(member.status === "revoked" && member.revoked_at ? { revoked_at: member.revoked_at } : {}),
    card: JSON.parse(member.card) as AgentCard,
    keys: keys.map((k) => ({ key_id: k.key_id, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq })),
  };
}

export async function loadMemberJson(db: D1Database, sphere: string, obi: string): Promise<Record<string, unknown>> {
  const member = await getMember(db, sphere, obi);
  if (!member) throw apiError("not_found", `no member ${obi}`);
  const owner = await getOwner(db, sphere, member.owner);
  if (!owner) throw apiError("internal", "the member's owner has no bound key");
  return memberJson(member, owner, await getKeys(db, sphere, obi));
}

/** D1's message when a guarded write lost its turn: the write guard's named CHECK (migrations/). */
const LOST_TURN = /CHECK constraint failed: lost_turn\b/;

/**
 * What a failed statement says about the schema, when it was a constraint (`UNIQUE constraint
 * failed: deliveries.id`): only table, column and constraint names, never a value a client sent,
 * so it is safe for the Worker's log. Null for any other failure.
 */
export function constraintFailure(e: unknown): string | null {
  const m = /\b(?:UNIQUE|CHECK|NOT NULL|FOREIGN KEY|PRIMARY KEY) constraint failed: [A-Za-z0-9_.,=<>!()' ]{1,200}/.exec(String((e as Error)?.message ?? e));
  return m ? m[0].trim() : null;
}

/**
 * Logs a constraint failure that no check foresaw (a schema mistake, a duplicate generated id)
 * and answers `500 internal`. Any other failure goes on to the router, which answers the same.
 */
export function unforeseen(e: unknown, where: string): never {
  const reason = constraintFailure(e);
  if (reason === null) throw e;
  console.error(`sphere: ${where} failed, nothing was recorded: ${reason}`);
  throw apiError("internal", INTERNAL_MESSAGE);
}

/**
 * Runs `statements` in one transaction if the Sphere's `rev` is still `rev`, moving it on.
 * Answers their results, or null when another write came first: the write guard's `lost_turn`
 * CHECK failed and nothing was changed. Only that is contention, worth reading again and
 * retrying. Any other failure, a constraint included, is the Sphere's own fault: it is logged
 * and answered `500 internal` at once, never retried into a `429`.
 */
export async function guardedWrite(db: D1Database, sphere: string, rev: number, statements: D1PreparedStatement[]): Promise<D1Result[] | null> {
  const writer = uuid();
  try {
    const results = await db.batch([
      db.prepare("UPDATE spheres SET rev = rev + 1, writer = ?1 WHERE id = ?2 AND rev = ?3").bind(writer, sphere, rev),
      db.prepare("INSERT INTO write_guard (ok) SELECT COUNT(*) FROM spheres WHERE id = ?1 AND writer = ?2").bind(sphere, writer),
      ...statements,
      db.prepare("DELETE FROM write_guard"),
    ]);
    return results.slice(2, 2 + statements.length);
  } catch (e) {
    if (LOST_TURN.test(String((e as Error)?.message ?? e))) return null;
    return unforeseen(e, "a guarded write");
  }
}

/** How long a write keeps retrying against other writes to the same Sphere, in milliseconds. */
export const RETRY_BUDGET_MS = 20_000;

/** The message of the `429 rate_limited` a write answers when concurrent writes kept it out. */
export const CONTENTION_MESSAGE = "the record could not be made because of concurrent writes to this Sphere; nothing was recorded";

/**
 * Retries `attempt` (which reads, checks, and makes a guarded write) until its write lands.
 *
 * Every write to a Sphere moves its one `rev` on, so concurrent writers to one Sphere take turns:
 * each turn one wins and the others read again. The losers wait a random time below a ceiling
 * that doubles with each loss (exponential backoff with full jitter), so a crowd of writers
 * spreads itself out instead of all reading and writing again at once, which would slow the
 * winner of each turn down. When the budget runs out the record could not be made because of
 * concurrent writes: the answer is `429 rate_limited` with `Retry-After` (sphere-api.md section
 * 1), nothing was recorded, and the caller learns when to try again instead of retrying blindly.
 * Every other failure is not contention and passes straight through (a check's own error, or
 * `500 internal`).
 */
export async function withRetries<T>(attempt: () => Promise<T | null>, budgetMs = RETRY_BUDGET_MS): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (let i = 0; ; i++) {
    const result = await attempt();
    if (result !== null) return result;
    if (Date.now() >= deadline) break;
    const ceiling = Math.min(2000, 4 * 2 ** Math.min(i, 9));
    await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * ceiling)));
  }
  throw rateLimited(CONTENTION_MESSAGE, 1);
}
