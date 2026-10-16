#!/usr/bin/env node
// `node scripts/local.mjs --port <port> --persist-to <dir>`: a Sphere on this machine
// (spec/sphere-api.md section 8). It applies the D1 migrations to the local database under
// --persist-to (`wrangler d1 migrations apply`), then starts the Worker on 127.0.0.1:<port> with the
// same --persist-to through wrangler's own dev server (scripts/serve-local.mjs: its programmatic
// API, the one `wrangler dev` is built on), the operator token from SPHERE_OPERATOR_TOKEN passed as
// a Worker secret (never written to a file). It stops on SIGINT or SIGTERM, exiting 0. Wrangler
// sends no metrics.
//
// No DevTools inspector: `wrangler dev` always opens one (127.0.0.1:9229 or the next free port; its
// flags only move it, none turns it off). It takes no token, and a debugger attached to it runs code
// inside the Worker with the Sphere's D1 binding, around every check. Started through the API with
// `inspector: false`, the Worker has none. The other loopback ports wrangler opens are its own:
// the Worker's direct socket (the same Sphere, the same checks) and Miniflare's internal ones,
// which refuse any request without Miniflare's per-run secret (403).
//
// Wrangler's Local Explorer and local observability are turned off: on by default, they add
// endpoints under /cdn-cgi/local/explorer on the Sphere's own port that take no token and run any
// SQL, writes included, against the Sphere's D1. With them on, a local process could rewrite the
// policy, add tokens or members, or change audit rows without a single check. Off, every request
// goes through the Sphere's checks, as on a deployed Sphere (sphere-api.md section 8).
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
  console.error(`local: ${message}\nusage: node scripts/local.mjs [--port <port>] [--persist-to <dir>]`);
  process.exit(64);
}
for (let i = 0; i < args.length; i += 2) if (!["--port", "--persist-to"].includes(args[i])) usage(`unknown argument ${args[i]}`);

const port = opt("--port", "8787");
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) usage("--port must be a port number");
const persistTo = resolve(opt("--persist-to", join(server, ".wrangler", "state")));
mkdirSync(persistTo, { recursive: true });

const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
// Wrangler's own settings: no metrics, no update check, no colours in logs, and no Local Explorer
// or local observability (see the top of this file). These win over the caller's environment.
const childEnv = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  NO_UPDATE_NOTIFIER: "1",
  FORCE_COLOR: "0",
  CI: process.env.CI ?? "1",
  X_LOCAL_EXPLORER: "false",
  X_LOCAL_OBSERVABILITY: "false",
};
// A VS Code debug terminal makes wrangler attach its own debugger; not here.
delete childEnv.VSCODE_INSPECTOR_OPTIONS;

let child = null;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(signal);
    else process.exit(0);
  });
}

function run(script, argv, label) {
  return new Promise((resolveRun) => {
    child = spawn(process.execPath, [script, ...argv], { cwd: server, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code, signal) => resolveRun({ code, signal }));
    child.on("error", (e) => {
      console.error(`local: ${label} failed to start: ${e.message}`);
      resolveRun({ code: 1, signal: null });
    });
  });
}

const migrated = await run(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo], "migrations");
if (stopping) process.exit(0);
if (migrated.code !== 0) {
  console.error("local: applying the D1 migrations failed");
  process.exit(migrated.code ?? 1);
}

if (!process.env.SPHERE_OPERATOR_TOKEN) console.error("local: SPHERE_OPERATOR_TOKEN is not set: every operator call (creating a Sphere) will be refused");
const served = await run(join(server, "scripts", "serve-local.mjs"), [port, persistTo], "the dev server");
process.exit(stopping ? 0 : (served.code ?? 0));
