// Hypha's webhooks (`POST /hypha/webhooks`, design note 0016 §8): signed with the app
// secret. `order.cancelled` cancels the order's open PaymentIntents at Stripe (Stripe's
// `payment_intent.canceled` then reports them voided); `app.uninstalled` forgets the
// tokens. Each event is handled once (`Hypha-Event-Id`).

import { SIGNATURE_HEADER, verifySignature } from "@hypha/app";

import type { Deps } from "./config.ts";
import { type Installation, type Installations, NotConfiguredError } from "./installations.ts";
import { APP_KEY } from "./manifest.ts";
import { StripeError } from "./stripe/api.ts";
import { fetchOrder } from "./stripe-webhooks.ts";
import { isRecord, parseJson, rec, str } from "./json.ts";

export interface HyphaEnvelope {
  id: string;
  type: string;
  subject: { type: string; id: string };
}

function toEnvelope(body: unknown): HyphaEnvelope | undefined {
  if (!isRecord(body)) return undefined;
  const subject = rec(body, "subject");
  const [id, type] = [str(body, "id"), str(body, "type")];
  if (!id || !type) return undefined;
  return {
    id,
    type,
    subject: {
      type: (subject && str(subject, "type")) ?? "",
      id: (subject && str(subject, "id")) ?? "",
    },
  };
}

export async function handleHyphaWebhook(
  deps: Deps,
  installations: Installations,
  request: Request,
): Promise<{ status: number; outcome: string }> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get(SIGNATURE_HEADER);
  // Webhooks name no store: the installation is the one whose secret signed this.
  const installation = await installations.resolve((secret) =>
    verifySignature(secret, signature, raw),
  );
  if (!installation) return { status: 401, outcome: "invalid_signature" };

  const envelope = toEnvelope(parseJson(new TextDecoder().decode(raw)));
  if (!envelope) return { status: 400, outcome: "not an event" };
  const { storage } = deps;
  if (await storage.eventSeen(installation.row.id, "hypha", envelope.id))
    return { status: 200, outcome: "duplicate" };

  switch (envelope.type) {
    case "order.cancelled":
      try {
        await cancelOpenIntents(deps, installations, installation, envelope.subject.id);
      } catch (error) {
        deps.log("error", "voiding a cancelled order's intents failed", { error: String(error) });
        return { status: 500, outcome: "try again" };
      }
      break;
    case "app.uninstalled":
      await storage.markUninstalled(installation.row.id, deps.now());
      installations.forget(installation.row.id);
      break;
    default:
      break;
  }
  await storage.markEvent(installation.row.id, "hypha", envelope.id, deps.now());
  return { status: 200, outcome: envelope.type };
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
