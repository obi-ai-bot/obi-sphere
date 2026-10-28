// Binding to the server (identity.md sections 4.1 and 4.6): assertions that name the server's URL,
// and tokens bound to a key of this process (DPoP), only with an Obysphere that lists them; and a
// sign-in's return_to (sphere-api.md section 3.1).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DpopKey, Member, Owner, SigningKey, SphereApi, b64url, fromB64url, parseJwt, sha256, timestamp, utf8, verifyEd25519 } from "../src/index.ts";

const BASE = "https://sphere.example.com";
const SPHERE = "team";

function decodeJwt(jwt: string) {
  const [h, c] = jwt.split(".") as [string, string, string];
  return { header: JSON.parse(new TextDecoder().decode(fromB64url(h))), claims: JSON.parse(new TextDecoder().decode(fromB64url(c))) };
}

test("a DPoP proof is a dpop+jwt signed by its key, for one method and URL, with the token's hash", async () => {
  const key = await DpopKey.generate();
  const proof = await key.proof("post", "https://sphere.example.com/v0.1/spheres/team/messages?x=1", "tok-123");
  const { header, claims } = decodeJwt(proof);
  assert.deepEqual(header, { alg: "EdDSA", jwk: key.jwk, typ: "dpop+jwt" });
  assert.equal(claims.htm, "POST");
  assert.equal(claims.htu, "https://sphere.example.com/v0.1/spheres/team/messages");
  assert.equal(claims.ath, b64url(await sha256(utf8("tok-123"))));
  assert.ok(Number.isInteger(claims.iat) && typeof claims.jti === "string");
  const [h, c, s] = proof.split(".") as [string, string, string];
  assert.ok(await verifyEd25519(key.jwk.x, utf8(`${h}.${c}`), s));
  assert.ok(!JSON.stringify(header).includes('"d"'));
  const other = await key.proof("POST", "https://sphere.example.com/v0.1/oauth/token");
  assert.equal(decodeJwt(other).claims.ath, undefined);
  assert.notEqual(decodeJwt(other).claims.jti, claims.jti);
});

async function fake(features: string[]) {
  const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    seen.push({ path: p, headers, body: String(init.body ?? "") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (p === "/v0.1/features") return json(200, { features });
    if (p === "/v0.1/oauth/token") return json(200, { access_token: "t".repeat(40), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: headers.DPoP ? "DPoP" : "Bearer", expires_in: 3600, scope: "receive" });
    if (p.endsWith("/deliveries")) return json(200, { deliveries: [] });
    if (p === "/v0.1/signin/google") return json(201, { url: "https://accounts.example.com/auth?x=1", state: "s".repeat(43) });
    return json(404, { error: { code: "not_found", message: "no" } });
  };
  const owner = await Owner.generate("ada");
  const key = await SigningKey.generate();
  const m = new Member({ api: new SphereApi(BASE, { fetch }), sphere: SPHERE, obi: "ada-agent", owner: "ada", key, delegation: await owner.delegation(SPHERE, "ada-agent") });
  return { m, seen, fetch };
}

test("with sphere_url_aud and dpop, the actor assertion names the server and the token is bound to a key", async () => {
  const { m, seen } = await fake(["dpop", "sphere_url_aud"]);
  await m.receive();
  const token = seen.find((s) => s.path === "/v0.1/oauth/token")!;
  const actor = new URLSearchParams(token.body).get("actor_token")!;
  assert.equal(parseJwt(actor)!.claims.aud, `${BASE}/v0.1/spheres/${SPHERE}`);
  assert.equal(decodeJwt(token.headers.DPoP!).claims.htu, `${BASE}/v0.1/oauth/token`);
  const call = seen.find((s) => s.path.endsWith("/deliveries"))!;
  assert.equal(call.headers.Authorization, `DPoP ${"t".repeat(40)}`);
  assert.equal(decodeJwt(call.headers.DPoP!).claims.ath, b64url(await sha256(utf8("t".repeat(40)))));
});

test("without them, the assertion names the Sphere alone and the token stays a bearer token", async () => {
  const { m, seen } = await fake([]);
  await m.receive();
  const token = seen.find((s) => s.path === "/v0.1/oauth/token")!;
  assert.equal(parseJwt(new URLSearchParams(token.body).get("actor_token")!)!.claims.aud, `obi-sphere:${SPHERE}`);
  assert.equal(token.headers.DPoP, undefined);
  assert.equal(seen.find((s) => s.path.endsWith("/deliveries"))!.headers.Authorization, `Bearer ${"t".repeat(40)}`);
});

test("a delegation can name the server, and a sign-in carries return_to", async () => {
  const owner = await Owner.generate("ada");
  const d = await owner.delegation(SPHERE, "ada-agent", { aud: `${BASE}/v0.1/spheres/${SPHERE}` });
  assert.equal(parseJwt(d)!.claims.aud, `${BASE}/v0.1/spheres/${SPHERE}`);
  const { fetch, seen } = await fake(["signin_providers"]);
  const api = new SphereApi(BASE, { fetch });
  const started = await api.signinStart("google", owner.key.publicKey, "http://127.0.0.1:41234/signin");
  assert.equal(started.state.length, 43);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { owner_key: owner.key.publicKey, return_to: "http://127.0.0.1:41234/signin" });
  assert.throws(() => api.signinStart("Google!", owner.key.publicKey));
  void timestamp;
});
