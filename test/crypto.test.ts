import assert from "node:assert/strict";
import { test } from "node:test";

import { createSealer, SealError } from "../src/crypto.ts";

const KEY = "0f".repeat(32);

test("a sealed value opens in its own context", async () => {
  const sealer = await createSealer(KEY);
  const sealed = await sealer.seal("sk_test_123", "inst_1:stripe_secret_key");
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal(sealed.includes("sk_test"), false);
  assert.equal(await sealer.open(sealed, "inst_1:stripe_secret_key"), "sk_test_123");
});

test("sealing twice gives different ciphertexts (a fresh IV each time)", async () => {
  const sealer = await createSealer(KEY);
  assert.notEqual(await sealer.seal("x", "c"), await sealer.seal("x", "c"));
});

test("a value moved to another installation or field doesn't open", async () => {
  const sealer = await createSealer(KEY);
  const sealed = await sealer.seal("sk_test_123", "inst_1:stripe_secret_key");
  await assert.rejects(sealer.open(sealed, "inst_2:stripe_secret_key"), SealError);
  await assert.rejects(sealer.open(sealed, "inst_1:stripe_webhook_secret"), SealError);
});

test("a tampered value or another key doesn't open", async () => {
  const sealer = await createSealer(KEY);
  const sealed = await sealer.seal("secret", "c");
  // Flip a character inside the ciphertext (the last one may only carry padding bits).
  const at = sealed.lastIndexOf(".") + 2;
  const flipped = sealed[at] === "A" ? "B" : "A";
  await assert.rejects(
    sealer.open(sealed.slice(0, at) + flipped + sealed.slice(at + 1), "c"),
    SealError,
  );
  const other = await createSealer("1e".repeat(32));
  await assert.rejects(other.open(sealed, "c"), SealError);
  await assert.rejects(sealer.open("garbage", "c"), SealError);
});

test("the key must be 32 bytes of hex", async () => {
  await assert.rejects(createSealer("abc"), SealError);
  await assert.rejects(createSealer("zz".repeat(32)), SealError);
});
