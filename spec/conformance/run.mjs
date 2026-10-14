#!/usr/bin/env node
// The conformance runner for the Obi-to-Obi protocol v0.1.
//
//   node conformance/run.mjs                    self-check: schemas, fixtures, reference verdicts
//   node conformance/run.mjs --impl "<cmd>"     judge an implementation: each fixture on stdin,
//                                               exit 0 = accept, anything else = reject
//   options: --kinds envelope,card,audit   only these case kinds (impl mode)
//            --verbose                     print every case, not only the failures
//
// Exit status 0 when every check passes, 1 otherwise.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "./generate.mjs";
import { ACTION_TYPES, SCHEMA_DIR, canonicalize, judge, schemas } from "./lib/obi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const verbose = flag("--verbose");

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function loadCases(kinds) {
  return listFiles(join(here, "fixtures"))
    .filter((p) => p.endsWith(".json"))
    .sort()
    .map((p) => ({ path: relative(here, p), data: JSON.parse(readFileSync(p, "utf8")) }))
    .filter((c) => !kinds || kinds.includes(c.data.case));
}

let failures = 0;
const failed = (section, message) => {
  failures++;
  console.log(`FAIL ${section}: ${message}`);
};
const section = (title) => console.log(`\n== ${title}`);

// ---------------------------------------------------------------------------------------------
// Implementation mode.

function runImpl(command, testCase) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err: err + "\n(timed out after 20 seconds)" });
    }, 20000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(testCase));
  });
}

async function implMode(command, kinds, label = "implementation") {
  const cases = loadCases(kinds);
  let passed = 0;
  const queue = [...cases];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const r = await runImpl(command, c.data);
      const got = r.code === 0 ? "accept" : r.code === null ? "error" : "reject";
      if (got === c.data.expect) {
        passed++;
        if (verbose) console.log(`ok   ${c.path} (${got})`);
      } else {
        failed(label, `${c.path}: expected ${c.data.expect}, got ${got} (exit ${r.code}) ${c.data.description}${r.out.trim() ? `\n     stdout: ${r.out.trim().slice(0, 300)}` : ""}${r.err.trim() ? `\n     stderr: ${r.err.trim().slice(0, 300)}` : ""}`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`${label}: ${passed} of ${cases.length} cases as expected.`);
  return passed === cases.length;
}

// ---------------------------------------------------------------------------------------------
// Self-check.

const TEXT_DEFS = new Set(["line_text", "block_text"]);

function lintSchemas() {
  section("Schemas");
  const { schemas: all } = schemas();
  let objects = 0, strings = 0, texts = 0;
  const walk = (name, node, path, parentHasTextAnnotation = false) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(name, n, `${path}/${i}`));
    if (!node || typeof node !== "object") return;
    // if/then/else/not only refine the object they sit in; they don't define one.
    const refiner = ["if", "then", "else", "not"].includes(path.split("/").pop());
    if (node.properties && !refiner) {
      objects++;
      if (node.additionalProperties !== false) failed("schemas", `${name}${path}: an object with properties must set additionalProperties: false`);
    }
    if (node.type === "string") {
      strings++;
      const isTextDef = TEXT_DEFS.has(path.split("/").pop()) && path.startsWith("/$defs/");
      if (!isTextDef && node.maxLength === undefined) failed("schemas", `${name}${path}: a string needs maxLength`);
      if (!isTextDef && node.pattern === undefined && node.enum === undefined && node.const === undefined) failed("schemas", `${name}${path}: a string that isn't data text needs a pattern, enum or const`);
    }
    if (typeof node.$ref === "string") {
      const target = node.$ref.split("#/$defs/")[1];
      if (TEXT_DEFS.has(target)) {
        texts++;
        if (node["x-obi-text"] !== "data") failed("schemas", `${name}${path}: human-written text must be annotated x-obi-text: data`);
        if (node.maxLength === undefined || node.minLength === undefined) failed("schemas", `${name}${path}: data text sets its own minLength and maxLength`);
      } else if (node["x-obi-text"] !== undefined) {
        failed("schemas", `${name}${path}: x-obi-text belongs only on line_text or block_text`);
      }
    } else if (node["x-obi-text"] !== undefined) {
      failed("schemas", `${name}${path}: x-obi-text belongs only on line_text or block_text`);
    }
    for (const [k, v] of Object.entries(node)) if (k !== "enum" && k !== "const") walk(name, v, `${path}/${k}`);
  };
  for (const [name, schema] of Object.entries(all)) walk(name, schema, "");
  const types = all.common.$defs.action_type.enum;
  if (canonicalize([...types].sort()) !== canonicalize([...ACTION_TYPES].sort())) failed("schemas", `the action types are ${types.join(", ")}`);
  for (const t of types) if (!all[`actions/${t}`]) failed("schemas", `no body schema for ${t}`);
  for (const t of types) if (/message|chat|text|prompt/.test(t)) failed("schemas", `${t} looks like a free-text type`);
  console.log(`${Object.keys(all).length} schemas compiled (draft 2020-12). ${objects} objects closed, ${strings} strings bounded, ${texts} data-text fields annotated x-obi-text: data. Action types: ${types.join(", ")}.`);
}

function checkJcs() {
  section("Canonical JSON (RFC 8785)");
  const vectors = JSON.parse(readFileSync(join(here, "jcs-vectors.json"), "utf8")).vectors;
  let ok = 0;
  for (const v of vectors) {
    const got = canonicalize(v.input);
    if (got === v.canonical) ok++;
    else failed("jcs", `${v.name}: got ${got}`);
  }
  console.log(`${ok} of ${vectors.length} vectors canonicalize as expected.`);
}

function checkDeterminism() {
  section("Fixtures are reproducible");
  const expected = buildFixtures();
  const onDisk = new Set(listFiles(join(here, "fixtures")).map((p) => relative(here, p)));
  onDisk.add("keys.json");
  let same = 0;
  for (const [path, content] of Object.entries(expected)) {
    let actual = null;
    try {
      actual = readFileSync(join(here, path), "utf8");
    } catch {}
    if (actual === content) same++;
    else failed("fixtures", `${path} differs from what generate.mjs produces: run \`pnpm run generate\``);
    onDisk.delete(path);
  }
  for (const path of onDisk) failed("fixtures", `${path} is not produced by generate.mjs: remove it or generate it`);
  console.log(`${same} of ${Object.keys(expected).length} generated files match the committed ones.`);
  if (/PRIVATE KEY|"d":/.test(Object.values(expected).join(""))) failed("fixtures", "a private key appears in the fixtures");
}

function checkVerdicts() {
  section("Reference verdicts");
  const cases = loadCases();
  const counts = {};
  for (const c of cases) {
    const verdict = judge(c.data);
    const got = verdict.ok ? "accept" : "reject";
    const key = `${c.data.case} ${c.data.expect}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (got !== c.data.expect) failed("verdict", `${c.path}: expected ${c.data.expect}, got ${got}${verdict.ok ? "" : ` (${verdict.code}: ${verdict.message})`}`);
    else if (!verdict.ok && c.data.reason && verdict.code !== c.data.reason) failed("verdict", `${c.path}: rejected as ${verdict.code} (${verdict.message}), expected ${c.data.reason}`);
    else if (verbose) console.log(`ok   ${c.path} (${got}${verdict.ok ? "" : `: ${verdict.code}`})`);
  }
  console.log(`${cases.length} cases: ${Object.entries(counts).sort().map(([k, n]) => `${n} ${k}`).join(", ")}.`);
  return cases;
}

function checkCoverage(cases) {
  section("Coverage");
  const names = new Set(cases.map((c) => `${c.data.case}/${c.data.name}`));
  const need = [];
  for (const t of ACTION_TYPES) need.push(`envelope/valid-${t === "result" ? "result-review" : t}`);
  need.push("envelope/valid-result-answer", "envelope/valid-result-handoff");
  for (const f of ["protocol", "id", "type", "from", "to", "sphere", "correlation_id", "created_at", "expires_at", "key_id", "body", "signature"]) need.push(`envelope/invalid-missing-envelope-${f.replaceAll("_", "-")}`);
  const { schemas: all } = schemas();
  for (const t of ACTION_TYPES.filter((t) => t !== "result")) for (const f of all[`actions/${t}`].required) need.push(`envelope/invalid-missing-${t.replaceAll("_", "-")}-${f.replaceAll("_", "-")}`);
  for (const [i, key] of [[0, "result"], [1, "result-answer"], [2, "result-handoff"]]) for (const f of all["actions/result"].oneOf[i].required) need.push(`envelope/invalid-missing-${key}-${f.replaceAll("_", "-")}`);
  for (const t of ["status", "accept", "decline", "result"]) need.push(`envelope/invalid-reply-without-in-reply-to-${t}`);
  for (const n of ["bad-signature-flipped-bit", "expired", "unknown-type-message", "extra-envelope-field", "smuggle-body-instructions", "smuggle-body-prompt", "smuggle-body-message", "oversize-goal", "oversize-envelope"]) need.push(`envelope/invalid-${n}`);
  for (const n of ["valid-chain", "invalid-chain-tampered-entry", "invalid-chain-reordered", "invalid-chain-broken-link"]) need.push(`audit/${n}`);
  need.push("card/valid-card", "card/invalid-card-changed-after-signing");
  let ok = 0;
  for (const n of need) {
    if (names.has(n)) ok++;
    else failed("coverage", `no fixture ${n}`);
  }
  console.log(`${ok} of ${need.length} required fixtures present.`);
}

async function selfCheck() {
  console.log("Obi-to-Obi protocol v0.1: conformance self-check");
  lintSchemas();
  checkJcs();
  checkDeterminism();
  const cases = checkVerdicts();
  checkCoverage(cases);
  section("Implementation mode, with the reference verifier");
  await implMode(`"${process.execPath}" "${join(here, "verify.mjs")}"`, undefined, "reference --impl");
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  return failures === 0;
}

const impl = option("--impl");
const kinds = option("--kinds")?.split(",");
if (args.includes("--impl") && !impl) {
  console.error('--impl needs a command, like --impl "node conformance/verify.mjs"');
  process.exit(64);
}
const passed = impl ? await implMode(impl, kinds) : await selfCheck();
process.exit(passed ? 0 : 1);
