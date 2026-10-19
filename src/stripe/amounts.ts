// Hypha's amounts are ISO 4217 minor units (`Money`: JPY has none, KWD three). Stripe's
// mostly agree (https://docs.stripe.com/currencies), with exceptions handled here:
//
// - ISK and UGX: ISO says no minor units, but Stripe still takes them as two-decimal
//   amounts ending in `00` ("5 ISK is 500"), so Hypha's amount is multiplied by 100.
// - Three-decimal currencies (BHD, JOD, KWD, OMR, TND): the same minor units, but Stripe
//   only charges multiples of 10 (its last digit must be 0).
// - Zero-decimal currencies (JPY, KRW, …) and HUF/TWD (two-decimal for charges): as is.

const HUNDREDFOLD = new Set(["ISK", "UGX"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/** Hypha's minor units to Stripe's `amount` for `currency` (an ISO code, any case). */
export function toStripeAmount(amount: number, currency: string): number {
  const code = currency.toUpperCase();
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new AmountError(`${amount} isn't an amount in minor units`);
  if (HUNDREDFOLD.has(code)) return amount * 100;
  if (THREE_DECIMAL.has(code) && amount % 10 !== 0)
    throw new AmountError(`Stripe charges ${code} only in multiples of 10 minor units`);
  return amount;
}

/** Stripe's `amount` back to Hypha's minor units (rounding a fraction of ISK/UGX down). */
export function fromStripeAmount(amount: number, currency: string): number {
  return HUNDREDFOLD.has(currency.toUpperCase()) ? Math.floor(amount / 100) : amount;
}
