import assert from "node:assert/strict";
import { test } from "node:test";

import { signRequest, verifyForwardedRequest, verifySignature } from "@hyphacommerce/app";

import { signStripePayload, verifyStripeSignature } from "../src/stripe/signature.ts";

// Stripe's scheme (https://docs.stripe.com/webhooks#verify-manually): v1 is the hex
// HMAC-SHA256 of "<t>.<payload>" under the endpoint secret. The expected value was
// computed independently with
//   printf '%s' '1492774577.{"id":"evt_test_webhook","object":"event"}' \
//     | openssl dgst -sha256 -hmac 'whsec_test_secret'
const VECTOR = {
  secret: "whsec_test_secret",
  timestamp: 1492774577,
  payload: '{"id":"evt_test_webhook","object":"event"}',
  v1: "88a022085c6bdb887b02cb26ff76dd681234d9675c0f22844059f55552a8883a",
};

test("Stripe: the test vector verifies", async () => {
  const header = `t=${VECTOR.timestamp},v1=${VECTOR.v1},v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39`;
  assert.equal(
    await verifyStripeSignature(VECTOR.secret, header, VECTOR.payload, { now: VECTOR.timestamp }),
    true,
  );
  assert.equal(
    await signStripePayload(VECTOR.secret, VECTOR.payload, VECTOR.timestamp),
    `t=${VECTOR.timestamp},v1=${VECTOR.v1}`,
  );
});

test("Stripe: five minutes either way, not a second more", async () => {
  const header = `t=${VECTOR.timestamp},v1=${VECTOR.v1}`;
  const at = (now: number) => verifyStripeSignature(VECTOR.secret, header, VECTOR.payload, { now });
  assert.equal(await at(VECTOR.timestamp + 300), true);
  assert.equal(await at(VECTOR.timestamp + 301), false);
  assert.equal(await at(VECTOR.timestamp - 300), true);
  assert.equal(await at(VECTOR.timestamp - 301), false);
});

test("Stripe: another secret, another body or only v0 doesn't verify", async () => {
  const now = VECTOR.timestamp;
  const header = `t=${now},v1=${VECTOR.v1}`;
  assert.equal(await verifyStripeSignature("whsec_other", header, VECTOR.payload, { now }), false);
  assert.equal(
    await verifyStripeSignature(VECTOR.secret, header, `${VECTOR.payload} `, { now }),
    false,
  );
  assert.equal(
    await verifyStripeSignature(VECTOR.secret, `t=${now},v0=${VECTOR.v1}`, VECTOR.payload, { now }),
    false,
  );
  assert.equal(await verifyStripeSignature(VECTOR.secret, null, VECTOR.payload, { now }), false);
  assert.equal(await verifyStripeSignature("", header, VECTOR.payload, { now }), false);
});

test("Stripe: any one of several v1 signatures (a rolled secret) verifies", async () => {
  const now = VECTOR.timestamp;
  const header = `t=${now},v1=${"0".repeat(64)},v1=${VECTOR.v1}`;
  assert.equal(await verifyStripeSignature(VECTOR.secret, header, VECTOR.payload, { now }), true);
});

test("Hypha: the SDK verifies what Hypha signs, and nothing else", async () => {
  const body = '{"payment":"pay_1"}';
  const header = await signRequest("hypha_as_1", body, { timestamp: 1_800_000_000 });
  assert.equal(await verifySignature("hypha_as_1", header, body, { now: 1_800_000_000 }), true);
  assert.equal(await verifySignature("hypha_as_2", header, body, { now: 1_800_000_000 }), false);
  assert.equal(await verifySignature("hypha_as_1", header, body, { now: 1_800_000_301 }), false);
});

test("Hypha: a forwarded call's context is signed too", async () => {
  const at = 1_800_000_000;
  const { contextSigningInput } = await import("@hyphacommerce/app");
  const headers = new Headers({ "hypha-store": "store_1", "hypha-staff": "user_1" });
  headers.set("hypha-signature", await signRequest("s", "", { timestamp: at }));
  headers.set(
    "hypha-context-signature",
    await signRequest("s", contextSigningInput("GET", headers), { timestamp: at }),
  );
  assert.equal(
    await verifyForwardedRequest("s", { method: "GET", headers }, "", { now: at }),
    true,
  );
  headers.set("hypha-store", "store_2");
  assert.equal(
    await verifyForwardedRequest("s", { method: "GET", headers }, "", { now: at }),
    false,
  );
});
