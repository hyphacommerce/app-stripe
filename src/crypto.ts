// Secrets at rest (Stripe keys, Hypha's app secret and tokens): AES-256-GCM under the
// app's own key (`APP_ENCRYPTION_KEY`, 64 hex characters), with Web Crypto only so the
// same code runs on Workers and Node.
//
// A sealed value is `v1.<base64url iv>.<base64url ciphertext+tag>`. Each is bound to
// where it lives (the additional data, e.g. `inst_…:stripe_secret_key`), so a sealed
// value copied into another installation's row or another field doesn't open.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

export interface Sealer {
  seal(plaintext: string, context: string): Promise<string>;
  open(sealed: string, context: string): Promise<string>;
}

/** A sealer under `hexKey` (32 bytes as 64 hex characters). */
export async function createSealer(hexKey: string): Promise<Sealer> {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey))
    throw new SealError("APP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)");
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = Number.parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
        key,
        encoder.encode(plaintext),
      );
      return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
    },
    async open(sealed, context) {
      const [version, ivText, dataText] = sealed.split(".");
      const iv = ivText === undefined ? undefined : fromBase64Url(ivText);
      const data = dataText === undefined ? undefined : fromBase64Url(dataText);
      if (version !== "v1" || !iv || !data || iv.length !== 12)
        throw new SealError("not a sealed value");
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
          key,
          data,
        );
        return decoder.decode(plain);
      } catch {
        throw new SealError("the value doesn't open with this key and context");
      }
    },
  };
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

/** A random identifier: `prefix` and 32 hex characters. */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Compares two strings in time that depends only on their length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
