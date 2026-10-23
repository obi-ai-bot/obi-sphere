// Signing in with Google, creating a Sphere with a sign-in, and invitations for one Workspace
// (spec/sphere-api.md sections 3, 3.1 and 4).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { b64url } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, GOOGLE, GOOGLE_KEY, OPERATOR, World, expectSchema, makeCard, newKey, type Key } from "./helpers";

const CLIENT = env.GOOGLE_CLIENT_ID;

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(utf8(JSON.stringify({ alg: "RS256", kid: "test-google-key", typ: "JWT" })));
  const body = b64url(utf8(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", GOOGLE_KEY.privateKey, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

/** Signs in for `key` as Google account `sub` of Workspace `hd` (none: a personal account): the sign-in, or the callback's Location. */
async function signIn(w: World, key: Key, o: { sub?: string; hd?: string | null; claims?: Record<string, unknown> } = {}) {
  const start = await w.call("POST", "/v0.1/signin/google", { body: { owner_key: key.publicKey } });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  expectSchema("signinResponse", start.body);
  const url = new URL(start.body.url);
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("client_id")).toBe(CLIENT);
  expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/v0.1/signin/google/callback`);
  expect(url.searchParams.get("response_type")).toBe("id_token");
  expect(url.searchParams.get("state")).toBe(start.body.state);
  const hd = o.hd === undefined ? "example.com" : o.hd;
  const token = await idToken({
    iss: "https://accounts.google.com", aud: CLIENT, sub: o.sub ?? "1001", email: "doti@example.com", email_verified: true,
    ...(hd ? { hd } : {}), nonce: url.searchParams.get("nonce"), iat: w.clock.s, exp: w.clock.s + 3600, ...o.claims,
  });
  const back = await w.call("POST", "/v0.1/signin/google/callback", {
    raw: new URLSearchParams({ state: start.body.state, id_token: token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(back.status).toBe(303);
  const location = new URL(back.headers.get("Location")!);
  return { state: start.body.state as string, code: location.searchParams.get("code"), location };
}

const createBody = (key: Key, signin: unknown, sphere = "team") => ({ sphere, name: "Team", admin: { owner: "doti", owner_key: key.publicKey }, signin });

describe("signing in with Google", () => {
  it("hands the browser back a one-time code, keeping neither the email nor the token", async () => {
    const w = new World();
    const key = await newKey();
    const s = await signIn(w, key);
    expect(s.location.protocol).toBe("obi-sphere:");
    expect(s.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT * FROM sign_ins WHERE state = ?1").bind(s.state).first<Record<string, unknown>>();
    expect(row).toMatchObject({ account: "google:1001", workspace: "example.com", used: 0 });
    expect(JSON.stringify(row)).not.toContain("doti@");
    expect(row!.code_sha256).not.toBe(s.code);
  });

  it("sends the browser back failed for a token that doesn't pass, and keeps the sign-in waiting", async () => {
    const w = new World();
    const key = await newKey();
    for (const claims of [{ aud: "another-client" }, { nonce: "another-nonce" }, { iss: "https://evil.example" }, { email_verified: false }, { exp: 0 }, { iat: 0 }]) {
      const s = await signIn(w, key, { claims });
      expect(s.code, JSON.stringify(claims)).toBeNull();
      expect(s.location.searchParams.get("error")).toBe("failed");
    }
  });

  it("is 403 forbidden on a Sphere server with no client id", async () => {
    const w = new World();
    const key = await newKey();
    const r = await handle(new Request(`${BASE}/v0.1/signin/google`, { method: "POST", body: JSON.stringify({ owner_key: key.publicKey }) }), { ...env, GOOGLE_CLIENT_ID: "" }, { now: w.clock.now, google: GOOGLE });
    expect(r.status).toBe(403);
  });
});

describe("creating a Sphere with a sign-in", () => {
  it("creates it for someone from a creator Workspace, binds the admin to the account, and uses the sign-in up", async () => {
    const w = new World();
    const key = await newKey();
    const s = await signIn(w, key);
    const r = await w.call("POST", "/v0.1/spheres", { body: createBody(key, { state: s.state, code: s.code }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectSchema("sphere", r.body);
    expect(r.body.admin_owner).toBe("doti");
    expect(await env.DB.prepare("SELECT account FROM owners WHERE sphere = 'team'").first()).toEqual({ account: "google:1001" });
    const again = await w.call("POST", "/v0.1/spheres", { body: createBody(key, { state: s.state, code: s.code }, "team-two") });
    expect(again.status).toBe(403);
  });

  it("refuses, 403 forbidden, a personal account, another Workspace, another owner key, a wrong code or an expired sign-in", async () => {
    const w = new World();
    const key = await newKey();
    const personal = await signIn(w, key, { hd: null });
    const elsewhere = await signIn(w, key, { hd: "elsewhere.com" });
    const ok = await signIn(w, key);
    const otherKey = await newKey();
    const cases: [string, Key, unknown][] = [
      ["personal", key, { state: personal.state, code: personal.code }],
      ["elsewhere", key, { state: elsewhere.state, code: elsewhere.code }],
      ["other key", otherKey, { state: ok.state, code: ok.code }],
      ["wrong code", key, { state: ok.state, code: "C".repeat(43) }],
    ];
    for (const [what, k, signin] of cases) {
      const r = await w.call("POST", "/v0.1/spheres", { body: createBody(k, signin) });
      expect(r.status, what).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
    }
    w.clock.advance(601);
    expect((await w.call("POST", "/v0.1/spheres", { body: createBody(key, { state: ok.state, code: ok.code }) })).status).toBe(403);
  });

  it("still needs the operator token without a sign-in, and the operator's create ignores one", async () => {
    const w = new World();
    const key = await newKey();
    expect((await w.call("POST", "/v0.1/spheres", { body: { sphere: "team", name: "Team", admin: { owner: "doti", owner_key: key.publicKey } } })).status).toBe(401);
    const s = await signIn(w, key);
    const r = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, body: createBody(key, { state: s.state, code: s.code }) });
    expect(r.status).toBe(201);
    expect(await env.DB.prepare("SELECT used FROM sign_ins WHERE state = ?1").bind(s.state).first()).toEqual({ used: 0 });
  });
});

describe("an invitation for one Workspace", () => {
  async function setup() {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    const inv = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: 2592000, max_uses: 1000, domain: "example.com" } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expectSchema("invitationResponse", inv.body);
    expect(inv.body.domain).toBe("example.com");
    const redeem = async (owner: string, signin?: unknown, ownerKey?: Key) => {
      const k = ownerKey ?? (await w.ownerKey(owner));
      const card = await makeCard({ sphere: "e2e", obi: `obi-${owner}`, owner, ownerKey: k, obiKey: await newKey(), issuedAt: w.clock.ts() });
      return w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: k.publicKey, card, ...(signin ? { signin } : {}) } });
    };
    return { w, inv: inv.body, redeem };
  }

  it("says its domain in the preview, so the Join screen signs in first", async () => {
    const { w, inv } = await setup();
    const p = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/preview`, { body: { secret: inv.secret } });
    expect(p.status).toBe(200);
    expectSchema("invitationPreviewResponse", p.body);
    expect(p.body.domain).toBe("example.com");
  });

  it("lets in only someone signed in from that Workspace, for their own owner key", async () => {
    const { w, redeem } = await setup();
    expect((await redeem("ernesto")).status).toBe(403);
    const elsewhere = await signIn(w, await w.ownerKey("ernesto"), { hd: "elsewhere.com", sub: "2002" });
    expect((await redeem("ernesto", { state: elsewhere.state, code: elsewhere.code })).status).toBe(403);
    const forOther = await signIn(w, await newKey(), { sub: "2002" });
    expect((await redeem("ernesto", { state: forOther.state, code: forOther.code })).status).toBe(403);
    const ok = await signIn(w, await w.ownerKey("ernesto"), { sub: "2002" });
    const r = await redeem("ernesto", { state: ok.state, code: ok.code });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectSchema("member", r.body);
    expect(JSON.stringify(r.body)).not.toContain("google:");
    expect(await env.DB.prepare("SELECT account FROM owners WHERE sphere = 'e2e' AND owner = 'ernesto'").first()).toEqual({ account: "google:2002" });
  });

  it("is 409 conflict for an account that joined as another owner", async () => {
    const { w, redeem } = await setup();
    const first = await signIn(w, await w.ownerKey("ernesto"), { sub: "2002" });
    expect((await redeem("ernesto", { state: first.state, code: first.code })).status).toBe(201);
    const second = await signIn(w, await w.ownerKey("ernesto-two"), { sub: "2002" });
    const r = await redeem("ernesto-two", { state: second.state, code: second.code });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });

  it("is 400 for a named invitation with a domain, and 403 on a Sphere server with no sign-in", async () => {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    const token = await w.ownerToken();
    expect((await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body: { owner: "x", obi: "obi-x", expires_in: 3600, domain: "example.com" } })).status).toBe(400);
    const r = await handle(
      new Request(`${BASE}/v0.1/spheres/e2e/invitations`, { method: "POST", headers: { Authorization: `Bearer ${await w.ownerToken()}` }, body: JSON.stringify({ expires_in: 3600, domain: "example.com" }) }),
      { ...env, GOOGLE_CLIENT_ID: "" },
      { now: w.clock.now },
    );
    expect(r.status).toBe(403);
  });
});
