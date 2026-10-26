import assert from "node:assert/strict";
import { test } from "node:test";

import { contextSigningInput, signRequest } from "@hyphacommerce/app";
import { validateBlock } from "@hyphacommerce/app-blocks";

import { APP_SECRET, configure, harness, type Harness, STORE } from "./helpers.ts";

async function startPayment(h: Harness) {
  await h.install();
  await configure(h);
  const response = await h.extension("payments.start", {
    payment: "pay_0001",
    cart: "cart_0001",
    method: "pm_1",
    amount: { amount: 1390, currency: "EUR" },
    channel: "chan_1",
    market: "mkt_1",
    country: "HR",
  });
  const { reference } = (await response.json()) as { reference: string };
  h.hypha.orders.set("ord_0001", {
    id: "ord_0001",
    payments: [
      {
        id: "pay_0001",
        provider: "app_stripe",
        status: "pending",
        reference,
        amount: { amount: 1390, currency: "EUR" },
        refunded: { amount: 0, currency: "EUR" },
      },
    ],
  });
  return reference;
}

async function signedGet(path: string, extra: Record<string, string> = {}) {
  const at = Math.floor(Date.now() / 1000);
  const headers = new Headers({
    "hypha-store": STORE,
    "hypha-target": "order.payment",
    "hypha-block": "payment",
    ...extra,
  });
  headers.set("hypha-signature", await signRequest(APP_SECRET, "", { timestamp: at }));
  headers.set(
    "hypha-context-signature",
    await signRequest(APP_SECRET, contextSigningInput("GET", headers), { timestamp: at }),
  );
  return { headers };
}

test("the order.payment block is a valid v1 tree with the intent's status and a dashboard link", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  h.stripe.succeed(reference);
  const response = await h.call(
    `/hypha/blocks/payment?order_id=ord_0001&payment_id=pay_0001`,
    await signedGet(""),
  );
  assert.equal(response.status, 200);
  const tree: unknown = await response.json();
  const result = validateBlock(tree);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const text = JSON.stringify(tree);
  assert.match(text, /"value":"Succeeded","tone":"success"/);
  assert.match(text, /"value":"13.90 EUR"/);
  assert.ok(text.includes(`https://dashboard.stripe.com/test/payments/${reference}`));
  assert.match(text, /"action":"refund"/);
});

test("an unsigned block request is a 401", async () => {
  const h = await harness();
  await startPayment(h);
  const response = await h.call(`/hypha/blocks/payment?order_id=ord_0001`, {
    headers: { "hypha-store": STORE },
  });
  assert.equal(response.status, 401);
});

/** A webhook delivery as Hypha sends it: signed, with `Hypha-Store` and a delivery ID. */
async function hyphaHook(
  h: Harness,
  envelope: Record<string, unknown>,
  options: { secret?: string; store?: string; delivery?: string } = {},
) {
  const raw = JSON.stringify({
    version: 1,
    actor: { type: "user", id: "user_1" },
    occurred_at: "2026-10-19T10:00:00Z",
    data: {},
    ...envelope,
  });
  return h.call("/hypha/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "hypha-signature": await signRequest(options.secret ?? APP_SECRET, raw),
      "hypha-event-id": String(envelope.id),
      "hypha-event-type": String(envelope.type),
      "hypha-delivery-id": options.delivery ?? `dlv_${String(envelope.id)}`,
      "hypha-store": options.store ?? STORE,
    },
    body: raw,
  });
}

test("order.cancelled cancels the order's open intent at Stripe, once per delivery", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  const envelope = {
    id: "evt_h1",
    type: "order.cancelled",
    subject: { type: "order", id: "ord_0001", version: 3 },
  };
  assert.equal((await hyphaHook(h, envelope)).status, 204);
  assert.equal(h.stripe.intents.get(reference)?.status, "canceled");
  const cancels = () => h.stripe.requests.filter((r) => r.path.endsWith("/cancel")).length;
  assert.equal(cancels(), 1);
  // A retry of the same delivery is answered without handling it again.
  assert.equal((await hyphaHook(h, envelope)).status, 204);
  assert.equal(cancels(), 1);
});

test("a Hypha webhook signed with another secret, or for another store, is a 401", async () => {
  const h = await harness();
  await startPayment(h);
  const envelope = {
    id: "evt_h2",
    type: "order.cancelled",
    subject: { type: "order", id: "ord_0001", version: 1 },
  };
  const forged = await hyphaHook(h, envelope, { secret: "hypha_as_x" });
  assert.equal(forged.status, 401);
  assert.equal(((await forged.json()) as { code: string }).code, "invalid_signature");
  const stranger = await hyphaHook(h, envelope, {
    store: "store_ffffffffffffffffffffffffffffffff",
  });
  assert.equal(stranger.status, 401);
});

test("a webhook that isn't an envelope is a 400", async () => {
  const h = await harness();
  await startPayment(h);
  const response = await hyphaHook(h, { id: "evt_h4", type: "order.cancelled", subject: "x" });
  assert.equal(response.status, 400);
});

test("a failure answers 500 so Hypha retries, and the retry is handled", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  const order = h.hypha.orders.get("ord_0001");
  h.hypha.orders.delete("ord_0001");
  h.hypha.failOrders = true;
  const envelope = {
    id: "evt_h5",
    type: "order.cancelled",
    subject: { type: "order", id: "ord_0001", version: 2 },
  };
  assert.equal((await hyphaHook(h, envelope)).status, 500);
  h.hypha.failOrders = false;
  if (order) h.hypha.orders.set("ord_0001", order);
  assert.equal((await hyphaHook(h, envelope)).status, 204);
  assert.equal(h.stripe.intents.get(reference)?.status, "canceled");
});

test("app.installed is acknowledged", async () => {
  const h = await harness();
  await startPayment(h);
  const response = await hyphaHook(h, {
    id: "evt_h6",
    type: "app.installed",
    subject: { type: "app", id: "appid_0123", version: 1 },
  });
  assert.equal(response.status, 204);
});

test("app.uninstalled forgets the tokens", async () => {
  const h = await harness();
  await startPayment(h);
  assert.equal(
    (
      await hyphaHook(h, {
        id: "evt_h3",
        type: "app.uninstalled",
        subject: { type: "app", id: "appid_0123", version: 2 },
      })
    ).status,
    204,
  );
  const row = await h.deps.storage.installationByStore(STORE);
  assert.equal(row?.tokens, null);
  assert.notEqual(row?.uninstalledAt, null);
});

test("an expired access token is refreshed once, under the lock", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  h.now.ms += 2 * 3600_000;
  h.stripe.succeed(reference);
  const { signStripePayload } = await import("../src/stripe/signature.ts");
  const deliver = async (id: string) => {
    const raw = JSON.stringify({
      id,
      object: "event",
      type: "payment_intent.succeeded",
      created: 1,
      data: { object: { ...h.stripe.intents.get(reference) } },
    });
    return h.call(`/stripe/webhook/${STORE}`, {
      method: "POST",
      body: raw,
      headers: {
        "stripe-signature": await signStripePayload(
          "whsec_testsigningsecret",
          raw,
          Math.floor(h.now.ms / 1000),
        ),
      },
    });
  };
  const [a, b] = await Promise.all([deliver("evt_x1"), deliver("evt_x2")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const refreshes = h.hypha.tokenCalls.filter((c) => c.get("grant_type") === "refresh_token");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]?.get("refresh_token"), "hypha_rt_1");
});

test("a refresh waits for another process's lock and uses the pair it stored", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  const row = await h.deps.storage.installationByStore(STORE);
  if (!row) throw new Error("installed");
  h.now.ms += 2 * 3600_000;
  // Another isolate holds the refresh lock, and stores its new pair a moment later.
  assert.equal(await h.deps.storage.takeRefreshLock(row.id, h.now.ms, h.now.ms + 15_000), true);
  setTimeout(() => {
    void (async () => {
      const tokens = {
        accessToken: "hypha_at_other",
        refreshToken: "hypha_rt_other",
        expiresAt: h.now.ms + 3600_000,
        scopes: ["payments:write", "orders:read"],
        store: STORE,
        issuer: "https://api.shop.test",
      };
      await h.deps.storage.setTokens(
        row.id,
        await h.deps.sealer.seal(JSON.stringify(tokens), `${row.id}:tokens`),
      );
      await h.deps.storage.releaseRefreshLock(row.id);
    })();
  }, 300);
  h.stripe.succeed(reference);
  const { signStripePayload } = await import("../src/stripe/signature.ts");
  const raw = JSON.stringify({
    id: "evt_lock",
    object: "event",
    type: "payment_intent.succeeded",
    created: 1,
    data: { object: { ...h.stripe.intents.get(reference) } },
  });
  const response = await h.call(`/stripe/webhook/${STORE}`, {
    method: "POST",
    body: raw,
    headers: {
      "stripe-signature": await signStripePayload(
        "whsec_testsigningsecret",
        raw,
        Math.floor(h.now.ms / 1000),
      ),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(h.hypha.tokenCalls.filter((c) => c.get("grant_type") === "refresh_token").length, 0);
  const report = h.hypha.requests.find((r) => r.path === "/admin/payments/pay_0001/events");
  assert.equal(report?.headers.get("authorization"), "Bearer hypha_at_other");
});
