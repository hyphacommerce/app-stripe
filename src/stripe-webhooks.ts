// Stripe's webhooks (`POST /stripe/webhook/:store`), verified with that store's signing
// secret, handled once per event, and reported to Hypha as payment events
// (`POST /admin/payments/{id}/events`, design note 0029, §3.1) with Stripe's event ID as
// the `Idempotency-Key`, so a redelivery never counts twice.

import { NotInstalledError } from "@hypha/app";

import type { Deps } from "./config.ts";
import type { Installation, Installations } from "./installations.ts";
import { fetchPayment } from "./hypha-api.ts";
import { fromStripeAmount } from "./stripe/amounts.ts";
import { bool, isRecord, num, parseJson, rec, str, strings } from "./json.ts";
import type { StripeClient, StripeEvent } from "./stripe/api.ts";
import { STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from "./stripe/signature.ts";

export type PaymentEventType =
  | "authorized"
  | "paid"
  | "failed"
  | "voided"
  | "partially_refunded"
  | "refunded";

export interface PaymentReport {
  payment: string;
  type: PaymentEventType;
  amount?: number;
  reference?: string;
  occurred_at?: string;
}

/** What happened to a webhook, for the answer and the tests. */
export type WebhookOutcome =
  | { status: "reported"; report: PaymentReport }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "rejected"; reason: string };

export class ReportError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "ReportError";
    this.status = status;
    this.code = code;
  }
  /** Hypha refused it for good (a move the payment can't make): don't retry. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 429;
  }
}

/** Reports a payment event to Hypha as the app. */
export async function reportToHypha(
  installations: Installations,
  installation: Installation,
  report: PaymentReport,
  idempotencyKey: string,
): Promise<void> {
  const { payment, ...body } = report;
  const response = await installations
    .client(installation)
    .fetch(`/admin/payments/${encodeURIComponent(payment)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  if (response.ok) return;
  const answer: unknown = await response.json().catch(() => undefined);
  const code = isRecord(answer) && typeof answer.code === "string" ? answer.code : undefined;
  const message = isRecord(answer) && typeof answer.error === "string" ? answer.error : "";
  throw new ReportError(
    response.status,
    code,
    `Hypha answered ${response.status} ${code ?? ""} ${message}`.trim(),
  );
}

/** The Hypha payment and what to report for a Stripe event; `undefined` to ignore it. */
export async function mapStripeEvent(
  deps: Deps,
  installations: Installations,
  installation: Installation,
  stripe: StripeClient,
  event: StripeEvent,
): Promise<PaymentReport | { ignore: string }> {
  const occurred_at = new Date(event.created * 1000).toISOString();
  const object = event.data.object;
  if (event.type.startsWith("payment_intent.")) {
    const payment = strings(object, "metadata").hypha_payment;
    const id = str(object, "id");
    if (!payment || !id) return { ignore: "not a Hypha payment" };
    const base = { payment, reference: id, occurred_at };
    switch (event.type) {
      case "payment_intent.succeeded":
        return { ...base, type: "paid" };
      case "payment_intent.amount_capturable_updated":
        if (!num(object, "amount_capturable")) return { ignore: "nothing capturable" };
        return { ...base, type: "authorized" };
      case "payment_intent.payment_failed":
        // Hypha's `failed` is final; Stripe's attempt usually isn't: a declined intent
        // goes back to `requires_payment_method` and the shopper may try another card on
        // it. Only an intent that can't take money any more failed for Hypha.
        if (str(object, "status") !== "canceled")
          return { ignore: "the shopper may still pay this intent" };
        return { ...base, type: "failed" };
      case "payment_intent.canceled":
        return { ...base, type: "voided" };
      default:
        return { ignore: `${event.type} isn't reported` };
    }
  }
  if (event.type === "charge.refunded") {
    const intentId = str(object, "payment_intent");
    if (!intentId) return { ignore: "a charge without a PaymentIntent" };
    let payment = (await deps.storage.paymentByIntent(installation.row.id, intentId))?.paymentId;
    payment ??= (await stripe.retrievePaymentIntent(intentId)).metadata?.hypha_payment;
    if (!payment) return { ignore: "not a Hypha payment" };
    const base = { payment, reference: intentId, occurred_at };
    if (bool(object, "refunded")) return { ...base, type: "refunded" };
    // Hypha counts each refund's own amount; Stripe's charge says how much in all.
    const total = fromStripeAmount(
      num(object, "amount_refunded") ?? 0,
      str(object, "currency") ?? "",
    );
    const already = await refundedInHypha(installations, installation, payment);
    const amount = total - already;
    if (amount <= 0) return { ignore: "Hypha has this refund already" };
    return { ...base, type: "partially_refunded", amount };
  }
  return { ignore: `${event.type} isn't handled` };
}

/** How much Hypha has counted as refunded on a payment. */
async function refundedInHypha(
  installations: Installations,
  installation: Installation,
  paymentId: string,
): Promise<number> {
  const payment = await fetchPayment(installations, installation, paymentId);
  if (!payment) throw new Error(`Hypha has no payment ${paymentId}`);
  return payment.refunded.amount;
}

/** Handles one Stripe webhook delivery for the store in the URL. */
export async function handleStripeWebhook(
  deps: Deps,
  installations: Installations,
  storeId: string,
  request: Request,
): Promise<{ status: number; outcome: WebhookOutcome }> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const installation = await installations.byStore(storeId);
  if (!installation)
    return { status: 404, outcome: { status: "rejected", reason: "unknown store" } };
  const settings = await installations.settings(installation);
  if (!settings.webhookSecret)
    return { status: 400, outcome: { status: "rejected", reason: "no signing secret set" } };
  const signed = await verifyStripeSignature(
    settings.webhookSecret,
    request.headers.get(STRIPE_SIGNATURE_HEADER),
    raw,
    { now: Math.floor(deps.now() / 1000) },
  );
  if (!signed) return { status: 400, outcome: { status: "rejected", reason: "bad signature" } };

  const event = toStripeEvent(parseJson(new TextDecoder().decode(raw)));
  if (!event) return { status: 400, outcome: { status: "rejected", reason: "not an event" } };

  const { storage } = deps;
  if (await storage.eventSeen(installation.row.id, "stripe", event.id))
    return { status: 200, outcome: { status: "duplicate" } };

  const { stripe } = await installations.stripe(installation);
  let mapped: PaymentReport | { ignore: string };
  try {
    mapped = await mapStripeEvent(deps, installations, installation, stripe, event);
  } catch (error) {
    deps.log("error", "a Stripe event couldn't be read", { event: event.id, error: String(error) });
    return { status: 500, outcome: { status: "rejected", reason: "try again" } };
  }
  if ("ignore" in mapped) {
    await storage.markEvent(installation.row.id, "stripe", event.id, deps.now());
    return { status: 200, outcome: { status: "ignored", reason: mapped.ignore } };
  }

  try {
    await reportToHypha(installations, installation, mapped, event.id);
  } catch (error) {
    if (error instanceof ReportError && error.permanent) {
      // A move the payment can't make (Hypha voided it already, …): retrying won't help.
      deps.log("warn", "Hypha refused a payment report", {
        event: event.id,
        payment: mapped.payment,
        type: mapped.type,
        error: error.message,
      });
      await storage.markEvent(installation.row.id, "stripe", event.id, deps.now());
      return { status: 200, outcome: { status: "ignored", reason: error.code ?? "refused" } };
    }
    if (error instanceof NotInstalledError) {
      await storage.markEvent(installation.row.id, "stripe", event.id, deps.now());
      return { status: 200, outcome: { status: "ignored", reason: "not installed" } };
    }
    deps.log("error", "reporting to Hypha failed; Stripe will retry", {
      event: event.id,
      error: String(error),
    });
    return { status: 500, outcome: { status: "rejected", reason: "try again" } };
  }
  await storage.markEvent(installation.row.id, "stripe", event.id, deps.now());
  return { status: 200, outcome: { status: "reported", report: mapped } };
}

function toStripeEvent(body: unknown): StripeEvent | undefined {
  if (!isRecord(body)) return undefined;
  const [id, type, created, data] = [
    str(body, "id"),
    str(body, "type"),
    num(body, "created"),
    rec(body, "data"),
  ];
  const object = data ? rec(data, "object") : undefined;
  if (!id || !type || !object) return undefined;
  return { id, object: "event", type, created: created ?? 0, data: { object } };
}
