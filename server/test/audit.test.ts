// The audit chain (spec/sphere-api.md section 7): what the Sphere appends, how it is read, and
// that it verifies, also across key rotation and revocation and under concurrent sends.

import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/protocol/chain";
import { BRIEF, RESULT, World, expectSchema, makeCard, newKey, team } from "./helpers";

async function chainOf(w: World) {
  const token = await w.ownerToken();
  const audit = await w.call("GET", "/v0.1/spheres/e2e/audit?from_seq=1&limit=1000", { token });
  const members = await w.call("GET", "/v0.1/spheres/e2e/members", { token });
  const keys: Record<string, { obi: string; public_key: string; valid_from_seq: number; valid_until_seq: number | null }> = {};
  for (const m of members.body.members) for (const k of m.keys) keys[k.key_id] = { obi: m.obi, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq };
  return { audit: audit.body, keys };
}

describe("the chain", () => {
  it("links every relayed message by hash, from 64 zeros, and verifies", async () => {
    const w = await team();
    const tokenA = await w.obiToken("obi-wellington");
    const tokenB = await w.obiToken("obi-ernesto");
    const request = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    const sent = (await w.send(request, tokenB)).body;
    w.clock.advance(3);
    await w.send(await w.reply(request, "accept", {}), tokenA);
    w.clock.advance(3);
    const last = (await w.send(await w.reply(request, "result", RESULT), tokenA)).body;

    const { audit, keys } = await chainOf(w);
    expectSchema("auditResponse", audit);
    expect(audit.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(audit.entries[0].prev).toBe("0".repeat(64));
    expect(audit.entries[0].hash).toBe(sent.entry_hash);
    expect(audit.entries[1].prev).toBe(audit.entries[0].hash);
    expect(audit.head).toEqual({ seq: 3, hash: last.entry_hash });
    expect(audit.entries[0].envelope).toEqual(request);
    expect(audit.entries.map((e: { recorded_at: string }) => e.recorded_at)).toEqual(["2026-10-14T12:00:00Z", "2026-10-14T12:00:03Z", "2026-10-14T12:00:06Z"]);
    expect(await verifyChain({ sphere: "e2e", entries: audit.entries }, { keys })).toEqual({ ok: true });
  });

  it("pages by from_seq and limit, answers [] past the head, and checks its parameters", async () => {
    const w = await team();
    const tokenB = await w.obiToken("obi-ernesto");
    for (let i = 0; i < 5; i++) await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF), tokenB);
    const token = await w.ownerToken();
    const page = await w.call("GET", "/v0.1/spheres/e2e/audit?from_seq=2&limit=2", { token });
    expect(page.body.entries.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    expect(page.body.head.seq).toBe(5);
    const past = await w.call("GET", "/v0.1/spheres/e2e/audit?from_seq=6", { token });
    expect(past.status).toBe(200);
    expect(past.body.entries).toEqual([]);
    expect(past.body.head.seq).toBe(5);
    for (const q of ["from_seq=0", "from_seq=9007199254740992", "limit=0", "limit=1001", "from_seq=x", "limit="]) {
      const r = await w.call("GET", `/v0.1/spheres/e2e/audit?${q}`, { token });
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
    expect((await w.call("GET", "/v0.1/spheres/e2e/audit?from_seq=9007199254740991&limit=1000", { token })).status).toBe(200);
  });

  it("needs audit:read", async () => {
    const w = await team();
    const r = await w.call("GET", "/v0.1/spheres/e2e/audit", { token: await w.obiToken("obi-ernesto", "receive") });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
  });

  it("still verifies after a key rotation and a revocation, old entries with old keys", async () => {
    const w = await team();
    const tokenA = await w.obiToken("obi-wellington");
    let tokenB = await w.obiToken("obi-ernesto");
    const r1 = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    await w.send(r1, tokenB);
    await w.send(await w.reply(r1, "accept", {}), tokenA);
    // Rotate B's key at head 2.
    const fresh = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await w.ownerKey("ernesto"), obiKey: fresh, cardSeq: 2, issuedAt: w.clock.ts() });
    const rotated = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: tokenB, body: { card } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.keys.map((k: { valid_from_seq: number; valid_until_seq: number | null }) => [k.valid_from_seq, k.valid_until_seq])).toEqual([[1, 2], [3, null]]);
    const oldKey = w.obis.get("obi-ernesto")!.key;
    w.obis.get("obi-ernesto")!.key = fresh;
    tokenB = await w.obiToken("obi-ernesto");
    // The old key can no longer send.
    const stale = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF, {}, oldKey);
    expect((await w.send(stale, tokenB)).body.error.code).toBe("unknown_key");
    const r2 = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    expect((await w.send(r2, tokenB)).body.seq).toBe(3);
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    const { audit, keys } = await chainOf(w);
    expect(Object.values(keys).filter((k) => k.obi === "obi-ernesto").map((k) => [k.valid_from_seq, k.valid_until_seq])).toEqual([[1, 2], [3, 3]]);
    expect(await verifyChain({ sphere: "e2e", entries: audit.entries }, { keys })).toEqual({ ok: true });
  });

  it("stays one chain under concurrent sends: every seq once, every link right", async () => {
    const w = await team();
    const tokenB = await w.obiToken("obi-ernesto");
    const envs = await Promise.all(Array.from({ length: 12 }, () => w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF)));
    const answers = await Promise.all(envs.map((e) => w.send(e, tokenB)));
    expect(answers.map((a) => a.status)).toEqual(Array(12).fill(202));
    expect(answers.map((a) => a.body.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const { audit, keys } = await chainOf(w);
    expect(await verifyChain({ sphere: "e2e", entries: audit.entries }, { keys })).toEqual({ ok: true });
  });

  it("records every one of 200 concurrent sends: no send gives up while others write", async () => {
    const w = await team();
    const tokenB = await w.obiToken("obi-ernesto");
    const n = 200;
    const envs = await Promise.all(Array.from({ length: n }, () => w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF)));
    const answers = await Promise.all(envs.map((e) => w.send(e, tokenB)));
    expect(answers.filter((a) => a.status !== 202).map((a) => `${a.status} ${a.body?.error?.code}`)).toEqual([]);
    expect(answers.map((a) => a.body.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const { audit, keys } = await chainOf(w);
    expect(audit.entries.map((e: { envelope: { id: string } }) => e.envelope.id).sort()).toEqual(envs.map((e) => e.id).sort());
    expect(await verifyChain({ sphere: "e2e", entries: audit.entries }, { keys })).toEqual({ ok: true });
  }, 60_000);

  it("records at most one accept when two race", async () => {
    const w = await team();
    const tokenA = await w.obiToken("obi-wellington");
    const request = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    await w.send(request, await w.obiToken("obi-ernesto"));
    const accepts = await Promise.all([w.reply(request, "accept", {}), w.reply(request, "accept", {}), w.reply(request, "accept", {})]);
    const answers = await Promise.all(accepts.map((a) => w.send(a, tokenA)));
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409, 409]);
    const { audit, keys } = await chainOf(w);
    expect(audit.entries).toHaveLength(2);
    expect(await verifyChain({ sphere: "e2e", entries: audit.entries }, { keys })).toEqual({ ok: true });
  });
});
