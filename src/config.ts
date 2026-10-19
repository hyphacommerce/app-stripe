// The app's configuration, read from the environment (Worker vars and secrets, or
// `process.env` on Node): the same names on both.

import { createSealer, type Sealer } from "./crypto.ts";
import { STRIPE_API_BASE } from "./stripe/api.ts";
import type { Storage } from "./storage/types.ts";

export interface Env {
  /** The app's public base URL, e.g. `https://stripe.apps.shop.example`. Required. */
  APP_URL?: string;
  /** 64 hex characters (`openssl rand -hex 32`): seals secrets at rest. Required. */
  APP_ENCRYPTION_KEY?: string;
  /** Stripe's API, for tests and the end-to-end script's fake. */
  STRIPE_API_BASE?: string;
  /** Comma-separated Hypha API origins that may install the app; empty: any. */
  HYPHA_API_ALLOWLIST?: string;
}

export interface Config {
  appUrl: string;
  manifestUrl: string;
  redirectUri: string;
  stripeApiBase: string;
  /** Origins, or `undefined` for any. */
  apiAllowlist: string[] | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function readConfig(env: Env): Config {
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");
  if (!appUrl) throw new ConfigError("APP_URL is required (the app's public base URL)");
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    throw new ConfigError(`APP_URL ${JSON.stringify(appUrl)} isn't a URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    throw new ConfigError("APP_URL must be https (http only for localhost)");
  const allowlist = (env.HYPHA_API_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
  return {
    appUrl,
    manifestUrl: `${appUrl}/manifest.json`,
    redirectUri: `${appUrl}/oauth/callback`,
    stripeApiBase: env.STRIPE_API_BASE?.trim() || STRIPE_API_BASE,
    apiAllowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

/** What every handler gets: configuration, storage, sealing and the outside world. */
export interface Deps {
  config: Config;
  storage: Storage;
  sealer: Sealer;
  fetch: typeof globalThis.fetch;
  /** Unix milliseconds. */
  now: () => number;
  log: (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export interface DepsInput {
  env: Env;
  storage: Storage;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: Deps["log"];
}

export async function createDeps(input: DepsInput): Promise<Deps> {
  const config = readConfig(input.env);
  const key = input.env.APP_ENCRYPTION_KEY;
  if (!key) throw new ConfigError("APP_ENCRYPTION_KEY is required (openssl rand -hex 32)");
  return {
    config,
    storage: input.storage,
    sealer: await createSealer(key),
    fetch: input.fetch ?? ((request, init) => globalThis.fetch(request, init)),
    now: input.now ?? Date.now,
    log:
      input.log ??
      ((level, message, fields) => {
        const line = JSON.stringify({ level, message, ...fields });
        if (level === "error") console.error(line);
        else console.log(line);
      }),
  };
}
