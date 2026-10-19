import assert from "node:assert/strict";
import { test } from "node:test";

import { AmountError, fromStripeAmount, toStripeAmount } from "../src/stripe/amounts.ts";

test("two-decimal and zero-decimal currencies pass as they are", () => {
  assert.equal(toStripeAmount(1050, "EUR"), 1050);
  assert.equal(toStripeAmount(500, "JPY"), 500);
  assert.equal(toStripeAmount(500, "krw"), 500);
  assert.equal(toStripeAmount(1045, "HUF"), 1045);
});

test("ISK and UGX are two-decimal at Stripe: 5 ISK is 500", () => {
  assert.equal(toStripeAmount(5, "ISK"), 500);
  assert.equal(toStripeAmount(5, "UGX"), 500);
  assert.equal(fromStripeAmount(500, "isk"), 5);
  assert.equal(fromStripeAmount(1050, "EUR"), 1050);
});

test("three-decimal currencies must end in 0", () => {
  assert.equal(toStripeAmount(1230, "KWD"), 1230);
  assert.throws(() => toStripeAmount(1235, "KWD"), AmountError);
  assert.throws(() => toStripeAmount(1, "BHD"), AmountError);
});

test("an amount must be a non-negative integer", () => {
  assert.throws(() => toStripeAmount(-1, "EUR"), AmountError);
  assert.throws(() => toStripeAmount(1.5, "EUR"), AmountError);
});
