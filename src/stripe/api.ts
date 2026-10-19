// Stripe's REST API over `fetch` (no stripe-node: it works on Workers too): form-encoded
// requests, JSON answers, `Idempotency-Key` on writes. `apiBase` points at Stripe
// (`https://api.stripe.com`) or, in tests and the end-to-end script, a fake.

import { isRecord } from "../json.ts";

export const STRIPE_API_BASE = "https://api.stripe.com";

export type FormValue = string | number | boolean | null | undefined | FormObject;
export interface FormObject {
  [key: string]: FormValue;
}

/** Stripe's nested form encoding: `{metadata: {a: "1"}}` is `metadata[a]=1`. */
export function encodeForm(params: FormObject): URLSearchParams {
  const out = new URLSearchParams();
  const add = (prefix: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) add(`${prefix}[${key}]`, inner);
      return;
    }
    out.append(prefix, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return out;
}

/** An error answer from Stripe (`card_error`, `invalid_request_error`, …) or no answer. */
export class StripeError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  constructor(status: number, type: string, message: string, code?: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
  /** Stripe said no to this request: retrying the same won't help. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface PaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_capturable?: number;
  amount_received?: number;
  currency: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "canceled"
    | "succeeded";
  client_secret: string | null;
  capture_method?: string;
  latest_charge?: string | { id: string } | null;
  metadata: Record<string, string>;
  livemode?: boolean;
  created?: number;
}

export interface Charge {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  currency: string;
  payment_intent: string | null;
  metadata?: Record<string, string>;
}

export interface Refund {
  id: string;
  object: "refund";
  amount: number;
  /** `pending`, `requires_action`, `succeeded`, `failed` or `canceled`. */
  status: string;
  payment_intent: string | null;
  charge?: string | null;
  currency?: string;
  created: number;
}

/** A page of a Stripe list. */
export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface StripeEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export interface StripeClientOptions {
  secretKey: string;
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

export class StripeClient {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: StripeClientOptions) {
    this.#key = options.secretKey;
    this.#base = (options.apiBase ?? STRIPE_API_BASE).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    params?: FormObject,
    idempotencyKey?: string,
  ): Promise<T> {
    const form = params ? encodeForm(params) : undefined;
    const url = new URL(`${this.#base}${path}`);
    if (method === "GET" && form) url.search = form.toString();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#key}`,
      accept: "application/json",
    };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (method === "POST" && idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: method === "POST" ? (form?.toString() ?? "") : undefined,
      });
    } catch (error) {
      throw new StripeError(0, "api_connection_error", `Stripe unreachable: ${String(error)}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const err = isRecord(body) && isRecord(body.error) ? body.error : {};
      throw new StripeError(
        response.status,
        typeof err.type === "string" ? err.type : "api_error",
        typeof err.message === "string" ? err.message : `Stripe answered HTTP ${response.status}`,
        typeof err.code === "string" ? err.code : undefined,
      );
    }
    if (!isRecord(body)) throw new StripeError(502, "api_error", "Stripe's answer isn't JSON");
    // Stripe's documented object for this endpoint; callers read the fields they use.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an external API's typed answer
    return body as T;
  }

  createPaymentIntent(params: FormObject, idempotencyKey: string): Promise<PaymentIntent> {
    return this.request("POST", "/v1/payment_intents", params, idempotencyKey);
  }

  retrievePaymentIntent(id: string): Promise<PaymentIntent> {
    return this.request("GET", `/v1/payment_intents/${encodeURIComponent(id)}`);
  }

  capturePaymentIntent(
    id: string,
    params: FormObject,
    idempotencyKey: string,
  ): Promise<PaymentIntent> {
    return this.request(
      "POST",
      `/v1/payment_intents/${encodeURIComponent(id)}/capture`,
      params,
      idempotencyKey,
    );
  }

  cancelPaymentIntent(
    id: string,
    params: FormObject,
    idempotencyKey: string,
  ): Promise<PaymentIntent> {
    return this.request(
      "POST",
      `/v1/payment_intents/${encodeURIComponent(id)}/cancel`,
      params,
      idempotencyKey,
    );
  }

  createRefund(params: FormObject, idempotencyKey: string): Promise<Refund> {
    return this.request("POST", "/v1/refunds", params, idempotencyKey);
  }

  /** Every refund of a PaymentIntent, oldest first (Stripe lists newest first, in pages
   * of at most 100). */
  async listRefunds(paymentIntent: string): Promise<Refund[]> {
    const all: Refund[] = [];
    let after: string | undefined;
    for (;;) {
      const page: StripeList<Refund> = await this.request("GET", "/v1/refunds", {
        payment_intent: paymentIntent,
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      });
      all.push(...page.data);
      const last = page.data.at(-1);
      if (!page.has_more || !last) break;
      after = last.id;
    }
    return all.toSorted(
      (a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** The account the key belongs to: checks a key when the merchant saves it. */
  retrieveAccount(): Promise<{ id: string }> {
    return this.request("GET", "/v1/account");
  }
}

export { isRecord };

/** Stripe's dashboard page for a PaymentIntent (the test-mode one for test keys). */
export function dashboardUrl(intentId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}payments/${encodeURIComponent(intentId)}`;
}
