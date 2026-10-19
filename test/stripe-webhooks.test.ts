import assert from "node:assert/strict";
import { test } from "node:test";

import { signStripePayload } from "../src/stripe/signature.ts";
import { configure, harness, type Harness, STORE, WEBHOOK_SECRET } from "./helpers.ts";

async function started(h: Harness) {
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
  return ((await response.json()) as { reference: string }).reference;
}

async function deliver(h: Harness, event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  return h.call(`/stripe/webhook/${STORE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": await signStripePayload(secret, raw, Math.floor(h.now.ms / 1000)),
    },
    body: raw,
  });
}

function intentEvent(h: Harness, id: string, type: string, reference: string) {
  const intent = h.stripe.intents.get(reference);
  return { id, object: "event", type, created: 1_800_000_000, data: { object: { ...intent } } };
}

test("payment_intent.succeeded reports paid, keyed by Stripe's event ID", async () => {
  const h = await harness();
  const reference = await started(h);
  h.stripe.succeed(reference);
  const response = await deliver(h, intentEvent(h, "evt_1", "payment_intent.succeeded", reference));
  assert.equal(response.status, 200);
  assert.deepEqual(h.hypha.events, [
    {
      payment: "pay_0001",
      idempotencyKey: "evt_1",
      body: { type: "paid", reference, occurred_at: "2027-01-15T08:00:00.000Z" },
    },
  ]);
  const report = h.hypha.requests.find((r) => r.path === "/admin/payments/pay_0001/events");
  assert.equal(report?.headers.get("authorization"), "Bearer hypha_at_1");
});

test("a redelivered event is handled once", async () => {
  const h = await harness();
  const reference = await started(h);
  h.stripe.succeed(reference);
  const event = intentEvent(h, "evt_1", "payment_intent.succeeded", reference);
  await deliver(h, event);
  const again = await deliver(h, event);
  assert.deepEqual(await again.json(), { status: "duplicate" });
  assert.equal(h.hypha.requests.filter((r) => r.path.endsWith("/events")).length, 1);
});

test("authorized, failed and canceled map to Hypha's moves", async () => {
  const h = await harness();
  const reference = await started(h);
  const intent = h.stripe.intents.get(reference);
  if (intent) intent.amount_capturable = 1390;
  await deliver(h, intentEvent(h, "evt_a", "payment_intent.amount_capturable_updated", reference));
  await deliver(h, intentEvent(h, "evt_c", "payment_intent.canceled", reference));
  assert.deepEqual(
    h.hypha.events.map((e) => e.body.type),
    ["authorized", "voided"],
  );
});

test("a declined intent the shopper may retry reports nothing", async () => {
  const h = await harness();
  const reference = await started(h);
  const response = await deliver(
    h,
    intentEvent(h, "evt_f", "payment_intent.payment_failed", reference),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ignored",
    reason: "the shopper may still pay this intent",
  });
  assert.equal(h.hypha.events.length, 0);
  // The intent stays open for another card.
  assert.equal(h.stripe.intents.get(reference)?.status, "requires_payment_method");
  assert.equal(h.stripe.requests.filter((r) => r.path.endsWith("/cancel")).length, 0);
});

test("a failure that ends the intent reports failed", async () => {
  const h = await harness();
  const reference = await started(h);
  const intent = h.stripe.intents.get(reference);
  if (intent) intent.status = "canceled";
  await deliver(h, intentEvent(h, "evt_f2", "payment_intent.payment_failed", reference));
  assert.deepEqual(
    h.hypha.events.map((e) => e.body.type),
    ["failed"],
  );
});

test("a bad signature is a 400 and nothing is reported", async () => {
  const h = await harness();
  const reference = await started(h);
  const response = await deliver(
    h,
    intentEvent(h, "evt_1", "payment_intent.succeeded", reference),
    "whsec_wrongsecret",
  );
  assert.equal(response.status, 400);
  assert.equal(h.hypha.events.length, 0);
});

test("an intent that isn't a Hypha payment is ignored", async () => {
  const h = await harness();
  await started(h);
  const response = await deliver(h, {
    id: "evt_x",
    object: "event",
    type: "payment_intent.succeeded",
    created: 1,
    data: { object: { id: "pi_other", object: "payment_intent", metadata: {} } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ignored", reason: "not a Hypha payment" });
  assert.equal(h.hypha.events.length, 0);
});

test("charge.refunded reports the refund's own amount (read from GET /admin/payments/{id}), or refunded in full", async () => {
  const h = await harness();
  const reference = await started(h);
  h.hypha.orders.set("ord_0001", {
    id: "ord_0001",
    payments: [
      {
        id: "pay_0001",
        provider: "app_stripe",
        status: "partially_refunded",
        reference,
        amount: { amount: 1390, currency: "EUR" },
        refunded: { amount: 300, currency: "EUR" },
      },
    ],
  });
  const charge = (amountRefunded: number, refunded: boolean) => ({
    id: "ch_1",
    object: "charge",
    amount: 1390,
    amount_refunded: amountRefunded,
    refunded,
    currency: "eur",
    payment_intent: reference,
  });
  await deliver(h, {
    id: "evt_r1",
    object: "event",
    type: "charge.refunded",
    created: 1,
    data: { object: charge(500, false) },
  });
  await deliver(h, {
    id: "evt_r2",
    object: "event",
    type: "charge.refunded",
    created: 1,
    data: { object: charge(1390, true) },
  });
  assert.deepEqual(
    h.hypha.events.map((e) => [e.body.type, e.body.amount]),
    [
      ["partially_refunded", 200],
      ["refunded", undefined],
    ],
  );
  assert.ok(
    h.hypha.requests.some((r) => r.method === "GET" && r.path === "/admin/payments/pay_0001"),
  );
});

test("an unknown store is a 404", async () => {
  const h = await harness();
  await started(h);
  const response = await h.call("/stripe/webhook/store_unknown", { method: "POST", body: "{}" });
  assert.equal(response.status, 404);
});
