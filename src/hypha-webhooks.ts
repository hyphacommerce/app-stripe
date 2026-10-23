// Hypha's webhooks (`POST /hypha/webhooks`, design note 0016 §8), through the SDK's
// `webhookHandler`: the secret is the one of the store in `Hypha-Store`, and each
// delivery is handled once (`Hypha-Delivery-Id`, stable across retries).
// `order.cancelled` cancels the order's open PaymentIntents at Stripe (Stripe's
// `payment_intent.canceled` then reports them voided); `app.uninstalled` forgets the
// tokens. A handler that throws answers 500, so Hypha retries.

import { webhookHandler, type WebhookContext } from "@hyphacommerce/app";

import type { Deps } from "./config.ts";
import { fetchOrder } from "./hypha-api.ts";
import { type Installation, type Installations, NotConfiguredError } from "./installations.ts";
import { APP_KEY } from "./manifest.ts";
import { StripeError } from "./stripe/api.ts";

export function hyphaWebhooks(
  deps: Deps,
  installations: Installations,
): (request: Request) => Promise<Response> {
  const { storage } = deps;
  /** The delivery's installation, found when its secret was looked up. */
  const callers = new WeakMap<Request, Installation>();
  const installationOf = (context: WebhookContext): Installation => {
    const installation = callers.get(context.request);
    if (!installation) throw new Error("no installation for this delivery");
    return installation;
  };
  return webhookHandler({
    secret: async ({ request, store }) => {
      const installation = await installations.byStore(store);
      if (installation) callers.set(request, installation);
      return installation?.appSecret;
    },
    dedupe: {
      seen: (deliveryId, context) =>
        storage.eventSeen(installationOf(context).row.id, "hypha", deliveryId),
      remember: (deliveryId, context) =>
        storage.markEvent(installationOf(context).row.id, "hypha", deliveryId, deps.now()),
    },
    onEvent: async (event, context) => {
      const installation = installationOf(context);
      switch (event.type) {
        case "order.cancelled":
          await cancelOpenIntents(deps, installations, installation, event.subject.id);
          break;
        case "app.uninstalled":
          await storage.markUninstalled(installation.row.id, deps.now());
          installations.forget(installation.row.id);
          break;
        default:
          // `app.installed` and the rest: nothing to do.
          break;
      }
    },
    onError: (error, event) =>
      deps.log("error", "handling a Hypha webhook failed; Hypha will retry", {
        event: event.id,
        type: event.type,
        error: String(error),
      }),
  });
}

/** Cancels every Stripe intent of the order that could still take money. */
async function cancelOpenIntents(
  deps: Deps,
  installations: Installations,
  installation: Installation,
  orderId: string,
): Promise<void> {
  const order = await fetchOrder(installations, installation, orderId);
  const open = (order?.payments ?? []).flatMap((p) =>
    p.provider === APP_KEY &&
    p.reference?.startsWith("pi_") &&
    ["pending", "authorized", "voided"].includes(p.status)
      ? [{ id: p.id, intent: p.reference }]
      : [],
  );
  if (open.length === 0) return;
  let stripe;
  try {
    ({ stripe } = await installations.stripe(installation));
  } catch (error) {
    if (error instanceof NotConfiguredError) return;
    throw error;
  }
  for (const payment of open) {
    try {
      await stripe.cancelPaymentIntent(
        payment.intent,
        { cancellation_reason: "abandoned" },
        `${payment.id}:order_cancelled`,
      );
    } catch (error) {
      // Already succeeded or canceled: nothing to cancel. Staff refund a paid one.
      if (error instanceof StripeError && error.isRefusal) {
        deps.log("info", "intent not canceled", { payment: payment.id, reason: error.message });
        continue;
      }
      throw error;
    }
  }
}
