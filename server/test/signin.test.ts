// Signing in with Google, creating a Sphere with a sign-in, and invitations for one Workspace
// (spec/sphere-api.md sections 3, 3.1 and 4).

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { b64url } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, GOOGLE_KEY, IDP, IDP_KEY, ISSUERS, OPERATOR, World, expectSchema, makeCall, makeCard, newKey, type Key } from "./helpers";

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
    const r = await handle(new Request(`${BASE}/v0.1/signin/google`, { method: "POST", body: JSON.stringify({ owner_key: key.publicKey }) }), { ...env, GOOGLE_CLIENT_ID: "" }, { now: w.clock.now, issuers: ISSUERS });
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

describe("how many Spheres an account creates", () => {
  const create = async (w: World, sub: string, sphere: string, e = env) => {
    const key = await newKey();
    const s = await signIn(w, key, { sub });
    const body = JSON.stringify(createBody(key, { state: s.state, code: s.code }, sphere));
    const r = await handle(new Request(`${BASE}/v0.1/spheres`, { method: "POST", body }), e, { now: w.clock.now, issuers: ISSUERS });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers, state: s.state };
  };

  it("is 429 rate_limited past 3 for one account, without using the sign-in, and counts nobody else's", async () => {
    const w = new World();
    for (const id of ["one", "two", "three"]) expect((await create(w, "1001", id)).status, id).toBe(201);
    const fourth = await create(w, "1001", "four");
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe("rate_limited");
    expect(fourth.headers.get("Retry-After")).toBeNull();
    expect(await env.DB.prepare("SELECT used FROM sign_ins WHERE state = ?1").bind(fourth.state).first()).toEqual({ used: 0 });
    expect((await create(w, "2002", "four")).status).toBe(201);
    expect((await w.call("POST", "/v0.1/spheres", { token: OPERATOR, body: { sphere: "five", name: "Five", admin: { owner: "doti", owner_key: (await newKey()).publicKey } } })).status).toBe(201);
  });

  it("takes the limit from SPHERE_CREATE_LIMIT", async () => {
    const w = new World();
    const one = { ...env, SPHERE_CREATE_LIMIT: "1" };
    expect((await create(w, "1001", "one", one)).status).toBe(201);
    expect((await create(w, "1001", "two", one)).status).toBe(429);
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

// ---------------------------------------------------------------------------------------------
// Any OpenID Connect provider: the test provider (helpers.ts, IDP), with its issuer's discovery
// document and an ES256 key made for this run.

const ACME = { id: "acme", name: "Acme SSO", issuer: IDP.issuer, client_id: "acme-client", domain: "acme.example" };
const withProviders = (providers: unknown[], more: Record<string, string> = {}) => ({ ...env, SIGNIN_PROVIDERS: JSON.stringify(providers), ...more });

async function es256(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: IDP.kid, typ: "JWT" }): Promise<string> {
  const head = b64url(utf8(JSON.stringify(header)));
  const body = b64url(utf8(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, IDP_KEY.privateKey, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

/** Signs in with the test provider `id` (in `e`), finishing at `callback` (its own by default): the callback's Location. */
async function signInWith(w: World, e: Record<string, unknown>, key: Key, o: { id?: string; returnTo?: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; callback?: string } = {}) {
  const call = makeCall(w.clock, e as never);
  const id = o.id ?? "acme";
  const start = await call("POST", `/v0.1/signin/${id}`, { body: { owner_key: key.publicKey, ...(o.returnTo ? { return_to: o.returnTo } : {}) } });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  expectSchema("signinResponse", start.body);
  const url = new URL(start.body.url);
  const token = await es256({ iss: IDP.issuer, aud: "acme-client", sub: "u-7", nonce: url.searchParams.get("nonce"), iat: w.clock.s, exp: w.clock.s + 600, ...o.claims }, o.header);
  const back = await call("POST", `/v0.1/signin/${o.callback ?? id}/callback`, {
    raw: new URLSearchParams({ state: start.body.state, id_token: token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(back.status).toBe(303);
  return { url, state: start.body.state as string, location: back.headers.get("Location")!, call };
}

describe("signing in with any OpenID Connect provider", () => {
  it("lists the providers the operator named, Google among them, and none without any", async () => {
    const w = new World();
    const listed = await makeCall(w.clock, withProviders([ACME]) as never)("GET", "/v0.1/signin");
    expect(listed.status).toBe(200);
    expectSchema("signinProvidersResponse", listed.body);
    expect(listed.body).toEqual({ providers: [{ id: "google", name: "Google" }, { id: "acme", name: "Acme SSO" }] });
    const none = await makeCall(w.clock, { ...env, GOOGLE_CLIENT_ID: "" } as never)("GET", "/v0.1/signin");
    expect(none.body).toEqual({ providers: [] });
  });

  it("signs in through the issuer's own authorization page, and hands the code back where the client asked", async () => {
    const w = new World();
    const key = await newKey();
    const e = withProviders([ACME]);
    const s = await signInWith(w, e, key, { returnTo: "http://127.0.0.1:53682/signed-in" });
    // Where the issuer's discovery document said, for the ID token alone, back to this provider's callback.
    expect(s.url.origin + s.url.pathname).toBe(IDP.authorize);
    expect(Object.fromEntries(["client_id", "redirect_uri", "response_type", "response_mode", "scope"].map((k) => [k, s.url.searchParams.get(k)]))).toEqual({
      client_id: "acme-client", redirect_uri: `${BASE}/v0.1/signin/acme/callback`, response_type: "id_token", response_mode: "form_post", scope: "openid email",
    });
    const location = new URL(s.location);
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:53682/signed-in");
    expect(location.searchParams.get("state")).toBe(s.state);
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The account is the provider's id and the sub; its domain the provider's own.
    expect(await env.DB.prepare("SELECT account, workspace FROM sign_ins WHERE state = ?1").bind(s.state).first()).toEqual({ account: "acme:u-7", workspace: "acme.example" });
    // It creates an Obysphere for a creator domain, as Google's does.
    const created = await makeCall(w.clock, withProviders([ACME], { CREATOR_WORKSPACES: "acme.example" }) as never)("POST", "/v0.1/spheres", { body: createBody(key, { state: s.state, code }, "acme-team") });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await env.DB.prepare("SELECT account FROM owners WHERE sphere = 'acme-team'").first()).toEqual({ account: "acme:u-7" });
  });

  it("goes back to a scheme of the client's own, or to obi-sphere://signin when the client names nowhere", async () => {
    const w = new World();
    const e = withProviders([ACME]);
    expect((await signInWith(w, e, await newKey(), { returnTo: "example-client:/signin" })).location).toMatch(/^example-client:\/signin\?state=[A-Za-z0-9_-]{43}&code=/);
    expect((await signInWith(w, e, await newKey())).location).toMatch(/^obi-sphere:\/\/signin\?state=/);
  });

  it("refuses to hand a code to anywhere off the person's machine, or with a query of its own", async () => {
    const w = new World();
    const call = makeCall(w.clock, withProviders([ACME]) as never);
    const key = await newKey();
    for (const returnTo of ["https://attacker.example/cb", "http://sphere.example/cb", "javascript:alert(1)", "data:text/html,x", "http://127.0.0.1:5000/cb?next=1", "example-client:/x#y", "http://me@127.0.0.1/cb", "no-scheme"]) {
      const r = await call("POST", "/v0.1/signin/acme", { body: { owner_key: key.publicKey, return_to: returnTo } });
      expect(r.status, returnTo).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });

  it("fails a token that doesn't pass, or a sign-in another provider's callback finishes", async () => {
    const w = new World();
    const e = withProviders([ACME]);
    for (const [why, o] of [
      ["another issuer", { claims: { iss: "https://other.test" } }],
      ["another client", { claims: { aud: "other-client" } }],
      ["several clients, none authorized", { claims: { aud: ["acme-client", "other-client"] } }],
      ["an unlisted key", { header: { alg: "ES256", kid: "who-knows", typ: "JWT" } }],
      ["a shared-secret algorithm", { header: { alg: "HS256", kid: "a-shared-secret", typ: "JWT" } }],
      ["no signature algorithm", { header: { alg: "none", kid: IDP.kid, typ: "JWT" } }],
      ["RS256 over an EC key", { header: { alg: "RS256", kid: IDP.kid, typ: "JWT" } }],
      ["Google's callback", { callback: "google" }],
    ] as const) {
      const s = await signInWith(w, e, await newKey(), o);
      expect(s.location, why).toMatch(/error=failed$/);
      expect(await env.DB.prepare("SELECT account FROM sign_ins WHERE state = ?1").bind(s.state).first(), why).toEqual({ account: null });
    }
    // Several audiences, with this client authorized, pass.
    const ok = await signInWith(w, e, await newKey(), { claims: { aud: ["acme-client", "other-client"], azp: "acme-client" } });
    expect(ok.location).toMatch(/&code=/);
  });

  it("takes an account's domain from the claim the operator names, and leaves out a provider set up wrong", async () => {
    const w = new World();
    const warned: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a) => void warned.push(a.join(" ")));
    const e = withProviders([
      { id: "bad", name: "Bad", issuer: "http://idp.example", client_id: "x" },
      { id: "keycloak", name: "Keycloak", issuer: IDP.issuer, client_id: "acme-client", domain_claim: "org_domain", email_verified: true },
    ]);
    expect((await makeCall(w.clock, e as never)("GET", "/v0.1/signin")).body.providers.map((p: { id: string }) => p.id)).toEqual(["google", "keycloak"]);
    expect(warned.join("\n")).toContain("SIGNIN_PROVIDERS[0] is left out: issuer is an https URL");
    const s = await signInWith(w, e, await newKey(), { id: "keycloak", claims: { org_domain: "Acme.Example", email_verified: true } });
    expect(await env.DB.prepare("SELECT account, workspace FROM sign_ins WHERE state = ?1").bind(s.state).first()).toEqual({ account: "keycloak:u-7", workspace: "acme.example" });
    const unverified = await signInWith(w, e, await newKey(), { id: "keycloak", claims: { org_domain: "acme.example" } });
    expect(unverified.location).toMatch(/error=failed$/);
    vi.restoreAllMocks();
  });

  it("is 403 forbidden for a provider the server doesn't have", async () => {
    const w = new World();
    const r = await makeCall(w.clock, withProviders([ACME]) as never)("POST", "/v0.1/signin/okta", { body: { owner_key: (await newKey()).publicKey } });
    expect(r.status).toBe(403);
  });

  it("limits an invitation to a domain on a server whose only provider isn't Google, and lets in its people", async () => {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    const e = withProviders([ACME], { GOOGLE_CLIENT_ID: "" });
    const call = makeCall(w.clock, e as never);
    const inv = await call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: 3600, max_uses: 10, domain: "acme.example" } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const k = await w.ownerKey("ernesto");
    const s = await signInWith(w, e, k, { returnTo: "http://127.0.0.1:53682/cb" });
    const code = new URL(s.location).searchParams.get("code")!;
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: k, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: k.publicKey, card, signin: { state: s.state, code } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await env.DB.prepare("SELECT account FROM owners WHERE sphere = 'e2e' AND owner = 'ernesto'").first()).toEqual({ account: "acme:u-7" });
  });
});
