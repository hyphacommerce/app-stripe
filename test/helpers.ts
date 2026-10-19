// A harness for the tests: the app over in-memory SQLite, with `fetch` routed to a fake
// Hypha API and the fake Stripe, and a way to install it into the fake Hypha.

import { signRequest } from "@hypha/app";

import { createApp } from "../src/app.ts";
import { createDeps, type Deps } from "../src/config.ts";
import { sqliteStorage } from "../src/storage/sqlite.ts";
import { createFakeStripe, type FakeStripe } from "./fake-stripe.ts";

export const APP_URL = "https://stripe-app.test";
export const API_URL = "https://api.shop.test";
export const STRIPE_BASE = "https://stripe.test";
export const KEY = "a".repeat(64);
export const STORE = "store_0123456789abcdef0123456789abcdef";
export const APP_SECRET = "hypha_as_testsecret";
export const SECRET_KEY = "sk_test_fake000000000000";
export const PUBLISHABLE_KEY = "pk_test_fake000000000000";
export const WEBHOOK_SECRET = "whsec_testsigningsecret";

export interface FakeHypha {
  /** Requests the app sent to Hypha. */
  requests: { method: string; path: string; body: string; headers: Headers }[];
  /** Payment events reported, by payment. */
  events: { payment: string; body: Record<string, unknown>; idempotencyKey: string | null }[];
  orders: Map<string, Record<string, unknown>>;
  /** The next token answer's app secret (undefined: none, like a re-authorization). */
  appSecret: string | undefined;
  tokenCalls: URLSearchParams[];
  issuedTokens: number;
  /** Leaves `store` and `issuer` out of token answers, as Hypha did before 0029's fixes. */
  legacyTokens: boolean;
  /** The store's admin origins (`GET /admin/app-extensions/origins`). */
  adminOrigins: string[];
  /** Answers reads of orders with a 503. */
  failOrders: boolean;
}

export interface Harness {
  deps: Deps;
  app: ReturnType<typeof createApp>;
  stripe: FakeStripe;
  hypha: FakeHypha;
  now: { ms: number };
  /** Calls the app. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** Installs through the OAuth flow; returns the installation's ID. */
  install(): Promise<string>;
  /** Calls an extension point as Hypha would, signed. */
  extension(
    point: string,
    body: unknown,
    options?: { store?: string; secret?: string; idempotencyKey?: string },
  ): Promise<Response>;
}

export async function harness(): Promise<Harness> {
  const stripe = createFakeStripe({ keys: [SECRET_KEY] });
  const now = { ms: Date.parse("2026-10-19T10:00:00Z") };
  const hypha: FakeHypha = {
    requests: [],
    events: [],
    orders: new Map(),
    appSecret: APP_SECRET,
    tokenCalls: [],
    issuedTokens: 0,
    legacyTokens: false,
    adminOrigins: ["https://admin.shop.test"],
    failOrders: false,
  };
  const fakeHypha = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : await request.text();
    hypha.requests.push({
      method: request.method,
      path: url.pathname,
      body,
      headers: request.headers,
    });
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      hypha.tokenCalls.push(form);
      if (form.get("grant_type") === "authorization_code" && form.get("code") !== "hypha_ac_good")
        return Response.json(
          { error: "invalid_grant", error_description: "bad code" },
          { status: 400 },
        );
      hypha.issuedTokens++;
      return Response.json({
        access_token: `hypha_at_${hypha.issuedTokens}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `hypha_rt_${hypha.issuedTokens}`,
        scope: "customer_data:email orders:read payments:write",
        ...(hypha.legacyTokens ? {} : { store: STORE, issuer: API_URL }),
        ...(form.get("grant_type") === "authorization_code" && hypha.appSecret
          ? { app_secret: hypha.appSecret }
          : {}),
      });
    }
    if (url.pathname === "/admin/app-extensions/origins")
      return Response.json({ origins: hypha.adminOrigins });
    const payment = /^\/admin\/payments\/([^/]+)$/.exec(url.pathname);
    if (payment?.[1] && request.method === "GET") {
      for (const [orderId, order] of hypha.orders) {
        const payments = (order.payments ?? []) as Record<string, unknown>[];
        const found = payments.find((p) => p.id === payment[1]);
        if (found) return Response.json({ ...found, order: orderId });
      }
      return Response.json({ code: "payment_not_found", error: "no" }, { status: 404 });
    }
    const order = /^\/admin\/orders\/([^/]+)$/.exec(url.pathname);
    if (order?.[1] && hypha.failOrders)
      return Response.json({ code: "unavailable", error: "try later" }, { status: 503 });
    if (order?.[1]) {
      const found = hypha.orders.get(order[1]);
      return found
        ? Response.json(found)
        : Response.json({ code: "order_not_found", error: "no" }, { status: 404 });
    }
    const event = /^\/admin\/payments\/([^/]+)\/events$/.exec(url.pathname);
    if (event?.[1] && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (!hypha.events.some((e) => e.idempotencyKey === key && key !== null))
        hypha.events.push({ payment: event[1], body: parsed, idempotencyKey: key });
      return Response.json({ payment: { id: event[1] }, order: "ord_1", financial_status: "paid" });
    }
    return Response.json({ code: "route_not_found", error: url.pathname }, { status: 404 });
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url.startsWith(STRIPE_BASE)) return stripe.handle(request);
    if (request.url.startsWith(API_URL)) return fakeHypha(request);
    throw new Error(`unexpected fetch ${request.url}`);
  };
  const deps = await createDeps({
    env: { APP_URL, APP_ENCRYPTION_KEY: KEY, STRIPE_API_BASE: STRIPE_BASE },
    storage: sqliteStorage(":memory:"),
    fetch,
    now: () => now.ms,
    log: () => {},
  });
  await deps.storage.migrate();
  const app = createApp(deps);
  const call = async (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${APP_URL}${path}`, init));
  return {
    deps,
    app,
    stripe,
    hypha,
    now,
    call,
    async install() {
      const started = await call(`/install?api=${encodeURIComponent(API_URL)}`);
      const location = new URL(started.headers.get("location") ?? "");
      const state = location.searchParams.get("state") ?? "";
      const done = await call(
        `/oauth/callback?code=hypha_ac_good&state=${encodeURIComponent(state)}`,
      );
      if (done.status !== 200)
        throw new Error(`install failed: ${done.status} ${await done.text()}`);
      const row = await deps.storage.installationByIssuer(API_URL);
      if (!row) throw new Error("no installation");
      return row.id;
    },
    async extension(point, body, options = {}) {
      const raw = JSON.stringify(body);
      const path = `/hypha/payments/${point.split(".")[1]}`;
      return call(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "hypha-signature": await signRequest(options.secret ?? APP_SECRET, raw, {
            timestamp: Math.floor(Date.now() / 1000),
          }),
          "hypha-extension": point,
          "hypha-extension-version": "1",
          // Hypha's keys: the payment ID for a start, a new one per attempt otherwise.
          "idempotency-key":
            options.idempotencyKey ??
            (point === "payments.start"
              ? ((body as { payment?: string }).payment ?? "key")
              : `${(body as { payment?: string }).payment}:${point.split(".")[1]}:${crypto.randomUUID()}`),
          "hypha-store": options.store ?? STORE,
        },
        body: raw,
      });
    },
  };
}

/** Saves Stripe settings for the installation directly. */
export async function configure(
  h: Harness,
  settings: Partial<{ captureMode: "automatic" | "manual"; webhookSecret: string | null }> = {},
) {
  const { Installations } = await import("../src/installations.ts");
  const installations = new Installations(h.deps);
  const row = await h.deps.storage.installationByIssuer(API_URL);
  if (!row) throw new Error("install first");
  const installation = await installations.open(row);
  await installations.saveSettings(installation, {
    secretKey: SECRET_KEY,
    publishableKey: PUBLISHABLE_KEY,
    webhookSecret: settings.webhookSecret === undefined ? WEBHOOK_SECRET : settings.webhookSecret,
    captureMode: settings.captureMode ?? "automatic",
    secretKeyLast4: null,
  });
}
