// The payment extension points (design note 0029, §3.1): Hypha calls them, signed, and
// the app answers from Stripe. Results (paid, refunded, …) don't come back here: Stripe
// tells the app by webhook (`stripe-webhooks.ts`), and the app reports them to Hypha.

import {
  defineExtensionHandler,
  ExtensionError,
  type ExtensionContext,
  extensionHandler,
  type PaymentActionResponse,
  type PointRequest,
  type PointResponse,
  SIGNATURE_HEADER,
  STORE_HEADER,
  verifySignature,
} from "@hypha/app";

import type { Deps } from "./config.ts";
import { type Installation, type Installations, NotConfiguredError } from "./installations.ts";
import { ELEMENT_TAG } from "./manifest.ts";
import { AmountError, toStripeAmount } from "./stripe/amounts.ts";
import { type PaymentIntent, StripeError } from "./stripe/api.ts";

/** Which installation each verified call is for (set before the SDK's handler runs). */
const callers = new WeakMap<Request, Installation>();

function installationOf(context: ExtensionContext): Installation {
  const installation = callers.get(context.request);
  if (!installation) throw new Error("no installation for this call");
  return installation;
}

export function paymentHandlers(deps: Deps, installations: Installations) {
  const configured = async (installation: Installation) => {
    try {
      return await installations.stripe(installation);
    } catch (error) {
      if (error instanceof NotConfiguredError)
        throw new ExtensionError("not_configured", error.message, 409);
      throw error;
    }
  };

  const start = defineExtensionHandler("payments.start", async (body, context) => {
    const installation = installationOf(context);
    const { stripe, settings } = await configured(installation);
    if (!settings.publishableKey)
      throw new ExtensionError("not_configured", "Stripe's publishable key isn't set", 409);
    const intent = await intentFor(deps, installation, body, settings.captureMode, stripe);
    return {
      next_action: {
        type: "client_widget",
        element: ELEMENT_TAG,
        props: {
          client_secret: intent.client_secret,
          publishable_key: settings.publishableKey,
          return_url: body.return_url ?? null,
          payment_id: body.payment,
        },
      },
      reference: intent.id,
    } satisfies PointResponse<"payments.start">;
  });

  const capture = defineExtensionHandler("payments.capture", async (body, context) =>
    act(context, body, async (stripe, reference, key) => {
      const params =
        body.amount == null
          ? {}
          : { amount_to_capture: toStripeAmount(body.amount.amount, body.amount.currency) };
      const intent = await stripe.capturePaymentIntent(reference, params, key);
      return intent.id;
    }),
  );

  const voidPayment = defineExtensionHandler("payments.void", async (body, context) =>
    act(context, body, async (stripe, reference, key) => {
      const intent = await stripe.cancelPaymentIntent(
        reference,
        { cancellation_reason: "requested_by_customer" },
        key,
      );
      return intent.id;
    }),
  );

  const refundPayment = defineExtensionHandler("payments.refund", async (body, context) =>
    act(context, body, async (stripe, reference, key) => {
      const refund = await stripe.createRefund(
        {
          payment_intent: reference,
          amount:
            body.amount == null
              ? undefined
              : toStripeAmount(body.amount.amount, body.amount.currency),
          metadata: { hypha_payment: body.payment, hypha_order: body.order },
        },
        key,
      );
      return refund.id;
    }),
  );

  type Action = (
    stripe: Awaited<ReturnType<Installations["stripe"]>>["stripe"],
    reference: string,
    idempotencyKey: string,
  ) => Promise<string>;

  /** Capture, void and refund: Stripe's "no" is `refused` (shown to staff), not a failure. */
  async function act(
    context: ExtensionContext,
    body: PointRequest<"payments.capture">,
    action: Action,
  ): Promise<PaymentActionResponse> {
    const installation = installationOf(context);
    const { stripe } = await configured(installation);
    const known = await deps.storage.paymentById(installation.row.id, body.payment);
    const reference = body.reference ?? known?.intentId;
    if (!reference?.startsWith("pi_"))
      return { status: "refused", reason: "This payment has no Stripe PaymentIntent." };
    try {
      // Stripe keeps a key's first answer, refusals included, and its keys are
      // account-wide. So the key names the operation and the intent's state: a retry in
      // the same state replays, while pressing again after the state moved (captured
      // once authorized) is a new request rather than the old refusal.
      const intent = await stripe.retrievePaymentIntent(reference);
      const key = `${context.idempotencyKey ?? body.payment}:${context.point}:${intent.status}`;
      return { status: "accepted", reference: await action(stripe, reference, key) };
    } catch (error) {
      if (error instanceof AmountError) return { status: "refused", reason: error.message };
      if (error instanceof StripeError && error.isRefusal)
        return { status: "refused", reason: error.message };
      throw error;
    }
  }

  const handler = extensionHandler({
    // The secret is the verified caller's: `handle` below checked the signature first.
    secret: (request) => callers.get(request)?.appSecret,
    handlers: [start, capture, voidPayment, refundPayment],
    onError: (error, context) =>
      deps.log("error", "extension handler failed", {
        point: context.point,
        error: String(error),
      }),
  });

  /** Finds the installation by `Hypha-Store` (or by the secret that verifies), then answers. */
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return handler(request);
    const raw = new Uint8Array(await request.arrayBuffer());
    const signature = request.headers.get(SIGNATURE_HEADER);
    const installation = await installations.resolve(
      (secret) => verifySignature(secret, signature, raw),
      { store: request.headers.get(STORE_HEADER) },
    );
    const copy = new Request(request.url, { method: "POST", headers: request.headers, body: raw });
    if (installation) callers.set(copy, installation);
    return handler(copy);
  };
}

/**
 * The PaymentIntent for a Hypha payment: the one made before (a retried start answers
 * alike), else a new one. Stripe's idempotency key is Hypha's payment ID as well, so two
 * concurrent starts still make one intent.
 */
async function intentFor(
  deps: Deps,
  installation: Installation,
  body: PointRequest<"payments.start">,
  captureMode: "automatic" | "manual",
  stripe: Awaited<ReturnType<Installations["stripe"]>>["stripe"],
): Promise<PaymentIntent> {
  const known = await deps.storage.paymentById(installation.row.id, body.payment);
  try {
    if (known) {
      const intent = await stripe.retrievePaymentIntent(known.intentId);
      if (intent.status !== "canceled") return intent;
      throw new ExtensionError(
        "intent_canceled",
        "This payment's PaymentIntent was canceled: start a new payment.",
        409,
      );
    }
    let amount: number;
    try {
      amount = toStripeAmount(body.amount.amount, body.amount.currency);
    } catch (error) {
      if (error instanceof AmountError) throw new ExtensionError("invalid_amount", error.message);
      throw error;
    }
    const intent = await stripe.createPaymentIntent(
      {
        amount,
        currency: body.amount.currency.toLowerCase(),
        capture_method: captureMode === "manual" ? "manual" : "automatic",
        automatic_payment_methods: { enabled: true },
        description: `Order ${body.order_number}`,
        receipt_email: body.customer_email ?? undefined,
        metadata: {
          hypha_payment: body.payment,
          hypha_order: body.order,
          hypha_order_number: body.order_number,
          hypha_store: installation.row.storeId ?? undefined,
          hypha_installation: installation.row.id,
        },
      },
      body.payment,
    );
    await deps.storage.putPayment({
      installationId: installation.row.id,
      paymentId: body.payment,
      orderId: body.order,
      intentId: intent.id,
      createdAt: deps.now(),
    });
    return intent;
  } catch (error) {
    if (error instanceof StripeError && error.isRefusal)
      throw new ExtensionError("stripe_refused", error.message, 422);
    throw error;
  }
}
