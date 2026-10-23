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
import * as validators from "../src/protocol/validators.generated.js";
import { schemaErrors, type SchemaName } from "../src/protocol/schemas.ts";

/** A wire case's schema (`wire/invitation-preview.request`) by the name the server compiles it under (`invitationPreviewRequest`). */
const wireSchema = (schema: unknown): SchemaName | undefined => {
  const m = typeof schema === "string" ? /^wire\/([a-z.-]+)$/.exec(schema) : null;
  const name = m?.[1]!.replace(/[-.]([a-z])/g, (_, c: string) => c.toUpperCase());
  return name && Object.hasOwn(validators, name) ? (name as SchemaName) : undefined;
};

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
  case "wire": {
    const name = wireSchema((testCase.context as { schema?: unknown } | undefined)?.schema);
    const errors = name ? schemaErrors(name, testCase.input) : ["the server compiles no such wire schema"];
    verdict = errors.length ? { ok: false, code: "bad_request", message: errors.join("; ") } : { ok: true };
    break;
  }
  default:
    console.log(JSON.stringify({ verdict: "error", message: "not a conformance case" }));
    process.exit(2);
}

console.log(JSON.stringify(verdict.ok ? { verdict: "accept" } : { verdict: "reject", code: verdict.code, message: verdict.message }));
process.exit(verdict.ok ? 0 : 1);
