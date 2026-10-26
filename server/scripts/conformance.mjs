#!/usr/bin/env node
// `pnpm run conformance`: the spec's conformance runner, in implementation mode, against the
// server's checker (conformance/check.ts), for the case kinds a Sphere judges: envelopes, cards,
// chains and wire bodies (not host_approval, a receiving Oby's own decision). Extra arguments go to the runner
// (like --verbose). Needs ../spec's packages installed (`pnpm install --frozen-lockfile` in spec/).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(server, "..", "spec");
const checker = `"${process.execPath}" "${join(server, "conformance", "check.ts")}"`;
const args = process.argv.slice(2).filter((a) => a !== "--");
const r = spawnSync(process.execPath, [join(spec, "conformance", "run.mjs"), "--impl", checker, "--kinds", "envelope,card,audit,wire", ...args], { cwd: spec, stdio: "inherit" });
process.exit(r.status ?? 1);
