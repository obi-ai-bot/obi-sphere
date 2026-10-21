// Running a job on another Obi's Mac (spec/protocol.md sections 5.10 to 5.13, 13 and 14;
// sphere-api.md sections 6.3 and 6.4): run_request exchanges, runner status in the directory, and
// the job channel's relay.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { runnerSigningInput } from "../src/routes/runner";
import { BASE, TEAM_REVIEWS, World, expectSchema, type Key } from "./helpers";

const RUN = {
  title: "Write tests for average()",
  request: "Add tests for average(), including the empty list.\nOBI-E2E-DATA-CANARY: this text is data for the sender's own agent.",
  agent: "claude",
  repo: "obi-e2e/fixture-app",
  base_branch: "main",
  base_sha: "6d20146f366b9fac8907b5066c30ee39aaec09b3",
  branch: "oby/tests-average",
  bundle: { sha256: "9".repeat(64), bytes: 48213 },
  size: "small",
  max_minutes: 120,
};
const RUN_RESULT = { for: "run_request", outcome: "done", repo: "obi-e2e/fixture-app", host: { wall_seconds: 840, cpu_seconds: 1900, peak_memory_mb: 2500 } };
const TEAM_RUNS = { id: "team-runs", from_owner: "*", to_owner: "*", actions: ["run_request"], repos: ["*"] };

/** Ernesto's Obi (the guest) and Wellington's (the host, whose Mac runs the job), with a policy that allows run_request. */
async function sharing(sphere = "e2e"): Promise<World> {
  const w = new World(sphere);
  expect((await w.create()).status).toBe(201);
  expect((await w.join("wellington", "obi-wellington", ["review_request", "run_request"])).status).toBe(201);
  expect((await w.join("ernesto", "obi-ernesto", ["review_request"])).status).toBe(201);
  expect((await w.join("sangam", "obi-sangam", ["review_request"])).status).toBe(201);
  expect((await w.putPolicy([TEAM_REVIEWS, TEAM_RUNS])).status).toBe(200);
  return w;
}

/** A run_request from ernesto to wellington. It lives 20 days: the relay's own checks use the real clock. */
const runRequest = (w: World) => w.envelope("obi-ernesto", "obi-wellington", "run_request", RUN, { expires_at: w.clock.ts(20 * 86400) });

describe("run_request exchanges", () => {
  it("relays a run_request, its progress, accept and result", async () => {
    const w = await sharing();
    const guest = await w.obiToken("obi-ernesto");
    const host = await w.obiToken("obi-wellington");
    const req = await runRequest(w);
    expect((await w.send(req, guest)).status).toBe(202);
    for (const [type, body] of [["run_progress", { state: "queued" }], ["accept", {}], ["run_progress", { state: "running" }], ["run_progress", { state: "paused" }], ["result", RUN_RESULT]] as const) {
      expect((await w.send(await w.reply(req, type, body), host)).status).toBe(202);
    }
  });

  it("needs the send:run_request scope", async () => {
    const w = await sharing();
    const token = await w.obiToken("obi-ernesto", "send:review_request reply receive");
    const r = await w.send(await runRequest(w), token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
  });

  it("goes only to an Obi whose card accepts run_request", async () => {
    const w = await sharing();
    const r = await w.send(await w.envelope("obi-wellington", "obi-ernesto", "run_request", RUN), await w.obiToken("obi-wellington"));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("policy_denied");
  });

  it("lets only the request's sender cancel it, and nothing follows", async () => {
    const w = await sharing();
    const guest = await w.obiToken("obi-ernesto");
    const host = await w.obiToken("obi-wellington");
    const req = await runRequest(w);
    await w.send(req, guest);
    const byHost = await w.send(await w.reply(req, "run_cancel", {}), host);
    expect(byHost.status).toBe(409);
    expect(byHost.body.error.code).toBe("bad_reply");
    const cancel = await w.envelope("obi-ernesto", "obi-wellington", "run_cancel", { note: "Not needed." }, { correlation_id: req.id, in_reply_to: req.id });
    expect((await w.send(cancel, guest)).status).toBe(202);
    expect((await w.send(await w.reply(req, "accept", {}), host)).status).toBe(409);
  });

  it("refuses a run_return before the accept, and anything after it", async () => {
    const w = await sharing();
    const guest = await w.obiToken("obi-ernesto");
    const host = await w.obiToken("obi-wellington");
    const req = await runRequest(w);
    await w.send(req, guest);
    const early = await w.send(await w.reply(req, "run_return", { reason: "owner_back", minutes: 3 }), host);
    expect(early.status).toBe(409);
    await w.send(await w.reply(req, "accept", {}), host);
    expect((await w.send(await w.reply(req, "run_return", { reason: "owner_back", minutes: 18 }), host)).status).toBe(202);
    expect((await w.send(await w.reply(req, "run_progress", { state: "running" }), host)).status).toBe(409);
  });

  it("keeps run_progress out of a review's exchange", async () => {
    const w = await sharing();
    const req = await w.envelope("obi-ernesto", "obi-wellington", "review_request", {
      goal: "A review", repo: "obi-e2e/fixture-app", base_branch: "main", head_branch: "f", head_sha: RUN.base_sha, acceptance: [{ kind: "tests_pass" }],
    });
    expect((await w.send(req, await w.obiToken("obi-ernesto"))).status).toBe(202);
    const r = await w.send(await w.reply(req, "run_progress", { state: "running" }), await w.obiToken("obi-wellington"));
    expect(r.status).toBe(409);
  });
});

/** A runner status for `obi`, signed with its key. */
async function runnerStatus(w: World, obi: string, over: Record<string, unknown> = {}, key?: Key): Promise<Record<string, unknown>> {
  const k = key ?? w.obis.get(obi)!.key;
  const unsigned: Record<string, unknown> = {
    protocol: "obi/0.1", sphere: w.sphere, obi, free: true, slots: 1, size: "small", agents: ["claude", "codex"], kinds: ["job"], for: ["ernesto"],
    created_at: w.clock.ts(), expires_at: w.clock.ts(600), key_id: k.keyId, ...over,
  };
  return { ...unsigned, signature: await k.sign(runnerSigningInput(unsigned as never)) };
}

describe("runner status", () => {
  it("is shown only to the owners it is offered to, and the Mac's own owner", async () => {
    const w = await sharing();
    const host = await w.obiToken("obi-wellington");
    const status = await runnerStatus(w, "obi-wellington", { for: ["ernesto", "wellington"] });
    const put = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/runner", { token: host, body: status });
    expect(put.status).toBe(200);
    expectSchema("member", put.body);
    expect(put.body.runner).toEqual(status);

    const ernesto = await w.call("GET", "/v0.1/spheres/e2e/members", { token: await w.obiToken("obi-ernesto") });
    expectSchema("membersResponse", ernesto.body);
    expect(ernesto.body.members.find((m: { obi: string }) => m.obi === "obi-wellington").runner).toEqual(status);
    // Sangam isn't offered it, and can't tell there is one.
    const sangam = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.obiToken("obi-sangam") });
    expect(sangam.status).toBe(200);
    expect(sangam.body.runner).toBeUndefined();
  });

  it("is for every member with for `*`, and gone once it expires", async () => {
    const w = await sharing();
    const host = await w.obiToken("obi-wellington");
    await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/runner", { token: host, body: await runnerStatus(w, "obi-wellington", { for: "*", expires_at: w.clock.ts(120) }) });
    const sangam = await w.obiToken("obi-sangam");
    expect((await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: sangam })).body.runner).toBeDefined();
    w.clock.advance(121);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.obiToken("obi-sangam") })).body.runner).toBeUndefined();
  });

  it("is published only by the Obi itself, signed with its current key, for at most 15 minutes", async () => {
    const w = await sharing();
    const path = "/v0.1/spheres/e2e/members/obi-wellington/runner";
    const other = await w.call("PUT", path, { token: await w.obiToken("obi-ernesto"), body: await runnerStatus(w, "obi-wellington") });
    expect(other.status).toBe(403);
    const host = await w.obiToken("obi-wellington");
    const forged = await runnerStatus(w, "obi-wellington", {}, w.obis.get("obi-ernesto")!.key);
    expect((await w.call("PUT", path, { token: host, body: forged })).body.error.code).toBe("unknown_key");
    const tampered = { ...(await runnerStatus(w, "obi-wellington")), slots: 3 };
    expect((await w.call("PUT", path, { token: host, body: tampered })).body.error.code).toBe("bad_signature");
    const long = await runnerStatus(w, "obi-wellington", { expires_at: w.clock.ts(901) });
    expect((await w.call("PUT", path, { token: host, body: long })).status).toBe(400);
    const away = { ...(await runnerStatus(w, "obi-wellington")), away: true };
    expect((await w.call("PUT", path, { token: host, body: away })).status).toBe(400);
  });

  it("is always shown to the Mac's own owner, never from the future, and only an active member's", async () => {
    const w = await sharing("e2e-runner-own");
    const host = await w.obiToken("obi-wellington");
    const path = `/v0.1/spheres/${w.sphere}/members/obi-wellington/runner`;
    // Offered to ernesto only: wellington's own Obi still sees it.
    const put = await w.call("PUT", path, { token: host, body: await runnerStatus(w, "obi-wellington", { sphere: w.sphere, for: ["ernesto"] }) });
    expect(put.status).toBe(200);
    expect(put.body.runner).toBeDefined();
    const future = await runnerStatus(w, "obi-wellington", { sphere: w.sphere, created_at: w.clock.ts(301), expires_at: w.clock.ts(900) });
    const refused = await w.call("PUT", path, { token: host, body: future });
    expect(refused.status).toBe(400);
    // A member revoked without its status taken away (an older Sphere left it): nobody sees it.
    await env.DB.prepare("UPDATE members SET status = 'revoked' WHERE sphere = ?1 AND obi = 'obi-wellington'").bind(w.sphere).run();
    const seen = await w.call("GET", `/v0.1/spheres/${w.sphere}/members`, { token: await w.obiToken("obi-ernesto") });
    expect(seen.body.members.find((m: { obi: string }) => m.obi === "obi-wellington")?.runner).toBeUndefined();
  });

  it("goes with DELETE, and with the member's revocation", async () => {
    const w = await sharing();
    const host = await w.obiToken("obi-wellington");
    const path = "/v0.1/spheres/e2e/members/obi-wellington/runner";
    await w.call("PUT", path, { token: host, body: await runnerStatus(w, "obi-wellington") });
    expect((await w.call("DELETE", path, { token: host })).body.runner).toBeUndefined();
    await w.call("PUT", path, { token: host, body: await runnerStatus(w, "obi-wellington") });
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken() })).status).toBe(200);
    const after = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.obiToken("obi-ernesto") });
    expect(after.body.runner).toBeUndefined();
  });
});

/** Opens one side of the exchange's channel with `token`. */
async function connect(w: World, correlationId: string, token: string, upgrade = true): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (upgrade) headers.Upgrade = "websocket";
  return handle(new Request(`${BASE}/v0.1/spheres/${w.sphere}/channels/${correlationId}`, { headers }), env, { now: w.clock.now });
}

interface Side {
  ws: WebSocket;
  texts: string[];
  frames: ArrayBuffer[];
  closed: { code: number } | null;
}

function side(res: Response): Side {
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const s: Side = { ws, texts: [], frames: [], closed: null };
  ws.accept();
  // The test's end of the socket gets binary frames as Blobs.
  ws.addEventListener("message", async (e) => {
    if (typeof e.data === "string") s.texts.push(e.data);
    else s.frames.push(e.data instanceof Blob ? await e.data.arrayBuffer() : (e.data as ArrayBuffer));
  });
  ws.addEventListener("close", (e) => (s.closed = { code: e.code }));
  return s;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

async function accepted(w: World) {
  const guest = await w.obiToken("obi-ernesto");
  const host = await w.obiToken("obi-wellington");
  const req = await runRequest(w);
  await w.send(req, guest);
  return { req, guest, host };
}

describe("job channels", () => {
  it("opens only once the run_request is accepted, only for its two Obis, only as a WebSocket", async () => {
    const w = await sharing();
    const { req, guest, host } = await accepted(w);
    const early = await connect(w, req.id as string, guest);
    expect(early.status).toBe(409);
    await w.send(await w.reply(req, "accept", {}), host);
    expect((await connect(w, req.id as string, await w.obiToken("obi-sangam"))).status).toBe(403);
    expect((await connect(w, req.id as string, guest, false)).status).toBe(400);
    expect((await connect(w, crypto.randomUUID(), guest)).status).toBe(404);
    const review = await w.envelope("obi-ernesto", "obi-wellington", "review_request", {
      goal: "A review", repo: "obi-e2e/fixture-app", base_branch: "main", head_branch: "f", head_sha: RUN.base_sha, acceptance: [{ kind: "tests_pass" }],
    });
    await w.send(review, guest);
    await w.send(await w.reply(review, "accept", {}), host);
    expect((await connect(w, review.id as string, guest)).status).toBe(404);
  });

  it("pairs the two sides and relays binary frames unchanged, each way", async () => {
    const w = await sharing();
    const { req, guest, host } = await accepted(w);
    await w.send(await w.reply(req, "accept", {}), host);
    const g = side(await connect(w, req.id as string, guest));
    const h = side(await connect(w, req.id as string, host));
    await until(() => g.texts.includes('{"peer":"joined"}') && h.texts.includes('{"peer":"joined"}'));
    g.ws.send(new Uint8Array([1, 2, 3, 255]));
    h.ws.send(new Uint8Array(262144).fill(7));
    await until(() => h.frames.length === 1 && g.frames.length === 1);
    expect([...new Uint8Array(h.frames[0]!)]).toEqual([1, 2, 3, 255]);
    expect(g.frames[0]!.byteLength).toBe(262144);
    g.ws.close(1000);
    await until(() => h.texts.includes('{"peer":"left"}'));
  });

  it("closes a side that sends text, or a frame over 256 KiB", async () => {
    const w = await sharing();
    const { req, guest, host } = await accepted(w);
    await w.send(await w.reply(req, "accept", {}), host);
    const g = side(await connect(w, req.id as string, guest));
    g.ws.send("hello");
    await until(() => g.closed !== null);
    expect(g.closed!.code).toBe(4004);
    const h = side(await connect(w, req.id as string, host));
    h.ws.send(new Uint8Array(262145));
    await until(() => h.closed !== null);
    expect(h.closed!.code).toBe(1009);
  });

  it("replaces a side's earlier connection with its new one", async () => {
    const w = await sharing();
    const { req, guest, host } = await accepted(w);
    await w.send(await w.reply(req, "accept", {}), host);
    const first = side(await connect(w, req.id as string, guest));
    const second = side(await connect(w, req.id as string, guest));
    await until(() => first.closed !== null);
    expect(first.closed!.code).toBe(4003);
    expect(second.closed).toBeNull();
  });

  it("closes both sides once the exchange ends, and when an Obi is revoked", async () => {
    for (const end of ["result", "revoke"] as const) {
      const w = await sharing(`e2e-${end}`);
      const { req, guest, host } = await accepted(w);
      await w.send(await w.reply(req, "accept", {}), host);
      const g = side(await connect(w, req.id as string, guest));
      const h = side(await connect(w, req.id as string, host));
      const relay = env.CHANNELS.get(env.CHANNELS.idFromName(`${w.sphere}/${req.id as string}`));
      await runDurableObjectAlarm(relay);
      expect(g.closed).toBeNull();
      if (end === "result") await w.send(await w.reply(req, "result", RUN_RESULT), host);
      else await w.call("DELETE", `/v0.1/spheres/${w.sphere}/members/obi-ernesto`, { token: await w.ownerToken() });
      await runDurableObjectAlarm(relay);
      await until(() => g.closed !== null && h.closed !== null);
      expect([g.closed!.code, h.closed!.code]).toEqual([4001, 4001]);
    }
  });
});

describe("job channel limits", () => {
  async function pair(name: string) {
    const w = await sharing(name);
    const { req, guest, host } = await accepted(w);
    await w.send(await w.reply(req, "accept", {}), host);
    const relay = env.CHANNELS.get(env.CHANNELS.idFromName(`${w.sphere}/${req.id as string}`));
    return { w, req, guest, host, relay };
  }

  it("closes both sides once either side's token is revoked (a card rotation does it)", async () => {
    const { w, req, guest, host, relay } = await pair("e2e-ch-token");
    const g = side(await connect(w, req.id as string, guest));
    const h = side(await connect(w, req.id as string, host));
    await runDurableObjectAlarm(relay);
    expect(g.closed).toBeNull();
    await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND actor = 'obi-ernesto'").bind(w.sphere).run();
    await runDurableObjectAlarm(relay);
    await until(() => g.closed !== null && h.closed !== null);
    expect([g.closed!.code, h.closed!.code]).toEqual([4001, 4001]);
  });

  it("closes a side whose other side doesn't join within 10 minutes", async () => {
    const { w, req, guest, relay } = await pair("e2e-ch-alone");
    const g = side(await connect(w, req.id as string, guest));
    await runDurableObjectAlarm(relay);
    expect(g.closed).toBeNull();
    await runInDurableObject(relay, async (_i, state) => state.storage.put("alone", Date.now() - 11 * 60_000));
    await runDurableObjectAlarm(relay);
    await until(() => g.closed !== null);
    expect(g.closed!.code).toBe(4005);
  });

  it("closes a channel that carried no frame for 5 minutes", async () => {
    const { w, req, guest, host, relay } = await pair("e2e-ch-idle");
    const g = side(await connect(w, req.id as string, guest));
    const h = side(await connect(w, req.id as string, host));
    await until(() => g.texts.includes('{"peer":"joined"}'));
    await runInDurableObject(relay, async (_i, state) => state.storage.put("last", Date.now() - 6 * 60_000));
    await runDurableObjectAlarm(relay);
    await until(() => g.closed !== null && h.closed !== null);
    expect([g.closed!.code, h.closed!.code]).toEqual([4006, 4006]);
  });

  it("lets a side open its channel at most 30 times in 10 minutes", async () => {
    const { w, req, guest } = await pair("e2e-ch-opens");
    for (let i = 0; i < 30; i++) side(await connect(w, req.id as string, guest));
    const refused = await connect(w, req.id as string, guest);
    expect(refused.status).toBe(429);
  });

  it("refuses a token from another Sphere", async () => {
    const { req } = await pair("e2e-ch-here");
    const there = await sharing("e2e-ch-there");
    const res = await handle(new Request(`${BASE}/v0.1/spheres/e2e-ch-here/channels/${req.id as string}`, {
      headers: { Authorization: `Bearer ${await there.obiToken("obi-ernesto")}`, Upgrade: "websocket" },
    }), env, { now: there.clock.now });
    expect(res.status).toBe(401);
  });
});
