// Installations: which Hypha store a call is for, its secrets, and a client for its API.
//
// One app instance serves many Hypha deployments (each a store). An installation is
// keyed by its API's OAuth issuer, and by its store ID once known. Hypha's token answer
// carries no store ID, and its webhooks no `Hypha-Store` header, so the store is learned
// from the first signed call that names one, and a call whose store isn't known yet is
// matched by the secret that verifies its signature (each installation has its own).

import {
  HyphaClient,
  NotInstalledError,
  OAuthError,
  refresh,
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

/** Refresh access tokens this long before they expire (more than the client's margin). */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** How long one refresh may hold the lock. */
const LOCK_MS = 15_000;

export class Installations {
  readonly #deps: Deps;
  /** One client per installation, so refreshes are single-flight within this isolate. */
  readonly #clients = new Map<string, HyphaClient>();

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async open(row: InstallationRow): Promise<Installation> {
    return { row, appSecret: await this.#deps.sealer.open(row.appSecret, `${row.id}:app_secret`) };
  }

  /**
   * The installation whose secret `verify` accepts: the one with `hint.store` (or
   * `hint.issuer`) first, then every other active one. Binds the store ID when the hint
   * names one. `undefined` when no secret verifies.
   */
  async resolve(
    verify: (secret: string) => Promise<boolean>,
    hint: { store?: string | null; issuer?: string | null } = {},
  ): Promise<Installation | undefined> {
    const { storage } = this.#deps;
    const candidates: InstallationRow[] = [];
    const seen = new Set<string>();
    const add = (row: InstallationRow | undefined) => {
      if (row && row.uninstalledAt === null && !seen.has(row.id)) {
        seen.add(row.id);
        candidates.push(row);
      }
    };
    if (hint.store) add(await storage.installationByStore(hint.store));
    if (hint.issuer) add(await storage.installationByIssuer(hint.issuer));
    // Only installations whose store isn't known yet can be the hinted store's.
    const others = await storage.activeInstallations();
    for (const row of others) if (!hint.store || row.storeId === null) add(row);

    for (const row of candidates) {
      let installation: Installation;
      try {
        installation = await this.open(row);
      } catch {
        this.#deps.log("error", "an installation's secret doesn't open", { installation: row.id });
        continue;
      }
      if (!(await verify(installation.appSecret))) continue;
      if (hint.store && row.storeId !== hint.store) {
        await storage.setStore(row.id, hint.store);
        installation.row = { ...row, storeId: hint.store };
      }
      return installation;
    }
    return undefined;
  }

  async byStore(storeId: string): Promise<Installation | undefined> {
    const row = await this.#deps.storage.installationByStore(storeId);
    return row && row.uninstalledAt === null ? this.open(row) : undefined;
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
      });
      this.#clients.set(row.id, client);
    }
    return client;
  }

  /** Forgets cached clients (after an uninstall or a reinstall). */
  forget(id: string): void {
    this.#clients.delete(id);
  }

  /**
   * A `TokenStore` that refreshes under a lock in storage. Hypha's refresh tokens rotate
   * and a reused one revokes the grant, so two isolates (or processes) must never
   * refresh the same token: `get` refreshes early, holding the lock, and the others wait
   * for the new tokens instead.
   */
  #tokenStore(row: InstallationRow): TokenStore {
    const { storage, sealer, now, config, fetch } = this.#deps;
    const context = `${row.id}:tokens`;
    const read = async (): Promise<TokenSet | undefined> => {
      const current = await storage.getInstallation(row.id);
      if (!current?.tokens || current.uninstalledAt !== null) return undefined;
      return toTokenSet(parseJson(await sealer.open(current.tokens, context)));
    };
    const write = async (tokens: TokenSet) => {
      await storage.setTokens(
        row.id,
        await sealer.seal(JSON.stringify(tokens), context),
        tokens.scopes.join(" "),
      );
    };
    const fresh = (tokens: TokenSet) => tokens.expiresAt - REFRESH_MARGIN_MS > now();
    return {
      get: async () => {
        const tokens = await read();
        if (!tokens || fresh(tokens)) return tokens;
        const deadline = now() + LOCK_MS;
        while (now() < deadline) {
          if (await storage.takeRefreshLock(row.id, now(), now() + LOCK_MS)) {
            try {
              const latest = await read();
              if (!latest || fresh(latest)) return latest;
              const next = await refresh({
                apiUrl: row.apiUrl,
                manifestUrl: config.manifestUrl,
                refreshToken: latest.refreshToken,
                fetch,
                now,
              });
              await write(next);
              return next;
            } catch (error) {
              if (error instanceof OAuthError && error.code === "invalid_grant") {
                // The grant is gone (uninstalled, or revoked): reinstall to get tokens.
                await storage.setTokens(row.id, null);
                throw new NotInstalledError();
              }
              throw error;
            } finally {
              await storage.releaseRefreshLock(row.id);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          const latest = await read();
          if (!latest || fresh(latest)) return latest;
        }
        return read();
      },
      set: write,
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

/** Stored tokens back as a `TokenSet` (`undefined` if they don't read as one). */
function toTokenSet(value: unknown): TokenSet | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = str(value, "accessToken");
  const refreshToken = str(value, "refreshToken");
  const expiresAt = num(value, "expiresAt");
  if (!accessToken || !refreshToken || expiresAt === undefined) return undefined;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return { accessToken, refreshToken, expiresAt, scopes };
}
