// The Sphere server's conformance checker: the conformance runner's --impl contract
// (spec/conformance/README.md) with the server's own protocol code (src/protocol/), the same code
// the Worker runs. Reads one case ({case, context, input}) on stdin, prints one JSON line, and
// exits 0 to accept, 1 to reject, 2 when stdin is not a case.
//
//   node ../spec/conformance/run.mjs --impl "node <abs path>/server/conformance/check.ts"
//
// Node 22.18 or later runs this file as it is (type stripping); `pnpm run conformance` does the above.

import { readFileSync } from "node:fs";
import { verifyCard } from "../src/protocol/card.ts";
import { verifyChain } from "../src/protocol/chain.ts";
import { verifyEnvelope, type ReceiverContext, type Verdict } from "../src/protocol/envelope.ts";

let testCase: { case?: unknown; context?: unknown; input?: unknown };
try {
  testCase = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.log(JSON.stringify({ verdict: "error", message: `stdin is not JSON: ${(e as Error).message}` }));
  process.exit(2);
}

let verdict: Verdict;
switch (testCase.case) {
  case "envelope":
    verdict = await verifyEnvelope(testCase.input, testCase.context as ReceiverContext);
    break;
  case "card":
    verdict = await verifyCard(testCase.input, (testCase.context ?? {}) as { now?: string; bound_owner_key?: string });
    break;
  case "audit":
    verdict = await verifyChain(testCase.input, (testCase.context ?? { keys: {} }) as { keys: Record<string, never> });
    break;
  default:
    console.log(JSON.stringify({ verdict: "error", message: "not a conformance case" }));
    process.exit(2);
}

console.log(JSON.stringify(verdict.ok ? { verdict: "accept" } : { verdict: "reject", code: verdict.code, message: verdict.message }));
process.exit(verdict.ok ? 0 : 1);
