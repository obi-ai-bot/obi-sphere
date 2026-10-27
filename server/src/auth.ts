// Who is calling: the operator (creating Spheres) or the holder of an access token
// (spec/sphere-api.md section 1, "Authentication"; spec/identity.md section 4).

import { apiError } from "./http.ts";
import type { Env } from "./env.ts";
import type { SphereRow } from "./db.ts";
import { constantTimeEqual, sha256Hex } from "./protocol/crypto.ts";
import { utf8 } from "./protocol/json.ts";

/** Every scope, in the canonical order the Sphere writes them in (identity.md 4.2). */
export const SCOPES = ["admin", "send:review_request", "send:question", "send:handoff", "send:run_request", "send:share_offer", "send:introduction", "reply", "receive", "directory:read", "audit:read"] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

/** Scopes as the Sphere writes them: each once, one space apart, in the canonical order. */
export const canonicalScope = (scopes: Iterable<string>): string => {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s)).join(" ");
};

export interface Caller {
  /** The Sphere the token is for. */
  sphere: string;
  /** The owner the token is for. */
  subject: string;
  /** The Obi acting for the owner, or null for an owner's own token. */
  actor: string | null;
  scopes: Set<string>;
}

const BEARER = /^Bearer ([A-Za-z0-9._~-]{1,512})$/;

export const tokenHash = (token: string): Promise<string> => sha256Hex(utf8(token));

/**
 * The caller behind `Authorization: Bearer <access token>`, for `sphere` (which exists), or for
 * whichever Sphere the token is for when `sphere` is null (the phone relay's paths name none). An
 * unknown, expired or revoked token, one for another Sphere, or one whose Obi was revoked, is
 * 401 unauthorized.
 */
export async function bearer(request: Request, env: Env, sphere: SphereRow | null, nowS: number): Promise<Caller> {
  const m = BEARER.exec(request.headers.get("Authorization") ?? "");
  if (!m) throw apiError("unauthorized", "an access token is needed: Authorization: Bearer <token>");
  const row = await env.DB.prepare(
    `SELECT t.subject, t.actor, t.scope, t.expires_at_s, t.revoked, t.sphere, m.status AS actor_status
       FROM tokens t LEFT JOIN members m ON m.sphere = t.sphere AND m.obi = t.actor
      WHERE t.sha256 = ?1`,
  )
    .bind(await tokenHash(m[1]!))
    .first<{ subject: string; actor: string | null; scope: string; expires_at_s: number; revoked: number; sphere: string; actor_status: string | null }>();
  if (!row || row.revoked || row.expires_at_s <= nowS) throw apiError("unauthorized", "the access token is unknown, expired or revoked");
  if (sphere && row.sphere !== sphere.id) throw apiError("unauthorized", "the access token is for another Sphere");
  if (row.actor !== null && row.actor_status !== "active") throw apiError("unauthorized", "the token's Obi is no longer an active member");
  return { sphere: row.sphere, subject: row.subject, actor: row.actor, scopes: new Set(row.scope.split(" ")) };
}

export function requireScope(caller: Caller, ...anyOf: Scope[]): void {
  if (!anyOf.some((s) => caller.scopes.has(s))) throw apiError("insufficient_scope", `this call needs the scope ${anyOf.join(" or ")}`);
}

/** An Obi's token (with an actor); an owner's own token is 403 forbidden. */
export function requireActor(caller: Caller): string {
  if (caller.actor === null) throw apiError("forbidden", "this call needs an Obi's token, not an owner's own");
  return caller.actor;
}

/** An owner's own token (no actor); an Obi's token is 403 forbidden. */
export function requireOwnerToken(caller: Caller): void {
  if (caller.actor !== null) throw apiError("forbidden", "this call needs an owner's own token, not an Obi's");
}

/**
 * The operator: `Authorization: Bearer <SPHERE_OPERATOR_TOKEN>`, compared in constant time and
 * never logged; or, on a self-hosted Sphere that keeps only its hash, the token whose SHA-256 is
 * SPHERE_OPERATOR_TOKEN_SHA256. With neither configured (or a token under 32 characters), 403 forbidden.
 */
export async function requireOperator(request: Request, env: Env): Promise<void> {
  const configured = env.SPHERE_OPERATOR_TOKEN;
  const want = typeof configured === "string" && configured.length >= 32 ? await sha256Hex(utf8(configured)) : env.SPHERE_OPERATOR_TOKEN_SHA256;
  if (!want) throw apiError("forbidden", "this Sphere server has no operator token configured");
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  const given = m ? m[1]! : "";
  if (!constantTimeEqual(utf8(await sha256Hex(utf8(given))), utf8(want))) throw apiError("unauthorized", "the operator token is missing or wrong");
}
