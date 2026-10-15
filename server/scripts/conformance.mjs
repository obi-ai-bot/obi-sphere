#!/usr/bin/env node
// `pnpm run conformance`: the spec's conformance runner, in implementation mode, against the
// server's checker (conformance/check.ts), for every case kind. Extra arguments go to the runner
// (like --verbose). Needs ../spec's packages installed (`pnpm install --frozen-lockfile` in spec/).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(server, "..", "spec");
const checker = `"${process.execPath}" "${join(server, "conformance", "check.ts")}"`;
const args = process.argv.slice(2).filter((a) => a !== "--");
const r = spawnSync(process.execPath, [join(spec, "conformance", "run.mjs"), "--impl", checker, ...args], { cwd: spec, stdio: "inherit" });
process.exit(r.status ?? 1);
