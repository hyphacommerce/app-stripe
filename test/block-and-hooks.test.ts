import assert from "node:assert/strict";
import { test } from "node:test";

import { contextSigningInput, signRequest } from "@hypha/app";
import { validateBlock } from "@hypha/app-blocks";

import { APP_SECRET, configure, harness, type Harness, STORE } from "./helpers.ts";

async function startPayment(h: Harness) {
  await h.install();
  await configure(h);
  const response = await h.extension("payments.start", {
    payment: "pay_0001",
    order: "ord_0001",
    order_number: 1001,
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

async function hyphaHook(h: Harness, envelope: Record<string, unknown>, secret = APP_SECRET) {
  const raw = JSON.stringify(envelope);
  return h.call("/hypha/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "hypha-signature": await signRequest(secret, raw),
      "hypha-event-id": String(envelope.id),
      "hypha-event-type": String(envelope.type),
    },
    body: raw,
  });
}

test("order.cancelled cancels the order's open intent at Stripe, once", async () => {
  const h = await harness();
  const reference = await startPayment(h);
  const envelope = {
    id: "evt_h1",
    type: "order.cancelled",
    version: 1,
    subject: { type: "order", id: "ord_0001" },
    data: {},
  };
  assert.equal((await hyphaHook(h, envelope)).status, 200);
  assert.equal(h.stripe.intents.get(reference)?.status, "canceled");
  const cancels = () => h.stripe.requests.filter((r) => r.path.endsWith("/cancel")).length;
  assert.equal(cancels(), 1);
  assert.deepEqual(await (await hyphaHook(h, envelope)).json(), { outcome: "duplicate" });
  assert.equal(cancels(), 1);
});

test("a Hypha webhook signed with another secret is a 401", async () => {
  const h = await harness();
  await startPayment(h);
  const response = await hyphaHook(
    h,
    { id: "evt_h2", type: "order.cancelled", subject: { type: "order", id: "ord_0001" } },
    "hypha_as_x",
  );
  assert.equal(response.status, 401);
});

test("app.uninstalled forgets the tokens", async () => {
  const h = await harness();
  await startPayment(h);
  await hyphaHook(h, {
    id: "evt_h3",
    type: "app.uninstalled",
    subject: { type: "app", id: "app_1" },
    data: {},
  });
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
