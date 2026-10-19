import assert from "node:assert/strict";
import { test } from "node:test";

import { configure, harness, PUBLISHABLE_KEY, STORE } from "./helpers.ts";

const START = {
  payment: "pay_0001",
  order: "ord_0001",
  order_number: 1001,
  method: "pm_0001",
  amount: { amount: 1390, currency: "EUR" },
  channel: "chan_1",
  market: "mkt_1",
  country: "HR",
  customer_email: "ana@example.hr",
  return_url: "https://shop.test/back",
};

test("payments.start makes a PaymentIntent and answers the element with its secret", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  const response = await h.extension("payments.start", START);
  assert.equal(response.status, 200);
  const answer = (await response.json()) as {
    next_action: { type: string; element: string; props: Record<string, unknown> };
    reference: string;
  };
  const intent = h.stripe.intents.get(answer.reference);
  assert.ok(intent);
  assert.deepEqual(answer.next_action, {
    type: "client_widget",
    element: "stripe-payment",
    props: {
      client_secret: intent.client_secret,
      publishable_key: PUBLISHABLE_KEY,
      return_url: "https://shop.test/back",
      payment_id: "pay_0001",
    },
  });
  const sent = h.stripe.requests.find((r) => r.path === "/v1/payment_intents");
  assert.equal(sent?.idempotencyKey, "pay_0001");
  assert.equal(sent?.form.amount, "1390");
  assert.equal(sent?.form.currency, "eur");
  assert.equal(sent?.form.capture_method, "automatic");
  assert.equal(sent?.form["automatic_payment_methods[enabled]"], "true");
  assert.equal(sent?.form.receipt_email, "ana@example.hr");
  assert.equal(sent?.form["metadata[hypha_payment]"], "pay_0001");
  assert.equal(sent?.form["metadata[hypha_store]"], STORE);
  // The store was learned from this signed call.
  const row = await h.deps.storage.installationByStore(STORE);
  assert.ok(row);
});

test("without the buyer's email (no customer_data:email) no receipt_email is sent", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  const { customer_email: _, ...rest } = START;
  assert.equal((await h.extension("payments.start", rest)).status, 200);
  const sent = h.stripe.requests.find((r) => r.path === "/v1/payment_intents");
  assert.equal("receipt_email" in (sent?.form ?? {}), false);
});

test("manual capture asks Stripe to authorize only", async () => {
  const h = await harness();
  await h.install();
  await configure(h, { captureMode: "manual" });
  await h.extension("payments.start", START);
  assert.equal(
    h.stripe.requests.find((r) => r.path === "/v1/payment_intents")?.form.capture_method,
    "manual",
  );
});

test("a retried start answers with the same intent", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  const first = (await (await h.extension("payments.start", START)).json()) as {
    reference: string;
  };
  const second = (await (await h.extension("payments.start", START)).json()) as {
    reference: string;
  };
  assert.equal(first.reference, second.reference);
  assert.equal(h.stripe.intents.size, 1);
});

test("zero-decimal and ISK amounts are converted for Stripe", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  await h.extension("payments.start", {
    ...START,
    payment: "pay_jpy",
    amount: { amount: 500, currency: "JPY" },
  });
  await h.extension("payments.start", {
    ...START,
    payment: "pay_isk",
    amount: { amount: 5, currency: "ISK" },
  });
  const forms = h.stripe.requests
    .filter((r) => r.path === "/v1/payment_intents")
    .map((r) => r.form);
  assert.deepEqual(
    forms.map((f) => [f.amount, f.currency]),
    [
      ["500", "jpy"],
      ["500", "isk"],
    ],
  );
});

test("an unsigned or wrongly signed call is refused", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  const response = await h.extension("payments.start", START, { secret: "hypha_as_wrong" });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, "invalid_signature");
  assert.equal(h.stripe.requests.length, 0);
});

test("a store without Stripe keys answers not_configured", async () => {
  const h = await harness();
  await h.install();
  const response = await h.extension("payments.start", START);
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "not_configured");
});

test("capture, void and refund: accepted, or refused with Stripe's reason", async () => {
  const h = await harness();
  await h.install();
  await configure(h, { captureMode: "manual" });
  const { reference } = (await (await h.extension("payments.start", START)).json()) as {
    reference: string;
  };
  const action = { payment: "pay_0001", order: "ord_0001", reference };

  const early = (await (await h.extension("payments.capture", action)).json()) as {
    status: string;
    reason: string;
  };
  assert.equal(early.status, "refused");
  assert.match(early.reason, /could not be captured/);

  h.stripe.succeed(reference);
  assert.deepEqual(await (await h.extension("payments.capture", action)).json(), {
    status: "accepted",
    reference,
  });
  const voided = (await (await h.extension("payments.void", action)).json()) as { status: string };
  assert.equal(voided.status, "refused");
  const refund = (await (
    await h.extension("payments.refund", { ...action, amount: { amount: 300, currency: "EUR" } })
  ).json()) as { status: string; reference: string };
  assert.equal(refund.status, "accepted");
  assert.match(refund.reference, /^re_/);
  assert.equal(h.stripe.requests.at(-1)?.form.amount, "300");
});

test("an action on a payment without an intent is refused", async () => {
  const h = await harness();
  await h.install();
  await configure(h);
  const answer = (await (
    await h.extension("payments.void", { payment: "pay_x", order: "ord_x" })
  ).json()) as { status: string };
  assert.equal(answer.status, "refused");
});
