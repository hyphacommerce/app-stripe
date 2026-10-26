// The payment extension points (design note 0029, §3.1): Hypha calls them, signed, and
// the app answers from Stripe. Results (paid, refunded, …) don't come back here: Stripe
// tells the app by webhook (`stripe-webhooks.ts`), and the app reports them to Hypha.

import {
  defineExtensionHandler,
  ExtensionError,
  type ExtensionContext,
  extensionHandler,
  type PaymentActionRequest,
  type PaymentActionResponse,
  type PaymentsStartRequest,
  type PaymentsStartResponse,
  type PaymentsStatusResponse,
} from "@hyphacommerce/app";

import type { Deps } from "./config.ts";
import { type Installation, type Installations, NotConfiguredError } from "./installations.ts";
import { ELEMENT_TAG } from "./manifest.ts";
import { AmountError, toStripeAmount } from "./stripe/amounts.ts";
import { canceledOutcome, type PaymentIntent, StripeError } from "./stripe/api.ts";
import { reportToHypha } from "./stripe-webhooks.ts";

/** Which installation each call is for: set when its secret is looked up by `Hypha-Store`. */
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

  // Version 2: a cart's payment, started before its order exists. Hypha places the
  // order once the app reports the money committed (or `payments.status` says so).
  const start = defineExtensionHandler(
    "payments.start",
    async (body, context) => {
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
      } satisfies PaymentsStartResponse;
    },
    { versions: [2] },
  );

  // Checkout asks where the money is when the shopper's browser says they paid before
  // Stripe's webhook arrived: the intent's state, read from Stripe. Hypha sends the
  // reference the start answered; storage is read only when it sends none.
  const status = defineExtensionHandler("payments.status", async (body, context) => {
    const installation = installationOf(context);
    const { stripe } = await configured(installation);
    const reference =
      body.attempt ??
      body.reference ??
      (await deps.storage.paymentById(installation.row.id, body.payment))?.intentId;
    if (!reference?.startsWith("pi_")) return { state: "open" } satisfies PaymentsStatusResponse;
    let intent: PaymentIntent;
    try {
      intent = await stripe.retrievePaymentIntent(reference);
    } catch (error) {
      // An intent the account doesn't know (the keys were swapped while a cart held a
      // pending payment): say so, so Hypha voids it and the shopper starts anew, rather
      // than fail, which would leave the cart's checkout waiting for good.
      if (error instanceof StripeError && error.code === "resource_missing")
        return { state: "canceled", reference } satisfies PaymentsStatusResponse;
      throw error;
    }
    return {
      state: intentState(intent),
      reference: intent.id,
      attempt: intent.id,
    } satisfies PaymentsStatusResponse;
  });

  const capture = defineExtensionHandler("payments.capture", async (body, context) => {
    let captured: PaymentIntent | undefined;
    const answer = await act(context, body, async (stripe, reference, key) => {
      const params =
        body.amount == null
          ? {}
          : { amount_to_capture: toStripeAmount(body.amount.amount, body.amount.currency) };
      captured = await stripe.capturePaymentIntent(reference, params, key);
      return captured.id;
    });
    // Stripe's answer already says the money is taken: report it now rather than wait
    // for `payment_intent.succeeded`, which can be late or lost (an endpoint set up after
    // the payment). The webhook's report later changes nothing: a paid payment stays
    // paid. A failed report is logged; the webhook is still the backstop.
    if (answer.status === "accepted" && captured?.status === "succeeded") {
      const installation = installationOf(context);
      await reportToHypha(
        installations,
        installation,
        {
          payment: body.payment,
          type: "paid",
          reference: captured.id,
          occurred_at: new Date().toISOString(),
          key: `${captured.id}:captured`,
        },
        `${captured.id}:captured`,
      ).catch((error: unknown) =>
        deps.log("warn", "reporting a capture failed; waiting for Stripe's webhook", {
          payment: body.payment,
          error: String(error),
        }),
      );
    }
    return answer;
  });

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
    body: PaymentActionRequest,
    action: Action,
  ): Promise<PaymentActionResponse> {
    const installation = installationOf(context);
    const { stripe } = await configured(installation);
    const known = await deps.storage.paymentById(installation.row.id, body.payment);
    const reference = body.reference ?? known?.intentId;
    if (!reference?.startsWith("pi_"))
      return { status: "refused", reason: "This payment has no Stripe PaymentIntent." };
    // Stripe keeps a key's first answer, refusals included, so a retry of this call
    // (Hypha's key repeats) replays what Stripe did, success or not, and a staff
    // member's next try is a new key from Hypha (`<payment>:<action>:<uuid>`), so it
    // isn't answered with the last refusal. Stripe's keys are account-wide and a client
    // may send its own: the payment (a UUIDv7) and the point make it ours.
    const key = `${body.payment}:${context.point}:${context.idempotencyKey ?? crypto.randomUUID()}`;
    try {
      return { status: "accepted", reference: await action(stripe, reference, key) };
    } catch (error) {
      if (error instanceof AmountError) return { status: "refused", reason: error.message };
      if (error instanceof StripeError && error.isRefusal)
        return { status: "refused", reason: error.message };
      throw error;
    }
  }

  return extensionHandler({
    // The secret of the store in `Hypha-Store`; the call's installation, for the handler.
    secret: async ({ request, store }) => {
      const installation = await installations.byStore(store);
      if (installation) callers.set(request, installation);
      return installation?.appSecret;
    },
    handlers: [start, status, capture, voidPayment, refundPayment],
    onError: (error, context) =>
      deps.log("error", "extension handler failed", {
        point: context.point,
        error: String(error),
      }),
  });
}

/**
 * The PaymentIntent for a Hypha payment: the one made before (a retried start answers
 * alike), else a new one. Stripe's idempotency key is Hypha's payment ID as well, so two
 * concurrent starts still make one intent.
 */
async function intentFor(
  deps: Deps,
  installation: Installation,
  body: PaymentsStartRequest,
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
        description: body.order_number == null ? `Cart ${body.cart}` : `Order ${body.order_number}`,
        receipt_email: body.customer_email ?? undefined,
        metadata: {
          hypha_payment: body.payment,
          hypha_cart: body.cart,
          hypha_order: body.order ?? undefined,
          hypha_order_number: body.order_number == null ? undefined : String(body.order_number),
          hypha_store: installation.row.storeId ?? undefined,
          hypha_installation: installation.row.id,
        },
      },
      body.payment,
    );
    await deps.storage.putPayment({
      installationId: installation.row.id,
      paymentId: body.payment,
      cartId: body.cart,
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

/**
 * A PaymentIntent as a payment's state: `requires_capture` holds the money, `processing`
 * is collecting it, `succeeded` has it; the `requires_…` steps before wait for the
 * shopper; a canceled one failed or was cancelled by the webhook's rule.
 */
function intentState(intent: PaymentIntent): PaymentsStatusResponse["state"] {
  switch (intent.status) {
    case "requires_capture":
      return "authorized";
    case "processing":
      return "processing";
    case "succeeded":
      return "paid";
    case "canceled":
      return canceledOutcome(intent);
    default:
      return "open";
  }
}
