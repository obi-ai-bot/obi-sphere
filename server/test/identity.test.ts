// Tokens bound to a key (DPoP, spec/identity.md section 4.6), and assertions bound to one server
// (an `aud` that is the Obysphere's own URL, section 4.1).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { thumbprint } from "../src/dpop";
import { b64url, sha256 } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, FORM, JWT_TYPE, TOKEN_EXCHANGE, World, expectSchema, form, signJwt, team } from "./helpers";

/** A client's DPoP key, made for this test: Ed25519 or P-256. */
async function dpopKey(alg: "EdDSA" | "ES256" = "EdDSA") {
  const pair = (await crypto.subtle.generateKey(alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk = alg === "EdDSA" ? { kty, crv, x } : { kty, crv, x, y };
  /** A proof for a `method` call to `url` (and `token`, past the token endpoint); `o` changes what it says. */
  const proof = async (method: string, url: string, token?: string, o: { claims?: Record<string, unknown>; header?: Record<string, unknown> } = {}) => {
    const header = { typ: "dpop+jwt", alg, jwk, ...o.header };
    const claims = { jti: crypto.randomUUID(), htm: method, htu: url, iat: Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000), ...(token ? { ath: b64url(await sha256(utf8(token))) } : {}), ...o.claims };
    const input = `${b64url(utf8(JSON.stringify(header)))}.${b64url(utf8(JSON.stringify(claims)))}`;
    const sig = await crypto.subtle.sign(alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, utf8(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, proof, jkt: await thumbprint(jwk) };
}

const TOKEN_URL = `${BASE}/v0.1/oauth/token`;

/** The admin's own token, bound to `key` with a proof at the token endpoint. */
async function boundOwnerToken(w: World, key: Awaited<ReturnType<typeof dpopKey>>, proof?: string) {
  const owner = await w.ownerKey("wellington");
  const claims = { iss: "wellington", sub: "wellington", aud: `obi-sphere:${w.sphere}`, iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), scope: "admin directory:read audit:read" };
  return w.call("POST", "/v0.1/oauth/token", {
    raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await signJwt(claims, owner), subject_token_type: JWT_TYPE }),
    headers: { ...FORM, DPoP: proof ?? (await key.proof("POST", TOKEN_URL)) },
  });
}

describe("tokens bound to a key (DPoP)", () => {
  it("binds a token to the proof's key, and takes it only with a new proof from that key", async () => {
    for (const alg of ["EdDSA", "ES256"] as const) {
      const w = new World(`e2e-${alg.toLowerCase()}`);
      await w.create();
      const key = await dpopKey(alg);
      const issued = await boundOwnerToken(w, key);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expectSchema("tokenResponse", issued.body);
      expect(issued.body.token_type).toBe("DPoP");
      const token = issued.body.access_token as string;
      expect(await env.DB.prepare("SELECT jkt FROM tokens WHERE jkt IS NOT NULL ORDER BY rowid DESC LIMIT 1").first()).toEqual({ jkt: key.jkt });
      const url = `${BASE}/v0.1/spheres/${w.sphere}`;
      const get = (headers: Record<string, string>) => w.call("GET", `/v0.1/spheres/${w.sphere}`, { headers });
      expect((await get({ Authorization: `DPoP ${token}`, DPoP: await key.proof("GET", url, token) })).status, alg).toBe(200);
      // Alone, as a bearer token, it opens nothing.
      expect((await get({ Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await get({ Authorization: `DPoP ${token}` })).status).toBe(401);
      // Nor with a proof for another call, another token, another key, or from too long ago.
      const other = await dpopKey(alg);
      for (const [why, proof] of [
        ["another method", await key.proof("DELETE", url, token)],
        ["another URL", await key.proof("GET", `${BASE}/v0.1/spheres/other`, token)],
        ["another server", await key.proof("GET", `https://elsewhere.example/v0.1/spheres/${w.sphere}`, token)],
        ["another token", await key.proof("GET", url, "a".repeat(43))],
        ["no ath", await key.proof("GET", url)],
        ["another key", await other.proof("GET", url, token)],
        ["an old iat", await key.proof("GET", url, token, { claims: { iat: w.clock.s - 301 } })],
        ["a private key in jwk", await key.proof("GET", url, token, { header: { jwk: { ...key.jwk, d: "AAAA" } } })],
        ["typ JWT", await key.proof("GET", url, token, { header: { typ: "JWT" } })],
      ] as const) {
        const r = await get({ Authorization: `DPoP ${token}`, DPoP: proof });
        expect(r.status, `${alg}: ${why}`).toBe(401);
        expect(r.body.error.code).toBe("unauthorized");
      }
    }
  });

  it("gives one token per proof, and refuses a proof that doesn't pass with invalid_dpop_proof", async () => {
    const w = new World();
    await w.create();
    const key = await dpopKey();
    const proof = await key.proof("POST", TOKEN_URL);
    expect((await boundOwnerToken(w, key, proof)).status).toBe(200);
    const again = await boundOwnerToken(w, key, proof);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_dpop_proof");
    for (const bad of [await key.proof("GET", TOKEN_URL), await key.proof("POST", `${BASE}/v0.1/oauth/other`), await key.proof("POST", TOKEN_URL, undefined, { header: { alg: "RS256" } }), "not.a.proof"]) {
      const r = await boundOwnerToken(w, key, bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_dpop_proof");
    }
  });

  it("keeps bearer tokens as they were, and refuses one sent as DPoP", async () => {
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    expect((await w.call("GET", "/v0.1/spheres/e2e", { token })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `DPoP ${token}` } })).status).toBe(401);
  });

  it("binds an agent's token too, and its phone relay takes it with a proof", async () => {
    const w = await team();
    const key = await dpopKey();
    const r = await w.call("POST", "/v0.1/oauth/token", {
      raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await w.delegation("obi-wellington"), subject_token_type: JWT_TYPE, actor_token: await w.actorAssertion("obi-wellington"), actor_token_type: JWT_TYPE }),
      headers: { ...FORM, DPoP: await key.proof("POST", TOKEN_URL) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const token = r.body.access_token as string;
    const relay = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const path = `/v0.1/relay/${relay}`;
    expect((await w.call("PUT", path, { headers: { Authorization: `DPoP ${token}`, DPoP: await key.proof("PUT", BASE + path, token) } })).status).toBe(201);
    expect((await w.call("PUT", path, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});

describe("assertions bound to one server", () => {
  it("takes the Obysphere's own URL as aud, and refuses another server's", async () => {
    const w = new World();
    await w.create();
    expect((await w.exchangeOwner("wellington", "admin", { aud: `${BASE}/v0.1/spheres/e2e` })).status).toBe(200);
    for (const aud of ["https://elsewhere.example/v0.1/spheres/e2e", "http://sphere.test:8080/v0.1/spheres/e2e", `${BASE}/v0.1/spheres/other`]) {
      const r = await w.exchangeOwner("wellington", "admin", { aud });
      expect(r.status, aud).toBe(400);
      expect(r.body.error, aud).toBe("invalid_request");
    }
    // A form the claims schema doesn't take.
    expect((await w.exchangeOwner("wellington", "admin", { aud: `${BASE}/v0.1/spheres/e2e/` })).body.error).toBe("invalid_request");
  });

  it("lets a delegation and an actor assertion name the Obysphere in either form, the same one", async () => {
    const w = await team();
    const url = `${BASE}/v0.1/spheres/e2e`;
    const mixed = await w.exchangeObi("obi-wellington", { actor: await w.actorAssertion("obi-wellington", undefined, { aud: url }) });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    const other = await w.exchangeObi("obi-wellington", { actor: await w.actorAssertion("obi-wellington", undefined, { aud: "https://elsewhere.example/v0.1/spheres/e2e" }) });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe("invalid_request");
  });
});
