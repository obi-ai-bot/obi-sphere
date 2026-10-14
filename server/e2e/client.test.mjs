// Tests of the scripted client itself (node --test): what it signs is what the spec's reference
// verifier accepts, so a failing scenario step points at the server, not at the client.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Obi, Owner, SphereClient, directoryKeys, newKey, spec, timestamp } from "./client.mjs";

const client = new SphereClient("http://127.0.0.1:8787", "e2e");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("keys are Ed25519 with the spec's key ids, and differ every time", () => {
  const a = newKey();
  const b = newKey();
  assert.match(a.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.keyId, spec.keyIdOf(a.publicKey));
  assert.notEqual(a.publicKey, b.publicKey);
});

test("a card signed by the owner passes verifyCard with the owner's key bound", () => {
  const owner = new Owner(client, "wellington");
  const obi = new Obi(client, "obi-wellington", owner);
  const card = owner.card(obi, { name: "Wellington's Obi", accepts: ["review_request"] });
  assert.deepEqual(spec.verifyCard(card, { now: timestamp(Math.floor(Date.now() / 1000)), bound_owner_key: owner.key.publicKey }), { ok: true });
  assert.equal(card.url, "http://127.0.0.1:8787/v0.1/spheres/e2e/members/obi-wellington");
  assert.equal(spec.verifyCard(card, { bound_owner_key: newKey().publicKey }).ok, false);
});

test("assertions are EdDSA JWTs with the claims identity.md 4.1 lists", () => {
  const owner = new Owner(client, "ernesto");
  const obi = new Obi(client, "obi-ernesto", owner);
  const [h, c] = owner.assertion("send:review_request reply", { lifetime: 3600, mayAct: "obi-ernesto" }).split(".");
  assert.deepEqual(decode(h), { alg: "EdDSA", kid: owner.key.keyId, typ: "JWT" });
  const claims = decode(c);
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "jti", "may_act", "scope", "sub"]);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.deepEqual(claims.may_act, { sub: "obi-ernesto" });
  assert.equal(spec.schemaErrors("wire/delegation.claims", claims).length, 0);
  const actor = decode(obi.actorAssertion().split(".")[1]);
  assert.equal(spec.schemaErrors("wire/actor.claims", actor).length, 0);
  assert.equal(actor.exp - actor.iat, 300);
});

test("requests and replies pass verifyEnvelope as their receiver", () => {
  const W = new Owner(client, "wellington");
  const E = new Owner(client, "ernesto");
  const a = new Obi(client, "obi-wellington", W);
  const b = new Obi(client, "obi-ernesto", E);
  const members = [a, b].map((o) => ({ obi: o.id, keys: [{ key_id: o.key.keyId, public_key: o.key.publicKey, valid_from_seq: 1, valid_until_seq: null }] }));
  const keys = directoryKeys(members);
  const now = timestamp(Math.floor(Date.now() / 1000));
  const brief = { goal: "Review", repo: "obi-e2e/fixture-app", base_branch: "main", head_branch: "feature/average", head_sha: "6d20146f366b9fac8907b5066c30ee39aaec09b3", acceptance: [{ kind: "tests_pass" }] };
  const request = b.request("obi-wellington", "review_request", brief);
  assert.deepEqual(spec.verifyEnvelope(request, { now, sphere: "e2e", receiver: "obi-wellington", keys, seq: 1, seen_ids: [] }), { ok: true });
  assert.equal(request.correlation_id, request.id);
  const accept = a.reply(request, "accept", {});
  assert.deepEqual(spec.verifyEnvelope(accept, { now, sphere: "e2e", receiver: "obi-ernesto", keys, seq: 2, seen_ids: [] }), { ok: true });
  assert.equal(accept.in_reply_to, request.id);
  // Addressed to the other Obi: rejected as the wrong recipient.
  assert.equal(spec.verifyEnvelope(accept, { now, sphere: "e2e", receiver: "obi-wellington", keys, seq: 2, seen_ids: [] }).code, "wrong_recipient");
});
