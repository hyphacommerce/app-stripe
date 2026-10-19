// Stripe's webhook signatures (https://docs.stripe.com/webhooks#verify-manually):
// `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=…][,v0=…]`,
// keyed with the endpoint's signing secret (`whsec_…`, used as is). Only `v1` counts;
// a timestamp more than five minutes away is a replay.

import { timingSafeEqual } from "../crypto.ts";

export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";
export const STRIPE_TOLERANCE_SECONDS = 300;

export interface StripeVerifyOptions {
  toleranceSeconds?: number;
  /** Unix seconds; for tests. */
  now?: number;
}

export async function verifyStripeSignature(
  secret: string,
  header: string | null | undefined,
  rawBody: Uint8Array | string,
  options: StripeVerifyOptions = {},
): Promise<boolean> {
  if (!secret || !header) return false;
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS))
    return false;
  const expected = await stripeDigest(secret, timestamp, rawBody);
  let matched = false;
  // Every candidate is compared, so the time taken doesn't say which one matched.
  for (const candidate of candidates) if (timingSafeEqual(candidate, expected)) matched = true;
  return matched;
}

/** The `Stripe-Signature` value Stripe would send; for tests and the fake Stripe. */
export async function signStripePayload(
  secret: string,
  rawBody: Uint8Array | string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await stripeDigest(secret, timestamp, rawBody)}`;
}

async function stripeDigest(
  secret: string,
  timestamp: number,
  body: Uint8Array | string,
): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const prefix = encoder.encode(`${timestamp}.`);
  const data = new Uint8Array(prefix.length + bytes.length);
  data.set(prefix, 0);
  data.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
