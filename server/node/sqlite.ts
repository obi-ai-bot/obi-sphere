// The one file that names the runtime's SQLite: Node's own `node:sqlite`. Bun can't load it (Bun
// 1.3.14), so running on Bun is a second copy of this file over `bun:sqlite`, same three calls.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type Value = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Sqlite {
  exec(sql: string): void;
  /** The statement's rows (none for a write), and how many rows it changed. */
  run(sql: string, params: Value[]): { rows: Row[]; changes: number; lastRowId: number };
  close(): void;
}

export function open(path: string): Sqlite {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  // ponytail: every statement the Sphere has is a fixed string, so the cache stays small.
  const statements = new Map<string, StatementSync>();
  const prepared = (sql: string) => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    exec: (sql) => db.exec(sql),
    run(sql, params) {
      const s = prepared(sql);
      if (s.columns().length) return { rows: s.all(...params).map((r) => ({ ...r })), changes: 0, lastRowId: 0 };
      const r = s.run(...params);
      return { rows: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
    },
    close: () => db.close(),
  };
}
