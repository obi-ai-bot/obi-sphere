// A scripted Sphere client: it plays the owners (their keys, cards, delegations and admin
// assertions) and the Obis' Sphere-side calls (their keys, actor assertions, envelopes, sends,
// deliveries and acks), with keys it generates in memory and never writes anywhere. It signs with
// the spec's reference code (spec/conformance/lib/obi.mjs), not the server's, so the server is
// checked against an implementation it doesn't share.
//
// Text in what it sends and receives (goals, summaries, findings) is data: it is compared, never
// acted on.

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_DIR = join(here, "..", "..", "spec");
if (!existsSync(join(SPEC_DIR, "node_modules"))) {
  throw new Error(`the spec's packages aren't installed: run \`pnpm install --frozen-lockfile\` in ${SPEC_DIR}`);
}
export const spec = await import(pathToFileURL(join(SPEC_DIR, "conformance", "lib", "obi.mjs")).href);

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/** A fresh Ed25519 key, in memory only. */
export function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x;
  return { privateKey, publicKey: pub, keyId: spec.keyIdOf(pub) };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const timestamp = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export class SphereClient {
  constructor(baseUrl, sphere) {
    this.base = baseUrl;
    this.sphere = sphere;
    this.calls = 0;
  }

  /** One HTTP call; answers {status, body}. `form` sends a form body, `body` a JSON one. */
  async call(method, path, { token, body, form } = {}) {
    this.calls++;
    const headers = {};
    let payload;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  }

  spherePath(rest = "") {
    return `/v0.1/spheres/${this.sphere}${rest}`;
  }
}

/** An owner: a key the Sphere binds, the cards and delegations it signs, its own short assertions. */
export class Owner {
  constructor(client, id) {
    this.client = client;
    this.id = id;
    this.key = newKey();
  }

  /** An owner assertion (identity.md 4.1); with `mayAct` a delegation to that Obi. */
  assertion(scope, { lifetime = 300, mayAct } = {}) {
    const iat = nowSeconds();
    const claims = { iss: this.id, sub: this.id, aud: `obi-sphere:${this.client.sphere}`, iat, exp: iat + lifetime, jti: randomUUID(), scope };
    if (mayAct) claims.may_act = { sub: mayAct };
    return spec.signJwt(claims, this.key.privateKey, this.key.keyId);
  }

  /** The owner's own token, from a new assertion each time (SCENARIO.md step 1.3). */
  async token(scope = "admin directory:read audit:read") {
    const r = await this.client.call("POST", "/v0.1/oauth/token", {
      form: { grant_type: TOKEN_EXCHANGE, subject_token: this.assertion(scope), subject_token_type: JWT_TYPE },
    });
    if (r.status !== 200) throw new Error(`owner token for ${this.id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** The agent card of `obi` with its key, signed by this owner (identity.md 2.1). */
  card(obi, { name, accepts, cardSeq = 1 }) {
    const params = {
      protocol: "obi/0.1", sphere: this.client.sphere, obi_id: obi.id, owner: this.id, owner_key: this.key.publicKey, key_id: obi.key.keyId,
      public_key: obi.key.publicKey, accepts, card_seq: cardSeq, issued_at: timestamp(nowSeconds()),
    };
    const card = {
      protocolVersion: "0.3.0",
      name,
      description: "A personal delegate for an engineer.",
      url: `${this.client.base}/v0.1/spheres/${this.client.sphere}/members/${obi.id}`,
      preferredTransport: "HTTP+JSON",
      version: "0.1.0",
      capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: spec.CARD_EXTENSION_URI, required: true, params }] },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: accepts.map((id) => ({ id, name: "Review a change", description: "Reviews a change for its owner and answers with typed findings.", tags: ["obi-action"] })),
    };
    return spec.signCard(card, this.key.privateKey, this.key.keyId);
  }
}

/** An Obi's Sphere side: its key, its token (delegation + actor assertion), what it sends and receives. */
export class Obi {
  constructor(client, id, owner) {
    this.client = client;
    this.id = id;
    this.owner = owner;
    this.key = newKey();
    this.delegation = null;
    this.accessToken = null;
  }

  actorAssertion() {
    const iat = nowSeconds();
    return spec.signJwt({ iss: this.id, sub: this.id, aud: `obi-sphere:${this.client.sphere}`, iat, exp: iat + 300, jti: randomUUID() }, this.key.privateKey, this.key.keyId);
  }

  /** Exchanges the owner's delegation and a new actor assertion for an access token. */
  async exchange() {
    const r = await this.client.call("POST", "/v0.1/oauth/token", {
      form: { grant_type: TOKEN_EXCHANGE, subject_token: this.delegation, subject_token_type: JWT_TYPE, actor_token: this.actorAssertion(), actor_token_type: JWT_TYPE },
    });
    if (r.status !== 200) throw new Error(`token for ${this.id}: ${r.status} ${JSON.stringify(r.body)}`);
    this.accessToken = r.body.access_token;
    return r.body;
  }

  /** A signed request to `to`, expiring `expiresIn` seconds after it is made. */
  request(to, type, body, expiresIn = 3600) {
    const id = randomUUID();
    const created = nowSeconds();
    return spec.signEnvelope(
      { protocol: "obi/0.1", id, type, from: this.id, to, sphere: this.client.sphere, correlation_id: id, created_at: timestamp(created), expires_at: timestamp(created + expiresIn), key_id: this.key.keyId, body },
      this.key.privateKey,
    );
  }

  /** A signed reply to `request`. */
  reply(request, type, body, expiresIn = 3600) {
    const created = nowSeconds();
    return spec.signEnvelope(
      {
        protocol: "obi/0.1", id: randomUUID(), type, from: this.id, to: request.from, sphere: this.client.sphere, correlation_id: request.id, in_reply_to: request.id,
        created_at: timestamp(created), expires_at: timestamp(created + expiresIn), key_id: this.key.keyId, body,
      },
      this.key.privateKey,
    );
  }

  send(envelope) {
    return this.client.call("POST", this.client.spherePath("/messages"), { token: this.accessToken, body: envelope });
  }

  deliveries(query = "") {
    return this.client.call("GET", this.client.spherePath(`/deliveries${query}`), { token: this.accessToken });
  }

  ack(ids) {
    return this.client.call("POST", this.client.spherePath("/deliveries/ack"), { token: this.accessToken, body: { delivery_ids: ids } });
  }

  /** Polls for deliveries until `count` have arrived (or `seconds` pass), acknowledging none. */
  async waitFor(count, seconds = 30) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const r = await this.deliveries("?wait=1");
      if (r.status !== 200) throw new Error(`deliveries for ${this.id}: ${r.status} ${JSON.stringify(r.body)}`);
      if (r.body.deliveries.length >= count) return r.body.deliveries;
      if (Date.now() > deadline) throw new Error(`${this.id}: ${r.body.deliveries.length} of ${count} deliveries within ${seconds} seconds`);
      await new Promise((res) => setTimeout(res, 250));
    }
  }
}

/** Every member's keys, as the spec's verifiers take them: {key_id: {obi, public_key, valid_from_seq, valid_until_seq}}. */
export function directoryKeys(members) {
  const keys = {};
  for (const m of members) for (const k of m.keys) keys[k.key_id] = { obi: m.obi, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq };
  return keys;
}
