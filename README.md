# Stripe for Hypha

Hypha's first-party Stripe app: card (and every other Payment Element method) payments
for any [Hypha](https://github.com/invocation97/Hypha) store, built on Hypha's public
app platform (design note 0029) like any third-party app. One TypeScript core on Web
APIs (Hono router) runs on **Cloudflare Workers** (D1) and on **Node** (SQLite), and one
instance can serve many Hypha stores.

What it does:

- **Installs over OAuth** (authorization code + PKCE; its client ID is its manifest URL,
  `<APP_URL>/manifest.json`), asking for `payments:write`, `orders:read` (reading orders
  and `GET /admin/payments/{id}`) and `customer_data:email` (for Stripe's receipt
  email). The token answer names the store and issuer, which key the installation;
  every signed call names the store in `Hypha-Store` (session tokens in `store`), which
  picks the secret its signature is checked with.
- **Answers `payments.start`** by creating a PaymentIntent through Stripe's REST API
  (plain `fetch`, form-encoded; idempotency key = Hypha's payment ID; amounts converted
  to Stripe's units, ISK/UGX ×100, three-decimal currencies in tens; `receipt_email`
  only when Hypha sent the buyer's email), returning
  `client_widget { element: "stripe-payment", props: { client_secret, publishable_key, return_url, payment_id } }`.
- **Answers `payments.capture`, `.void`, `.refund`** (Stripe's capture, cancel and
  refunds; Stripe's "no" becomes `refused` with its reason). Stripe's idempotency key is
  `<payment>:<point>:<Hypha's Idempotency-Key>`: Hypha's key is new per staff attempt
  (`<payment>:<action>:<uuid>`) and repeated on its retries, so a retried call replays
  what Stripe did and a second press isn't answered with the first one's refusal.
- **Receives Stripe's webhooks** at `/stripe/webhook/<store id>`, verified with the
  store's signing secret (HMAC-SHA256, five minutes' tolerance, constant time), handled
  once per event, and reports them to Hypha (`POST /admin/payments/{id}/events`,
  `Idempotency-Key` = Stripe's event ID): `payment_intent.succeeded` → `paid`,
  `.amount_capturable_updated` → `authorized`, `.canceled` → `voided`,
  `charge.refunded` → one `partially_refunded` per refund of the intent
  (`GET /v1/refunds?payment_intent=`, oldest first; failed and cancelled ones skipped),
  with that refund's amount and its `re_…` as the `reference` and in the key, the one
  completing a fully refunded charge `refunded`. Hypha counts a refund once by its ID,
  so the refunds it has already change nothing and two events, however they race,
  can't count one twice. Hypha's `failed` is
  final, so `.payment_failed` is reported only when the intent is over (`canceled`); a
  declined card leaves the intent waiting for another one, and the payment stays
  `pending` (the storefront's "Complete payment" starts it again under the same ID,
  which answers the same intent).
- **Hears Hypha's webhooks** (`order.cancelled`: it cancels the order's open intents;
  `app.uninstalled`: it forgets the tokens) through `@hypha/app`'s `webhookHandler`,
  the secret picked by `Hypha-Store`, each delivery handled once (`Hypha-Delivery-Id`);
  a failure answers 500 so Hypha retries.
- **Admin UI**: a settings page (`settings.app`, in the admin's iframe, using
  `@hypha/app-bridge` for session tokens; the admin's `?origin=` is trusted only when
  it's one of the store's admin origins, `GET /admin/app-extensions/origins`, read at
  install and again, at most every five minutes, for one not known yet), the same settings through Hypha's admin
  proxy (`/admin/apps/app_stripe/proxy/settings`), a block on `order.payment` (Stripe's
  status, amounts, a dashboard link, capture/void/refund buttons) and actions on
  `payment` through the payment points.
- **Storefront element** `<stripe-payment>` for `checkout.payment`
  (`/elements/payment.js`): loads Stripe.js from js.stripe.com, mounts the Payment
  Element (themed from `--hypha-*` custom properties), confirms with
  `redirect: "if_required"` and emits `hypha:payment-confirmed { paymentId }` or
  `hypha:error { message }` (docs/apps/elements.md in Hypha).

Secrets (the Stripe keys, the webhook signing secret, Hypha's app secret and tokens) are
encrypted at rest with AES-256-GCM under `APP_ENCRYPTION_KEY`, each bound to its
installation and field, and are write-only in the UI and API.

## Configuration

| Variable | | |
| --- | --- | --- |
| `APP_URL` | required | The app's public base URL (`https://…`; `http://localhost` in development). Its manifest is `<APP_URL>/manifest.json`. Never change it once stores installed the app: it's their OAuth client ID. |
| `APP_ENCRYPTION_KEY` | required, secret | 64 hex characters (`openssl rand -hex 32`). Losing it loses every stored secret (merchants re-enter keys, stores reinstall). |
| `HYPHA_API_ALLOWLIST` | optional | Comma-separated Hypha API origins allowed to install this instance; empty for any. |
| `STRIPE_API_BASE` | optional | Stripe's API base (default `https://api.stripe.com`); the tests point it at a fake. |
| `DATABASE_PATH` | Node only | SQLite file (default `stripe-app.sqlite`; `/data/stripe-app.sqlite` in Docker). |
| `PORT`, `HOST` | Node only | Default `3000`, `0.0.0.0`. |

On Workers the database is the D1 binding `DB`; the schema is created on an isolate's
first request (`CREATE TABLE IF NOT EXISTS`), on Node at start.

## Deploy on Cloudflare Workers

```bash
pnpm install
cp wrangler.example.toml wrangler.toml         # set APP_URL; wrangler.toml is git-ignored
pnpm exec wrangler d1 create hypha-app-stripe  # paste the database_id into wrangler.toml
pnpm exec wrangler secret put APP_ENCRYPTION_KEY
pnpm deploy:worker
```

`pnpm dev:worker` runs it locally (`wrangler dev`, with a local D1; put
`APP_ENCRYPTION_KEY` in `.dev.vars`). The core uses Web APIs only, so no
`nodejs_compat` flag is needed.

## Deploy on Node (Docker)

```bash
pnpm install && pnpm build:node   # bundles the server, Hypha's SDK included, into dist/server.js
docker build -t hypha-app-stripe .
docker run -d -p 3000:3000 -v stripe-data:/data \
  -e APP_URL=https://stripe.apps.example.com \
  -e APP_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  hypha-app-stripe
```

Put it behind TLS (Caddy, a load balancer). Without Docker: `pnpm start` runs
`src/entry/node.ts` directly (Node ≥ 24 runs the TypeScript as is; SQLite is Node's
built-in `node:sqlite`).

## Installing into a Hypha store

1. **Install:** open `<APP_URL>/install?api=<your Hypha API's base URL>` (or the app's
   home page and type the URL). This is the convention any admin's "Install app" button
   uses. The app starts OAuth (PKCE verifier kept server side, keyed by `state`) and
   sends you to Hypha's `/oauth/authorize`; Hypha checks the manifest and shows its
   admin's consent page (scopes, and the email scope apart with its reason). Approve as
   a staff member with `apps:write` and every scope asked for. Hypha sends you back to
   `<APP_URL>/oauth/callback`, which trades the code for tokens and the app secret
   (a Hypha whose token answer lacks `store` and `issuer` is too old: the page says so).
   The Hypha API must reach the app (`HYPHA_ALLOW_PRIVATE_CALLBACKS=true` for a
   localhost app in development).
2. **Settings** (Settings → Stripe in the admin, or the admin proxy): the secret key
   (`sk_…` or a restricted `rk_…`), the publishable key, and the capture mode
   (automatic, or manual: authorize now, staff capture later). The page shows the
   store's webhook URL, `<APP_URL>/stripe/webhook/<store id>`.
3. **Stripe's webhook:** in Stripe's dashboard (Developers → Webhooks) add that URL with
   the events `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`,
   `payment_intent.payment_failed`, `payment_intent.canceled` and `charge.refunded`,
   then paste its signing secret (`whsec_…`) into the settings.
4. **A payment method:** `POST /admin/payment-methods {"provider": "app_stripe", "name": "Card"}`
   (or in the admin). The storefront mounts `<stripe-payment>` with the props
   `payments.start` answered, and shows the confirmation on `hypha:payment-confirmed`;
   the order turns paid when Stripe's webhook arrives and the app reports it.

Uninstalling in Hypha revokes the tokens and sends `app.uninstalled`, on which the app
forgets them.

## Development

The Hypha SDK packages (`@hypha/app`, `@hypha/app-bridge`, `@hypha/app-blocks`,
`@hypha/storefront-elements`) are linked from a sibling Hypha checkout
(`link:../hypha/packages/…`), so clone Hypha next to this repository and run
`pnpm install` there first. **They'll move to a registry**; the links become versions
then. CI checks Hypha out beside this repository with the secret `HYPHA_REPO_TOKEN`
(read access to invocation97/Hypha) and the variable `HYPHA_REF` (the branch carrying
the SDK, while it isn't on `main`); without the secret it skips.

```bash
pnpm typecheck
pnpm lint          # Oxlint through Vite+, configured like Hypha's (vite.config.ts)
pnpm fmt           # Oxfmt; fmt:check in CI
pnpm build         # bundles src/browser/* into src/generated/assets.ts (committed; build:check in CI)
pnpm test          # node:test: signatures (Hypha's via the SDK, Stripe's with a test vector),
                   # encryption, OAuth against a fake Hypha, payment points and webhooks
                   # against a fake Stripe, settings, the block, the element in happy-dom
pnpm e2e           # against a real local Hypha (below)
```

### End to end

`pnpm e2e` (`scripts/e2e.ts`) runs a copy of Hypha's API binary
(`HYPHA_BIN`, default `../hypha/target/debug/hypha-host-axum`; it doesn't build Rust)
on a free port over a fresh Postgres database (created and dropped through
`docker exec hypha-postgres-1 psql`: start Hypha's `docker compose up -d` first;
`E2E_PG_CONTAINER` or `E2E_ADMIN_DATABASE_URL` to change that), the app in-process
over a temporary SQLite file, and a fake Stripe. It installs the app through
authorize → the owner's approval (`POST /admin/oauth/requests/{id}/approve`) → token,
saves the settings with a session token, places an order through the storefront API,
checks that `payments.start` answered the element with the intent's client secret,
delivers a signed `payment_intent.succeeded` and checks the order is paid, then a
staff refund and `charge.refunded` (partially refunded), a second refund under Hypha's
per-attempt key, a second `charge.refunded` and the first one again under a new event ID
(each refund counted once), `GET /admin/payments/{id}`, a declined card (nothing reported, the
payment stays pending), a cancelled order (Hypha's signed `order.cancelled` makes the
app cancel the intent), the settings page's `?origin=`, the block, discovery and the
element module.

With `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_PUBLISHABLE_KEY` set, it uses Stripe's
test mode instead of the fake (the intent is confirmed with `pm_card_visa`); Stripe's
webhook is still simulated from the intent's real state, since Stripe can't reach
localhost.

## Layout

```
src/
  app.ts               the routes (Hono)
  config.ts            environment, dependencies
  manifest.ts          the manifest and the paths it registers
  oauth.ts             /install and /oauth/callback
  installations.ts     a call's installation by store, secrets, the Hypha client (its
                       TokenStore's withLock: refreshes under a lock in storage)
  hypha-api.ts         reading payments and orders through the typed admin client
  payments.ts          payments.start / capture / void / refund
  stripe-webhooks.ts   Stripe's webhooks → Hypha's payment events
  hypha-webhooks.ts    Hypha's webhooks through webhookHandler (order.cancelled, app.uninstalled)
  block.ts             the order.payment block
  settings.ts          the settings API and page
  crypto.ts            AES-GCM sealing
  stripe/              the REST client, signatures, amounts
  storage/             the storage interface; SQL shared by D1 and SQLite
  browser/             the element and the settings page's script (bundled)
  generated/assets.ts  their bundles
  entry/worker.ts      the Worker
  entry/node.ts        the Node server
```

## License

MIT or Apache-2.0, at your option, like Hypha.
