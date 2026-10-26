// Hypha's webhooks (`POST /hypha/webhooks`), through the SDK's `webhookHandler`: the
// secret is the one of the store in `Hypha-Store`, and each delivery is handled once
// (`Hypha-Delivery-Id`, stable across retries). `app.uninstalled` forgets the tokens.
// A handler that throws answers 500, so Hypha retries. An order is placed only once its
// money is held, and staff void a held payment through `payments.void` before cancelling
// the order, so nothing is left to cancel at Stripe on `order.cancelled`.

import { webhookHandler, type WebhookContext } from "@hyphacommerce/app";

import type { Deps } from "./config.ts";
import type { Installation, Installations } from "./installations.ts";

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
