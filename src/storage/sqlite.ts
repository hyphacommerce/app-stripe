// Storage on Node: SQLite through `node:sqlite` (built in since Node 22.5, no native
// module to compile). `:memory:` gives a database for tests.

import { DatabaseSync } from "node:sqlite";

import { type SqlDriver, sqlStorage } from "./sql.ts";
import type { Storage } from "./types.ts";

export function sqliteDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    async run(sql, params) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    async first(sql, params) {
      return db.prepare(sql).get(...params);
    },
    async all(sql, params) {
      return db.prepare(sql).all(...params);
    },
  };
}

export function sqliteStorage(path: string): Storage {
  return sqlStorage(sqliteDriver(path));
}
