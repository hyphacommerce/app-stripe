import assert from "node:assert/strict";
import { test } from "node:test";

import { API_URL, APP_SECRET, APP_URL, harness, STORE } from "./helpers.ts";

test("/install sends the browser to Hypha's authorize with PKCE", async () => {
  const h = await harness();
  const response = await h.call(`/install?api=${encodeURIComponent(`${API_URL}/some/path`)}`);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, `${API_URL}/oauth/authorize`);
  const q = location.searchParams;
  assert.equal(q.get("client_id"), `${APP_URL}/manifest.json`);
  assert.equal(q.get("redirect_uri"), `${APP_URL}/oauth/callback`);
  assert.equal(q.get("scope"), "payments:write orders:read customer_data:email");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.get("state"));
});

test("an API that isn't https is refused", async () => {
  const h = await harness();
  const response = await h.call(`/install?api=${encodeURIComponent("http://api.shop.test")}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /must be https/);
});

test("the callback trades the code (with the verifier) and stores the installation sealed", async () => {
  const h = await harness();
  const id = await h.install();
  const call = h.hypha.tokenCalls[0];
  assert.equal(call?.get("grant_type"), "authorization_code");
  assert.equal(call?.get("code"), "hypha_ac_good");
  assert.equal(call?.get("client_id"), `${APP_URL}/manifest.json`);
  assert.match(call?.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
  const row = await h.deps.storage.getInstallation(id);
  assert.ok(row);
  assert.equal(row.apiUrl, API_URL);
  assert.equal(row.issuer, API_URL);
  // Keyed by the store and issuer the token answer names.
  assert.equal(row.storeId, STORE);
  assert.deepEqual(row.adminOrigins, ["https://admin.shop.test"]);
  assert.equal(row.scopes, "customer_data:email orders:read payments:write");
  assert.equal(row.appSecret.includes(APP_SECRET), false);
  assert.equal(row.tokens?.includes("hypha_at_"), false);
  assert.equal(await h.deps.sealer.open(row.appSecret, `${id}:app_secret`), APP_SECRET);
});

test("a token answer without store and issuer (an older Hypha) can't install", async () => {
  const h = await harness();
  h.hypha.legacyTokens = true;
  await assert.rejects(h.install(), /502.*update Hypha/s);
  assert.equal(await h.deps.storage.installationByStore(STORE), undefined);
});

test("the manifest's icon is served", async () => {
  const h = await harness();
  const manifest = (await (await h.call("/manifest.json")).json()) as Record<string, unknown>;
  assert.equal(manifest.icon, "/icon.svg");
  assert.equal("icon_url" in manifest, false);
  const icon = await h.call("/icon.svg");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
});

test("a state is used once", async () => {
  const h = await harness();
  const started = await h.call(`/install?api=${encodeURIComponent(API_URL)}`);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  assert.equal((await h.call(`/oauth/callback?code=hypha_ac_good&state=${state}`)).status, 200);
  const again = await h.call(`/oauth/callback?code=hypha_ac_good&state=${state}`);
  assert.equal(again.status, 400);
  assert.match(await again.text(), /expired or was already used/);
});

test("an expired state is refused", async () => {
  const h = await harness();
  const started = await h.call(`/install?api=${encodeURIComponent(API_URL)}`);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  h.now.ms += 11 * 60_000;
  assert.equal((await h.call(`/oauth/callback?code=hypha_ac_good&state=${state}`)).status, 400);
});

test("a declined consent says so", async () => {
  const h = await harness();
  const started = await h.call(`/install?api=${encodeURIComponent(API_URL)}`);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const response = await h.call(`/oauth/callback?error=access_denied&state=${state}`);
  assert.equal(response.status, 403);
});

test("a code Hypha refuses is a 502 page", async () => {
  const h = await harness();
  const started = await h.call(`/install?api=${encodeURIComponent(API_URL)}`);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const response = await h.call(`/oauth/callback?code=hypha_ac_bad&state=${state}`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid_grant/);
});

test("re-authorizing (no new secret) keeps the installation and its secret", async () => {
  const h = await harness();
  const id = await h.install();
  h.hypha.appSecret = undefined;
  assert.equal(await h.install(), id);
  const row = await h.deps.storage.getInstallation(id);
  assert.equal(await h.deps.sealer.open(row?.appSecret ?? "", `${id}:app_secret`), APP_SECRET);
});

test("a first authorization without a secret can't install", async () => {
  const h = await harness();
  h.hypha.appSecret = undefined;
  await assert.rejects(h.install(), /409/);
});

test("the manifest is served, with relative URLs under app_url", async () => {
  const h = await harness();
  const response = await h.call("/manifest.json");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const manifest = (await response.json()) as Record<string, unknown>;
  assert.equal(manifest.key, "app_stripe");
  assert.equal(manifest.app_url, APP_URL);
  assert.deepEqual(manifest.redirect_uris, ["/oauth/callback"]);
  assert.deepEqual(manifest.scopes, ["payments:write", "orders:read", "customer_data:email"]);
  assert.ok((manifest.scope_reasons as Record<string, string>)["customer_data:email"]);
});
