#!/usr/bin/env node
// `node scripts/deploy.mjs --env <name>`: deploys the Sphere server as wrangler.jsonc's environment
// <name> (docs/run-your-own.md), a person's step, never CI's. The first time, it makes everything:
//
// 1. The D1 database: `wrangler deploy` makes it when the environment's `d1_databases` has no
//    `database_id`, then the migrations are applied. Later runs apply new migrations first, just
//    before the deploy that needs them (docs/deploy-cloudflare.md, "Redeploying").
// 2. The operator token, when the Worker has none: 32 random bytes, given to `wrangler secret put`
//    on its standard input (never an argument, a file or the screen), and, on a Mac, saved in the
//    login Keychain as service `obi-sphere-operator-token`, account the server's host (the
//    environment's route, else its workers.dev name), where Oby finds it to create Obyspheres on
//    that server, and only there.
//
// `--env` is required: the top level is a template (wrangler.jsonc), and deploying it by mistake
// would replace a Worker of the same name. Wrangler sends no metrics.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const env = args[0] === "--env" ? args[1] : undefined;
if (!env || !/^[a-z0-9][a-z0-9-]*$/.test(env) || args.length !== 2) {
  console.error("usage: node scripts/deploy.mjs --env <name>   (an environment in wrangler.jsonc; see docs/run-your-own.md)");
  process.exit(64);
}

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
// The environment's account_id, for every command: `wrangler deploy` reads it from the environment,
// but `wrangler d1 …` doesn't (wrangler 4.150), and with more than one account it stops there.
const { unstable_readConfig } = await import("wrangler");
const config = unstable_readConfig({ config: join(server, "wrangler.jsonc"), env });
const accountId = config.account_id;
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_UPDATE_NOTIFIER: "1", ...(accountId && !process.env.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) };
const wrangler = (list, o = {}) =>
  spawnSync(process.execPath, [wranglerBin, ...list, "--env", env], { cwd: server, env: childEnv, stdio: o.input !== undefined || o.quiet ? ["pipe", "pipe", "pipe"] : "inherit", input: o.input, encoding: "utf8" });
const must = (list, what, o = {}) => {
  const r = wrangler(list, o);
  if (o.quiet) process.stdout.write(r.stdout + r.stderr);
  if (r.status !== 0) {
    console.error(`deploy: ${what} failed (wrangler ${list.join(" ")} --env ${env}).`);
    process.exit(1);
  }
  return r;
};

// Whether the database is there yet: listing its migrations fails with "Couldn't find a D1 DB" when it
// isn't. Any other failure stops here, before anything is deployed.
const listed = wrangler(["d1", "migrations", "list", "DB", "--remote"], { quiet: true });
const exists = listed.status === 0;
if (!exists && !/Couldn't find a D1 DB/.test(listed.stdout + listed.stderr)) {
  console.error(`deploy: the D1 database couldn't be read; nothing was deployed.\n${listed.stderr || listed.stdout}`);
  process.exit(1);
}
let deployed;
if (exists) {
  must(["d1", "migrations", "apply", "DB", "--remote"], "applying the migrations");
  deployed = must(["deploy"], "the deploy", { quiet: true });
} else {
  console.log(`deploy: the first deploy of ${env}: the Worker and its D1 database, then the migrations.`);
  deployed = must(["deploy"], "the deploy", { quiet: true });
  must(["d1", "migrations", "apply", "DB", "--remote"], "applying the migrations");
}
// The server's host, the operator token's Keychain account: Oby sends the token to that host only.
const route = config.routes?.[0];
const host = [(typeof route === "string" ? route : route?.pattern)?.split("/")[0], /https:\/\/([a-z0-9.-]+\.workers\.dev)/.exec(deployed.stdout)?.[1]].find((h) => h && /^[a-z0-9.-]+$/i.test(h));

const secrets = wrangler(["secret", "list", "--format", "json"], { quiet: true });
let names = [];
try {
  names = JSON.parse(secrets.stdout).map((s) => s.name);
} catch {
  console.error("deploy: the Worker's secrets couldn't be listed; set the operator token yourself: wrangler secret put SPHERE_OPERATOR_TOKEN --env " + env);
  process.exit(1);
}
if (!names.includes("SPHERE_OPERATOR_TOKEN")) {
  const token = randomBytes(32).toString("base64url");
  const put = wrangler(["secret", "put", "SPHERE_OPERATOR_TOKEN"], { input: token + "\n" });
  if (put.status !== 0) {
    console.error(`deploy: the operator token couldn't be set:\n${put.stderr}`);
    process.exit(1);
  }
  if (process.platform === "darwin" && host) {
    // `security -i` reads its command on standard input, so the token is in no process's arguments.
    const kept = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s obi-sphere-operator-token -a ${host} -l "obi-sphere operator token" -w ${token}\n`, encoding: "utf8" });
    console.log(
      kept.status === 0
        ? `deploy: made the operator token and kept it in your login Keychain (obi-sphere-operator-token, ${host}). Oby on this Mac creates Obyspheres on ${host} with it.`
        : "deploy: made the operator token, but the Keychain didn't take it. Rotate it with `wrangler secret put SPHERE_OPERATOR_TOKEN` and keep the new one yourself.",
    );
  } else {
    console.log(`deploy: made the operator token. It was shown nowhere; to create Spheres with it, rotate it with \`wrangler secret put SPHERE_OPERATOR_TOKEN --env ${env}\` and keep the new one.`);
  }
}
console.log(`deploy: done. Check it: curl https://${host ?? "<your host>"}/v0.1/health`);
