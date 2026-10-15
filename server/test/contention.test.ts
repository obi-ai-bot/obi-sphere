// Contention, through the API (spec/sphere-api.md section 1): a write that loses its turn to
// concurrent writes reads again and lands; one that concurrent writes keep out until its budget
// runs out answers `429 rate_limited` with `Retry-After`, having recorded nothing; any other
// failure of the write is `500 internal` at once, logged, never retried.
//
// The send goes through `handle` with a D1 that lets a real competing write move the Sphere's
// `rev` on between the send's read and its guarded write, exactly what another writer does.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import type { Env } from "../src/env";
import { CONTENTION_MESSAGE } from "../src/db";
import { INTERNAL_MESSAGE } from "../src/http";
import { BASE, BRIEF, expectSchema, team, type World } from "./helpers";

const GUARD = "UPDATE spheres SET rev = rev + 1, writer";

interface Contended {
  db: D1Database;
  /** Guarded writes the Sphere tried. */
  guarded: number;
  /** Turns a competing write took from them. */
  stolen: number;
}

/**
 * The real D1, except that a competing write takes the turn of the first `steal` guarded writes,
 * and `rewrite` may change a statement's SQL (to stand in for a schema mistake).
 */
function contended(sphere: string, steal: number, rewrite: (sql: string) => string = (s) => s): Contended {
  const real = env.DB;
  let armed = false;
  const c: Contended = {
    guarded: 0,
    stolen: 0,
    db: {
      prepare(sql: string) {
        if (sql.startsWith(GUARD)) armed = true;
        return real.prepare(rewrite(sql));
      },
      async batch(statements: D1PreparedStatement[]) {
        if (armed) {
          armed = false;
          c.guarded++;
          if (c.stolen < steal) {
            c.stolen++;
            await real.prepare("UPDATE spheres SET rev = rev + 1 WHERE id = ?1").bind(sphere).run();
          }
        }
        return real.batch(statements);
      },
      exec: (q: string) => real.exec(q),
      dump: () => real.dump(),
      withSession: (b?: string) => real.withSession(b),
    } as unknown as D1Database,
  };
  return c;
}

async function sendThrough(w: World, db: D1Database, envelope: unknown, token: string, retryBudgetMs?: number) {
  const workerEnv: Env = { DB: db, SPHERE_OPERATOR_TOKEN: env.SPHERE_OPERATOR_TOKEN };
  const res = await handle(
    new Request(`${BASE}/v0.1/spheres/${w.sphere}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope) }),
    workerEnv,
    { now: w.clock.now, pollMs: 20, ...(retryBudgetMs === undefined ? {} : { retryBudgetMs }) },
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const recorded = async () => ({
  audit: (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first<{ n: number }>())!.n,
  deliveries: (await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first<{ n: number }>())!.n,
  rev: (await env.DB.prepare("SELECT rev FROM spheres WHERE id = 'e2e'").first<{ rev: number }>())!.rev,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a send under contention", () => {
  // Before the fix a write gave up after ten lost turns with 500 internal; this one loses twelve.
  it("loses its turn to concurrent writes twelve times, reads again each time, and lands once", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const envelope = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    const c = contended(w.sphere, 12);
    const r = await sendThrough(w, c.db, envelope, token);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expectSchema("sendResponse", r.body);
    expect(r.body.seq).toBe(1);
    expect(c.stolen).toBe(12);
    expect(c.guarded).toBe(13);
    expect(await recorded()).toMatchObject({ audit: 1, deliveries: 1 });
  }, 30_000);

  it("answers 429 rate_limited with Retry-After when concurrent writes keep it out, and records nothing", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const envelope = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    const c = contended(w.sphere, Number.POSITIVE_INFINITY);
    const r = await sendThrough(w, c.db, envelope, token, 300);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("1");
    expectSchema("error", r.body);
    expect(r.body.error).toEqual({ code: "rate_limited", message: CONTENTION_MESSAGE });
    expect(c.guarded).toBeGreaterThan(1);
    expect(c.stolen).toBe(c.guarded);
    expect(await recorded()).toMatchObject({ audit: 0, deliveries: 0 });
  });

  it("answers 500 internal at once for a constraint failure that isn't contention, logs why, and records nothing", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const envelope = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    const before = await recorded();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // A schema mistake: the delivery's state breaks the deliveries table's CHECK.
    const c = contended(w.sphere, 0, (sql) => (sql.startsWith("INSERT INTO deliveries") ? sql.replace("'queued')", "'lost')") : sql));
    const r = await sendThrough(w, c.db, envelope, token);
    expect(r.status).toBe(500);
    expect(r.headers.get("Retry-After")).toBeNull();
    expectSchema("error", r.body);
    expect(r.body.error).toEqual({ code: "internal", message: INTERNAL_MESSAGE });
    expect(c.guarded).toBe(1);
    const logged = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toMatch(/a guarded write failed, nothing was recorded: CHECK constraint failed: state IN/);
    // What the client sent never reaches the log.
    expect(logged).not.toContain(String(envelope.id));
    expect(logged).not.toContain("OBI-E2E-DATA-CANARY");
    expect(await recorded()).toEqual(before);
  });
});
