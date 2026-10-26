// The app: one Hono router over Web APIs, which the Worker and the Node server both run
// (`entry/worker.ts`, `entry/node.ts`).

import { Hono } from "hono";

import { handleBlock } from "./block.ts";
import type { Deps } from "./config.ts";
import { paymentElement, settingsScript } from "./generated/assets.ts";
import { escapeHtml, page } from "./html.ts";
import { hyphaWebhooks } from "./hypha-webhooks.ts";
import { Installations } from "./installations.ts";
import { ICON_SVG, manifest, PATHS } from "./manifest.ts";
import { finishInstall, InstallError, installedPage, installPage, startInstall } from "./oauth.ts";
import { paymentHandlers } from "./payments.ts";
import {
  canRead,
  canWrite,
  fromProxy,
  fromSessionToken,
  SettingsError,
  settingsPage,
  settingsView,
  updateSettings,
} from "./settings.ts";
import { handleStripeWebhook } from "./stripe-webhooks.ts";

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  const installations = new Installations(deps);
  const payments = paymentHandlers(deps, installations);
  const webhooks = hyphaWebhooks(deps, installations);

  app.onError((err) => {
    deps.log("error", "unhandled error", { error: String(err), stack: err.stack });
    return error(500, "internal_error", "something went wrong");
  });
  app.notFound(() => error(404, "not_found", "no such route"));

  app.get("/health", () => Response.json({ ok: true }));
  app.get("/", () => html(installPage()));
  app.get("/manifest.json", () =>
    Response.json(manifest(deps.config.appUrl), {
      headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" },
    }),
  );
  app.get(
    PATHS.icon,
    () =>
      new Response(ICON_SVG, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
          "cross-origin-resource-policy": "cross-origin",
          "x-content-type-options": "nosniff",
        },
      }),
  );
  app.get(PATHS.privacy, () =>
    html(
      page(
        "Privacy",
        `<h1>Privacy</h1>
         <p>This app keeps, per Hypha store: the store's API address and IDs, the app's tokens
           and secret, your Stripe keys (encrypted), and which Hypha payment each Stripe
           PaymentIntent belongs to. With the <code>customer_data:email</code> scope it passes the
           buyer's email to Stripe for the receipt and keeps no copy. Uninstalling the app in
           Hypha deletes its tokens; ask the operator of <code>${escapeHtml(deps.config.appUrl)}</code>
           to delete the rest.</p>`,
      ),
    ),
  );

  // ---------- installing ----------
  app.get("/install", async (c) => {
    const api = c.req.query("api");
    if (!api) return html(installPage());
    try {
      return c.redirect(await startInstall(deps, api), 302);
    } catch (err) {
      if (err instanceof InstallError) return html(installPage(err.message), err.status);
      throw err;
    }
  });
  app.get(PATHS.callback, async (c) => {
    try {
      return html(installedPage(await finishInstall(deps, installations, c.req.url)));
    } catch (err) {
      if (err instanceof InstallError) return html(installPage(err.message), err.status);
      throw err;
    }
  });

  // ---------- Hypha calls the app ----------
  for (const path of [PATHS.start, PATHS.status, PATHS.capture, PATHS.void, PATHS.refund])
    app.all(path, (c) => payments(c.req.raw));
  app.post(PATHS.hyphaWebhooks, (c) => webhooks(c.req.raw));
  app.get(PATHS.paymentBlock, (c) => handleBlock(deps, installations, c.req.raw));

  // ---------- Stripe calls the app ----------
  app.post("/stripe/webhook/:store", async (c) => {
    const { status, outcome } = await handleStripeWebhook(
      deps,
      installations,
      c.req.param("store"),
      c.req.raw,
    );
    return Response.json(outcome, { status });
  });

  // ---------- the merchant's settings ----------
  app.get(PATHS.settingsPage, async (c) => {
    const { html: body, frameAncestors } = await settingsPage(deps, installations, c.req.raw);
    return html(body, 200, {
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors ${frameAncestors}`,
    });
  });
  app.get("/admin/settings.js", () => script(settingsScript, "no-cache"));

  const settingsRoute = async (
    method: string,
    caller: Awaited<ReturnType<typeof fromSessionToken>>,
    body: () => Promise<unknown>,
  ): Promise<Response> => {
    if (!caller) return error(401, "invalid_token", "a valid session token is required");
    const { installation, scopes } = caller;
    try {
      if (method === "GET") {
        if (!canRead(scopes)) return error(403, "forbidden", "needs payments:read");
        return Response.json(
          settingsView(deps, installation, await installations.settings(installation)),
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (!canWrite(scopes)) return error(403, "forbidden", "needs payments:write");
      let input: unknown;
      try {
        input = await body();
      } catch {
        return error(400, "malformed_json", "the body isn't JSON");
      }
      return Response.json(await updateSettings(deps, installations, installation, input));
    } catch (err) {
      if (err instanceof SettingsError)
        return Response.json(
          { code: err.code, error: err.message, ...(err.field ? { field: err.field } : {}) },
          { status: err.status },
        );
      throw err;
    }
  };
  app.on(["GET", "PUT"], "/api/settings", async (c) =>
    settingsRoute(c.req.method, await fromSessionToken(installations, c.req.raw), () =>
      c.req.json(),
    ),
  );
  app.on(["GET", "PUT"], `${PATHS.adminProxy}/settings`, async (c) => {
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    const caller = await fromProxy(installations, c.req.raw, raw);
    return settingsRoute(c.req.method, caller, async () =>
      JSON.parse(new TextDecoder().decode(raw)),
    );
  });

  // ---------- the storefront element ----------
  app.get(PATHS.element, (c) => {
    if (c.req.header("if-none-match") === `"${paymentElement.hash}"`)
      return new Response(null, { status: 304, headers: elementHeaders() });
    return script(paymentElement, "public, max-age=300", elementHeaders());
  });

  return app;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ code, error: message }, { status });
}

function elementHeaders(): Record<string, string> {
  // A public script any storefront may import (docs/apps/elements.md).
  return { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...headers,
    },
  });
}

function script(
  asset: { hash: string; code: string },
  cache: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(asset.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": cache,
      etag: `"${asset.hash}"`,
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
