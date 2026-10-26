// The storefront element in a DOM (happy-dom), with a fake Stripe.js: props set before
// the module loaded are taken over, the Payment Element is mounted with the client
// secret and the storefront's --hypha-* theme, and confirming emits the documented events.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";

const window = new Window({ url: "https://shop.test/checkout" });
const globals = globalThis as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "customElements",
  "Node",
  "Event",
  "CustomEvent",
  "getComputedStyle",
  "location",
])
  globals[key] = (window as unknown as Record<string, unknown>)[key];

interface Calls {
  keys: string[];
  elementsOptions: Record<string, unknown>[];
  confirms: Record<string, unknown>[];
  mounted: number;
}
const calls: Calls = { keys: [], elementsOptions: [], confirms: [], mounted: 0 };
let confirmResult: Record<string, unknown> = { paymentIntent: { id: "pi_1", status: "succeeded" } };
let readyHandler: (() => void) | undefined;

(window as unknown as Record<string, unknown>).Stripe = (key: string) => {
  calls.keys.push(key);
  return {
    elements(options: Record<string, unknown>) {
      calls.elementsOptions.push(options);
      return {
        create: () => ({
          mount: () => {
            calls.mounted++;
            readyHandler?.();
          },
          destroy: () => {},
          on: (event: string, handler: () => void) => {
            if (event === "ready") readyHandler = handler;
          },
        }),
        submit: async () => ({}),
      };
    },
    retrievePaymentIntent: async () => ({
      paymentIntent: { id: "pi_1", status: "requires_payment_method" },
    }),
    confirmPayment: async (options: Record<string, unknown>) => {
      calls.confirms.push(options);
      return confirmResult;
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// Created and given props before the module defines the tag, as a storefront may.
const element = document.createElement("stripe-payment") as HTMLElement & Record<string, unknown>;
element.client_secret = "pi_1_secret_x";
element.publishable_key = "pk_test_1";
element.payment_id = "pay_1";
element.style.setProperty("--hypha-color-accent", "#ff0000");
document.body.append(element);
await import("../src/browser/payment-element.ts");
await settle();

test("props set before the upgrade are kept and the Payment Element is mounted", () => {
  assert.equal(element.client_secret, "pi_1_secret_x");
  assert.deepEqual(calls.keys, ["pk_test_1"]);
  assert.equal(calls.mounted, 1);
  const options = calls.elementsOptions[0] as {
    clientSecret: string;
    appearance: { variables: Record<string, string> };
  };
  assert.equal(options.clientSecret, "pi_1_secret_x");
  // Resolved on a probe: the test DOM computes the literal, a browser `rgb()`.
  assert.match(options.appearance.variables.colorPrimary ?? "", /^(#ff0000|rgb\(255, 0, 0\))$/);
  // Stripe's container is in the light DOM, slotted into the shadow root.
  assert.equal(element.querySelector('[slot="stripe"]') !== null, true);
  assert.ok(element.shadowRoot?.querySelector("button"));
});

test("paying confirms with redirect if_required and emits hypha:payment-confirmed", async () => {
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["hypha:payment-confirmed", "hypha:error"])
    document.body.addEventListener(type, (event) =>
      events.push({ type, detail: (event as CustomEvent).detail }),
    );
  const pay = element.shadowRoot?.querySelector("button");
  assert.ok(pay);
  pay.click();
  await settle();
  assert.equal(calls.confirms[0]?.redirect, "if_required");
  assert.deepEqual(calls.confirms[0]?.confirmParams, { return_url: "https://shop.test/checkout" });
  assert.deepEqual(events, [{ type: "hypha:payment-confirmed", detail: { paymentId: "pay_1" } }]);
});

test("a declined card emits hypha:error with Stripe's message and leaves the button for another try", async () => {
  const second = document.createElement("stripe-payment") as HTMLElement & Record<string, unknown>;
  document.body.append(second);
  second.publishableKey = "pk_test_1";
  second.clientSecret = "pi_2_secret_y";
  await settle();
  confirmResult = { error: { type: "card_error", message: "Your card was declined." } };
  const errors: unknown[] = [];
  second.addEventListener("hypha:error", (event) => errors.push((event as CustomEvent).detail));
  const button = second.shadowRoot?.querySelector("button") as HTMLButtonElement;
  button.click();
  await settle();
  assert.deepEqual(errors, [{ message: "Your card was declined." }]);
  // The intent still takes a card (Stripe says `requires_payment_method`).
  assert.equal(button.disabled, false);
});

test("submit_mode external hides the button, emits hypha:ready and pays through submit()", async () => {
  const third = document.createElement("stripe-payment") as HTMLElement & Record<string, unknown>;
  const ready: string[] = [];
  third.addEventListener("hypha:ready", () => ready.push("ready"));
  document.body.append(third);
  third.submit_mode = "external";
  third.publishableKey = "pk_test_1";
  third.clientSecret = "pi_3_secret_z";
  third.payment_id = "pay_3";
  await settle();
  assert.deepEqual(ready, ["ready"]);
  const button = third.shadowRoot?.querySelector("button") as HTMLButtonElement;
  assert.equal(button.hidden, true);
  confirmResult = { paymentIntent: { id: "pi_3", status: "succeeded" } };
  const confirmed: unknown[] = [];
  third.addEventListener("hypha:payment-confirmed", (event) =>
    confirmed.push((event as CustomEvent).detail),
  );
  (third as unknown as { submit(): void }).submit();
  await settle();
  assert.deepEqual(confirmed, [{ paymentId: "pay_3" }]);
});
