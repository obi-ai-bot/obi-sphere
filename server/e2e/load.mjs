#!/usr/bin/env node
// Concurrent sends against a real local Sphere (`pnpm run local`), started as the scenario starts
// it, with the scripted client: one Sphere, two Obis, then `--sends` valid review_requests from B
// to A fired at once. It prints how the sends were answered and checks the chain afterwards.
//
//   pnpm run load                       (node e2e/load.mjs, 200 concurrent sends)
//   pnpm run load -- --sends 400
//
// Exit 0 only when every send was answered 202 and the chain holds every one of them, each seq
// once, and verifies (spec/conformance/lib verifyChain).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Obi, Owner, SphereClient, directoryKeys, spec } from "./client.mjs";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const sendsArg = args.indexOf("--sends") === -1 ? "200" : args[args.indexOf("--sends") + 1];
if (!/^[0-9]{1,5}$/.test(sendsArg ?? "") || Number(sendsArg) < 1) {
  console.error("usage: pnpm run load -- [--sends <n>]");
  process.exit(64);
}
const SENDS = Number(sendsArg);
const SCOPES = "send:review_request reply receive directory:read audit:read";
const BRIEF = { goal: "Load", repo: "obi-e2e/fixture-app", base_branch: "main", head_branch: "feature/average", head_sha: "6d20146f366b9fac8907b5066c30ee39aaec09b3", acceptance: [{ kind: "tests_pass" }] };

const run = mkdtempSync(join(tmpdir(), "obi-sphere-load-"));
for (const d of ["state", "home", "tmp"]) mkdirSync(join(run, d), { recursive: true });
const logPath = join(run, "sphere.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

const port = await freePort();
const operatorToken = randomBytes(32).toString("base64url");
const log = createWriteStream(logPath, { flags: "a" });
const child = spawn("pnpm", ["run", "local", "--", "--port", String(port), "--persist-to", join(run, "state")], {
  cwd: SERVER_DIR,
  env: { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: join(run, "home"), TMPDIR: join(run, "tmp"), WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
const exited = new Promise((res) => child.on("exit", res));

let ok = false;
try {
  const c = new SphereClient(`http://127.0.0.1:${port}`, "load");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await c.call("GET", "/v0.1/health")).status === 200) break;
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the Sphere didn't come up (see ${logPath})`);
    await sleep(250);
  }
  const W = new Owner(c, "wellington");
  const E = new Owner(c, "ernesto");
  const expect = (r, status, what) => {
    if (r.status !== status) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  expect(await c.call("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: "load", name: "Load", admin: { owner: "wellington", owner_key: W.key.publicKey } } }), 201, "create");
  const admin = async () => (await W.token("admin directory:read audit:read")).access_token;
  expect(
    await c.call("PUT", c.spherePath("/policy"), { token: await admin(), body: { expected_version: 0, rules: [{ id: "all", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["*"] }] } }),
    200, "policy",
  );
  const A = new Obi(c, "obi-wellington", W);
  const B = new Obi(c, "obi-ernesto", E);
  for (const obi of [A, B]) {
    const inv = expect(await c.call("POST", c.spherePath("/invitations"), { token: await admin(), body: { owner: obi.owner.id, obi: obi.id, expires_in: 3600 } }), 201, "invite");
    const card = obi.owner.card(obi, { name: obi.id, accepts: ["review_request"] });
    expect(await c.call("POST", c.spherePath(`/invitations/${inv.invitation_id}/redeem`), { body: { secret: inv.secret, owner_key: obi.owner.key.publicKey, card } }), 201, "redeem");
    obi.delegation = obi.owner.assertion(SCOPES, { lifetime: 3600, mayAct: obi.id });
    await obi.exchange();
  }

  const envelopes = Array.from({ length: SENDS }, () => B.request(A.id, "review_request", BRIEF));
  const started = Date.now();
  const answers = await Promise.all(envelopes.map((e) => B.send(e)));
  const elapsed = Date.now() - started;
  const tally = {};
  for (const a of answers) {
    const k = a.status === 202 ? "202" : `${a.status}:${a.body?.error?.code ?? "?"}`;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  console.log(`${SENDS} concurrent sends answered in ${elapsed} ms: ${JSON.stringify(tally)}`);

  const members = expect(await c.call("GET", c.spherePath("/members"), { token: await admin() }), 200, "members").members;
  const entries = [];
  for (let from = 1; ; ) {
    const page = expect(await c.call("GET", c.spherePath(`/audit?from_seq=${from}&limit=1000`), { token: await admin() }), 200, "audit");
    entries.push(...page.entries);
    if (page.entries.length === 0 || entries.length >= page.head.seq) break;
    from = entries.length + 1;
  }
  const v = spec.verifyChain({ sphere: "load", entries }, { keys: directoryKeys(members) });
  const recorded = new Set(entries.map((e) => e.envelope.id));
  const accepted = answers.filter((a) => a.status === 202);
  const seqs = new Set(accepted.map((a) => a.body.seq));
  console.log(`chain: ${entries.length} entries, verifyChain ${v.ok ? "ok" : `${v.code} ${v.message}`}`);
  ok = accepted.length === SENDS && v.ok && entries.length === SENDS && seqs.size === SENDS && envelopes.every((e) => recorded.has(e.id));
  console.log(ok ? "PASS" : "FAIL");
} catch (e) {
  console.log(`FAIL ${e.message}`);
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, sleep(10_000)]);
  if (!ok) console.log(`  --- the last lines of ${logPath}:\n${readFileSync(logPath, "utf8").split("\n").slice(-20).join("\n")}`);
  rmSync(run, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
