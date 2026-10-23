// The `order.payment` block (design note 0029, §6.2): Hypha GETs it, signed, with the
// order and payment as query parameters, and renders the tree with its own components.

import type { BlockElement, BlockTree } from "@hyphacommerce/app-blocks";
import { STORE_HEADER, verifyForwardedRequest } from "@hyphacommerce/app";

import type { Deps } from "./config.ts";
import { type Installation, type Installations, NotConfiguredError } from "./installations.ts";
import { APP_KEY } from "./manifest.ts";
import { fromStripeAmount } from "./stripe/amounts.ts";
import { dashboardUrl, type PaymentIntent, StripeError } from "./stripe/api.ts";
import { fetchOrder, fetchPayment, type HyphaPayment } from "./hypha-api.ts";

type Tone = "neutral" | "info" | "success" | "warning" | "error";

const STATUS: Record<PaymentIntent["status"], { label: string; tone: Tone }> = {
  requires_payment_method: { label: "Awaiting payment", tone: "neutral" },
  requires_confirmation: { label: "Awaiting confirmation", tone: "neutral" },
  requires_action: { label: "Needs the buyer's action", tone: "warning" },
  processing: { label: "Processing", tone: "info" },
  requires_capture: { label: "Authorized", tone: "info" },
  canceled: { label: "Canceled", tone: "neutral" },
  succeeded: { label: "Succeeded", tone: "success" },
};

export async function handleBlock(
  deps: Deps,
  installations: Installations,
  request: Request,
): Promise<Response> {
  const installation = await installations.byStore(request.headers.get(STORE_HEADER));
  if (!installation || !(await verifyForwardedRequest(installation.appSecret, request, "")))
    return Response.json(
      { code: "invalid_signature", error: "the signature doesn't verify" },
      { status: 401 },
    );
  const url = new URL(request.url);
  const tree = await paymentBlock(
    deps,
    installations,
    installation,
    url.searchParams.get("order_id"),
    url.searchParams.get("payment_id"),
  );
  return Response.json(tree, { headers: { "cache-control": "no-store" } });
}

function card(children: BlockElement[]): BlockTree {
  return {
    version: 1,
    root: { type: "card", title: "Stripe", children },
  };
}

export async function paymentBlock(
  deps: Deps,
  installations: Installations,
  installation: Installation,
  orderId: string | null,
  paymentId: string | null,
): Promise<BlockTree> {
  if (!orderId) return card([{ type: "text", value: "No order given.", variant: "supporting" }]);

  // The block's payment (`GET /admin/payments/{id}`), else the order's first Stripe one.
  let payment: HyphaPayment | undefined;
  try {
    if (paymentId) {
      const found = await fetchPayment(installations, installation, paymentId);
      payment = found?.order === orderId && found.provider === APP_KEY ? found : undefined;
    } else {
      const order = await fetchOrder(installations, installation, orderId);
      payment = order?.payments.find((p) => p.provider === APP_KEY);
    }
  } catch (error) {
    deps.log("warn", "block: reading the payment failed", { error: String(error) });
  }
  if (!payment)
    return card([
      { type: "text", value: "This order has no Stripe payment.", variant: "supporting" },
    ]);
  const reference =
    payment.reference ??
    (await deps.storage.paymentById(installation.row.id, payment.id))?.intentId;
  if (!reference)
    return card([{ type: "text", value: "Not started at Stripe yet.", variant: "supporting" }]);

  let intent: PaymentIntent;
  let live = false;
  try {
    const { stripe, settings } = await installations.stripe(installation);
    live = settings.secretKey?.includes("_live_") ?? false;
    intent = await stripe.retrievePaymentIntent(reference);
  } catch (error) {
    const message =
      error instanceof NotConfiguredError
        ? "Add the Stripe keys in the app's settings."
        : error instanceof StripeError
          ? `Stripe: ${error.message}`
          : "Stripe couldn't be reached.";
    return card([
      {
        type: "banner",
        tone: "warning",
        title: "Can't show the Stripe payment",
        description: message,
      },
    ]);
  }

  const status = STATUS[intent.status] ?? { label: intent.status, tone: "neutral" };
  const money = (amount: number) =>
    formatMoney(fromStripeAmount(amount, intent.currency), intent.currency);
  const refunded = payment.refunded.amount;
  const children: BlockElement[] = [
    {
      type: "row",
      align: "between",
      children: [
        { type: "text", value: "Status", weight: "semibold" },
        { type: "badge", value: status.label, tone: status.tone },
      ],
    },
    {
      type: "keyvalue",
      items: [
        { label: "Amount", value: money(intent.amount) },
        ...(intent.amount_received
          ? [{ label: "Received", value: money(intent.amount_received) }]
          : []),
        ...(refunded > 0
          ? [{ label: "Refunded", value: formatMoney(refunded, payment.amount.currency) }]
          : []),
        { label: "Capture", value: intent.capture_method === "manual" ? "Manual" : "Automatic" },
        { label: "PaymentIntent", value: intent.id },
      ],
    },
    {
      type: "link",
      label: "Open in Stripe",
      href: dashboardUrl(intent.id, intent.livemode ?? live),
      external: true,
    },
  ];
  const buttons: BlockElement[] = [];
  if (intent.status === "requires_capture") {
    buttons.push({ type: "button", label: "Capture", action: "capture", variant: "primary" });
    buttons.push({ type: "button", label: "Void", action: "void", variant: "secondary" });
  }
  if (intent.status === "succeeded" && refunded < payment.amount.amount)
    buttons.push({ type: "button", label: "Refund", action: "refund", variant: "destructive" });
  if (buttons.length > 0) children.push({ type: "row", gap: 2, children: buttons });
  return card(children);
}

/** `12.50 EUR`, with the currency's own minor units (from `Intl`). */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // An unknown code: two decimals.
  }
  // Intl says ISK and UGX have none, as ISO and Hypha do.
  return `${(amount / 10 ** digits).toFixed(digits)} ${code}`;
}
