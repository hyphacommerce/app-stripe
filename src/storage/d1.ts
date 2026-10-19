// Storage on Cloudflare D1: the binding's prepared statements. The few D1 types used are
// declared here, so the core needs no `@cloudflare/workers-types`.

import { type SqlDriver, type SqlValue, sqlStorage } from "./sql.ts";
import type { Storage } from "./types.ts";

export interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  run(): Promise<{ meta: { changes?: number } }>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export function d1Driver(db: D1Database): SqlDriver {
  return {
    async run(sql, params) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .run();
      return { changes: result.meta.changes ?? 0 };
    },
    async first(sql, params) {
      return (
        (await db
          .prepare(sql)
          .bind(...params)
          .first()) ?? undefined
      );
    },
    async all(sql, params) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all()
      ).results;
    },
  };
}

export function d1Storage(db: D1Database): Storage {
  return sqlStorage(d1Driver(db));
}
