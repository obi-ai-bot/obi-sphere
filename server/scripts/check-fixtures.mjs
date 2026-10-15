#!/usr/bin/env node
// `pnpm run check:fixtures`: e2e/fixtures/ still equal obi's e2e fixtures (e2e/fixtures.mjs says
// which file is which). It needs an obi checkout, $OBI_DIR or ../obi beside this repository, and
// fails when there is none: a check that didn't run never passes.

import { compareWithObi, findObi } from "../e2e/fixtures.mjs";

let obiDir;
try {
  obiDir = findObi();
} catch (e) {
  console.error(`check:fixtures: ${e.message}`);
  process.exit(2);
}
if (!obiDir) {
  console.error("check:fixtures: no obi checkout found; set OBI_DIR to one (or put it at ../obi beside obi-sphere)");
  process.exit(2);
}
const problems = compareWithObi(obiDir);
if (problems.length) {
  console.error(`check:fixtures: stale, against ${obiDir}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check:fixtures: e2e/fixtures/brief.json and result.json match ${obiDir}`);
