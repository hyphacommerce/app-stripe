// The merchant's settings: Stripe's secret and publishable keys, the webhook signing
// secret and the capture mode. Secrets are write-only: the page and the API say whether
// one is set (and a secret key's last four characters), never what it is.
//
// Two ways in, the same rules: the settings page in the admin's iframe calls
// `/api/settings` with a session token from the bridge (design note 0029, §6.3), and
// any admin can save through Hypha's app proxy (`/admin/apps/app_stripe/proxy/settings`,
// §6.1, §8), signed by Hypha. Reading needs `payments:read`, saving `payments:write`,
// as far as the staff member holds them.

import {
  SessionTokenError,
  STORE_HEADER,
  verifyForwardedRequest,
  verifySessionToken,
} from "@hypha/app";

import type { Deps } from "./config.ts";
import { fromBase64Url } from "./crypto.ts";
import { escapeHtml, page } from "./html.ts";
import type { Installation, Installations, Settings } from "./installations.ts";
import { APP_KEY } from "./manifest.ts";
import { isRecord, StripeClient, StripeError } from "./stripe/api.ts";

export interface SettingsView {
  store: string | null;
  /** Where to point Stripe's webhook endpoint; null until the store is known. */
  webhook_url: string | null;
  /** From the secret key: `test` or `live`, null without one. */
  mode: "test" | "live" | null;
  secret_key: { set: boolean; last4: string | null };
  publishable_key: string | null;
  webhook_secret: { set: boolean };
  capture_mode: "automatic" | "manual";
  /** Events to select for the endpoint in Stripe's dashboard. */
  webhook_events: string[];
}

export const STRIPE_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.amount_capturable_updated",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
];

export class SettingsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function keyMode(key: string | null): "test" | "live" | null {
  if (!key) return null;
  if (key.includes("_test_")) return "test";
  if (key.includes("_live_")) return "live";
  return null;
}

export function settingsView(
  deps: Deps,
  installation: Installation,
  settings: Settings,
): SettingsView {
  const store = installation.row.storeId;
  return {
    store,
    webhook_url: store ? `${deps.config.appUrl}/stripe/webhook/${encodeURIComponent(store)}` : null,
    mode: keyMode(settings.secretKey),
    secret_key: { set: settings.secretKey !== null, last4: settings.secretKeyLast4 },
    publishable_key: settings.publishableKey,
    webhook_secret: { set: settings.webhookSecret !== null },
    capture_mode: settings.captureMode,
    webhook_events: STRIPE_EVENTS,
  };
}

const PATTERNS = {
  secret_key: /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/,
  publishable_key: /^pk_(test|live)_[A-Za-z0-9]{8,}$/,
  webhook_secret: /^whsec_[A-Za-z0-9+/=]{8,}$/,
};

/** Applies a partial update: absent keeps a field, `null` or `""` clears it. */
export async function updateSettings(
  deps: Deps,
  installations: Installations,
  installation: Installation,
  input: unknown,
): Promise<SettingsView> {
  if (!isRecord(input)) throw new SettingsError(422, "invalid_body", "send a JSON object");
  const allowed = new Set(["secret_key", "publishable_key", "webhook_secret", "capture_mode"]);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      throw new SettingsError(422, "unknown_field", `${JSON.stringify(key)} isn't a setting`, key);

  const current = await installations.settings(installation);
  const next: Settings = { ...current };
  const text = (field: keyof typeof PATTERNS): string | null | undefined => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (typeof value !== "string")
      throw new SettingsError(422, "invalid_value", `${field} is a string`, field);
    const trimmed = value.trim();
    if (!PATTERNS[field].test(trimmed))
      throw new SettingsError(
        422,
        `invalid_${field}`,
        `that doesn't look like a Stripe ${field.replace("_", " ")}`,
        field,
      );
    return trimmed;
  };
  const secretKey = text("secret_key");
  const publishableKey = text("publishable_key");
  const webhookSecret = text("webhook_secret");
  if (secretKey !== undefined) {
    next.secretKey = secretKey;
    next.secretKeyLast4 = secretKey === null ? null : secretKey.slice(-4);
  }
  if (publishableKey !== undefined) next.publishableKey = publishableKey;
  if (webhookSecret !== undefined) next.webhookSecret = webhookSecret;
  if (input.capture_mode !== undefined) {
    if (input.capture_mode !== "automatic" && input.capture_mode !== "manual")
      throw new SettingsError(
        422,
        "invalid_capture_mode",
        "capture_mode is automatic or manual",
        "capture_mode",
      );
    next.captureMode = input.capture_mode;
  }
  const secretMode = keyMode(next.secretKey);
  const publishableMode = keyMode(next.publishableKey);
  if (secretMode && publishableMode && secretMode !== publishableMode)
    throw new SettingsError(
      422,
      "key_modes_differ",
      `the secret key is a ${secretMode} key, the publishable key a ${publishableMode} one`,
      "publishable_key",
    );

  if (secretKey) {
    // A key Stripe doesn't know is better refused now than at the first checkout.
    try {
      await new StripeClient({
        secretKey,
        apiBase: deps.config.stripeApiBase,
        fetch: deps.fetch,
      }).retrieveAccount();
    } catch (error) {
      if (error instanceof StripeError && (error.status === 401 || error.status === 403))
        throw new SettingsError(
          422,
          "stripe_key_rejected",
          "Stripe doesn't accept this secret key",
          "secret_key",
        );
      if (error instanceof StripeError && error.status === 0)
        throw new SettingsError(502, "stripe_unreachable", "Stripe couldn't be reached: try again");
      // A restricted key without account access still works for payments.
      if (!(error instanceof StripeError)) throw error;
    }
  }
  await installations.saveSettings(installation, next);
  return settingsView(deps, installation, next);
}

/** The installation and scopes behind `Authorization: Bearer <session token>`. */
export async function fromSessionToken(
  installations: Installations,
  request: Request,
): Promise<{ installation: Installation; scopes: string[] } | undefined> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return undefined;
  // The `store` claim picks the secret; verifying with it proves the claim.
  const installation = await installations.byStore(unverifiedStore(token));
  if (!installation) return undefined;
  try {
    const claims = await verifySessionToken(token, installation.appSecret, { audience: APP_KEY });
    if (claims.store !== installation.row.storeId) return undefined;
    return { installation, scopes: claims.scopes };
  } catch (error) {
    if (error instanceof SessionTokenError) return undefined;
    throw error;
  }
}

/** The installation and scopes of a call Hypha forwarded through the admin proxy. */
export async function fromProxy(
  installations: Installations,
  request: Request,
  rawBody: Uint8Array,
): Promise<{ installation: Installation; scopes: string[] } | undefined> {
  const installation = await installations.byStore(request.headers.get(STORE_HEADER));
  if (!installation || !(await verifyForwardedRequest(installation.appSecret, request, rawBody)))
    return undefined;
  const scopes = (request.headers.get("hypha-scopes") ?? "").split(/[ ,]+/).filter(Boolean);
  return { installation, scopes };
}

export function canRead(scopes: string[]): boolean {
  return scopes.includes("payments:read") || scopes.includes("payments:write");
}

export function canWrite(scopes: string[]): boolean {
  return scopes.includes("payments:write");
}

/** A session token's `store` claim, unverified: it only picks the secret to verify with. */
function unverifiedStore(token: string): string | undefined {
  const payload = token.split(".")[1];
  const bytes = payload ? fromBase64Url(payload) : undefined;
  if (!bytes) return undefined;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(claims) && typeof claims.store === "string" ? claims.store : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings page, framed by the admin. The admin names itself in `?origin=` (the
 * Referer when it's missing): only a claim, so it must be one of the installed stores'
 * admin origins (`GET /admin/app-extensions/origins`, kept at install and read again,
 * now and then, for an origin not known yet). That one origin is the page's
 * `frame-ancestors` and the bridge's peer.
 */
export async function settingsPage(
  deps: Deps,
  installations: Installations,
  request: Request,
): Promise<{ html: string; frameAncestors: string }> {
  const rows = await deps.storage.activeInstallations();
  let known = new Set(rows.flatMap((row) => row.adminOrigins));
  const url = new URL(request.url);
  const referer = request.headers.get("referer");
  let candidate = url.searchParams.get("origin") ?? undefined;
  if (!candidate && referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = undefined;
    }
  }
  // A store's admin may have moved since the install.
  if (candidate && !known.has(candidate) && (await installations.refreshAllAdminOrigins()))
    known = new Set((await deps.storage.activeInstallations()).flatMap((row) => row.adminOrigins));
  const hostOrigin = candidate && known.has(candidate) ? candidate : null;
  const frameAncestors = hostOrigin ?? ([...known].join(" ") || "'none'");
  const html = page(
    "Stripe settings",
    `<h1>Stripe</h1>
     <div id="app" data-host-origin="${escapeHtml(hostOrigin ?? "")}" data-known-origins="${escapeHtml(JSON.stringify([...known]))}">
       <p class="muted" id="status">Loading…</p>
       <form id="settings" hidden>
         <div class="box" id="webhook"></div>
         <label>Secret key <span class="hint" id="secret-key-hint"></span>
           <input name="secret_key" type="password" autocomplete="off" placeholder="sk_live_… (leave empty to keep)">
         </label>
         <label>Publishable key
           <input name="publishable_key" type="text" autocomplete="off" placeholder="pk_live_…">
         </label>
         <label>Webhook signing secret <span class="hint" id="webhook-secret-hint"></span>
           <input name="webhook_secret" type="password" autocomplete="off" placeholder="whsec_… (leave empty to keep)">
         </label>
         <label>Capture
           <select name="capture_mode">
             <option value="automatic">Automatic: charge when the buyer pays</option>
             <option value="manual">Manual: authorize, staff capture later</option>
           </select>
         </label>
         <button type="submit">Save</button>
         <p id="message" role="status"></p>
       </form>
     </div>`,
    { script: "/admin/settings.js" },
  );
  return { html, frameAncestors };
}
