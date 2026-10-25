// D1's shape over SQLite (sqlite.ts), so the Sphere's queries and migrations run unchanged off
// Cloudflare: `prepare`, `bind`, `first`, `all`, `run`, and `batch` as one transaction. SQLite here
// is synchronous and has one connection, so a statement or a batch runs whole before anything else.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Row, Sqlite, Value } from "./sqlite.ts";

interface Result {
  results: Row[];
  success: true;
  meta: { changes: number; last_row_id: number; changed_db: boolean };
}

/** What D1 binds: the same types, with booleans as 0 and 1, and undefined refused. */
function bindable(v: unknown): Value {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Value;
}

class Statement {
  readonly db: Sqlite;
  readonly sql: string;
  readonly params: Value[];
  constructor(db: Sqlite, sql: string, params: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params.map(bindable));
  }

  exec(): Result {
    const r = this.db.run(this.sql, this.params);
    return { results: r.rows, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId, changed_db: r.changes > 0 } };
  }

  async first(column?: string): Promise<unknown> {
    const row = this.exec().results[0];
    if (!row || column === undefined) return row ?? null;
    if (!(column in row)) throw new Error(`D1_ERROR: no such column: ${column}`);
    return row[column];
  }

  async all(): Promise<Result> {
    return this.exec();
  }

  async run(): Promise<Result> {
    return this.exec();
  }
}

function transaction<T>(db: Sqlite, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = work();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const d1 = (db: Sqlite) => ({
  prepare: (sql: string) => new Statement(db, sql),
  batch: async (statements: Statement[]) => transaction(db, () => statements.map((s) => s.exec())),
});

/**
 * Applies the migrations in `dir` that aren't applied yet, in order, each in a transaction, and
 * records them as wrangler does on D1 (`d1_migrations`). Answers the names it applied.
 */
export function migrate(db: Sqlite, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const done = new Set(db.run("SELECT name FROM d1_migrations", []).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    transaction(db, () => {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.run("INSERT INTO d1_migrations (name) VALUES (?1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}
