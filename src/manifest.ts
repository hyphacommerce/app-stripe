// The app's manifest (design note 0029, §4), served at `/manifest.json`: that URL is the
// app's OAuth client ID. Relative URLs resolve against `app_url`.

import { type AppManifest, defineManifest, MANIFEST_SCHEMA_URL } from "@hyphacommerce/app";

export const APP_KEY = "app_stripe";
export const APP_VERSION = "0.1.0";

export const SCOPES = ["payments:write", "orders:read", "customer_data:email"] as const;

/** Paths, relative to `app_url`, the manifest registers and the router serves. */
export const PATHS = {
  callback: "/oauth/callback",
  privacy: "/privacy",
  icon: "/icon.svg",
  hyphaWebhooks: "/hypha/webhooks",
  start: "/hypha/payments/start",
  capture: "/hypha/payments/capture",
  void: "/hypha/payments/void",
  refund: "/hypha/payments/refund",
  settingsPage: "/admin/settings",
  paymentBlock: "/hypha/blocks/payment",
  adminProxy: "/hypha/admin-proxy",
  element: "/elements/payment.js",
} as const;

export const ELEMENT_TAG = "stripe-payment";

/** The manifest's `icon`: a card on Stripe's purple, square. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="14" fill="#635bff"/><rect x="12" y="19" width="40" height="27" rx="4" fill="#fff"/><rect x="12" y="25" width="40" height="5" fill="#0a2540"/><rect x="17" y="36" width="12" height="4" rx="2" fill="#635bff"/></svg>`;

export function manifest(appUrl: string): AppManifest {
  return defineManifest({
    $schema: MANIFEST_SCHEMA_URL,
    key: APP_KEY,
    name: "Stripe",
    version: APP_VERSION,
    publisher: "Hypha",
    icon: PATHS.icon,
    app_url: appUrl,
    redirect_uris: [PATHS.callback],
    scopes: [...SCOPES],
    scope_reasons: {
      "customer_data:email": "Stripe emails the buyer their receipt.",
    },
    privacy_url: PATHS.privacy,
    webhooks: { url: PATHS.hyphaWebhooks, events: ["order.cancelled"] },
    extension_points: [
      { point: "payments.start", version: 1, url: PATHS.start },
      { point: "payments.capture", version: 1, url: PATHS.capture },
      { point: "payments.void", version: 1, url: PATHS.void },
      { point: "payments.refund", version: 1, url: PATHS.refund },
    ],
    settings: {
      schema: {
        type: "object",
        title: "Stripe",
        properties: {
          secret_key: {
            type: "string",
            title: "Secret key",
            description: "sk_live_… or sk_test_… (a restricted rk_… key works too)",
          },
          publishable_key: { type: "string", title: "Publishable key", pattern: "^pk_" },
          webhook_secret: {
            type: "string",
            title: "Webhook signing secret",
            description: "whsec_…, from the endpoint you add in Stripe's dashboard",
          },
          capture_mode: {
            type: "string",
            title: "Capture",
            enum: ["automatic", "manual"],
            default: "automatic",
          },
        },
      },
      secret_fields: ["secret_key", "webhook_secret"],
    },
    admin: {
      pages: [{ id: "settings", title: "Stripe", url: PATHS.settingsPage, nav: "settings" }],
      blocks: [{ id: "payment", target: "order.payment", url: PATHS.paymentBlock }],
      actions: [
        { id: "capture", target: "payment", label: "Capture", point: "payments.capture" },
        { id: "void", target: "payment", label: "Void", point: "payments.void" },
        {
          id: "refund",
          target: "payment",
          label: "Refund",
          point: "payments.refund",
          input_schema: {
            type: "object",
            properties: {
              amount: {
                type: "integer",
                minimum: 1,
                title: "Amount (minor units; empty for all that's left)",
              },
            },
          },
        },
      ],
      proxy: PATHS.adminProxy,
    },
    storefront: {
      elements: [
        {
          id: "payment-element",
          target: "checkout.payment",
          module: PATHS.element,
          tag: ELEMENT_TAG,
        },
      ],
    },
  });
}
