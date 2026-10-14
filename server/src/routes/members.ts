// Invitations, pairing and the directory (spec/sphere-api.md section 4; spec/identity.md section 3).

import { bearer, requireActor, requireOwnerToken, requireScope } from "../auth.ts";
import {
  getKeys, getMember, getOwner, guardedWrite, loadMemberJson, memberJson, requireSphere, withRetries, type KeyRow, type MemberRow,
  type OwnerRow,
} from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { cardParams, verifyCard, type AgentCard } from "../protocol/card.ts";
import { constantTimeEqual, keyIdOf, randomToken, sha256, sha256Hex, uuid } from "../protocol/crypto.ts";
import { timestamp } from "../protocol/envelope.ts";
import { canonicalize, utf8 } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** Whether `obi` is or was a member, or another member uses `keyId`. */
const obiTaken = async (db: D1Database, sphere: string, obi: string) => (await getMember(db, sphere, obi)) !== null;
const keyTaken = async (db: D1Database, sphere: string, keyId: string) =>
  (await db.prepare("SELECT 1 AS taken FROM member_keys WHERE sphere = ?1 AND key_id = ?2").bind(sphere, keyId).first()) !== null;

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations

export async function invite(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  const body = await readJson(request);
  const errors = schemaErrors("invitationRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match invitation.request", errors);
  const req = body as unknown as { owner: string; obi: string; expires_in: number };
  if (await obiTaken(env.DB, sphere.id, req.obi)) throw apiError("conflict", `${req.obi} is or was a member: Obi ids are never reused`);
  const id = uuid();
  const secret = randomToken(32);
  const expiresAt = nowS(deps) + req.expires_in;
  await env.DB.prepare("INSERT INTO invitations (id, sphere, owner, obi, secret_sha256, expires_at_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, sphere.id, req.owner, req.obi, await sha256Hex(utf8(secret)), expiresAt)
    .run();
  return json(201, { invitation_id: id, sphere: sphere.id, owner: req.owner, obi: req.obi, secret, expires_at: timestamp(expiresAt) });
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/redeem

interface InvitationRow {
  id: string;
  sphere: string;
  owner: string;
  obi: string;
  secret_sha256: string;
  expires_at_s: number;
  used_at: string | null;
}

const DUMMY_HASH = "0".repeat(64);

export async function redeem(request: Request, env: Env, deps: Deps, sphereId: string, invitationId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  // 1. The body.
  const body = await readJson(request);
  const errors = schemaErrors("redeemRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match redeem.request", errors);
  const req = body as unknown as { secret: string; owner_key: string; card: AgentCard };
  const givenHash = await sha256(utf8(req.secret));

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const now = nowS(deps);
    // 2. The invitation: every way it fails answers the same.
    const inv = await env.DB.prepare("SELECT * FROM invitations WHERE id = ?1 AND sphere = ?2").bind(invitationId, sphere.id).first<InvitationRow>();
    const stored = fromHex(inv?.secret_sha256 ?? DUMMY_HASH);
    const secretOk = constantTimeEqual(givenHash, stored);
    if (!inv || inv.used_at !== null || inv.expires_at_s <= now || !secretOk) throw apiError("invitation_invalid", "the invitation is unknown, used, expired, or the secret is wrong");
    // 3 and 4. The card, and that it is the invitation's.
    const verdict = await verifyCard(req.card, { now });
    if (!verdict.ok) throw apiError("card_invalid", verdict.message);
    const p = cardParams(req.card);
    if (p.sphere !== sphere.id || p.obi_id !== inv.obi || p.owner !== inv.owner) throw apiError("card_invalid", "the card's sphere, obi_id or owner is not the invitation's");
    if (p.owner_key !== req.owner_key) throw apiError("card_invalid", "the card's owner_key is not the body's owner_key");
    // 5. The owner's bound key.
    const bound = await getOwner(env.DB, sphere.id, inv.owner);
    if (bound && bound.owner_key !== req.owner_key) throw apiError("forbidden", "the owner already has another bound key");
    // 6. Ids are never reused.
    if (await keyTaken(env.DB, sphere.id, p.key_id)) throw apiError("conflict", "another member uses this key_id");
    if (await obiTaken(env.DB, sphere.id, inv.obi)) throw apiError("conflict", `${inv.obi} is or was a member: Obi ids are never reused`);

    const joinedAt = timestamp(now);
    const owner: OwnerRow = bound ?? { sphere: sphere.id, owner: inv.owner, owner_key: req.owner_key, owner_key_id: await keyIdOf(req.owner_key) };
    const member: MemberRow = { sphere: sphere.id, obi: inv.obi, owner: inv.owner, status: "active", joined_at: joinedAt, revoked_at: null, card: canonicalize(req.card), card_seq: p.card_seq };
    const key: KeyRow = { sphere: sphere.id, key_id: p.key_id, obi: inv.obi, public_key: p.public_key, valid_from_seq: sphere.head_seq + 1, valid_until_seq: null };
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("UPDATE invitations SET used_at = ?1 WHERE id = ?2 AND used_at IS NULL").bind(joinedAt, inv.id),
      env.DB.prepare("INSERT OR IGNORE INTO owners (sphere, owner, owner_key, owner_key_id) VALUES (?1, ?2, ?3, ?4)").bind(owner.sphere, owner.owner, owner.owner_key, owner.owner_key_id),
      env.DB.prepare("INSERT INTO members (sphere, obi, owner, status, joined_at, card, card_seq) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6)").bind(
        member.sphere, member.obi, member.owner, member.joined_at, member.card, member.card_seq,
      ),
      env.DB.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(key.sphere, key.key_id, key.obi, key.public_key, key.valid_from_seq),
    ]);
    if (!written) return null;
    return json(201, memberJson(member, owner, [key]));
  }, deps.retryBudgetMs);
}

const fromHex = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

// ---------------------------------------------------------------------------------------------
// GET /members, GET /members/{obi}

export async function listMembers(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read");
  // One batch: a consistent snapshot of members, owners and keys.
  const [members, owners, keys] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM members WHERE sphere = ?1 ORDER BY joined_at, obi").bind(sphere.id),
    env.DB.prepare("SELECT * FROM owners WHERE sphere = ?1").bind(sphere.id),
    env.DB.prepare("SELECT * FROM member_keys WHERE sphere = ?1 ORDER BY valid_from_seq, rowid").bind(sphere.id),
  ]);
  const ownerBy = new Map((owners!.results as unknown as OwnerRow[]).map((o) => [o.owner, o]));
  const keysBy = new Map<string, KeyRow[]>();
  for (const k of keys!.results as unknown as KeyRow[]) keysBy.set(k.obi, [...(keysBy.get(k.obi) ?? []), k]);
  const list = (members!.results as unknown as MemberRow[]).map((m) => memberJson(m, ownerBy.get(m.owner)!, keysBy.get(m.obi) ?? []));
  return json(200, { sphere: sphere.id, members: list });
}

export async function getMemberRoute(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read");
  return json(200, await loadMemberJson(env.DB, sphere.id, obi));
}

// ---------------------------------------------------------------------------------------------
// PUT /members/{obi}/card: a new card, maybe a new key (identity.md section 3, "Rotating").

export async function updateCard(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  if (!(await getMember(env.DB, sphere0.id, obi))) throw apiError("not_found", `no member ${obi}`);
  if (requireActor(caller) !== obi) throw apiError("forbidden", `only ${obi}'s own token may change its card`);
  const body = await readJson(request);
  const errors = schemaErrors("cardUpdateRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match card-update.request", errors);
  const card = (body as unknown as { card: AgentCard }).card;

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const member = (await getMember(env.DB, sphere.id, obi))!;
    const owner = (await getOwner(env.DB, sphere.id, member.owner))!;
    const verdict = await verifyCard(card, { now: nowS(deps), bound_owner_key: owner.owner_key });
    if (!verdict.ok) throw apiError("card_invalid", verdict.message);
    const p = cardParams(card);
    if (p.sphere !== sphere.id || p.obi_id !== obi || p.owner !== member.owner || p.owner_key !== owner.owner_key) {
      throw apiError("card_invalid", "a new card keeps the sphere, obi_id, owner and bound owner_key");
    }
    if (p.card_seq <= member.card_seq) throw apiError("conflict", `card_seq must be above ${member.card_seq}`);
    const keys = await getKeys(env.DB, sphere.id, obi);
    const current = keys.find((k) => k.valid_until_seq === null);
    const rotate = current?.key_id !== p.key_id;
    if (rotate && (await keyTaken(env.DB, sphere.id, p.key_id))) throw apiError("conflict", "this key_id is in use");
    const h = sphere.head_seq;
    const statements = [env.DB.prepare("UPDATE members SET card = ?1, card_seq = ?2 WHERE sphere = ?3 AND obi = ?4").bind(canonicalize(card), p.card_seq, sphere.id, obi)];
    let newKeys = keys;
    if (rotate) {
      statements.push(
        env.DB.prepare("UPDATE member_keys SET valid_until_seq = ?1 WHERE sphere = ?2 AND obi = ?3 AND valid_until_seq IS NULL").bind(h, sphere.id, obi),
        env.DB.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(sphere.id, p.key_id, obi, p.public_key, h + 1),
        env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND actor = ?2").bind(sphere.id, obi),
      );
      newKeys = [
        ...keys.map((k) => (k.valid_until_seq === null ? { ...k, valid_until_seq: h } : k)),
        { sphere: sphere.id, key_id: p.key_id, obi, public_key: p.public_key, valid_from_seq: h + 1, valid_until_seq: null },
      ];
    }
    if (!(await guardedWrite(env.DB, sphere.id, sphere.rev, statements))) return null;
    return json(200, memberJson({ ...member, card: canonicalize(card), card_seq: p.card_seq }, owner, newKeys));
  }, deps.retryBudgetMs);
}

// ---------------------------------------------------------------------------------------------
// DELETE /members/{obi}: revoke.

export async function revoke(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  requireOwnerToken(caller);
  const member0 = await getMember(env.DB, sphere0.id, obi);
  if (!member0) throw apiError("not_found", `no member ${obi}`);
  if (!caller.scopes.has("admin") && caller.subject !== member0.owner) throw apiError("forbidden", "only the admin or the Obi's own owner may revoke it");

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const member = (await getMember(env.DB, sphere.id, obi))!;
    if (member.status === "revoked") return json(200, await loadMemberJson(env.DB, sphere.id, obi));
    const revokedAt = timestamp(nowS(deps));
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("UPDATE member_keys SET valid_until_seq = ?1 WHERE sphere = ?2 AND obi = ?3 AND valid_until_seq IS NULL").bind(sphere.head_seq, sphere.id, obi),
      env.DB.prepare("UPDATE members SET status = 'revoked', revoked_at = ?1 WHERE sphere = ?2 AND obi = ?3").bind(revokedAt, sphere.id, obi),
      env.DB.prepare("UPDATE deliveries SET state = 'dropped' WHERE sphere = ?1 AND to_obi = ?2 AND state = 'queued'").bind(sphere.id, obi),
      env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND actor = ?2").bind(sphere.id, obi),
    ]);
    if (!written) return null;
    return json(200, await loadMemberJson(env.DB, sphere.id, obi));
  }, deps.retryBudgetMs);
}
