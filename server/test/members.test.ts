// Invitations, pairing, the directory, rotation and revocation (spec/sphere-api.md section 4,
// spec/identity.md section 3).

import { describe, expect, it } from "vitest";
import { verifyCard } from "../src/protocol/card";
import { World, expectSchema, makeCard, newKey, team } from "./helpers";

describe("invitations", () => {
  it("makes one for an Obi of an owner, with a 43-character secret and the Sphere's expiry", async () => {
    const w = new World();
    await w.create();
    const r = await w.invite("ernesto", "obi-ernesto", 3600);
    expect(r.status).toBe(201);
    expectSchema("invitationResponse", r.body);
    expect(r.body).toMatchObject({ sphere: "e2e", owner: "ernesto", obi: "obi-ernesto", expires_at: "2026-10-14T13:00:00Z" });
    expect(r.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is admin only: an owner token without admin is 403 insufficient_scope, an Obi token too", async () => {
    const w = await team();
    const r = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken("ernesto", "directory:read"), body: { owner: "x", obi: "obi-x", expires_in: 3600 } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
    const o = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.obiToken("obi-ernesto"), body: { owner: "x", obi: "obi-x", expires_in: 3600 } });
    expect(o.status).toBe(403);
  });

  it("never reuses an Obi id: 409 conflict for a member, past or present", async () => {
    const w = await team();
    expect((await w.invite("ernesto", "obi-ernesto")).status).toBe(409);
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    const again = await w.invite("ernesto", "obi-ernesto");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
  });

  it("checks its body: 400 bad_request", async () => {
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    for (const body of [{ owner: "x", obi: "obi-x" }, { owner: "x", obi: "obi-x", expires_in: 59 }, { owner: "x", obi: "obi-x", expires_in: 3600, note: "hi" }]) {
      expect((await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body })).status).toBe(400);
    }
  });
});

describe("redeeming (pairing an Obi)", () => {
  async function setup() {
    const w = new World();
    await w.create();
    const inv = (await w.invite("ernesto", "obi-ernesto")).body;
    const ownerKey = await w.ownerKey("ernesto");
    const obiKey = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts() });
    const redeem = (body: unknown, id = inv.invitation_id) => w.call("POST", `/v0.1/spheres/e2e/invitations/${id}/redeem`, { body });
    return { w, inv, ownerKey, obiKey, card, redeem };
  }

  it("binds the owner key, makes the member active with its key valid from the next seq", async () => {
    const { w, inv, ownerKey, obiKey, card, redeem } = await setup();
    w.clock.advance(5);
    const r = await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card });
    expect(r.status).toBe(201);
    expectSchema("member", r.body);
    expect(r.body).toEqual({
      obi: "obi-ernesto", owner: "ernesto", owner_key: ownerKey.publicKey, owner_key_id: ownerKey.keyId, status: "active", joined_at: "2026-10-14T12:00:05Z", card,
      keys: [{ key_id: obiKey.keyId, public_key: obiKey.publicKey, valid_from_seq: 1, valid_until_seq: null }],
    });
    expect(await verifyCard(r.body.card, { bound_owner_key: ownerKey.publicKey })).toEqual({ ok: true });
  });

  it("answers every invitation failure the same: unknown, wrong secret, used, expired", async () => {
    const { w, inv, ownerKey, card, redeem } = await setup();
    const body = { secret: inv.secret, owner_key: ownerKey.publicKey, card };
    const messages = new Set<string>();
    for (const r of [
      await redeem(body, crypto.randomUUID()),
      await redeem({ ...body, secret: "A".repeat(43) }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("invitation_invalid");
      messages.add(r.body.error.message);
    }
    expect((await redeem(body)).status).toBe(201);
    const used = await redeem(body);
    expect(used.status).toBe(403);
    messages.add(used.body.error.message);

    const late = await w.invite("someone", "obi-someone", 60);
    w.clock.advance(60);
    const someKey = await w.ownerKey("someone");
    const lateCard = await makeCard({ sphere: "e2e", obi: "obi-someone", owner: "someone", ownerKey: someKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const expired = await redeem({ secret: late.body.secret, owner_key: someKey.publicKey, card: lateCard }, late.body.invitation_id);
    expect(expired.status).toBe(403);
    messages.add(expired.body.error.message);
    expect(messages.size).toBe(1);
  });

  it("is 400 card_invalid for a card that fails its checks or isn't the invitation's", async () => {
    const { w, inv, ownerKey, obiKey, card, redeem } = await setup();
    const other = await newKey();
    const cards: [string, unknown][] = [
      ["changed after signing", { ...card, name: "Someone else" }],
      ["signed by another key", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: other, obiKey, issuedAt: w.clock.ts() })],
      ["another obi", await makeCard({ sphere: "e2e", obi: "obi-other", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts() })],
      ["another owner", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "other", ownerKey, obiKey, issuedAt: w.clock.ts() })],
      ["issued in the future", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts(301) })],
      ["the Obi's key is the owner's", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: ownerKey, issuedAt: w.clock.ts() })],
      ["an extra field", { ...card, instructions: "do this" }],
    ];
    for (const [what, c] of cards) {
      const r = await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card: c });
      expect(r.status, what).toBe(400);
      expect(r.body.error.code, what).toBe(what === "an extra field" ? "bad_request" : "card_invalid");
    }
    // The card's owner_key must be the body's.
    const mismatch = await redeem({ secret: inv.secret, owner_key: other.publicKey, card });
    expect(mismatch.body.error.code).toBe("card_invalid");
    // Nothing was used up: the right card still pairs.
    expect((await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card })).status).toBe(201);
  });

  it("is 403 forbidden when the owner's bound key differs", async () => {
    const w = await team();
    const inv = (await w.invite("ernesto", "obi-ernesto-2")).body;
    const otherOwnerKey = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto-2", owner: "ernesto", ownerKey: otherOwnerKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/redeem`, { body: { secret: inv.secret, owner_key: otherOwnerKey.publicKey, card } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
  });

  it("is 409 conflict for a key id another member uses", async () => {
    const w = await team();
    const inv = (await w.invite("ernesto", "obi-ernesto-2")).body;
    const ownerKey = await w.ownerKey("ernesto");
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto-2", owner: "ernesto", ownerKey, obiKey: w.obis.get("obi-wellington")!.key, issuedAt: w.clock.ts() });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/redeem`, { body: { secret: inv.secret, owner_key: ownerKey.publicKey, card } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });

  it("can't be redeemed twice at once", async () => {
    const { inv, ownerKey, card, redeem } = await setup();
    const body = { secret: inv.secret, owner_key: ownerKey.publicKey, card };
    const results = await Promise.all([redeem(body), redeem(body), redeem(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
  });
});

describe("the directory", () => {
  it("lists every member by joined_at then obi, each with its card and keys", async () => {
    const w = new World();
    await w.create();
    await w.join("wellington", "obi-wellington");
    await w.join("ernesto", "obi-ernesto");
    w.clock.advance(1);
    await w.join("ernesto", "obi-a-later");
    const token = await w.obiToken("obi-ernesto");
    const r = await w.call("GET", "/v0.1/spheres/e2e/members", { token });
    expect(r.status).toBe(200);
    expectSchema("membersResponse", r.body);
    expect(r.body.members.map((m: { obi: string }) => m.obi)).toEqual(["obi-ernesto", "obi-wellington", "obi-a-later"]);
    for (const m of r.body.members) expect(m.keys).toEqual([{ key_id: w.obis.get(m.obi)!.key.keyId, public_key: w.obis.get(m.obi)!.key.publicKey, valid_from_seq: 1, valid_until_seq: null }]);
    const one = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(r.body.members[1]);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members/nobody", { token })).status).toBe(404);
  });

  it("needs directory:read", async () => {
    const w = await team();
    const r = await w.call("GET", "/v0.1/spheres/e2e/members", { token: await w.obiToken("obi-ernesto", "receive") });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
  });
});

describe("rotation", () => {
  it("closes the old key at the head, opens the new one after it, and revokes the Obi's tokens", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const old = w.obis.get("obi-ernesto")!.key;
    const ownerKey = await w.ownerKey("ernesto");
    const fresh = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: fresh, cardSeq: 2, issuedAt: w.clock.ts() });
    const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card } });
    expect(r.status).toBe(200);
    expectSchema("member", r.body);
    expect(r.body.keys).toEqual([
      { key_id: old.keyId, public_key: old.publicKey, valid_from_seq: 1, valid_until_seq: 0 },
      { key_id: fresh.keyId, public_key: fresh.publicKey, valid_from_seq: 1, valid_until_seq: null },
    ]);
    // The token used for it is revoked; a new exchange must prove the new key.
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(401);
    expect((await w.exchangeObi("obi-ernesto")).body.error).toBe("invalid_grant");
    w.obis.get("obi-ernesto")!.key = fresh;
    expect((await w.exchangeObi("obi-ernesto")).status).toBe(200);
  });

  it("needs a higher card_seq, the same identity and the Obi's own token; the same key changes no key", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const ownerKey = await w.ownerKey("ernesto");
    const key = w.obis.get("obi-ernesto")!.key;
    const same = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 1, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: same } })).body.error.code).toBe("conflict");
    const other = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await newKey(), obiKey: key, cardSeq: 2, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: other } })).body.error.code).toBe("card_invalid");
    const wellingtonToken = await w.obiToken("obi-wellington");
    const next = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 2, accepts: ["review_request", "question"], issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: wellingtonToken, body: { card: next } })).body.error.code).toBe("forbidden");
    const taken = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: w.obis.get("obi-wellington")!.key, cardSeq: 2, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: taken } })).body.error.code).toBe("conflict");
    const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: next } });
    expect(r.status).toBe(200);
    expect(r.body.card).toEqual(next);
    expect(r.body.keys).toHaveLength(1);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(200);
  });
});

describe("revocation", () => {
  it("closes the key, marks the member revoked, and answers the same when revoked again", async () => {
    const w = await team();
    const admin = await w.ownerToken();
    w.clock.advance(7);
    const r = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: admin });
    expect(r.status).toBe(200);
    expectSchema("member", r.body);
    expect(r.body.status).toBe("revoked");
    expect(r.body.revoked_at).toBe("2026-10-14T12:00:07Z");
    // Nothing was recorded since the key was opened: an empty range.
    expect(r.body.keys[0].valid_from_seq).toBe(1);
    expect(r.body.keys[0].valid_until_seq).toBe(0);
    w.clock.advance(5);
    const again = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(r.body);
    const active = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken() });
    expect(active.body.revoked_at).toBeUndefined();
  });

  it("is for the admin or the Obi's own owner, with an owner token", async () => {
    const w = await team();
    const r = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken("ernesto", "directory:read") });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.obiToken("obi-ernesto") })).body.error.code).toBe("forbidden");
    const own = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken("ernesto", "directory:read") });
    expect(own.status).toBe(200);
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/nobody", { token: await w.ownerToken() })).status).toBe(404);
  });
});
