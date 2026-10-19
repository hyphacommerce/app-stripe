// The settings page's script, in the admin's iframe: a session token from the bridge
// (docs/apps/bridge.md) authenticates each call to the app's own `/api/settings`.
// Bundled by scripts/build-assets.ts into src/generated/assets.ts.

import { type Bridge, createBridge } from "@hypha/app-bridge";

interface View {
  store: string | null;
  webhook_url: string | null;
  mode: "test" | "live" | null;
  secret_key: { set: boolean; last4: string | null };
  publishable_key: string | null;
  webhook_secret: { set: boolean };
  capture_mode: "automatic" | "manual";
  webhook_events: string[];
}

/** The page's element with this ID, of this kind (the server rendered them all). */
function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`the page lacks #${id}`);
  return element;
}

function field<T extends HTMLElement>(name: string, kind: new () => T): T {
  const element = form.elements.namedItem(name);
  if (!(element instanceof kind)) throw new Error(`the form lacks ${name}`);
  return element;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const root = byId("app", HTMLElement);
const status = byId("status", HTMLElement);
const form = byId("settings", HTMLFormElement);
const message = byId("message", HTMLElement);

function hostOrigin(): string | null {
  const given = root.dataset.hostOrigin;
  if (given) return given;
  // Not named by the server: the referrer's origin, if it's an installed store's admin.
  const parsed: unknown = JSON.parse(root.dataset.knownOrigins ?? "[]");
  const known = Array.isArray(parsed) ? parsed.filter((o) => typeof o === "string") : [];
  try {
    const origin = document.referrer ? new URL(document.referrer).origin : "";
    return known.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

function show(view: View) {
  field("publishable_key", HTMLInputElement).value = view.publishable_key ?? "";
  field("capture_mode", HTMLSelectElement).value = view.capture_mode;
  field("secret_key", HTMLInputElement).value = "";
  field("webhook_secret", HTMLInputElement).value = "";
  byId("secret-key-hint", HTMLElement).textContent = view.secret_key.set
    ? `set, ending ${view.secret_key.last4 ?? "…"} (${view.mode ?? "?"} mode)`
    : "not set";
  byId("webhook-secret-hint", HTMLElement).textContent = view.webhook_secret.set
    ? "set"
    : "not set";
  const webhook = byId("webhook", HTMLElement);
  webhook.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "Stripe webhook endpoint";
  const url = document.createElement("p");
  const code = document.createElement("code");
  code.textContent = view.webhook_url ?? "(known after the store's first call)";
  url.append(code);
  const events = document.createElement("p");
  events.className = "hint";
  events.textContent = `Add it in Stripe's dashboard (Developers → Webhooks) with the events ${view.webhook_events.join(", ")}, then paste its signing secret below.`;
  webhook.append(title, url, events);
  status.hidden = true;
  form.hidden = false;
}

async function call(bridge: Bridge, method: "GET" | "PUT", body?: unknown): Promise<View> {
  const token = await bridge.getSessionToken();
  const init: RequestInit =
    body === undefined
      ? { method, headers: { authorization: `Bearer ${token}` } }
      : {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch("/api/settings", init);
  const answer: unknown = await response.json();
  if (!response.ok) {
    const reason =
      typeof answer === "object" && answer !== null && "error" in answer
        ? String(answer.error)
        : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  // The app's own API, whose answer `settingsView` builds.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own server's shape
  return answer as View;
}

async function main() {
  const origin = hostOrigin();
  if (!origin) {
    status.textContent = "Open this page from your Hypha admin (Settings → Stripe).";
    return;
  }
  const bridge = createBridge({ hostOrigin: origin, autoResize: true });
  try {
    show(await call(bridge, "GET"));
  } catch (error) {
    status.textContent = `Couldn't load the settings: ${String(error)}`;
    return;
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const update: Record<string, string> = {
      publishable_key: formText(data, "publishable_key"),
      capture_mode: formText(data, "capture_mode") || "automatic",
    };
    // Empty secret fields keep what's stored: they're write-only.
    for (const name of ["secret_key", "webhook_secret"]) {
      const value = formText(data, name).trim();
      if (value) update[name] = value;
    }
    const button = form.querySelector("button");
    if (!button) return;
    button.disabled = true;
    message.textContent = "";
    call(bridge, "PUT", update)
      .then(async (view) => {
        show(view);
        message.className = "ok";
        message.textContent = "Saved.";
        await bridge.toast("Stripe settings saved", { tone: "success" }).catch(() => undefined);
        return undefined;
      })
      .catch((error: unknown) => {
        message.className = "error";
        message.textContent = String(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

void main();
