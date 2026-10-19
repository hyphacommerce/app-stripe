// Installing (design note 0029, §4.1): `/install?api=<Hypha API URL>` sends the staff
// member's browser to Hypha's `/oauth/authorize` with a fresh PKCE verifier; Hypha's
// consent page sends it back to `/oauth/callback` with a code, which becomes tokens and,
// on a first install, the app secret.

import {
  createAuthorizationUrl,
  exchangeCode,
  OAuthError,
  parseAuthorizationResponse,
} from "@hypha/app";

import type { Deps } from "./config.ts";
import { randomId } from "./crypto.ts";
import { isRecord, readJson } from "./json.ts";
import type { Installations } from "./installations.ts";
import { SCOPES } from "./manifest.ts";
import { page, escapeHtml } from "./html.ts";
import type { InstallationRow } from "./storage/types.ts";

/** A pending authorization lasts as long as Hypha's (ten minutes). */
const STATE_TTL_MS = 10 * 60_000;

export class InstallError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "InstallError";
    this.status = status;
  }
}

/** The Hypha API's base URL from what a merchant typed: an origin, https (or localhost). */
export function normalizeApiUrl(raw: string, allowlist: string[] | undefined): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InstallError("That isn't a URL: give your Hypha API's address.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new InstallError("The Hypha API must be https (http only for localhost).");
  if (url.username || url.password) throw new InstallError("No credentials in the URL, please.");
  const origin = url.origin;
  if (allowlist && !allowlist.includes(origin))
    throw new InstallError("This app instance doesn't serve that Hypha deployment.", 403);
  return origin;
}

/** Starts an installation: where to send the browser. */
export async function startInstall(deps: Deps, apiInput: string): Promise<string> {
  const apiUrl = normalizeApiUrl(apiInput, deps.config.apiAllowlist);
  const authorization = await createAuthorizationUrl({
    apiUrl,
    manifestUrl: deps.config.manifestUrl,
    redirectUri: deps.config.redirectUri,
    scopes: SCOPES,
  });
  await deps.storage.putOAuthState({
    state: authorization.state,
    apiUrl,
    verifier: await deps.sealer.seal(authorization.codeVerifier, `state:${authorization.state}`),
    expiresAt: deps.now() + STATE_TTL_MS,
  });
  return authorization.url;
}

export interface Installed {
  row: InstallationRow;
  firstInstall: boolean;
}

/** Finishes an installation from the redirect's URL. */
export async function finishInstall(
  deps: Deps,
  installations: Installations,
  url: string,
): Promise<Installed> {
  const answer = parseAuthorizationResponse(url);
  const stateId = answer.state;
  const state = stateId ? await deps.storage.takeOAuthState(stateId, deps.now()) : undefined;
  if (!answer.ok) {
    if (answer.error === "access_denied")
      throw new InstallError("The installation was declined in the Hypha admin.", 403);
    throw new InstallError(
      `Hypha answered ${answer.error}${answer.description ? `: ${answer.description}` : ""}.`,
    );
  }
  if (!state)
    throw new InstallError(
      "This link has expired or was already used: start the installation again.",
    );
  const codeVerifier = await deps.sealer.open(state.verifier, `state:${state.state}`);

  let tokens;
  try {
    tokens = await exchangeCode({
      apiUrl: state.apiUrl,
      manifestUrl: deps.config.manifestUrl,
      code: answer.code,
      codeVerifier,
      redirectUri: deps.config.redirectUri,
      fetch: deps.fetch,
      now: deps.now,
    });
  } catch (error) {
    if (error instanceof OAuthError && error.code === "invalid_response")
      // The SDK refuses an answer without `store` and `issuer` (a Hypha before 0029's fixes).
      throw new InstallError(
        `Hypha's token answer isn't one this app reads (${error.message}): update Hypha.`,
        502,
      );
    if (error instanceof OAuthError)
      throw new InstallError(`Hypha refused the code (${error.code}): start again.`, 502);
    throw error;
  }

  // The token answer names the store and the issuer: the installation's keys.
  const { store, issuer } = tokens;
  const adminOrigins = await adminOriginsOf(deps, state.apiUrl, tokens.accessToken);
  const existing =
    (await deps.storage.installationByStore(store)) ??
    (await deps.storage.installationByIssuer(issuer));
  const now = deps.now();
  const id = existing?.id ?? randomId("inst");
  const secret = tokens.appSecret
    ? await deps.sealer.seal(tokens.appSecret, `${id}:app_secret`)
    : existing?.appSecret;
  if (!secret)
    // Hypha sends the secret only with an app's first grant. Without it there's nothing
    // to verify Hypha's calls with: uninstall the app in Hypha and install it again.
    throw new InstallError(
      "Hypha didn't send the app secret (the app was installed before): uninstall Stripe in your Hypha admin, then install it again.",
      409,
    );
  const row: InstallationRow = {
    id,
    apiUrl: state.apiUrl,
    issuer,
    storeId: store,
    appSecret: secret,
    tokens: await deps.sealer.seal(JSON.stringify(tokens), `${id}:tokens`),
    scopes: tokens.scopes.join(" "),
    adminOrigins: adminOrigins ?? existing?.adminOrigins ?? [],
    settings: existing?.settings ?? null,
    refreshLockUntil: null,
    installedAt: existing && existing.uninstalledAt === null ? existing.installedAt : now,
    updatedAt: now,
    uninstalledAt: null,
  };
  await deps.storage.putInstallation(row);
  installations.forget(id);
  deps.log("info", "installed", {
    installation: id,
    store,
    issuer,
    first: Boolean(tokens.appSecret),
  });
  return { row, firstInstall: !existing || existing.uninstalledAt !== null };
}

/** The store's admin origins (`GET /admin/app-extensions/origins`), for frame-ancestors. */
async function adminOriginsOf(
  deps: Deps,
  apiUrl: string,
  accessToken: string,
): Promise<string[] | undefined> {
  try {
    const response = await deps.fetch(new URL("/admin/app-extensions/origins", apiUrl), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const body = await readJson(response);
    const origins = isRecord(body) ? body.origins : undefined;
    return Array.isArray(origins)
      ? origins.filter((o): o is string => typeof o === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

export function installPage(error?: string): string {
  return page(
    "Install Stripe for Hypha",
    `<h1>Stripe for Hypha</h1>
     <p>Card payments through Stripe's Payment Element, for any Hypha store.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
     <form method="get" action="/install">
       <label>Your Hypha API's address
         <input name="api" type="url" required placeholder="https://api.shop.example">
       </label>
       <button type="submit">Install</button>
     </form>
     <p class="muted">You'll be asked to approve the app's access in your Hypha admin.</p>`,
  );
}

export function installedPage(installed: Installed): string {
  return page(
    "Stripe is installed",
    `<h1>Stripe is installed</h1>
     <p>${installed.firstInstall ? "The app is connected to" : "The app's access was renewed for"}
       <code>${escapeHtml(installed.row.apiUrl)}</code>.</p>
     <p>Next: open <strong>Settings → Stripe</strong> in your Hypha admin, add your Stripe keys,
       then create a payment method whose provider is <code>app_stripe</code>.</p>`,
  );
}
