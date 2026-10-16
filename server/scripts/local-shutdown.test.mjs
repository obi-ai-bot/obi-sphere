// Real launcher regression: signal the documented launcher's PID, never its process group. In
// particular, signalling a package-manager wrapper can orphan the Worker.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function groupMembers(pid) {
  // Ignore zombies: they have exited, and init reaps them independently.
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\n")
    .map((row) => row.trim().split(/\s+/)).filter(([, group, state]) => Number(group) === pid && !state.startsWith("Z"));
}
async function until(probe, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await probe()) return;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail(message());
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`launcher PID-only ${signal} stops the Sphere and all descendants`, { timeout: 90_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "sphere-shutdown-"));
    const port = await freePort();
    for (const dir of ["home", "tmp"]) mkdirSync(join(root, dir));
    let output = "";
    const child = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", join(root, "state")], {
      cwd: server, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        SPHERE_OPERATOR_TOKEN: randomBytes(32).toString("hex"), WRANGLER_SEND_METRICS: "false" },
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { output += error.message; });
    const alive = async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/v0.1/health`, { signal: AbortSignal.timeout(500) })).status === 200; }
      catch { return false; }
    };
    try {
      await until(alive, 60_000, () => `Sphere never became ready:\n${output}`);
      assert(child.kill(signal), "launcher could not be signalled");
      await until(async () => (child.exitCode !== null || child.signalCode !== null) && !(await alive()) && groupMembers(child.pid).length === 0,
        10_000, () => `Sphere survived ${signal}; group ${JSON.stringify(groupMembers(child.pid))}:\n${output}`);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      await sleep(100);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
