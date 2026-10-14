#!/usr/bin/env node
// `pnpm run local -- --port <port> --persist-to <dir>`: a Sphere on this machine
// (spec/sphere-api.md section 8). It applies the D1 migrations to the local database under
// --persist-to, then runs `wrangler dev` on 127.0.0.1:<port> with the same --persist-to, the
// operator token from SPHERE_OPERATOR_TOKEN passed as a Worker variable (never written to a file).
// It stops on SIGINT or SIGTERM. Wrangler sends no metrics.
//
// Options: --port <n> (default 8787), --persist-to <dir> (default .wrangler/state, wrangler's
// own). A lone `--` (pnpm passes it through) is ignored.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${name} needs a value`);
  return v;
};
function usage(message) {
  console.error(`local: ${message}\nusage: pnpm run local -- [--port <port>] [--persist-to <dir>]`);
  process.exit(64);
}
for (let i = 0; i < args.length; i += 2) if (!["--port", "--persist-to"].includes(args[i])) usage(`unknown argument ${args[i]}`);

const port = opt("--port", "8787");
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) usage("--port must be a port number");
const persistTo = resolve(opt("--persist-to", join(server, ".wrangler", "state")));
mkdirSync(persistTo, { recursive: true });

const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
// Wrangler's own settings: no metrics, no update check, no colours in logs.
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true", NO_UPDATE_NOTIFIER: "1", FORCE_COLOR: "0", CI: process.env.CI ?? "1" };

let child = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(signal);
    else process.exit(0);
  });
}

function run(argv, label) {
  return new Promise((resolveRun) => {
    child = spawn(process.execPath, [wrangler, ...argv], { cwd: server, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code, signal) => resolveRun({ code, signal }));
    child.on("error", (e) => {
      console.error(`local: ${label} failed to start: ${e.message}`);
      resolveRun({ code: 1, signal: null });
    });
  });
}

const migrated = await run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo], "migrations");
if (stopping) process.exit(0);
if (migrated.code !== 0) {
  console.error("local: applying the D1 migrations failed");
  process.exit(migrated.code ?? 1);
}

const token = process.env.SPHERE_OPERATOR_TOKEN;
const vars = token ? ["--var", `SPHERE_OPERATOR_TOKEN:${token}`] : [];
if (!token) console.error("local: SPHERE_OPERATOR_TOKEN is not set: every operator call (creating a Sphere) will be refused");
const served = await run(["dev", "--ip", "127.0.0.1", "--port", port, "--persist-to", persistTo, "--local", "--show-interactive-dev-session=false", ...vars], "wrangler dev");
process.exit(stopping ? 0 : (served.code ?? 0));
