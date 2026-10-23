// Signing in with Google (spec/sphere-api.md section 3.1): what lets a Sphere be created without
// the operator token, and an invitation be for one Workspace's people. Google's ID token is checked
// here (RS256, Google's keys, its issuer, the client id, the nonce) the way Oby's control plane
// checks it (obi-ai-bot/oby, cloud/control-plane/src/signin.ts). Only the account (`google:<sub>`)
// and its Workspace (`hd`) are kept, never the email or the token.

import type { Deps, Env } from "./env.ts";
import { apiError, json, rateLimited, readJson } from "./http.ts";
import { constantTimeEqual, fromB64url, randomToken, sha256, sha256Hex } from "./protocol/crypto.ts";
import { utf8 } from "./protocol/json.ts";
import { schemaErrors } from "./protocol/schemas.ts";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
/// Google issues its tokens under either spelling.
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const SIGN_IN_SECONDS = 10 * 60;
const TOKEN_SKEW_SECONDS = 60;
const MAX_WAITING = 1000;
/// Where the browser goes back to: the client's own scheme.
const BACK = "obi-sphere://signin";

type Jwk = JsonWebKey & { kid?: string };

/// Google's keys, kept for a day and fetched again for a `kid` not among them, at most once a
/// minute. A fetch that fails keeps the keys there are.
export class KeyCache {
  private keys: Jwk[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private readonly fetchKeys: () => Promise<Jwk[]>;

  constructor(fetchKeys: () => Promise<Jwk[]> = googleKeys) {
    this.fetchKeys = fetchKeys;
  }

  async key(kid: string, nowS: number): Promise<Jwk | undefined> {
    const stale = nowS - this.fetchedAt > 24 * 3600;
    const unknown = !this.keys.some((k) => k.kid === kid) && nowS - this.fetchedAt > 60;
    if (stale || unknown) {
      try {
        const keys = await this.fetchKeys();
        if (Array.isArray(keys) && keys.length && keys.every((k) => k.kty === "RSA" && typeof k.kid === "string")) {
          this.keys = keys;
          this.fetchedAt = nowS;
        }
      } catch {
        console.warn("sign-in: Google's keys couldn't be read");
      }
    }
    return this.keys.find((k) => k.kid === kid);
  }
}

async function googleKeys(): Promise<Jwk[]> {
  const response = await fetch(KEYS_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { keys: Jwk[] }).keys;
}

const shared = new KeyCache();

const configured = (env: Env): string => {
  const client = env.GOOGLE_CLIENT_ID?.trim();
  if (!client) throw apiError("forbidden", "this Sphere server has no sign-in configured");
  return client;
};

/** CREATOR_WORKSPACES, lower case. */
export const creatorWorkspaces = (env: Env): string[] =>
  (env.CREATOR_WORKSPACES ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// POST /v0.1/signin/google

export async function startSignIn(request: Request, env: Env, deps: Deps): Promise<Response> {
  const client = configured(env);
  const body = await readJson(request);
  const errors = schemaErrors("signinRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match signin.request", errors);
  const ownerKey = (body as unknown as { owner_key: string }).owner_key;
  const nowS = Math.floor(deps.now() / 1000);
  await env.DB.prepare("DELETE FROM sign_ins WHERE expires_at_s <= ?1").bind(nowS).run();
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM sign_ins WHERE account IS NULL").first<{ n: number }>();
  if ((waiting?.n ?? 0) >= MAX_WAITING) throw rateLimited("too many sign-ins are waiting", 60);
  const state = randomToken(32);
  const nonce = randomToken(32);
  await env.DB.prepare("INSERT INTO sign_ins (state, owner_key, nonce_sha256, expires_at_s) VALUES (?1, ?2, ?3, ?4)")
    .bind(state, ownerKey, await sha256Hex(utf8(nonce)), nowS + SIGN_IN_SECONDS)
    .run();
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: client,
    redirect_uri: `${new URL(request.url).origin}/v0.1/signin/google/callback`,
    response_type: "id_token",
    response_mode: "form_post",
    scope: "openid email",
    prompt: "select_account",
    state,
    nonce,
  }).toString();
  return json(201, { url: url.toString(), state });
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/signin/google/callback: Google's form post.

export async function finishSignIn(request: Request, env: Env, deps: Deps): Promise<Response> {
  const client = configured(env);
  const back = (state: string, query: string) =>
    new Response(null, { status: 303, headers: { Location: `${BACK}?state=${encodeURIComponent(state)}&${query}`, "Cache-Control": "no-store" } });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw apiError("bad_request", "send Google's form");
  }
  const state = String(form.get("state") ?? "");
  const token = String(form.get("id_token") ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw apiError("bad_request", "that sign-in isn't this Sphere's");
  const nowS = Math.floor(deps.now() / 1000);
  const waiting = await env.DB.prepare("SELECT nonce_sha256 FROM sign_ins WHERE state = ?1 AND account IS NULL AND expires_at_s > ?2")
    .bind(state, nowS)
    .first<{ nonce_sha256: string }>();
  if (!waiting || !token) return back(state, "error=failed");
  let account: { sub: string; workspace: string | null };
  try {
    account = await verifyGoogleToken(token, deps.google ?? shared, client, waiting.nonce_sha256, nowS);
  } catch (e) {
    console.warn(`sign-in: ${e instanceof Error ? e.message : "refused"}`);
    return back(state, "error=failed");
  }
  const code = randomToken(32);
  await env.DB.prepare("UPDATE sign_ins SET account = ?2, workspace = ?3, code_sha256 = ?4 WHERE state = ?1 AND account IS NULL")
    .bind(state, `google:${account.sub}`, account.workspace, await sha256Hex(utf8(code)))
    .run();
  return back(state, `code=${code}`);
}

/// Google's ID token for `audience`: its `sub`, and its Workspace (`hd`), or null for a personal
/// account. Throws with a line for the log, never the token.
export async function verifyGoogleToken(token: string, cache: KeyCache, audience: string, nonceHash: string, nowS: number): Promise<{ sub: string; workspace: string | null }> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error("not a JWT");
  const [head, body, signature] = parts as [string, string, string];
  const header = decode(head) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("not RS256 with a kid");
  const jwk = await cache.key(header.kid, nowS);
  if (!jwk) throw new Error("signed by a key Google doesn't list");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(signature), utf8(`${head}.${body}`)))) throw new Error("bad signature");
  const claims = decode(body) as Record<string, unknown>;
  if (typeof claims.iss !== "string" || !ISSUERS.includes(claims.iss)) throw new Error("not issued by Google");
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw new Error("for another client");
  if (typeof claims.exp !== "number" || claims.exp <= nowS) throw new Error("expired");
  if (typeof claims.iat !== "number" || claims.iat > nowS + TOKEN_SKEW_SECONDS || claims.iat < nowS - SIGN_IN_SECONDS) throw new Error("issued at the wrong time");
  if (typeof claims.nonce !== "string" || (await sha256Hex(utf8(claims.nonce))) !== nonceHash) throw new Error("for another sign-in");
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(claims.sub)) throw new Error("no account");
  if (claims.email_verified !== true) throw new Error("no verified email");
  const hd = claims.hd === undefined ? null : typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
  if (hd !== null && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hd)) throw new Error("an hd that isn't a domain");
  return { sub: claims.sub, workspace: hd };
}

function decode(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(part)));
  } catch {
    throw new Error("unreadable");
  }
}

// ---------------------------------------------------------------------------------------------
// Using a sign-in (section 3.1, step 3)

export interface SignIn {
  state: string;
  account: string;
  workspace: string | null;
}

/** A finished, unexpired, unused sign-in started for `ownerKey` whose code matches; else 403 forbidden, the same for all. */
export async function checkSignIn(db: D1Database, given: { state: string; code: string }, ownerKey: string, nowS: number): Promise<SignIn> {
  const row = await db.prepare("SELECT * FROM sign_ins WHERE state = ?1").bind(given.state).first<{
    state: string; owner_key: string; expires_at_s: number; account: string | null; workspace: string | null; code_sha256: string | null; used: number;
  }>();
  const codeOk = constantTimeEqual(await sha256(utf8(given.code)), hexBytes(row?.code_sha256 ?? "0".repeat(64)));
  if (!row || !row.account || !row.code_sha256 || row.used || row.expires_at_s <= nowS || row.owner_key !== ownerKey || !codeOk) {
    throw apiError("forbidden", "the sign-in is unknown, unfinished, used, expired, or for another owner key");
  }
  return { state: row.state, account: row.account, workspace: row.workspace };
}

/** Uses the sign-in up, in the caller's batch: a second use fails the batch's check. */
export const useSignIn = (db: D1Database, state: string): D1PreparedStatement => db.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(state);

const hexBytes = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
