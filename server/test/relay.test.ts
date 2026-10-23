// The phone relay (spec/sphere-api.md section 9): Wellington's Mac (obi-wellington) registers a
// relay and its phones' token hashes, and the Sphere passes sealed frames between them, reading
// and keeping none.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { b64url, hex, randomBytes, sha256Hex } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { MAX_ENVELOPE_BYTES, MAX_FRAMES_PER_MINUTE, type PhoneRelay } from "../src/relay";
import { BASE, World, expectSchema, makeCall, newKey, side, signJwt, team, until, type Key } from "./helpers";

const OPEN_ENV = { ...env, RELAY_OWNERS: "owner_keys" };

/** A phone as the Mac pairs it: its relay token, and the hash the Sphere keeps. */
async function phone() {
  const token = b64url(randomBytes(32));
  return { token, hash: await sha256Hex(utf8(token)) };
}

const newRelay = () => b64url(randomBytes(16));
const path = (relay: string, device?: string) => `/v0.1/relay/${relay}${device ? `/devices/${device}` : ""}`;

function open(w: World, relay: string, token: string, o: { upgrade?: boolean; env?: Cloudflare.Env } = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (o.upgrade !== false) headers.Upgrade = "websocket";
  return handle(new Request(BASE + path(relay), { headers }), o.env ?? env, { now: w.clock.now });
}

const stub = (relay: string) => env.RELAYS.get(env.RELAYS.idFromName(relay));

/** A relay assertion for `relay`, signed by `key` (section 9.2). */
const assertion = (w: World, key: Key, relay: string, claims: Record<string, unknown> = {}) =>
  signJwt({ iss: key.publicKey, aud: `obi-sphere:relay:${relay}`, iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), ...claims }, key);

/** The team, Wellington's Mac's token, a relay with two phones, and what it takes to open each. */
async function paired() {
  const w = await team();
  const mac = await w.obiToken("obi-wellington");
  const relay = newRelay();
  const a = await phone();
  const b = await phone();
  const made = await w.call("PUT", path(relay), { token: mac });
  expect(made.status).toBe(201);
  expectSchema("relay", made.body);
  expect((await w.call("PUT", path(relay, a.hash), { token: mac })).status).toBe(201);
  const added = await w.call("PUT", path(relay, b.hash), { token: mac });
  expect(added.status).toBe(201);
  expect(added.body).toEqual({ relay, devices: [a.hash, b.hash].sort() });
  return { w, mac, relay, a, b };
}

const bytes = (b: ArrayBuffer) => [...new Uint8Array(b)];
const framed = (device: string, body: number[]) => new Uint8Array([...Buffer.from(device, "hex"), ...body]);

afterEach(() => vi.restoreAllMocks());

describe("phone relay", () => {
  it("lets a Mac and two phones meet and pass frames both ways, keeping and logging none", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args));
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    expect(m.texts.map((t) => JSON.parse(t))).toEqual([{ device: a.hash, peer: "joined" }, { device: b.hash, peer: "joined" }]);
    // A canary no frame may leave behind.
    const canary = [0xca, 0x4a, 0x41, 0x52, 0x59, 0x5f, 0x34, 0x32];
    pa.ws.send(new Uint8Array(canary));
    pb.ws.send(new Uint8Array(MAX_ENVELOPE_BYTES).fill(7));
    await until(() => m.frames.length === 2);
    const fromA = m.frames.find((f) => f.byteLength === 32 + canary.length)!;
    expect(hex(new Uint8Array(fromA, 0, 32))).toBe(a.hash);
    expect(bytes(fromA.slice(32))).toEqual(canary);
    const fromB = m.frames.find((f) => f.byteLength === 32 + MAX_ENVELOPE_BYTES)!;
    expect(hex(new Uint8Array(fromB, 0, 32))).toBe(b.hash);
    m.ws.send(framed(a.hash, [9, 9]));
    m.ws.send(new Uint8Array([...framed(b.hash, []), ...new Uint8Array(MAX_ENVELOPE_BYTES).fill(8)]));
    await until(() => pa.frames.length === 1 && pb.frames.length === 1);
    expect(bytes(pa.frames[0]!)).toEqual([9, 9]);
    expect(pb.frames[0]!.byteLength).toBe(MAX_ENVELOPE_BYTES);
    // A frame for a device that isn't there is dropped.
    m.ws.send(framed("ab".repeat(32), [1]));
    pa.ws.send("ping");
    await until(() => pa.texts.includes("pong"));
    pb.ws.close(1000);
    await until(() => m.texts.length === 3);
    expect(JSON.parse(m.texts[2]!)).toEqual({ device: b.hash, peer: "left" });
    expect([m.closed, pa.closed]).toEqual([null, null]);
    expect(pa.frames.length).toBe(1);

    const stored = await runInDurableObject(stub(relay), async (_i, state) => [...(await state.storage.list()).values()]);
    const kept = JSON.stringify(stored) + JSON.stringify(await env.DB.prepare("SELECT * FROM relays, relay_devices").all());
    expect(kept).not.toContain(canary.join(","));
    expect(kept).not.toContain(a.token);
    expect(JSON.stringify(logged)).not.toContain(canary.join(","));
  });

  it("refuses a wrong token, and closes and refuses a forgotten one", async () => {
    const { w, mac, relay, a, b } = await paired();
    expect((await open(w, relay, (await phone()).token)).status).toBe(401);
    expect((await open(w, newRelay(), a.token)).status).toBe(401);
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    expect((await w.call("DELETE", path(relay, a.hash), { token: mac })).status).toBe(204);
    await until(() => pa.closed !== null);
    expect(pa.closed!.code).toBe(4001);
    await until(() => m.texts.length === 3);
    expect(JSON.parse(m.texts[2]!)).toEqual({ device: a.hash, peer: "left" });
    expect((await open(w, relay, a.token)).status).toBe(401);
    expect((await w.call("DELETE", path(relay, a.hash), { token: mac })).status).toBe(404);
    expect([m.closed, pb.closed]).toEqual([null, null]);
    expect((await w.call("PUT", path(relay), { token: mac })).body).toEqual({ relay, devices: [b.hash] });
    // Told once.
    expect(m.texts.length).toBe(3);
  });

  it("lets only a member's Mac own a relay, by default", async () => {
    const { w, mac, relay, a } = await paired();
    const other = await w.obiToken("obi-ernesto");
    expect((await w.call("PUT", path(relay), { token: other })).status).toBe(409);
    expect((await w.call("PUT", path(relay, (await phone()).hash), { token: other })).status).toBe(403);
    expect((await w.call("DELETE", path(relay, a.hash), { token: other })).status).toBe(403);
    expect((await open(w, relay, other)).status).toBe(403);
    expect((await w.call("PUT", path(newRelay()), { token: await w.ownerToken() })).body.error.code).toBe("forbidden");
    expect((await w.call("PUT", path(newRelay()), { token: await w.obiToken("obi-wellington", "directory:read") })).body.error.code).toBe("insufficient_scope");
    expect((await w.call("PUT", path(newRelay()), { token: "not-a-token-0123456789abcdefghijklmnop" })).status).toBe(401);
    // A Mac that isn't a member has only a relay assertion, and this server takes none.
    const stranger = await newKey();
    const refused = await w.call("PUT", path(relay), { token: await assertion(w, stranger, relay) });
    expect([refused.status, refused.body.error.code]).toEqual([403, "forbidden"]);
    expect((await open(w, relay, await assertion(w, stranger, relay))).status).toBe(403);
    // Wellington's Obi revoked: its tokens open nothing, and its phones find no Mac.
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken() })).status).toBe(200);
    expect((await open(w, relay, mac)).status).toBe(401);
    const pa = side(await open(w, relay, a.token));
    await until(() => pa.closed !== null);
    expect(pa.closed!.code).toBe(4008);
  });

  it("checks paths, upgrades and how many relays and devices", async () => {
    const { w, mac, relay } = await paired();
    expect((await w.call("PUT", path("short"), { token: mac })).status).toBe(400);
    expect((await w.call("PUT", path(relay, "A".repeat(64)), { token: mac })).status).toBe(400);
    expect((await open(w, relay, mac, { upgrade: false })).status).toBe(400);
    expect((await open(w, newRelay(), mac)).status).toBe(404);
    expect((await w.call("DELETE", path(newRelay()), { token: mac })).status).toBe(404);
    expect((await w.call("PUT", path(relay), { token: mac })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await w.call("PUT", path(newRelay()), { token: mac })).status).toBe(201);
    const fifth = await w.call("PUT", path(newRelay()), { token: mac });
    expect([fifth.status, fifth.headers.get("Retry-After")]).toEqual([429, null]);
    for (let i = 0; i < 14; i++) expect((await w.call("PUT", path(relay, (await phone()).hash), { token: mac })).status).toBe(201);
    expect((await w.call("PUT", path(relay, (await phone()).hash), { token: mac })).status).toBe(429);
  });

  it("lets anyone with an owner key own a relay with a fresh assertion, on owner_keys", async () => {
    const w = new World();
    const call = makeCall(w.clock, OPEN_ENV);
    const key = await newKey();
    const relay = newRelay();
    const first = await assertion(w, key, relay);
    expect((await call("PUT", path(relay), { token: first })).status).toBe(201);
    expect((await call("PUT", path(relay), { token: first })).status).toBe(401);
    expect((await call("PUT", path(relay), { token: await assertion(w, key, newRelay()) })).status).toBe(401);
    expect((await call("PUT", path(relay), { token: await assertion(w, key, relay, { exp: w.clock.s + 301 }) })).status).toBe(401);
    expect((await call("PUT", path(relay), { token: await assertion(w, key, relay, { iat: w.clock.s - 400, exp: w.clock.s - 100 }) })).status).toBe(401);
    expect((await call("PUT", path(relay), { token: await assertion(w, key, relay, { iss: (await newKey()).publicKey }) })).status).toBe(401);
    // Another key's relay.
    expect((await call("PUT", path(relay), { token: await assertion(w, await newKey(), relay) })).status).toBe(409);
    const p = await phone();
    expect((await call("PUT", path(relay, p.hash), { token: await assertion(w, key, relay) })).status).toBe(201);
    const m = side(await open(w, relay, await assertion(w, key, relay), { env: OPEN_ENV }));
    const ph = side(await open(w, relay, p.token, { env: OPEN_ENV }));
    await until(() => m.texts.length === 1);
    ph.ws.send(new Uint8Array([5]));
    m.ws.send(framed(p.hash, [6]));
    await until(() => m.frames.length === 1 && ph.frames.length === 1);
    expect([bytes(m.frames[0]!.slice(32)), bytes(ph.frames[0]!)]).toEqual([[5], [6]]);
    // A member's Mac still uses its token there.
    const t = await team();
    expect((await makeCall(t.clock, OPEN_ENV)("PUT", path(newRelay()), { token: await t.obiToken("obi-wellington") })).status).toBe(201);
  });

  it("closes a phone when the Mac isn't there, and every phone when it leaves", async () => {
    const { w, mac, relay, a, b } = await paired();
    const early = side(await open(w, relay, a.token));
    await until(() => early.closed !== null);
    expect(early.closed!.code).toBe(4008);
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    m.ws.close(1000);
    await until(() => pa.closed !== null && pb.closed !== null);
    expect([pa.closed!.code, pb.closed!.code]).toEqual([4008, 4008]);
  });

  it("keeps one socket each: a new one replaces the earlier, and a new Mac socket keeps the phones", async () => {
    const { w, mac, relay, a } = await paired();
    const m1 = side(await open(w, relay, mac));
    const p1 = side(await open(w, relay, a.token));
    const p2 = side(await open(w, relay, a.token));
    await until(() => p1.closed !== null);
    expect(p1.closed!.code).toBe(4003);
    // A Mac renewing its token: a new socket with a new one.
    const m2 = side(await open(w, relay, await w.obiToken("obi-wellington")));
    await until(() => m1.closed !== null && m2.texts.length === 1);
    expect(m1.closed!.code).toBe(4003);
    expect(JSON.parse(m2.texts[0]!)).toEqual({ device: a.hash, peer: "joined" });
    p2.ws.send(new Uint8Array([1]));
    await until(() => m2.frames.length === 1);
    expect([p2.closed, m1.texts.filter((t) => t.includes('"left"'))]).toEqual([null, []]);
  });

  it("closes a socket that sends a frame over its size, or text", async () => {
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    const pb = side(await open(w, relay, b.token));
    await until(() => m.texts.length === 2);
    pa.ws.send(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
    pb.ws.send("hello");
    await until(() => pa.closed !== null && pb.closed !== null);
    expect([pa.closed!.code, pb.closed!.code]).toEqual([1009, 4004]);
    m.ws.send(new Uint8Array(32 + MAX_ENVELOPE_BYTES + 1));
    await until(() => m.closed !== null);
    expect(m.closed!.code).toBe(1009);
  });

  it("closes the socket that floods the relay, by frames and by bytes", async () => {
    const { w, mac, relay, a } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    // This minute's first 2,995 frames, counted without sending them (each costs the test runner milliseconds).
    await runInDurableObject(stub(relay), (relayObject: PhoneRelay) => {
      (relayObject as unknown as { minute: object }).minute = { start: Date.now(), frames: MAX_FRAMES_PER_MINUTE - 5, bytes: 0 };
    });
    for (let i = 0; i < 6; i++) pa.ws.send(new Uint8Array([i]));
    await until(() => pa.closed !== null);
    expect(pa.closed!.code).toBe(4009);
    await until(() => m.frames.length === 5);

    const second = newRelay();
    expect((await w.call("PUT", path(second), { token: mac })).status).toBe(201);
    const m2 = side(await open(w, second, mac));
    // 129 frames of 256 KiB pass 32 MiB.
    for (let i = 0; i < 129; i++) m2.ws.send(new Uint8Array(32 + MAX_ENVELOPE_BYTES));
    await until(() => m2.closed !== null, 1000);
    expect(m2.closed!.code).toBe(4009);
  });

  it("closes a revoked or expired Mac, a forgotten phone and an idle socket within a minute", async () => {
    const { w, mac, relay, a, b } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    await runDurableObjectAlarm(stub(relay));
    expect([m.closed, pa.closed]).toEqual([null, null]);
    // A card rotation revokes the Obi's tokens.
    await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sha256 = ?1").bind(await sha256Hex(utf8(mac))).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => m.closed !== null && pa.closed !== null);
    expect([m.closed!.code, pa.closed!.code]).toEqual([4001, 4008]);

    const fresh = await w.obiToken("obi-wellington");
    const m2 = side(await open(w, relay, fresh));
    const pb = side(await open(w, relay, b.token));
    await until(() => m2.texts.length === 1);
    // Forgotten behind the relay's back: the alarm finds it.
    await env.DB.prepare("DELETE FROM relay_devices WHERE token_sha256 = ?1").bind(b.hash).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => pb.closed !== null);
    expect(pb.closed!.code).toBe(4001);
    await env.DB.prepare("UPDATE tokens SET expires_at_s = 0 WHERE sha256 = ?1").bind(await sha256Hex(utf8(fresh))).run();
    await runDurableObjectAlarm(stub(relay));
    await until(() => m2.closed !== null);
    expect(m2.closed!.code).toBe(4007);

    const m3 = side(await open(w, relay, await w.obiToken("obi-wellington")));
    const pa3 = side(await open(w, relay, a.token));
    await until(() => m3.texts.length === 1);
    pa3.ws.send("ping");
    await until(() => pa3.texts.includes("pong"));
    // The Mac sent nothing for 3 minutes; the phone pinged just now.
    await runInDurableObject(stub(relay), async (_i, state) => {
      for (const ws of state.getWebSockets("mac")) ws.serializeAttachment({ ...ws.deserializeAttachment(), last: Date.now() - 3 * 60_000 });
      for (const ws of state.getWebSockets(a.hash)) ws.serializeAttachment({ ...ws.deserializeAttachment(), last: Date.now() - 3 * 60_000 });
    });
    await runDurableObjectAlarm(stub(relay));
    await until(() => m3.closed !== null && pa3.closed !== null);
    expect([m3.closed!.code, pa3.closed!.code]).toEqual([4006, 4008]);
  });

  it("closes everything on a relay its Mac deletes, and forgets it", async () => {
    const { w, mac, relay, a } = await paired();
    const m = side(await open(w, relay, mac));
    const pa = side(await open(w, relay, a.token));
    await until(() => m.texts.length === 1);
    expect((await w.call("DELETE", path(relay), { token: mac })).status).toBe(204);
    await until(() => m.closed !== null && pa.closed !== null);
    expect([m.closed!.code, pa.closed!.code]).toEqual([4001, 4001]);
    expect((await open(w, relay, a.token)).status).toBe(401);
    expect((await w.call("PUT", path(relay, a.hash), { token: mac })).status).toBe(404);
  });

  it("lets a socket open at most 30 times in 10 minutes", async () => {
    const { w, mac, relay } = await paired();
    for (let i = 0; i < 30; i++) side(await open(w, relay, mac));
    const refused = await open(w, relay, mac);
    expect([refused.status, refused.headers.get("Retry-After")]).toEqual([429, "60"]);
  });
});
