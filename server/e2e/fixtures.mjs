// The scenario's message fixtures, and the check that they are still obi's.
//
// e2e/fixtures/ holds copies of what obi's e2e/SCENARIO.md fixes, so the scenario runs from this
// repository alone:
//
//   brief.json   = obi e2e/fixtures/messages/brief.json
//   result.json  = obi e2e/fixtures/messages/result.example.json, its `body`
//
// Copies can go stale. Whenever an obi checkout is at hand, each copy is compared with obi's file
// as a JSON value, and any difference is an error: the scenario never passes against values
// SCENARIO.md no longer has. The checkout is $OBI_DIR when set (then it must hold the fixtures),
// else the obi next to this repository (`../obi` from the obi-sphere checkout) when there is one.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
export const VENDORED_DIR = join(here, "fixtures");
const CHECKOUT = resolve(here, "..", "..");

/** Each vendored fixture: obi's file it copies, and the part of that file it is. */
export const SOURCES = {
  "brief.json": { path: "e2e/fixtures/messages/brief.json", part: (v) => v, what: "the file" },
  "result.json": { path: "e2e/fixtures/messages/result.example.json", part: (v) => v?.body, what: "its body" },
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const holdsFixtures = (dir) => Object.values(SOURCES).every((s) => existsSync(join(dir, s.path)));

/**
 * The obi checkout to compare with: $OBI_DIR (an error when it lacks the fixtures), else
 * `../obi` beside this checkout when it holds them, else null.
 */
export function findObi(env = process.env) {
  if (env.OBI_DIR) {
    const dir = resolve(env.OBI_DIR);
    if (!holdsFixtures(dir)) throw new Error(`OBI_DIR=${dir} is not an obi checkout with ${Object.values(SOURCES).map((s) => s.path).join(" and ")}`);
    return dir;
  }
  const sibling = resolve(CHECKOUT, "..", "obi");
  return holdsFixtures(sibling) ? sibling : null;
}

/** The differences between the copies in `vendoredDir` and obi's files in `obiDir`: [] when none. */
export function compareWithObi(obiDir, vendoredDir = VENDORED_DIR) {
  const problems = [];
  for (const [name, source] of Object.entries(SOURCES)) {
    const ours = readJson(join(vendoredDir, name));
    const theirs = source.part(readJson(join(obiDir, source.path)));
    if (!isDeepStrictEqual(ours, theirs)) problems.push(`server/e2e/fixtures/${name} is not ${source.what} of obi ${source.path}`);
  }
  return problems;
}

/**
 * The fixtures the scenario uses. With an obi checkout they are checked against it first and
 * any difference throws; `checkedAgainst` says which checkout, or null when none was found.
 */
export function loadFixtures({ obiDir = findObi(), vendoredDir = VENDORED_DIR } = {}) {
  if (obiDir) {
    const problems = compareWithObi(obiDir, vendoredDir);
    if (problems.length) throw new Error(`the fixtures are stale; copy them again from ${obiDir}:\n  ${problems.join("\n  ")}`);
  }
  return { brief: readJson(join(vendoredDir, "brief.json")), result: readJson(join(vendoredDir, "result.json")), checkedAgainst: obiDir };
}
