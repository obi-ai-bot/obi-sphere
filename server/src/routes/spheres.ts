// Spheres (spec/sphere-api.md section 3) and health.

import { bearer, requireOperator } from "../auth.ts";
import { constraintFailure, getSphere, unforeseen, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { keyIdOf } from "../protocol/crypto.ts";
import { PROTOCOL, timestamp } from "../protocol/envelope.ts";
import { ZERO_HASH } from "../protocol/chain.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { checkSignIn, creatorWorkspaces, useSignIn, type SignIn } from "../signin.ts";

export const health = (): Response => json(200, { ok: true, protocol: PROTOCOL });

/**
 * `GET /join`: where an invite link (`https://<sphere server>/join#…`, everything after `#` staying
 * in the browser) lands when someone opens it in a browser. It says what to do with it, and reads
 * nothing: no script, and the part after `#` never reaches the server.
 */
export const joinPage = (): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Join an Obysphere</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
<h1>You're invited to an Obysphere</h1>
<p>Copy this page's address from the address bar. Then, in Oby on your Mac, open Settings › Obysphere, paste it under Join an Obysphere, and choose Open.</p>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Referrer-Policy": "no-referrer" } },
  );

export const sphereJson = (s: SphereRow) => ({ sphere: s.id, name: s.name, protocol: PROTOCOL, admin_owner: s.admin_owner, created_at: s.created_at });

/** Sphere ids taken from the start, Sangam's TAKEN list (sphere-api.md section 3): nobody creates them. */
export const RESERVED_SPHERES = new Set(["avenga", "tetrix", "oby", "app", "www", "admin", "api", "help", "acme"]);

/** How many Spheres one account may be the admin owner of (`SPHERE_CREATE_LIMIT`, section 3, "How many"). */
const createLimit = (env: Env): number => {
  const n = Number(env.SPHERE_CREATE_LIMIT ?? "");
  return env.SPHERE_CREATE_LIMIT && Number.isInteger(n) && n >= 0 ? n : 3;
};

interface CreateSphere {
  sphere: string;
  name: string;
  admin: { owner: string; owner_key: string };
  signin?: { state: string; code: string };
}

export async function createSphere(request: Request, env: Env, deps: Deps): Promise<Response> {
  // The operator, or, with no Authorization at all, a body with a sign-in (section 3.1) from a
  // creator Workspace. Anything else is the operator's answer (401, or 403 with none configured).
  const operator = request.headers.has("Authorization");
  if (operator) await requireOperator(request, env);
  const body = await readJson(request).catch(async (e) => {
    if (!operator) await requireOperator(request, env);
    throw e;
  });
  const signedIn = !operator && typeof body === "object" && body !== null && !Array.isArray(body) && "signin" in body;
  if (!operator && !signedIn) await requireOperator(request, env);
  const errors = schemaErrors("createSphereRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match create-sphere.request", errors);
  const req = body as unknown as CreateSphere;
  let signin: SignIn | null = null;
  if (signedIn) {
    signin = await checkSignIn(env.DB, req.signin!, req.admin.owner_key, Math.floor(deps.now() / 1000));
    if (!signin.workspace || !creatorWorkspaces(env).includes(signin.workspace)) throw apiError("forbidden", "this account's Workspace may not create Spheres here");
    // ponytail: count, then insert; two creates racing can pass the limit by one each.
    const admin = await env.DB.prepare("SELECT COUNT(*) AS n FROM spheres s JOIN owners o ON o.sphere = s.id AND o.owner = s.admin_owner WHERE o.account = ?1")
      .bind(signin.account).first<{ n: number }>();
    if ((admin?.n ?? 0) >= createLimit(env)) throw apiError("rate_limited", "this account is the admin of as many Spheres as this server allows");
  }
  if (RESERVED_SPHERES.has(req.sphere)) throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
  let ownerKeyId: string;
  try {
    ownerKeyId = await keyIdOf(req.admin.owner_key);
  } catch {
    throw apiError("bad_request", "admin.owner_key is not an Ed25519 public key");
  }
  const createdAt = timestamp(deps.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO spheres (id, name, admin_owner, created_at, policy_version, policy_rules, policy_updated_at, head_seq, head_hash, head_recorded_at_s)
         VALUES (?1, ?2, ?3, ?4, 0, '[]', ?4, 0, ?5, NULL)`,
      ).bind(req.sphere, req.name, req.admin.owner, createdAt, ZERO_HASH),
      env.DB.prepare("INSERT INTO owners (sphere, owner, owner_key, owner_key_id, account) VALUES (?1, ?2, ?3, ?4, ?5)").bind(req.sphere, req.admin.owner, req.admin.owner_key, ownerKeyId, signin?.account ?? null),
      ...(signin ? [useSignIn(env.DB, signin.state)] : []),
    ]);
  } catch (e) {
    if (constraintFailure(e) === "UNIQUE constraint failed: spheres.id") throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
    unforeseen(e, "creating a Sphere");
  }
  return json(201, { sphere: req.sphere, name: req.name, protocol: PROTOCOL, admin_owner: req.admin.owner, created_at: createdAt });
}

export async function getSphereRoute(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  // A reserved id with no Sphere answers as a Sphere does to a caller without its token: 401, taken
  // (section 3). No token is for a Sphere that doesn't exist, so the stand-in never lets one through.
  const sphere = (await getSphere(env.DB, sphereId)) ?? (RESERVED_SPHERES.has(sphereId) ? ({ id: sphereId } as SphereRow) : null);
  if (!sphere) throw apiError("not_found", `no Sphere ${sphereId}`);
  await bearer(request, env, sphere, Math.floor(deps.now() / 1000));
  return json(200, sphereJson(sphere));
}
