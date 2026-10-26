// The storage as SQL, shared by D1 and SQLite (they speak the same dialect): adapters
// only say how to run a statement.

import { isRecord, parseJson } from "../json.ts";
import type {
  EventSource,
  InstallationRow,
  OAuthStateRow,
  PaymentRow,
  Storage,
  StoredSettings,
} from "./types.ts";

export type SqlValue = string | number | null;

/** How an adapter runs one statement. */
export interface SqlDriver {
  run(sql: string, params: SqlValue[]): Promise<{ changes: number }>;
  first(sql: string, params: SqlValue[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, params: SqlValue[]): Promise<Record<string, unknown>[]>;
}

/** The schema, statement by statement (`IF NOT EXISTS`: running it again is harmless). */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    api_url TEXT NOT NULL,
    issuer TEXT NOT NULL UNIQUE,
    store_id TEXT UNIQUE,
    app_secret TEXT NOT NULL,
    tokens TEXT,
    scopes TEXT NOT NULL DEFAULT '',
    admin_origins TEXT NOT NULL DEFAULT '[]',
    settings TEXT,
    refresh_lock_until INTEGER,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    uninstalled_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    api_url TEXT NOT NULL,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    installation_id TEXT NOT NULL,
    source TEXT NOT NULL,
    event_id TEXT NOT NULL,
    handled_at INTEGER NOT NULL,
    PRIMARY KEY (installation_id, source, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    installation_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    cart_id TEXT,
    order_id TEXT,
    intent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (installation_id, payment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS payments_by_intent ON payments (installation_id, intent_id)`,
];

/**
 * A `payments` table made before payments started with a cart (`payments.start` v1) has
 * no `cart_id` and requires an order; SQLite can't drop a NOT NULL, so it's rebuilt:
 * copied into `payments_v2`, dropped, renamed. D1 runs each statement on its own, so
 * every step can be run again after a crash: the copy is `IF NOT EXISTS` and `OR IGNORE`,
 * and a `payments_v2` left without a `payments` is renamed. Runs before the schema, so
 * the schema's `CREATE TABLE IF NOT EXISTS` can't make an empty table beside it.
 */
async function rebuildPayments(db: SqlDriver): Promise<void> {
  const tables = new Set(
    (
      await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('payments', 'payments_v2')",
        [],
      )
    ).map((row) => String(row.name)),
  );
  if (tables.has("payments")) {
    const columns = await db.all("PRAGMA table_info(payments)", []);
    const old =
      !columns.some((c) => c.name === "cart_id") ||
      columns.some((c) => c.name === "order_id" && Number(c.notnull) === 1);
    if (!old) return;
    await db.run(
      `CREATE TABLE IF NOT EXISTS payments_v2 (
        installation_id TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        cart_id TEXT,
        order_id TEXT,
        intent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (installation_id, payment_id)
      )`,
      [],
    );
    await db.run(
      `INSERT OR IGNORE INTO payments_v2 (installation_id, payment_id, cart_id, order_id,
        intent_id, created_at) SELECT installation_id, payment_id, NULL, order_id, intent_id,
        created_at FROM payments`,
      [],
    );
    await db.run("DROP TABLE payments", []);
    tables.add("payments_v2");
  }
  if (tables.has("payments_v2")) await db.run("ALTER TABLE payments_v2 RENAME TO payments", []);
}

function installation(row: Record<string, unknown> | undefined): InstallationRow | undefined {
  return row === undefined ? undefined : toInstallation(row);
}

export function sqlStorage(db: SqlDriver): Storage {
  return {
    async migrate() {
      await rebuildPayments(db);
      for (const statement of SCHEMA) await db.run(statement, []);
    },
    async getInstallation(id) {
      return installation(await db.first("SELECT * FROM installations WHERE id = ?", [id]));
    },
    async installationByIssuer(issuer) {
      return installation(await db.first("SELECT * FROM installations WHERE issuer = ?", [issuer]));
    },
    async installationByStore(storeId) {
      return installation(
        await db.first("SELECT * FROM installations WHERE store_id = ?", [storeId]),
      );
    },
    async activeInstallations() {
      const rows = await db.all(
        "SELECT * FROM installations WHERE uninstalled_at IS NULL ORDER BY installed_at",
        [],
      );
      return rows.map(toInstallation);
    },
    async putInstallation(row) {
      await db.run(
        `INSERT OR REPLACE INTO installations (id, api_url, issuer, store_id, app_secret, tokens,
          scopes, admin_origins, settings, refresh_lock_until, installed_at, updated_at,
          uninstalled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.apiUrl,
          row.issuer,
          row.storeId,
          row.appSecret,
          row.tokens,
          row.scopes,
          JSON.stringify(row.adminOrigins),
          row.settings === null ? null : JSON.stringify(row.settings),
          row.refreshLockUntil,
          row.installedAt,
          row.updatedAt,
          row.uninstalledAt,
        ],
      );
    },
    async setAdminOrigins(id, origins) {
      await db.run("UPDATE installations SET admin_origins = ? WHERE id = ?", [
        JSON.stringify(origins),
        id,
      ]);
    },
    async setTokens(id, tokens, scopes) {
      if (scopes === undefined)
        await db.run("UPDATE installations SET tokens = ? WHERE id = ?", [tokens, id]);
      else
        await db.run("UPDATE installations SET tokens = ?, scopes = ? WHERE id = ?", [
          tokens,
          scopes,
          id,
        ]);
    },
    async setSettings(id, settings) {
      await db.run("UPDATE installations SET settings = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify(settings),
        settings.updatedAt,
        id,
      ]);
    },
    async markUninstalled(id, at) {
      await db.run(
        "UPDATE installations SET tokens = NULL, uninstalled_at = ?, updated_at = ? WHERE id = ?",
        [at, at, id],
      );
    },
    async takeRefreshLock(id, now, until) {
      const { changes } = await db.run(
        `UPDATE installations SET refresh_lock_until = ?
          WHERE id = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)`,
        [until, id, now],
      );
      return changes === 1;
    },
    async releaseRefreshLock(id) {
      await db.run("UPDATE installations SET refresh_lock_until = NULL WHERE id = ?", [id]);
    },
    async putOAuthState(row) {
      await db.run(
        "INSERT INTO oauth_states (state, api_url, verifier, expires_at) VALUES (?, ?, ?, ?)",
        [row.state, row.apiUrl, row.verifier, row.expiresAt],
      );
    },
    async takeOAuthState(state, now) {
      const row = await db.first("SELECT * FROM oauth_states WHERE state = ?", [state]);
      // Deleted whether or not it's still good: a state is used once.
      const { changes } = await db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
      await db.run("DELETE FROM oauth_states WHERE expires_at < ?", [now]);
      if (!row || changes !== 1 || Number(row.expires_at) < now) return undefined;
      return {
        state: String(row.state),
        apiUrl: String(row.api_url),
        verifier: String(row.verifier),
        expiresAt: Number(row.expires_at),
      } satisfies OAuthStateRow;
    },
    async eventSeen(installationId: string, source: EventSource, eventId: string) {
      const row = await db.first(
        "SELECT 1 AS seen FROM events WHERE installation_id = ? AND source = ? AND event_id = ?",
        [installationId, source, eventId],
      );
      return row !== undefined;
    },
    async markEvent(installationId, source, eventId, at) {
      await db.run(
        `INSERT OR IGNORE INTO events (installation_id, source, event_id, handled_at)
          VALUES (?, ?, ?, ?)`,
        [installationId, source, eventId, at],
      );
    },
    async putPayment(row) {
      await db.run(
        `INSERT OR REPLACE INTO payments (installation_id, payment_id, cart_id, intent_id,
          created_at) VALUES (?, ?, ?, ?, ?)`,
        [row.installationId, row.paymentId, row.cartId, row.intentId, row.createdAt],
      );
    },
    async paymentById(installationId, paymentId) {
      const row = await db.first(
        "SELECT * FROM payments WHERE installation_id = ? AND payment_id = ?",
        [installationId, paymentId],
      );
      return row && toPayment(row);
    },
    async paymentByIntent(installationId, intentId) {
      const row = await db.first(
        "SELECT * FROM payments WHERE installation_id = ? AND intent_id = ? LIMIT 1",
        [installationId, intentId],
      );
      return row && toPayment(row);
    },
  };
}

/** A column's text (SQLite may hand back numbers for numeric-looking text). */
function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toInstallation(row: Record<string, unknown>): InstallationRow {
  return {
    id: text(row.id),
    apiUrl: text(row.api_url),
    issuer: text(row.issuer),
    storeId: nullableString(row.store_id),
    appSecret: text(row.app_secret),
    tokens: nullableString(row.tokens),
    scopes: text(row.scopes),
    adminOrigins: toOrigins(row.admin_origins),
    settings: toSettings(row.settings),
    refreshLockUntil: nullableNumber(row.refresh_lock_until),
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
    uninstalledAt: nullableNumber(row.uninstalled_at),
  };
}

function toPayment(row: Record<string, unknown>): PaymentRow {
  return {
    installationId: text(row.installation_id),
    paymentId: text(row.payment_id),
    cartId: nullableString(row.cart_id),
    intentId: text(row.intent_id),
    createdAt: Number(row.created_at),
  };
}

function toOrigins(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJson(value) : undefined;
  return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string") : [];
}

function toSettings(value: unknown): StoredSettings | null {
  const parsed = typeof value === "string" ? parseJson(value) : undefined;
  if (!isRecord(parsed)) return null;
  const optional = (key: string) => (typeof parsed[key] === "string" ? parsed[key] : null);
  return {
    secretKey: optional("secretKey"),
    publishableKey: optional("publishableKey"),
    webhookSecret: optional("webhookSecret"),
    captureMode: parsed.captureMode === "manual" ? "manual" : "automatic",
    secretKeyLast4: optional("secretKeyLast4"),
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
  };
}
