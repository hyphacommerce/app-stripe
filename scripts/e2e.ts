// End to end against a real local Hypha: installs the app over OAuth, sets it up, starts
// a cart's card payment through the storefront API, and checks that the order is placed
// once Stripe holds the money (asked through payments.status, and reported by the app
// from Stripe's webhook), then a staff refund (partly) and a void.
//
//   docker compose up -d            # in the Hypha repository: its Postgres
//   pnpm e2e
//
// - Hypha: a copy of `HYPHA_BIN` (default ../hypha/target/debug/hypha-host-axum; never
//   rebuilt here) on a free port, with a fresh database created and dropped around the
//   run (`E2E_PG_CONTAINER`, default hypha-postgres-1, through `docker exec`; or
//   `E2E_ADMIN_DATABASE_URL` with a local `psql`), `HYPHA_ALLOW_PRIVATE_CALLBACKS` so it
//   can call the app on localhost, and `HYPHA_ADMIN_URL` for its consent page's address.
// - The app: in this process (the Node entry), over a temporary SQLite file.
// - Stripe: a fake on a free port (`test/fake-stripe.ts`), unless STRIPE_TEST_SECRET_KEY
//   and STRIPE_TEST_PUBLISHABLE_KEY are set: then Stripe's test mode, the intent
//   confirmed with `pm_card_visa`. Either way Stripe's webhook is simulated (nothing
//   reaches localhost from Stripe), signed with a test secret, from the intent's real state.
//
// Exits non-zero when a step fails; stops everything it started.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/entry/node.ts";
import { signStripePayload } from "../src/stripe/signature.ts";
import { createFakeStripe } from "../test/fake-stripe.ts";

const HYPHA_BIN =
  process.env.HYPHA_BIN ??
  new URL("../../hypha/target/debug/hypha-host-axum", import.meta.url).pathname;
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? "hypha-postgres-1";
const PG_URL_BASE = process.env.E2E_DATABASE_URL_BASE ?? "postgres://hypha:hypha@localhost:5432";
const OWNER = { email: "owner@example.com", password: "stripe-e2e-owner-password" };
const WEBHOOK_SECRET = "whsec_e2etestsigningsecret";
const REAL_STRIPE =
  process.env.STRIPE_TEST_SECRET_KEY && process.env.STRIPE_TEST_PUBLISHABLE_KEY
    ? {
        secret: process.env.STRIPE_TEST_SECRET_KEY,
        publishable: process.env.STRIPE_TEST_PUBLISHABLE_KEY,
      }
    : undefined;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(
      `FAIL ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
    );
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function psql(sql: string) {
  if (process.env.E2E_ADMIN_DATABASE_URL)
    execFileSync("psql", [process.env.E2E_ADMIN_DATABASE_URL, "-c", sql], { stdio: "pipe" });
  else
    execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "hypha", "-c", sql], {
      stdio: "pipe",
    });
}

/** The value at a path in parsed JSON (`undefined` once a step is missing). */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** A JSON string or number as text; anything else is "". */
function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

async function http(
  method: string,
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; redirect?: "manual" } = {},
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const response = await fetch(url, {
    method,
    redirect: options.redirect ?? "manual",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let body: unknown = {};
  try {
    body = JSON.parse(raw);
  } catch {
    // Not JSON (a page): `text` has it.
  }
  return { status: response.status, body, text: raw, headers: response.headers };
}

async function waitFor(url: string, seconds: number) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const work = await mkdtemp(join(tmpdir(), "hypha-stripe-e2e-"));
const database = `hypha_stripe_e2e_${randomBytes(4).toString("hex")}`;
let hypha: ChildProcess | undefined;
let app: Server | undefined;
let stripeServer: Server | undefined;
let databaseCreated = false;

async function cleanup() {
  if (hypha && hypha.exitCode === null) {
    hypha.kill("SIGTERM");
    await new Promise((r) => {
      const timer = setTimeout(() => {
        hypha?.kill("SIGKILL");
        r(undefined);
      }, 5000);
      hypha?.once("exit", () => {
        clearTimeout(timer);
        r(undefined);
      });
    });
  }
  await new Promise((r) => (app ? app.close(r) : r(undefined)));
  await new Promise((r) => (stripeServer ? stripeServer.close(r) : r(undefined)));
  if (databaseCreated) {
    try {
      psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      console.log(`     dropped database ${database}`);
    } catch (error) {
      console.log(`     couldn't drop ${database}: ${String(error)}`);
    }
  }
  await rm(work, { recursive: true, force: true });
}

try {
  // ---------- start everything ----------
  const [hyphaPort, appPort, stripePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const API = `http://127.0.0.1:${hyphaPort}`;
  const APP = `http://127.0.0.1:${appPort}`;

  const fake = createFakeStripe({ keys: ["sk_test_e2efake0000000000"] });
  const stripeKeys = REAL_STRIPE ?? {
    secret: "sk_test_e2efake0000000000",
    publishable: "pk_test_e2efake0000000000",
  };
  if (!REAL_STRIPE) {
    stripeServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const request = new Request(`http://127.0.0.1:${stripePort}${req.url ?? "/"}`, {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            typeof v === "string" ? [[k, v] as [string, string]] : [],
          ),
          body: req.method === "GET" ? undefined : Buffer.concat(chunks),
        });
        void fake.handle(request).then(async (response) => {
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
          return undefined;
        });
      });
    });
    await new Promise<void>((r) => stripeServer?.listen(stripePort, "127.0.0.1", r));
  }
  console.log(
    `     Stripe: ${REAL_STRIPE ? "test mode (api.stripe.com)" : `fake at http://127.0.0.1:${stripePort}`}`,
  );

  app = await startServer({
    APP_URL: APP,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    DATABASE_PATH: join(work, "app.sqlite"),
    PORT: String(appPort),
    HOST: "127.0.0.1",
    ...(REAL_STRIPE ? {} : { STRIPE_API_BASE: `http://127.0.0.1:${stripePort}` }),
  });
  console.log(`     app: ${APP}`);

  psql(`CREATE DATABASE ${database}`);
  databaseCreated = true;
  const bin = join(work, "hypha-host-axum");
  await copyFile(HYPHA_BIN, bin);
  execFileSync("chmod", ["+x", bin]);
  hypha = spawn(bin, [], {
    env: {
      PATH: process.env.PATH,
      RUST_LOG: process.env.RUST_LOG ?? "warn",
      DATABASE_URL: `${PG_URL_BASE}/${database}`,
      HYPHA_SECRET_KEY: randomBytes(32).toString("hex"),
      HYPHA_OWNER_EMAIL: OWNER.email,
      HYPHA_OWNER_PASSWORD: OWNER.password,
      HYPHA_BIND: `127.0.0.1:${hyphaPort}`,
      HYPHA_ADMIN_URL: "http://admin.e2e.localhost",
      HYPHA_ALLOW_PRIVATE_CALLBACKS: "true",
    },
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hyphaLog = "";
  hypha.stdout?.on("data", (d: Buffer) => (hyphaLog += d.toString()));
  hypha.stderr?.on("data", (d: Buffer) => (hyphaLog += d.toString()));
  const up = await waitFor(`${API}/health`, 60);
  check("Hypha starts on a fresh database", up, hyphaLog.slice(-2000));
  if (!up) throw new Error("Hypha didn't start");

  // ---------- the owner ----------
  const login = await http("POST", `${API}/admin/auth/login`, { body: OWNER });
  const session = text(at(login.body, "session", "token"));
  check("the owner logs in", login.status === 200 && session.startsWith("hypha_sess_"), login.body);
  const staff = { authorization: `Bearer ${session}` };
  const admin = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => http(method, `${API}${path}`, { body, headers: { ...staff, ...headers } });

  // ---------- install the app through OAuth ----------
  const install = await http("GET", `${APP}/install?api=${encodeURIComponent(API)}`);
  const authorize = install.headers.get("location") ?? "";
  check(
    "the app sends the browser to Hypha's authorize",
    install.status === 302 && authorize.startsWith(`${API}/oauth/authorize?`),
    authorize,
  );
  const consent = await http("GET", authorize);
  const consentUrl = consent.headers.get("location") ?? "";
  const requestId = /request=(oareq_[0-9a-f]+)/.exec(consentUrl)?.[1] ?? "";
  check(
    "Hypha checks the manifest and asks for consent",
    consent.status === 302 && requestId !== "",
    consent.text || consentUrl,
  );
  const shown = await admin("GET", `/admin/oauth/requests/${requestId}`);
  check(
    "the consent page lists the email scope with its reason",
    JSON.stringify(at(shown.body, "personal_data") ?? "").includes("customer_data:email") &&
      JSON.stringify(at(shown.body, "personal_data") ?? "").includes("receipt"),
    shown.body,
  );
  const approved = await admin("POST", `/admin/oauth/requests/${requestId}/approve`);
  const redirectTo = text(at(approved.body, "redirect_to") ?? "");
  check(
    "the owner approves",
    approved.status === 200 && redirectTo.startsWith(`${APP}/oauth/callback?`),
    approved.body,
  );
  const callback = await http("GET", redirectTo);
  check(
    "the app trades the code and is installed",
    callback.status === 200 && callback.text.includes("Stripe is installed"),
    callback.text.slice(0, 500),
  );
  const settingsPage = await http(
    "GET",
    `${APP}/admin/settings?origin=${encodeURIComponent("http://admin.e2e.localhost")}`,
  );
  check(
    "the settings page trusts ?origin= as the store's admin (GET /admin/app-extensions/origins)",
    settingsPage.text.includes('data-host-origin="http://admin.e2e.localhost"') &&
      (settingsPage.headers.get("content-security-policy") ?? "").includes(
        "frame-ancestors http://admin.e2e.localhost",
      ),
    settingsPage.headers.get("content-security-policy"),
  );
  const strangerPage = await http("GET", `${APP}/admin/settings?origin=https://evil.example`);
  check(
    "and not a stranger's",
    strangerPage.text.includes('data-host-origin=""'),
    strangerPage.text.slice(0, 300),
  );
  const appInfo = await admin("GET", "/admin/apps/app_stripe");
  check(
    "Hypha shows the grant",
    JSON.stringify(appInfo.body).includes('"installed":true'),
    appInfo.body,
  );

  // ---------- settings, through a session token as the settings page does ----------
  const session1 = await admin("POST", "/admin/app-extensions/app_stripe/session");
  const sessionToken = text(at(session1.body, "token") ?? "");
  check(
    "a session token for the settings page",
    session1.status === 200 && sessionToken.split(".").length === 3,
    session1.body,
  );
  const saved = await http("PUT", `${APP}/api/settings`, {
    headers: { authorization: `Bearer ${sessionToken}` },
    body: {
      secret_key: stripeKeys.secret,
      publishable_key: stripeKeys.publishable,
      webhook_secret: WEBHOOK_SECRET,
      capture_mode: "automatic",
    },
  });
  check(
    "the app saves the Stripe keys",
    saved.status === 200 && at(saved.body, "secret_key", "set") === true,
    saved.body,
  );
  check(
    "and never shows the secret back",
    !saved.text.includes(stripeKeys.secret) && !saved.text.includes(WEBHOOK_SECRET),
  );
  const store = text(at(saved.body, "store") ?? "");
  check(
    "the installation is keyed by the store the token answer named",
    store.startsWith("store_") &&
      text(at(saved.body, "webhook_url")) === `${APP}/stripe/webhook/${store}`,
    saved.body,
  );

  // ---------- a store to sell in ----------
  const market = await admin("POST", "/admin/markets", {
    name: "Croatia",
    countries: ["HR"],
    currency: "EUR",
  });
  const product = await admin("POST", "/admin/products", {
    handle: "stripe-mug",
    title: "Mug",
    price: { amount: 1250, currency: "EUR" },
  });
  const productId = text(at(product.body, "id"));
  const variant = text(at(product.body, "variants", 0, "id"));
  await admin("PATCH", `/admin/products/${productId}/status`, { status: "active" });
  const catalog = await admin("POST", "/admin/catalogs", { market: at(market.body, "id") });
  await admin("POST", `/admin/catalogs/${text(at(catalog.body, "id"))}/products`, {
    products: [productId],
  });
  const channels = await admin("GET", "/admin/channels");
  const channel = text(at(channels.body, "items", 0, "id"));
  await admin("POST", `/admin/channels/${channel}/products`, { products: [productId] });
  const zone = await admin("POST", "/admin/shipping-zones", { name: "Croatia", countries: ["HR"] });
  const option = await admin("POST", `/admin/shipping-zones/${text(at(zone.body, "id"))}/options`, {
    name: "Post",
    code: "post",
    rate: {
      type: "builtin",
      basis: "flat",
      tables: [{ currency: "EUR", tiers: [{ amount: 300 }] }],
    },
  });
  const optionId = /"id":"(shipopt_[0-9a-f]+)"/.exec(option.text)?.[1] ?? "";
  const key = await admin("POST", "/admin/api-keys", { kind: "publishable", name: "e2e", channel });
  const shop = { "x-publishable-key": text(at(key.body, "token") ?? "") };
  check(
    "a market, a product, shipping and a publishable key",
    market.status === 201 &&
      product.status === 201 &&
      zone.status === 201 &&
      optionId !== "" &&
      key.status === 201,
    {
      market: market.body,
      product: product.status,
      zone: zone.body,
      option: option.body,
      key: key.status,
    },
  );
  const method = await admin("POST", "/admin/payment-methods", {
    provider: "app_stripe",
    name: "Card",
  });
  check(
    "a payment method collected by the app",
    method.status === 201 && at(method.body, "provider") === "app_stripe",
    method.body,
  );

  // ---------- a buyer pays by card ----------
  const sf = (verb: string, path: string, body?: unknown) =>
    http(verb, `${API}${path}`, { body, headers: shop });
  const cart = await sf("POST", "/storefront/carts", { country: "HR" });
  const C = `/storefront/carts/${text(at(cart.body, "id"))}`;
  await sf("POST", `${C}/lines`, { variant, quantity: 2 });
  const addressed = await sf("PUT", `${C}/shipping-address`, {
    address: {
      first_name: "Ana",
      last_name: "Horvat",
      line1: "Ilica 1",
      city: "Zagreb",
      postal_code: "10000",
      country: "HR",
    },
  });
  const group = /"shipping_groups":\[\{"id":"(shgrp_[0-9a-f]+)"/.exec(addressed.text)?.[1] ?? "";
  await sf("PUT", `${C}/shipping/${group}`, { option: optionId });
  await sf("PUT", `${C}/email`, { email: "ana@example.hr" });
  const offered = await sf("GET", `${C}/payment-methods`);
  check(
    "the card is offered at checkout",
    offered.text.includes('"provider":"app_stripe"'),
    offered.body,
  );
  await sf("PUT", `${C}/payment-method`, { payment_method: at(method.body, "id") });
  const early = await sf("POST", `${C}/checkout`, {});
  check(
    "checkout before paying waits for the money (payment_required)",
    early.status === 409 && at(early.body, "code") === "payment_required",
    early.body,
  );
  const started = await sf("POST", `${C}/payment`, { return_url: "https://shop.example/back" });
  const next = at(started.body, "next_action");
  const props = at(next, "props");
  check(
    "the cart's payment starts before its order (status pending)",
    started.status === 200 && at(started.body, "status") === "pending",
    started.body,
  );
  check(
    "payments.start v2 answered the stripe-payment element with a client secret",
    at(next, "type") === "client_widget" &&
      at(next, "element") === "stripe-payment" &&
      typeof at(props, "client_secret") === "string" &&
      at(props, "publishable_key") === stripeKeys.publishable,
    started.body,
  );
  const paymentId = text(at(started.body, "payment"));
  const payment = (await admin("GET", `/admin/payments/${paymentId}`)).body;
  const intentId = text(at(payment, "reference"));
  check(
    "the payment is pending with the intent as its reference and no order yet",
    at(payment, "status") === "pending" &&
      intentId.startsWith("pi_") &&
      at(payment, "order") === null,
    payment,
  );
  check(
    "the client secret is the intent's",
    text(at(props, "client_secret")).startsWith(`${intentId}_secret_`),
    props,
  );
  const resumed = await sf("POST", `${C}/payment`, {});
  check(
    "starting again resumes the same payment and intent",
    at(resumed.body, "payment") === paymentId &&
      at(resumed.body, "next_action", "props", "client_secret") === at(props, "client_secret"),
    resumed.body,
  );
  if (!REAL_STRIPE) {
    const created = fake.requests.find((r) => r.path === "/v1/payment_intents");
    check(
      "Stripe got the cart's amount, in minor units",
      created?.form.amount === "2800" && created.form.currency === "eur",
      created?.form,
    );
    check(
      "keyed by Hypha's payment",
      created?.idempotencyKey === paymentId,
      created?.idempotencyKey,
    );
    check(
      "with the buyer's email for the receipt (customer_data:email)",
      created?.form.receipt_email === "ana@example.hr",
      created?.form,
    );
    check(
      "and the payment and cart in its metadata",
      created?.form["metadata[hypha_payment]"] === paymentId &&
        created?.form["metadata[hypha_cart]"] === text(at(cart.body, "id")),
      created?.form,
    );
  }

  // The buyer confirms (the element does this in the browser).
  let intent: unknown;
  if (REAL_STRIPE) {
    const confirmed = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}/confirm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${REAL_STRIPE.secret}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        payment_method: "pm_card_visa",
        return_url: "https://shop.example/back",
      }),
    });
    intent = await confirmed.json();
  } else {
    intent = fake.succeed(intentId);
  }
  check(
    "Stripe says the intent succeeded",
    at(intent, "status") === "succeeded",
    at(intent, "status"),
  );

  // ---------- the shopper checks out before the webhook: Hypha asks payments.status ----------
  const placed = await sf("POST", `${C}/checkout`, { return_url: "https://shop.example/back" });
  check(
    "checkout asks the app where the money is (payments.status) and places the order",
    placed.status === 201 && at(placed.body, "financial_status") === "paid",
    placed.body,
  );
  const orderId = text(at(placed.body, "id"));
  const checkedOut = (await admin("GET", `/admin/orders/${orderId}`)).body;
  check(
    "the order carries the cart's payment, paid",
    at(checkedOut, "payments", 0, "id") === paymentId &&
      at(checkedOut, "payments", 0, "status") === "paid",
    checkedOut,
  );

  // ---------- Stripe's webhook reaches the app, which reports to Hypha ----------
  const deliver = async (event: Record<string, unknown>) => {
    const raw = JSON.stringify(event);
    return http("POST", `${APP}/stripe/webhook/${store}`, {
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signStripePayload(WEBHOOK_SECRET, raw),
      },
      body: event,
    });
  };
  const succeeded = {
    id: `evt_e2e_${randomBytes(6).toString("hex")}`,
    object: "event",
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: { object: intent },
  };
  const hook = await deliver(succeeded);
  check(
    "the app takes Stripe's webhook and reports it (a paid payment stays paid)",
    hook.status === 200 && at(hook.body, "status") === "reported",
    hook.body,
  );
  const order2 = await admin("GET", `/admin/orders/${orderId}`);
  const paid = at(order2.body, "payments", 0);
  check(
    "the order is paid in Hypha",
    at(order2.body, "financial_status") === "paid" && at(paid, "status") === "paid",
    { financial_status: at(order2.body, "financial_status"), payment: paid },
  );
  const again = await deliver(succeeded);
  check(
    "a redelivered event is a duplicate",
    again.status === 200 && at(again.body, "status") === "duplicate",
    again.body,
  );
  const badSig = await http("POST", `${APP}/stripe/webhook/${store}`, {
    headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    body: succeeded,
  });
  check("a forged webhook is refused", badSig.status === 400, badSig.body);
  const calls = await admin("GET", "/admin/apps/app_stripe/extension-calls");
  check(
    "Hypha logged the payments.start and payments.status calls",
    calls.text.includes('"point":"payments.start"') &&
      calls.text.includes('"point":"payments.status"'),
    calls.body,
  );

  // ---------- the admin block, and a staff refund through payments.refund ----------
  const block = await admin(
    "GET",
    `/admin/app-extensions/blocks/app_stripe/payment?order_id=${orderId}&payment_id=${paymentId}`,
  );
  check(
    "the order.payment block shows Stripe's status",
    block.status === 200 && block.text.includes("Succeeded") && block.text.includes(intentId),
    block.body,
  );
  const refund = await admin(
    "POST",
    `/admin/payments/${paymentId}/refund`,
    { amount: 500 },
    { "idempotency-key": `refund-${paymentId}` },
  );
  check("staff refund 5.00: the app accepts (202)", refund.status === 202, refund.body);
  const refunded = {
    id: `evt_e2e_${randomBytes(6).toString("hex")}`,
    object: "event",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "ch_e2e",
        object: "charge",
        amount: 2800,
        amount_refunded: 500,
        refunded: false,
        currency: "eur",
        payment_intent: intentId,
      },
    },
  };
  const refundHook = await deliver(refunded);
  check(
    "Stripe's charge.refunded is reported",
    refundHook.status === 200 && at(refundHook.body, "status") === "reported",
    refundHook.body,
  );
  const order3 = await admin("GET", `/admin/orders/${orderId}`);
  const after = at(order3.body, "payments", 0);
  check(
    "the order is partially refunded by 5.00",
    at(order3.body, "financial_status") === "partially_refunded" &&
      at(after, "refunded", "amount") === 500,
    { financial_status: at(order3.body, "financial_status"), payment: after },
  );

  // A second refund without an Idempotency-Key: Hypha sends a new key per attempt.
  const refund2 = await admin("POST", `/admin/payments/${paymentId}/refund`, { amount: 100 });
  check(
    "a second refund, without a key of staff's own: accepted (202)",
    refund2.status === 202,
    refund2.body,
  );
  if (!REAL_STRIPE) {
    const refundKeys = fake.requests
      .filter((r) => r.method === "POST" && r.path === "/v1/refunds")
      .map((r) => r.idempotencyKey ?? "");
    check(
      "each refund reached Stripe under its own key, Hypha's per attempt",
      refundKeys.length === 2 &&
        refundKeys[0] !== refundKeys[1] &&
        new RegExp(`^${paymentId}:payments\\.refund:${paymentId}:refund:[0-9a-f-]{36}$`).test(
          refundKeys[1] ?? "",
        ),
      refundKeys,
    );
  }
  // Stripe's next charge.refunded lists both refunds: the first is counted once (Hypha
  // dedupes by the refund's ID), the second adds its 1.00.
  const charge = (amountRefunded: number) => ({
    id: `evt_e2e_${randomBytes(6).toString("hex")}`,
    object: "event",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: { object: { ...refunded.data.object, amount_refunded: amountRefunded } },
  });
  const secondHook = await deliver(charge(600));
  check(
    "the second charge.refunded is reported",
    secondHook.status === 200 && at(secondHook.body, "status") === "reported",
    secondHook.body,
  );
  // The first event's charge again under a new event ID (as two raced events would be):
  // nothing more is counted.
  const againHook = await deliver(charge(500));
  check("a refund reported again is accepted", againHook.status === 200, againHook.body);
  const fetched = await admin("GET", `/admin/payments/${paymentId}`);
  check(
    "GET /admin/payments/{id} answers the payment with its order, each refund counted once",
    fetched.status === 200 &&
      at(fetched.body, "order") === orderId &&
      at(fetched.body, "refunded", "amount") === 600 &&
      at(fetched.body, "reference") === intentId,
    fetched.body,
  );

  // ---------- a cancelled order: Hypha's webhook makes the app cancel the intent ----------
  const cart2 = await sf("POST", "/storefront/carts", { country: "HR" });
  const C2 = `/storefront/carts/${text(at(cart2.body, "id"))}`;
  await sf("POST", `${C2}/lines`, { variant, quantity: 1 });
  const addressed2 = await sf("PUT", `${C2}/shipping-address`, {
    address: {
      first_name: "Ana",
      last_name: "Horvat",
      line1: "Ilica 1",
      city: "Zagreb",
      postal_code: "10000",
      country: "HR",
    },
  });
  await sf(
    "PUT",
    `${C2}/shipping/${/"shipping_groups":\[\{"id":"(shgrp_[0-9a-f]+)"/.exec(addressed2.text)?.[1] ?? ""}`,
    { option: optionId },
  );
  await sf("PUT", `${C2}/email`, { email: "ana@example.hr" });
  await sf("PUT", `${C2}/payment-method`, { payment_method: at(method.body, "id") });
  // Manual capture from here: the order is placed on an authorization, which staff
  // release through payments.void before cancelling the order.
  const manual = await http("PUT", `${APP}/api/settings`, {
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { capture_mode: "manual" },
  });
  check("the capture mode is switched to manual", manual.status === 200, manual.body);
  const started2 = await sf("POST", `${C2}/payment`, {});
  const payment2 = text(at(started2.body, "payment"));
  const intent2 = text(at((await admin("GET", `/admin/payments/${payment2}`)).body, "reference"));
  check(
    "a second cart's payment starts",
    started2.status === 200 && intent2.startsWith("pi_"),
    started2.body,
  );
  if (!REAL_STRIPE) {
    // The buyer's card is declined: Stripe's intent waits for another card.
    const declined = await deliver({
      id: `evt_e2e_${randomBytes(6).toString("hex")}`,
      object: "event",
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { ...fake.intents.get(intent2), last_payment_error: { code: "card_declined" } },
      },
    });
    const stillPending = await admin("GET", `/admin/payments/${payment2}`);
    check(
      "a declined card reports nothing: the payment stays pending for another card",
      declined.status === 200 &&
        at(declined.body, "status") === "ignored" &&
        at(stillPending.body, "status") === "pending",
      { hook: declined.body, payment: stillPending.body },
    );
    const waiting = await sf("POST", `${C2}/checkout`, {});
    check(
      "checkout while the intent is open waits (payment_pending)",
      waiting.status === 409 && at(waiting.body, "code") === "payment_pending",
      waiting.body,
    );
  }
  if (REAL_STRIPE) {
    await fetch(`https://api.stripe.com/v1/payment_intents/${intent2}/confirm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${REAL_STRIPE.secret}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        payment_method: "pm_card_visa",
        return_url: "https://shop.example/back",
      }),
    });
  } else {
    fake.succeed(intent2);
  }
  const placed2 = await sf("POST", `${C2}/checkout`, {});
  check(
    "an authorized intent places the order (financial_status authorized)",
    placed2.status === 201 && at(placed2.body, "financial_status") === "authorized",
    placed2.body,
  );
  // An order whose money is held can't be cancelled under it: staff void the payment
  // first (payments.void cancels the intent at Stripe), then cancel the order.
  const voided = await admin(
    "POST",
    `/admin/payments/${payment2}/void`,
    {},
    { "idempotency-key": `void-${payment2}` },
  );
  check("staff void the authorization: the app accepts (202)", voided.status === 202, voided.body);
  let canceledAtStripe = false;
  if (REAL_STRIPE) {
    const read = await fetch(`https://api.stripe.com/v1/payment_intents/${intent2}`, {
      headers: { authorization: `Bearer ${REAL_STRIPE.secret}` },
    });
    canceledAtStripe = at(await read.json(), "status") === "canceled";
  } else canceledAtStripe = fake.intents.get(intent2)?.status === "canceled";
  check(
    "payments.void cancels the intent at Stripe",
    canceledAtStripe,
    fake.intents.get(intent2)?.status,
  );
  const canceledEvent = await deliver({
    id: `evt_e2e_${randomBytes(6).toString("hex")}`,
    object: "event",
    type: "payment_intent.canceled",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: REAL_STRIPE
        ? {
            id: intent2,
            object: "payment_intent",
            status: "canceled",
            metadata: { hypha_payment: payment2 },
          }
        : fake.intents.get(intent2),
    },
  });
  const voidedPayment = await admin("GET", `/admin/payments/${payment2}`);
  check(
    "Stripe's payment_intent.canceled is reported: the payment is voided",
    canceledEvent.status === 200 && at(voidedPayment.body, "status") === "voided",
    { hook: canceledEvent.body, payment: voidedPayment.body },
  );
  const cancelled = await admin("POST", `/admin/orders/${text(at(placed2.body, "id"))}/cancel`, {
    reason: "customer",
  });
  check(
    "staff cancel the second order once its money is released",
    cancelled.status === 200,
    cancelled.body,
  );

  // ---------- what a storefront loads ----------
  const discovery = await sf("GET", "/storefront/app-extensions?target=checkout.payment");
  check(
    "the storefront discovers the element",
    discovery.text.includes('"tag":"stripe-payment"') &&
      discovery.text.includes(`${APP}/elements/payment.js`),
    discovery.body,
  );
  const module = await fetch(`${APP}/elements/payment.js`);
  const moduleText = await module.text();
  check(
    "the element's module is served to any origin",
    module.status === 200 &&
      module.headers.get("access-control-allow-origin") === "*" &&
      moduleText.includes("stripe-payment") &&
      moduleText.includes("https://js.stripe.com/v3"),
  );
} catch (error) {
  failed++;
  console.log(`FAIL ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`);
} finally {
  await cleanup();
}

console.log(failed === 0 ? "\nall steps passed" : `\n${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
