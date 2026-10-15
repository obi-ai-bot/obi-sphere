// Spheres (spec/sphere-api.md section 3) and health.

import { bearer, requireOperator } from "../auth.ts";
import { constraintFailure, requireSphere, unforeseen, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { keyIdOf } from "../protocol/crypto.ts";
import { PROTOCOL, timestamp } from "../protocol/envelope.ts";
import { ZERO_HASH } from "../protocol/chain.ts";
import { schemaErrors } from "../protocol/schemas.ts";

export const health = (): Response => json(200, { ok: true, protocol: PROTOCOL });

export const sphereJson = (s: SphereRow) => ({ sphere: s.id, name: s.name, protocol: PROTOCOL, admin_owner: s.admin_owner, created_at: s.created_at });

interface CreateSphere {
  sphere: string;
  name: string;
  admin: { owner: string; owner_key: string };
}

export async function createSphere(request: Request, env: Env, deps: Deps): Promise<Response> {
  await requireOperator(request, env);
  const body = await readJson(request);
  const errors = schemaErrors("createSphereRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match create-sphere.request", errors);
  const req = body as unknown as CreateSphere;
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
      env.DB.prepare("INSERT INTO owners (sphere, owner, owner_key, owner_key_id) VALUES (?1, ?2, ?3, ?4)").bind(req.sphere, req.admin.owner, req.admin.owner_key, ownerKeyId),
    ]);
  } catch (e) {
    if (constraintFailure(e) === "UNIQUE constraint failed: spheres.id") throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
    unforeseen(e, "creating a Sphere");
  }
  return json(201, { sphere: req.sphere, name: req.name, protocol: PROTOCOL, admin_owner: req.admin.owner, created_at: createdAt });
}

export async function getSphereRoute(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  await bearer(request, env, sphere, Math.floor(deps.now() / 1000));
  return json(200, sphereJson(sphere));
}
