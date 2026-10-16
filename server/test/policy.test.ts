// Policy: who may ask whose Obi for what (spec/sphere-api.md section 5).

import { describe, expect, it } from "vitest";
import { policyAllows } from "../src/routes/policy";
import type { PolicyRule } from "../src/db";
import { BRIEF, TEAM_REVIEWS, World, expectSchema, team } from "./helpers";

describe("GET and PUT /policy", () => {
  it("replaces the policy whole, version by version, rules in the order given", async () => {
    const w = new World();
    await w.create();
    w.clock.advance(6);
    const rules = [TEAM_REVIEWS, { id: "questions", from_owner: "ernesto", to_owner: "*", actions: ["question"], repos: ["*"] }];
    const r = await w.putPolicy(rules);
    expect(r.status).toBe(200);
    expectSchema("policy", r.body);
    expect(r.body).toEqual({ version: 1, updated_at: "2026-10-14T12:00:06Z", rules });
    const got = await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken() });
    expect(got.body).toEqual(r.body);
    const stale = await w.putPolicy([], 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect((await w.putPolicy([], 1)).body.version).toBe(2);
  });

  it("refuses rule ids that repeat, and bodies outside the schema (400 bad_request)", async () => {
    const w = new World();
    await w.create();
    for (const rules of [[TEAM_REVIEWS, TEAM_REVIEWS], [{ ...TEAM_REVIEWS, actions: ["result"] }], [{ ...TEAM_REVIEWS, repos: ["a/b/c"] }], [{ ...TEAM_REVIEWS, note: "x" }]]) {
      const r = await w.putPolicy(rules);
      expect(r.status, JSON.stringify(rules)).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });

  it("is written by the admin only, and read with directory:read or admin", async () => {
    const w = await team();
    const ernesto = await w.ownerToken("ernesto", "directory:read");
    const put = await w.call("PUT", "/v0.1/spheres/e2e/policy", { token: ernesto, body: { expected_version: 1, rules: [] } });
    expect(put.body.error.code).toBe("insufficient_scope");
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: ernesto })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken("wellington", "admin") })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken("wellington", "audit:read") })).body.error.code).toBe("insufficient_scope");
  });
});

describe("matching", () => {
  const rule = (o: Partial<PolicyRule>): PolicyRule => ({ id: "r", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["*"], ...o });

  it("matches owners, the action, and the repository ignoring ASCII case", () => {
    expect(policyAllows([rule({})], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ actions: ["question"] })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ from_owner: "a" })], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ from_owner: "c" })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ to_owner: "b" })], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ to_owner: "c" })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ repos: ["Obi-E2E/Fixture-App"] })], "a", "b", "review_request", "obi-e2e/fixture-app")).not.toBeNull();
    expect(policyAllows([rule({ repos: ["OBI-E2E/*"] })], "a", "b", "review_request", "obi-e2e/other")).not.toBeNull();
    expect(policyAllows([rule({ repos: ["obi-e2e/*"] })], "a", "b", "review_request", "obi-e2ex/other")).toBeNull();
    expect(policyAllows([rule({ repos: ["obi-e2e/fixture-app"] })], "a", "b", "review_request", "obi-e2e/fixture-app2")).toBeNull();
  });

  it("matches a request without a repo only with `*`", () => {
    expect(policyAllows([rule({ actions: ["question"], repos: ["x/*", "x/y"] })], "a", "b", "question", undefined)).toBeNull();
    expect(policyAllows([rule({ actions: ["question"], repos: ["*"] })], "a", "b", "question", undefined)).not.toBeNull();
  });

  it("allows nothing with no rules", () => {
    expect(policyAllows([], "a", "b", "review_request", "x/y")).toBeNull();
  });
});

describe("policy at send", () => {
  it("refuses a request no rule allows (403 policy_denied), and applies a new policy to the next send", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const other = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", { ...BRIEF, repo: "obi-e2e/other-app" }), token);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("policy_denied");
    expect((await w.putPolicy([{ ...TEAM_REVIEWS, repos: ["obi-e2e/*"] }], 1)).status).toBe(200);
    const now = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", { ...BRIEF, repo: "obi-e2e/other-app" }), token);
    expect(now.status).toBe(202);
  });

  it("takes a question's repository from its about: one repository, or none", async () => {
    const w = await team();
    await w.putPolicy([{ id: "q", from_owner: "*", to_owner: "*", actions: ["question"], repos: ["obi-e2e/*"] }], 1);
    expect((await w.join("ernesto", "obi-ernesto-q", ["question"])).status).toBe(201);
    const token = await w.obiToken("obi-wellington");
    const ask = async (about?: unknown[]) => (await w.send(await w.envelope("obi-wellington", "obi-ernesto-q", "question", { text: "Is it ready?", ...(about ? { about } : {}) }), token)).status;
    const pr = { kind: "pr", repo: "obi-e2e/fixture-app", pr: 1 };
    expect(await ask([pr, { kind: "issue", repo: "OBI-E2E/Fixture-App", issue: 2 }])).toBe(202);
    expect(await ask([pr, { kind: "repo", repo: "other/app" }])).toBe(403);
    expect(await ask()).toBe(403);
  });

  it("refuses a request type the receiver's card doesn't accept (403 policy_denied)", async () => {
    const w = await team();
    await w.putPolicy([{ id: "all", from_owner: "*", to_owner: "*", actions: ["review_request", "question", "handoff"], repos: ["*"] }], 1);
    const token = await w.obiToken("obi-ernesto");
    const r = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "question", { text: "Which?" }), token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("policy_denied");
  });
});
