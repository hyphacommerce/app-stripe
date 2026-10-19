// A fake of the slice of Stripe's API the app uses, as a fetch handler: the unit tests
// pass it as the app's `fetch`, the end-to-end script serves it over HTTP
// (`STRIPE_API_BASE`). It keeps PaymentIntents in memory, honours idempotency keys like
// Stripe (same key, same answer), and records every request.

export interface FakeIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  status: string;
  client_secret: string;
  capture_method: string;
  metadata: Record<string, string>;
  receipt_email: string | null;
  livemode: false;
  latest_charge: string | null;
  created: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  form: Record<string, string>;
  idempotencyKey: string | null;
  authorization: string | null;
}

export interface FakeRefund {
  id: string;
  object: "refund";
  amount: number;
  status: string;
  payment_intent: string;
  charge: string | null;
  currency: string;
  created: number;
}

export interface FakeStripe {
  handle(request: Request): Promise<Response>;
  intents: Map<string, FakeIntent>;
  /** Every refund made, oldest first; tests may add their own. */
  refunds: FakeRefund[];
  requests: RecordedRequest[];
  /** Keys Stripe accepts (`sk_test_…`). */
  keys: Set<string>;
  /** Moves an intent as a buyer's confirmation would. */
  succeed(id: string): FakeIntent;
}

function error(status: number, type: string, message: string, code?: string) {
  return {
    status,
    body: { error: { type, message, ...(code ? { code } : {}) } },
  };
}

export function createFakeStripe(options: { keys?: string[] } = {}): FakeStripe {
  const intents = new Map<string, FakeIntent>();
  const refunds: FakeRefund[] = [];
  const requests: RecordedRequest[] = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  const keys = new Set(options.keys ?? ["sk_test_fake000000000000"]);
  let n = 0;
  const next = (prefix: string) => `${prefix}_fake${String(++n).padStart(8, "0")}`;

  const route = (method: string, path: string, form: Record<string, string>) => {
    if (method === "GET" && path === "/v1/account")
      return { status: 200, body: { id: "acct_fake" } };
    if (method === "POST" && path === "/v1/payment_intents") {
      const amount = Number(form.amount);
      if (!Number.isInteger(amount) || amount < 1)
        return error(400, "invalid_request_error", "Invalid amount", "parameter_invalid_integer");
      const metadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(form)) {
        const m = /^metadata\[(.+)\]$/.exec(key);
        if (m?.[1]) metadata[m[1]] = value;
      }
      const id = next("pi");
      const intent: FakeIntent = {
        id,
        object: "payment_intent",
        amount,
        amount_capturable: 0,
        amount_received: 0,
        currency: form.currency ?? "eur",
        status: "requires_payment_method",
        client_secret: `${id}_secret_fake`,
        capture_method: form.capture_method ?? "automatic",
        metadata,
        receipt_email: form.receipt_email ?? null,
        livemode: false,
        latest_charge: null,
        created: Math.floor(Date.now() / 1000),
      };
      intents.set(id, intent);
      return { status: 200, body: intent };
    }
    const m = /^\/v1\/payment_intents\/([^/]+)(\/capture|\/cancel)?$/.exec(path);
    if (m?.[1]) {
      const intent = intents.get(decodeURIComponent(m[1]));
      if (!intent)
        return error(404, "invalid_request_error", "No such payment_intent", "resource_missing");
      if (method === "GET" && !m[2]) return { status: 200, body: intent };
      if (method === "POST" && m[2] === "/capture") {
        if (intent.status !== "requires_capture")
          return error(
            400,
            "invalid_request_error",
            `This PaymentIntent could not be captured because it has a status of ${intent.status}.`,
            "payment_intent_unexpected_state",
          );
        intent.status = "succeeded";
        intent.amount_received = form.amount_to_capture
          ? Number(form.amount_to_capture)
          : intent.amount;
        intent.amount_capturable = 0;
        return { status: 200, body: intent };
      }
      if (method === "POST" && m[2] === "/cancel") {
        if (intent.status === "succeeded" || intent.status === "canceled")
          return error(
            400,
            "invalid_request_error",
            `You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`,
            "payment_intent_unexpected_state",
          );
        intent.status = "canceled";
        return { status: 200, body: intent };
      }
    }
    if (method === "POST" && path === "/v1/refunds") {
      const intent = intents.get(form.payment_intent ?? "");
      if (!intent)
        return error(404, "invalid_request_error", "No such payment_intent", "resource_missing");
      if (intent.status !== "succeeded")
        return error(
          400,
          "invalid_request_error",
          "This PaymentIntent has no successful charge to refund.",
          "charge_not_refundable",
        );
      const refund: FakeRefund = {
        id: next("re"),
        object: "refund",
        amount: form.amount ? Number(form.amount) : intent.amount_received,
        status: "succeeded",
        payment_intent: intent.id,
        charge: intent.latest_charge,
        currency: intent.currency,
        created: Math.floor(Date.now() / 1000) + refunds.length,
      };
      refunds.push(refund);
      return { status: 200, body: refund };
    }
    if (method === "GET" && path === "/v1/refunds") {
      // Newest first, as Stripe lists; one page here.
      const data = refunds
        .filter((r) => !form.payment_intent || r.payment_intent === form.payment_intent)
        .filter((r) => !form.charge || r.charge === form.charge)
        .toReversed();
      return { status: 200, body: { object: "list", data, has_more: false } };
    }
    return error(404, "invalid_request_error", `Unrecognized request URL (${method}: ${path})`);
  };

  return {
    intents,
    refunds,
    requests,
    keys,
    succeed(id) {
      const intent = intents.get(id);
      if (!intent) throw new Error(`no intent ${id}`);
      if (intent.capture_method === "manual") {
        intent.status = "requires_capture";
        intent.amount_capturable = intent.amount;
      } else {
        intent.status = "succeeded";
        intent.amount_received = intent.amount;
      }
      intent.latest_charge = next("ch");
      return intent;
    },
    async handle(request) {
      const url = new URL(request.url);
      const form = Object.fromEntries(
        request.method === "GET" ? url.searchParams : new URLSearchParams(await request.text()),
      );
      const idempotencyKey = request.headers.get("idempotency-key");
      requests.push({
        method: request.method,
        path: url.pathname,
        form,
        idempotencyKey,
        authorization: request.headers.get("authorization"),
      });
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      let answer: { status: number; body: unknown };
      if (!keys.has(key)) answer = error(401, "invalid_request_error", "Invalid API Key provided");
      else if (
        request.method === "POST" &&
        idempotencyKey &&
        idempotent.has(`${key}:${idempotencyKey}`)
      )
        answer = idempotent.get(`${key}:${idempotencyKey}`) as { status: number; body: unknown };
      else {
        answer = route(request.method, url.pathname, form);
        if (request.method === "POST" && idempotencyKey)
          idempotent.set(`${key}:${idempotencyKey}`, answer);
      }
      return Response.json(answer.body, { status: answer.status });
    },
  };
}
