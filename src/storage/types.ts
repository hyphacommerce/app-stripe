// What the app keeps, behind one small interface: D1 on Workers (`d1.ts`), SQLite on
// Node (`sqlite.ts`), both through the SQL in `sql.ts`. Values that are secrets arrive
// here already sealed (`crypto.ts`): storage never sees a Stripe key or a token in clear.

/** One Hypha store the app is installed in. A Hypha deployment serves one store. */
export interface InstallationRow {
  /** `inst_…`, the app's own ID for the installation. */
  id: string;
  /** The Hypha API's base URL the app calls (`https://api.shop.example`). */
  apiUrl: string;
  /** The API's OAuth issuer, from the token answer, as session tokens name it. */
  issuer: string;
  /**
   * Hypha's store ID (`store_…`), from the token answer. Null only in rows made before
   * token answers named it: authorizing the app again binds it.
   */
  storeId: string | null;
  /** Sealed: Hypha's app secret, which signs its calls and session tokens. */
  appSecret: string;
  /** Sealed JSON `TokenSet`; null once uninstalled or the grant is gone. */
  tokens: string | null;
  /** The granted scopes, space-separated. */
  scopes: string;
  /** The store's admin origins (for `frame-ancestors` and the bridge). */
  adminOrigins: string[];
  /** The merchant's settings, with the secret fields sealed. */
  settings: StoredSettings | null;
  /** Unix ms until which a token refresh is under way elsewhere. */
  refreshLockUntil: number | null;
  installedAt: number;
  updatedAt: number;
  uninstalledAt: number | null;
}

export type CaptureMode = "automatic" | "manual";

export interface StoredSettings {
  /** Sealed `sk_…` or `rk_…`. */
  secretKey: string | null;
  publishableKey: string | null;
  /** Sealed `whsec_…`. */
  webhookSecret: string | null;
  captureMode: CaptureMode;
  /** The secret key's last four characters, to show which one is set. */
  secretKeyLast4: string | null;
  updatedAt: number;
}

/** A pending authorization: the browser went to Hypha's consent page. */
export interface OAuthStateRow {
  state: string;
  apiUrl: string;
  /** Sealed PKCE verifier. */
  verifier: string;
  expiresAt: number;
}

/** A Hypha payment and the PaymentIntent the app made for it. */
export interface PaymentRow {
  installationId: string;
  paymentId: string;
  /** The cart it was started for (a payment starts before its order exists); `null` for
   * a row written before payments started with a cart. */
  cartId: string | null;
  intentId: string;
  createdAt: number;
}

export interface Storage {
  /** Creates the tables when missing; cheap to call again. */
  migrate(): Promise<void>;

  getInstallation(id: string): Promise<InstallationRow | undefined>;
  installationByIssuer(issuer: string): Promise<InstallationRow | undefined>;
  installationByStore(storeId: string): Promise<InstallationRow | undefined>;
  /** Every installation that isn't uninstalled. */
  activeInstallations(): Promise<InstallationRow[]>;
  /**
   * Inserts or replaces the row with this ID; a stale row holding its issuer or store
   * (a reset deployment's) goes.
   */
  putInstallation(row: InstallationRow): Promise<void>;
  setAdminOrigins(id: string, origins: string[]): Promise<void>;
  setTokens(id: string, tokens: string | null, scopes?: string): Promise<void>;
  setSettings(id: string, settings: StoredSettings): Promise<void>;
  markUninstalled(id: string, at: number): Promise<void>;
  /** Takes the refresh lock until `until` if nobody holds it at `now`; whether it did. */
  takeRefreshLock(id: string, now: number, until: number): Promise<boolean>;
  releaseRefreshLock(id: string): Promise<void>;

  putOAuthState(row: OAuthStateRow): Promise<void>;
  /** Reads and deletes a state (single use); expired ones are never returned. */
  takeOAuthState(state: string, now: number): Promise<OAuthStateRow | undefined>;

  /** Whether an event (Stripe's `evt_…`, or Hypha's) was handled already. */
  eventSeen(installationId: string, source: EventSource, eventId: string): Promise<boolean>;
  markEvent(
    installationId: string,
    source: EventSource,
    eventId: string,
    at: number,
  ): Promise<void>;

  putPayment(row: PaymentRow): Promise<void>;
  paymentById(installationId: string, paymentId: string): Promise<PaymentRow | undefined>;
  paymentByIntent(installationId: string, intentId: string): Promise<PaymentRow | undefined>;
}

export type EventSource = "stripe" | "hypha";
