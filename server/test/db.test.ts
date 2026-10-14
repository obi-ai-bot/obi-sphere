// Guarded writes and their retries (src/db.ts): only a lost turn (the write guard's `lost_turn`
// CHECK) is contention. A record that could not be made because of concurrent writes is
// `429 rate_limited` with `Retry-After`; any other failure is `500 internal`, logged, never
// retried. Nothing is recorded either way.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENTION_MESSAGE, guardedWrite, withRetries } from "../src/db";
import { ApiError, INTERNAL_MESSAGE, errorResponse } from "../src/http";

async function aSphere(): Promise<number> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO spheres (id, name, admin_owner, created_at, policy_version, policy_rules, policy_updated_at, head_seq, head_hash)
       VALUES ('s', 'S', 'wellington', '2026-10-14T12:00:00Z', 0, '[]', '2026-10-14T12:00:00Z', 0, ?1)`,
    ).bind("0".repeat(64)),
    env.DB.prepare("INSERT INTO owners (sphere, owner, owner_key, owner_key_id) VALUES ('s', 'wellington', 'k', 'kid')"),
  ]);
  return (await env.DB.prepare("SELECT rev FROM spheres WHERE id = 's'").first<{ rev: number }>())!.rev;
}

const state = async () => ({
  rev: (await env.DB.prepare("SELECT rev FROM spheres WHERE id = 's'").first<{ rev: number }>())!.rev,
  owners: (await env.DB.prepare("SELECT COUNT(*) AS n FROM owners").first<{ n: number }>())!.n,
  guard: (await env.DB.prepare("SELECT COUNT(*) AS n FROM write_guard").first<{ n: number }>())!.n,
});

const addOwner = (owner: string) => env.DB.prepare("INSERT INTO owners (sphere, owner, owner_key, owner_key_id) VALUES ('s', ?1, 'k2', 'kid2')").bind(owner);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardedWrite", () => {
  it("makes the change and moves rev on when rev is still what the writer read", async () => {
    const rev = await aSphere();
    expect(await guardedWrite(env.DB, "s", rev, [addOwner("ernesto")])).toHaveLength(1);
    expect(await state()).toEqual({ rev: rev + 1, owners: 2, guard: 0 });
  });

  it("answers null and changes nothing when another write took the turn", async () => {
    const rev = await aSphere();
    await env.DB.prepare("UPDATE spheres SET rev = rev + 1 WHERE id = 's'").run();
    expect(await guardedWrite(env.DB, "s", rev, [addOwner("ernesto")])).toBeNull();
    expect(await state()).toEqual({ rev: rev + 1, owners: 1, guard: 0 });
  });

  it("answers 500 internal for any other constraint failure, logs which, and is never retried", async () => {
    const rev = await aSphere();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let tries = 0;
    const err = await withRetries(async () => {
      tries++;
      // A duplicate key: the owner is bound already.
      return guardedWrite(env.DB, "s", rev, [addOwner("wellington")]);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("internal");
    expect((err as ApiError).message).toBe(INTERNAL_MESSAGE);
    expect(errorResponse(err as ApiError).status).toBe(500);
    expect(tries).toBe(1);
    expect(log).toHaveBeenCalledWith("sphere: a guarded write failed, nothing was recorded: UNIQUE constraint failed: owners.sphere, owners.owner");
    expect(await state()).toEqual({ rev, owners: 1, guard: 0 });
  });
});

describe("withRetries", () => {
  it("answers the attempt's result once a write lands", async () => {
    let tries = 0;
    expect(await withRetries(async () => (++tries < 4 ? null : "landed"))).toBe("landed");
    expect(tries).toBe(4);
  });

  it("gives up with 429 rate_limited and Retry-After when its budget runs out", async () => {
    let tries = 0;
    const err = await withRetries(async () => {
      tries++;
      return null;
    }, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("rate_limited");
    expect((err as ApiError).message).toBe(CONTENTION_MESSAGE);
    expect(tries).toBeGreaterThan(1);
    const res = errorResponse(err as ApiError);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("passes a check's error straight through, without retrying", async () => {
    let tries = 0;
    const err = await withRetries(async () => {
      tries++;
      throw new ApiError("policy_denied", "no");
    }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("policy_denied");
    expect(tries).toBe(1);
  });
});
