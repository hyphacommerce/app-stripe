// Installations: which Hypha store a call is for, its secrets, and a client for its API.
//
// One app instance serves many Hypha deployments (each a store). An installation is
// keyed by the store ID Hypha's token answer names (`store`), which every signed call
// repeats in `Hypha-Store` (extension calls, blocks, the admin proxy, webhooks) and
// session tokens in their `store` claim: the store picks the secret, then the signature
// is checked with it.

import {
  HyphaClient,
  NotInstalledError,
  OAuthError,
  type TokenSet,
  type TokenStore,
} from "@hypha/app";

import type { Deps } from "./config.ts";
import { isRecord, num, parseJson, str } from "./json.ts";
import { StripeClient } from "./stripe/api.ts";
import type { CaptureMode, InstallationRow, StoredSettings } from "./storage/types.ts";

/** An installation with its secrets opened, for one request. */
export interface Installation {
  row: InstallationRow;
  appSecret: string;
}

export interface Settings {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  captureMode: CaptureMode;
  secretKeyLast4: string | null;
}

export class NotConfiguredError extends Error {
  constructor(message = "Stripe isn't set up for this store yet: add the keys in its settings") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** Refresh access tokens this long before they expire. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** How long one refresh may hold the lock. */
const LOCK_MS = 15_000;
/** How often a refresh waiting for the lock tries again. */
const LOCK_POLL_MS = 200;
/** Admin origins are read again for an unknown `?origin=` at most this often. */
const ORIGINS_REFRESH_MS = 5 * 60_000;

export class Installations {
  readonly #deps: Deps;
  /** One client per installation, so refreshes are single-flight within this isolate. */
  readonly #clients = new Map<string, HyphaClient>();
  #originsRefreshedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async open(row: InstallationRow): Promise<Installation> {
    return { row, appSecret: await this.#deps.sealer.open(row.appSecret, `${row.id}:app_secret`) };
  }

  /** The active installation for a store (`Hypha-Store`, a session token's `store`). */
  async byStore(storeId: string | null | undefined): Promise<Installation | undefined> {
    if (!storeId) return undefined;
    const row = await this.#deps.storage.installationByStore(storeId);
    if (!row || row.uninstalledAt !== null) return undefined;
    try {
      return await this.open(row);
    } catch {
      this.#deps.log("error", "an installation's secret doesn't open", { installation: row.id });
      return undefined;
    }
  }

  /** The store's app secret, for the SDK's `secret` callbacks. */
  async secretOf(storeId: string | null | undefined): Promise<string | undefined> {
    return (await this.byStore(storeId))?.appSecret;
  }

  /** A client for the installation's admin API, authenticated as the app. */
  client(installation: Installation): HyphaClient {
    const { row } = installation;
    let client = this.#clients.get(row.id);
    if (!client) {
      client = new HyphaClient({
        apiUrl: row.apiUrl,
        manifestUrl: this.#deps.config.manifestUrl,
        tokens: this.#tokenStore(row),
        fetch: this.#deps.fetch,
        now: this.#deps.now,
        refreshMarginMs: REFRESH_MARGIN_MS,
      });
      this.#clients.set(row.id, client);
    }
    return client;
  }

  /**
   * The store's admin origins read again (`GET /admin/app-extensions/origins`) and kept;
   * `undefined` when Hypha can't be asked.
   */
  async refreshAdminOrigins(installation: Installation): Promise<string[] | undefined> {
    try {
      const response = await this.client(installation).fetch("/admin/app-extensions/origins");
      if (!response.ok) return undefined;
      const body = parseJson(await response.text());
      const origins = isRecord(body) ? body.origins : undefined;
      if (!Array.isArray(origins)) return undefined;
      const list = origins.filter((o): o is string => typeof o === "string");
      await this.#deps.storage.setAdminOrigins(installation.row.id, list);
      installation.row = { ...installation.row, adminOrigins: list };
      return list;
    } catch (error) {
      this.#deps.log("warn", "reading the admin origins failed", { error: String(error) });
      return undefined;
    }
  }

  /**
   * Every active installation's admin origins read again, at most every
   * `ORIGINS_REFRESH_MS` (an unknown `?origin=` costs strangers nothing more); whether
   * it ran.
   */
  async refreshAllAdminOrigins(): Promise<boolean> {
    const now = this.#deps.now();
    if (now - this.#originsRefreshedAt < ORIGINS_REFRESH_MS) return false;
    this.#originsRefreshedAt = now;
    for (const row of await this.#deps.storage.activeInstallations()) {
      const installation = await this.open(row).catch(() => undefined);
      if (installation) await this.refreshAdminOrigins(installation);
    }
    return true;
  }

  /** Forgets cached clients (after an uninstall or a reinstall). */
  forget(id: string): void {
    this.#clients.delete(id);
  }

  /**
   * The installation's tokens, sealed in storage, with a lock in storage around
   * `HyphaClient`'s refreshes (`withLock`). Hypha's refresh tokens rotate and a reused one
   * revokes the grant, so two isolates (or processes) must never refresh the same token:
   * the client refreshes inside the lock and reads the tokens again first, so one that
   * waited uses the pair the other stored.
   */
  #tokenStore(row: InstallationRow): TokenStore {
    const { storage, sealer, now } = this.#deps;
    const context = `${row.id}:tokens`;
    return {
      get: async () => {
        const current = await storage.getInstallation(row.id);
        if (!current?.tokens || current.uninstalledAt !== null) return undefined;
        return toTokenSet(parseJson(await sealer.open(current.tokens, context)), current);
      },
      set: async (tokens) => {
        await storage.setTokens(
          row.id,
          await sealer.seal(JSON.stringify(tokens), context),
          tokens.scopes.join(" "),
        );
      },
      withLock: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
        // Whoever holds it finishes, or its lock lapses, within `LOCK_MS`.
        for (let wait = 0; !(await storage.takeRefreshLock(row.id, now(), now() + LOCK_MS));) {
          if (wait >= LOCK_MS) throw new Error("the token refresh lock is held too long");
          await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
          wait += LOCK_POLL_MS;
        }
        try {
          return await fn();
        } catch (error) {
          if (error instanceof OAuthError && error.code === "invalid_grant") {
            // The grant is gone (uninstalled, or revoked): reinstall to get tokens.
            await storage.setTokens(row.id, null);
            this.forget(row.id);
            throw new NotInstalledError();
          }
          throw error;
        } finally {
          await storage.releaseRefreshLock(row.id);
        }
      },
    };
  }

  async settings(installation: Installation): Promise<Settings> {
    const stored = installation.row.settings;
    const open = async (value: string | null, field: string) =>
      value === null ? null : this.#deps.sealer.open(value, `${installation.row.id}:${field}`);
    return {
      secretKey: await open(stored?.secretKey ?? null, "stripe_secret_key"),
      publishableKey: stored?.publishableKey ?? null,
      webhookSecret: await open(stored?.webhookSecret ?? null, "stripe_webhook_secret"),
      captureMode: stored?.captureMode ?? "automatic",
      secretKeyLast4: stored?.secretKeyLast4 ?? null,
    };
  }

  async saveSettings(installation: Installation, settings: Settings): Promise<StoredSettings> {
    const seal = async (value: string | null, field: string) =>
      value === null ? null : this.#deps.sealer.seal(value, `${installation.row.id}:${field}`);
    const stored: StoredSettings = {
      secretKey: await seal(settings.secretKey, "stripe_secret_key"),
      publishableKey: settings.publishableKey,
      webhookSecret: await seal(settings.webhookSecret, "stripe_webhook_secret"),
      captureMode: settings.captureMode,
      secretKeyLast4: settings.secretKey === null ? null : settings.secretKey.slice(-4),
      updatedAt: this.#deps.now(),
    };
    await this.#deps.storage.setSettings(installation.row.id, stored);
    installation.row = { ...installation.row, settings: stored };
    return stored;
  }

  /** Stripe, with the installation's secret key; `NotConfiguredError` without one. */
  async stripe(installation: Installation): Promise<{ stripe: StripeClient; settings: Settings }> {
    const settings = await this.settings(installation);
    if (!settings.secretKey) throw new NotConfiguredError();
    return {
      stripe: new StripeClient({
        secretKey: settings.secretKey,
        apiBase: this.#deps.config.stripeApiBase,
        fetch: this.#deps.fetch,
      }),
      settings,
    };
  }
}

/**
 * Stored tokens back as a `TokenSet` (`undefined` if they don't read as one). Pairs
 * stored before token answers named the store and issuer take the row's.
 */
function toTokenSet(value: unknown, row: InstallationRow): TokenSet | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = str(value, "accessToken");
  const refreshToken = str(value, "refreshToken");
  const expiresAt = num(value, "expiresAt");
  if (!accessToken || !refreshToken || expiresAt === undefined) return undefined;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const store = str(value, "store") ?? row.storeId ?? "";
  const issuer = str(value, "issuer") ?? row.issuer;
  return { accessToken, refreshToken, expiresAt, scopes, store, issuer };
}
