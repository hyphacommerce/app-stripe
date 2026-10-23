import assert from "node:assert/strict";
import { test } from "node:test";

import { contextSigningInput, signRequest, signSessionToken } from "@hyphacommerce/app";

import {
  API_URL,
  APP_SECRET,
  APP_URL,
  harness,
  type Harness,
  SECRET_KEY,
  STORE,
} from "./helpers.ts";

async function token(scope = "payments:write orders:read", secret = APP_SECRET) {
  const iat = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: API_URL,
      aud: "app_stripe",
      sub: "user_1",
      store: STORE,
      scope,
      iat,
      exp: iat + 60,
      jti: "j1",
    },
    secret,
  );
}

async function api(h: Harness, method: "GET" | "PUT", body?: unknown, bearer?: string) {
  return h.call("/api/settings", {
    method,
    headers: {
      authorization: `Bearer ${bearer ?? (await token())}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a session token reads the settings and binds the store", async () => {
  const h = await harness();
  await h.install();
  const response = await api(h, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    store: STORE,
    webhook_url: `${APP_URL}/stripe/webhook/${STORE}`,
    mode: null,
    secret_key: { set: false, last4: null },
    publishable_key: null,
    webhook_secret: { set: false },
    capture_mode: "automatic",
    webhook_events: [
      "payment_intent.succeeded",
      "payment_intent.amount_capturable_updated",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
      "charge.refunded",
    ],
  });
});

test("secrets are write-only and sealed at rest", async () => {
  const h = await harness();
  const id = await h.install();
  const saved = await api(h, "PUT", {
    secret_key: SECRET_KEY,
    publishable_key: "pk_test_fake000000000000",
    webhook_secret: "whsec_abcdefghijkl",
    capture_mode: "manual",
  });
  assert.equal(saved.status, 200);
  const view = (await saved.json()) as Record<string, unknown>;
  assert.deepEqual(view.secret_key, { set: true, last4: "0000" });
  assert.deepEqual(view.webhook_secret, { set: true });
  assert.equal(view.mode, "test");
  assert.equal(view.capture_mode, "manual");
  assert.equal(JSON.stringify(view).includes(SECRET_KEY), false);
  assert.equal(JSON.stringify(view).includes("whsec_abcdefghijkl"), false);
  const row = await h.deps.storage.getInstallation(id);
  const stored = JSON.stringify(row?.settings);
  assert.equal(stored.includes(SECRET_KEY), false);
  assert.equal(stored.includes("whsec_abcdefghijkl"), false);
  // Stripe was asked whether it knows the key.
  assert.ok(h.stripe.requests.some((r) => r.path === "/v1/account"));
});

test("an absent field keeps its value; null clears it", async () => {
  const h = await harness();
  await h.install();
  await api(h, "PUT", { secret_key: SECRET_KEY, webhook_secret: "whsec_abcdefghijkl" });
  let view = (await (await api(h, "PUT", { capture_mode: "manual" })).json()) as Record<
    string,
    { set: boolean }
  >;
  assert.equal(view.secret_key?.set, true);
  view = (await (await api(h, "PUT", { webhook_secret: null })).json()) as Record<
    string,
    { set: boolean }
  >;
  assert.equal(view.webhook_secret?.set, false);
  assert.equal(view.secret_key?.set, true);
});

test("malformed keys, mismatched modes and unknown fields are refused", async () => {
  const h = await harness();
  await h.install();
  const code = async (body: unknown) =>
    ((await (await api(h, "PUT", body)).json()) as { code: string }).code;
  assert.equal(await code({ secret_key: "pk_test_123456789" }), "invalid_secret_key");
  assert.equal(
    await code({ secret_key: SECRET_KEY, publishable_key: "pk_live_123456789" }),
    "key_modes_differ",
  );
  assert.equal(await code({ capture_mode: "later" }), "invalid_capture_mode");
  assert.equal(await code({ api_key: "x" }), "unknown_field");
  assert.equal(await code({ secret_key: "sk_test_notknowntostripe" }), "stripe_key_rejected");
});

test("saving needs payments:write; reading payments:read", async () => {
  const h = await harness();
  await h.install();
  assert.equal(
    (await api(h, "PUT", { capture_mode: "manual" }, await token("orders:read payments:read")))
      .status,
    403,
  );
  assert.equal(
    (await api(h, "GET", undefined, await token("orders:read payments:read"))).status,
    200,
  );
  assert.equal((await api(h, "GET", undefined, await token("orders:read"))).status, 403);
});

test("a token signed with another secret is a 401", async () => {
  const h = await harness();
  await h.install();
  assert.equal(
    (await api(h, "GET", undefined, await token(undefined, "hypha_as_other"))).status,
    401,
  );
  assert.equal((await h.call("/api/settings")).status, 401);
});

test("the admin proxy saves settings when Hypha signed the call", async () => {
  const h = await harness();
  await h.install();
  const body = JSON.stringify({ capture_mode: "manual" });
  const at = Math.floor(Date.now() / 1000);
  const headers = new Headers({
    "content-type": "application/json",
    "hypha-store": STORE,
    "hypha-scopes": "payments:write orders:read",
    "hypha-staff": "user_1",
    "hypha-path": "/settings",
  });
  headers.set("hypha-signature", await signRequest(APP_SECRET, body, { timestamp: at }));
  headers.set(
    "hypha-context-signature",
    await signRequest(APP_SECRET, contextSigningInput("PUT", headers), { timestamp: at }),
  );
  const response = await h.call("/hypha/admin-proxy/settings", { method: "PUT", headers, body });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { capture_mode: string }).capture_mode, "manual");
  // A changed context breaks the signature.
  headers.set("hypha-scopes", "payments:write apps:write");
  assert.equal(
    (await h.call("/hypha/admin-proxy/settings", { method: "PUT", headers, body })).status,
    401,
  );
});

test("the settings page trusts ?origin= only when it's the store's admin", async () => {
  const h = await harness();
  await h.install();
  const response = await h.call(
    `/admin/settings?origin=${encodeURIComponent("https://admin.shop.test")}`,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /frame-ancestors https:\/\/admin\.shop\.test$/,
  );
  assert.match(await response.text(), /data-host-origin="https:\/\/admin\.shop\.test"/);
  const stranger = await h.call("/admin/settings?origin=https://evil.test");
  assert.match(await stranger.text(), /data-host-origin=""/);
  // Without the parameter, the Referer is the claim.
  const referred = await h.call("/admin/settings", {
    headers: { referer: "https://admin.shop.test/apps/app_stripe" },
  });
  assert.match(await referred.text(), /data-host-origin="https:\/\/admin\.shop\.test"/);
});

test("an admin origin added after the install is read again from Hypha, now and then", async () => {
  const h = await harness();
  await h.install();
  h.hypha.adminOrigins = ["https://admin.shop.test", "https://new-admin.shop.test"];
  const origins = () =>
    h.hypha.requests.filter((r) => r.path === "/admin/app-extensions/origins").length;
  const before = origins();
  const moved = await h.call("/admin/settings?origin=https://new-admin.shop.test");
  assert.match(await moved.text(), /data-host-origin="https:\/\/new-admin\.shop\.test"/);
  assert.equal(origins(), before + 1);
  // Strangers' origins don't make the app ask Hypha on every request.
  await h.call("/admin/settings?origin=https://evil.test");
  await h.call("/admin/settings?origin=https://evil2.test");
  assert.equal(origins(), before + 1);
});
