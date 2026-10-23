// Tests of the fixture check (node --test): a copy that no longer equals obi's file is caught,
// for each fixture, and $OBI_DIR pointing at something that isn't obi is an error, never a pass.

import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SOURCES, VENDORED_DIR, compareWithObi, findObi, loadFixtures } from "./fixtures.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** A fake obi checkout whose fixtures are exactly what the vendored copies say. */
function fakeObi() {
  const dir = mkdtempSync(join(tmpdir(), "obi-fixtures-"));
  mkdirSync(join(dir, "e2e", "fixtures", "messages"), { recursive: true });
  writeFileSync(join(dir, SOURCES["brief.json"].path), JSON.stringify(read(join(VENDORED_DIR, "brief.json")), null, 2));
  const result = { protocol: "obi/0.1", type: "result", body: read(join(VENDORED_DIR, "result.json")) };
  writeFileSync(join(dir, SOURCES["result.json"].path), JSON.stringify(result, null, 2));
  return dir;
}

test("copies equal to obi's files pass, and load", () => {
  const obi = fakeObi();
  try {
    assert.deepEqual(compareWithObi(obi), []);
    const f = loadFixtures({ obiDir: obi });
    assert.equal(f.checkedAgainst, obi);
    assert.equal(f.brief.repo, "obi-e2e/fixture-app");
    assert.equal(f.result.for, "review_request");
  } finally {
    rmSync(obi, { recursive: true, force: true });
  }
});

test("a brief that changed in obi is caught, and the scenario's load throws", () => {
  const obi = fakeObi();
  try {
    const path = join(obi, SOURCES["brief.json"].path);
    writeFileSync(path, JSON.stringify({ ...read(path), head_sha: "0".repeat(40) }));
    assert.deepEqual(compareWithObi(obi), ["server/e2e/fixtures/brief.json is not the file of obi e2e/fixtures/messages/brief.json"]);
    assert.throws(() => loadFixtures({ obiDir: obi }), /the fixtures are stale/);
  } finally {
    rmSync(obi, { recursive: true, force: true });
  }
});

test("a result whose body changed in obi is caught, but not a change outside the body", () => {
  const obi = fakeObi();
  try {
    const path = join(obi, SOURCES["result.json"].path);
    const result = read(path);
    writeFileSync(path, JSON.stringify({ ...result, id: "another" }));
    assert.deepEqual(compareWithObi(obi), []);
    writeFileSync(path, JSON.stringify({ ...result, body: { ...result.body, outcome: "changes_requested" } }));
    assert.deepEqual(compareWithObi(obi), ["server/e2e/fixtures/result.json is not its body of obi e2e/fixtures/messages/result.example.json"]);
  } finally {
    rmSync(obi, { recursive: true, force: true });
  }
});

test("a vendored copy that drifted is caught the same way", () => {
  const obi = fakeObi();
  const vendored = mkdtempSync(join(tmpdir(), "obi-vendored-"));
  try {
    cpSync(VENDORED_DIR, vendored, { recursive: true });
    const path = join(vendored, "result.json");
    writeFileSync(path, JSON.stringify({ ...read(path), findings: [] }));
    assert.equal(compareWithObi(obi, vendored).length, 1);
  } finally {
    rmSync(obi, { recursive: true, force: true });
    rmSync(vendored, { recursive: true, force: true });
  }
});

test("OBI_DIR that isn't an obi checkout is an error, not a skip", () => {
  const empty = mkdtempSync(join(tmpdir(), "not-obi-"));
  try {
    assert.throws(() => findObi({ OBI_DIR: empty }), /is not an obi checkout/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
