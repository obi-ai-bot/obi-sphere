#!/usr/bin/env node
// The reference implementation behind the conformance runner's --impl contract: reads one
// conformance case (JSON) on stdin, judges it, prints one JSON line, and exits 0 to accept or
// 1 to reject (2 when the input isn't a case at all).
//
//   node conformance/run.mjs --impl "node conformance/verify.mjs"
//
// With --schema <name> it instead validates a bare JSON document against one schema
// (`envelope`, `actions/review_request`, `wire/policy`…) and nothing else: no signature, no clock.

import { readFileSync } from "node:fs";
import { judge, schemaErrors, semanticProblems } from "./lib/obi.mjs";

const args = process.argv.slice(2);
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.log(JSON.stringify({ verdict: "error", message: `stdin is not JSON: ${e.message}` }));
  process.exit(2);
}

if (args[0] === "--schema") {
  const name = args[1];
  const errors = schemaErrors(name, input);
  if (!errors.length && name === "envelope") errors.push(...semanticProblems(input));
  console.log(JSON.stringify(errors.length ? { verdict: "reject", schema: name, errors } : { verdict: "accept", schema: name }));
  process.exit(errors.length ? 1 : 0);
}

const verdict = judge(input);
console.log(JSON.stringify(verdict.ok ? { verdict: "accept" } : { verdict: "reject", code: verdict.code, message: verdict.message }));
process.exit(verdict.ok ? 0 : 1);
