// Guarded writes and their retries (src/db.ts): a write that keeps losing its turn to other
// writes gives up with `429 rate_limited` and `Retry-After`, having recorded nothing.

import { describe, expect, it } from "vitest";
import { withRetries } from "../src/db";
import { ApiError, errorResponse } from "../src/http";

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
