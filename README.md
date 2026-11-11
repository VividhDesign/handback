# Handback

**An AI return desk for small rental shops.** The deposit is a PayPal authorization hold. AI compares pickup and return photos. The deposit is released in seconds, or a human-approved, evidence-backed charge is captured.

> Sandbox demo. No real money moves. Live demo: https://handback-nvq9.onrender.com · Video: _added at submission_

## The problem

Small rental shops (cameras, tools, speakers, camping gear) take a deposit for every rental. Today that means either holding cash, or charging a card and refunding it later, and arguing about damage with no shared evidence. Customers wait days for their money; owners lose time on every return.

Handback turns the deposit into a PayPal **authorization hold**, photographs the item at pickup and at return, and settles the hold with **one final capture**: the rental fee only on a clean return, or the fee plus charges the owner approved, with the evidence shown to the customer.

### Three product rules

1. **AI may release money on its own. AI may never take money on its own.** Every charge needs the shop owner's click and shows its evidence to the customer.
2. **Deterministic checks first, AI where judgment is needed, a human when the AI is unsure.**
3. **Charges come from a visible rate card and live market prices, never from a guess.**

## How it uses PayPal

| API | What Handback does with it | Code |
|---|---|---|
| **PayPal JS SDK v6** (`web-sdk/v6/core`, `paypal-payments`, one-time payment session) | The rent page shows the PayPal button; the click creates the AUTHORIZE order on our server and opens PayPal. The redirect link stays as a fallback if the SDK cannot load | `client/src/components/PayPalButton.tsx`, `client/src/pages/Rent.tsx` |
| Orders v2: create with `intent: AUTHORIZE` | Booking creates one order for rental fee + deposit; the buyer approves it on PayPal | `server/paypal/orders.ts` |
| Orders v2: authorize | After approval the order is authorized: the money is held, nothing is charged | `server/paypal/orders.ts` |
| Payments v2: capture with `final_capture: true` | Settlement makes exactly one capture (fee, or fee + approved charges, never above the hold); PayPal releases the rest | `server/paypal/payments.ts`, `server/bookings.ts` (`settle`) |
| Payments v2: void | Cancel before pickup, or an expired demo hold: the whole hold is released | `server/paypal/payments.ts` |
| Payments v2: reauthorize | Called in the sandbox test run (`scripts/approval-session.ts`, branch D); PayPal answers `REAUTHORIZATION_TOO_SOON` inside the 3-day honor period. There is no in-app reauthorize button: a booking is at most 7 days, well inside the 29-day authorization | `server/paypal/payments.ts` |
| Payments v2: refund, via the **PayPal Agent Toolkit** `create_refund` tool | Contest resolution refunds part or all of the captured charges (never the rental fee). The agent recommends; the owner decides; code builds the tool call with a `PayPal-Request-Id`, so a retry returns the same refund | `server/paypal/toolkit.ts`, `server/agent/contest.ts` |
| Webhooks + signature verification | Every event is verified with `verify-webhook-signature`, stored once by event id, and shown in the live ledger | `server/paypal/webhooks.ts`, `server/sync.ts` |
| Invoicing via the **PayPal Agent Toolkit** (`@paypal/agent-toolkit`, tools `create_invoice` + `send_invoice`) | Approved charges above the hold: the agent drafts an invoice with the evidence link; it is sent only after the owner's click. The tool arguments are built by code from the approved amount, never by the model. One invoice per booking | `server/paypal/toolkit.ts`, `server/agent/invoice.ts` |
| `PayPal-Request-Id` | Every write call carries a stable request id, so a retry or double click never charges twice | `server/paypal/client.ts` |

Every PayPal id (order, authorization, capture, refund) and every `debug_id` on an error is shown in the UI.

## How it uses AI

- **Model:** Google Gemini (vision), chosen by env (`GEMINI_VISION_MODEL`, default `gemini-3.5-flash`). Free-tier quotas are per model and small, so a busy or exhausted model hands over to the next one in `GEMINI_FALLBACK_MODELS`; the model that answered is recorded with every inspection.
- **Call 1, pickup passport:** five pickup photos → JSON with existing marks (with boxes), accessories present, photo quality.
- **Call 2, return comparison:** pickup + return photos + the passport → JSON with new findings (type, severity, confidence, box), accessories, `same_item`, `cannot_determine`, `suspicious_text_in_photos`, and an overall verdict.
- Both responses are validated with zod (`server/ai/schemas.ts`). Photo text is treated as data; text aimed at the AI sends the return to a human.
- **Code decides, not the model** (`server/ai/decide.ts`): the deposit is released automatically only when the deterministic checks pass, the item is the same, every accessory is present, there are no new findings, and confidence is at least `AUTO_RELEASE_MIN_CONF`. Anything else goes to the owner.
- **Deterministic before AI** (`server/checks/`): all five angles present, photos taken after pickup, no pickup photo re-uploaded (SHA-256 and a 256-bit dHash), size and exposure, late return.
- **Prices** come from the rate card (`server/pricing/ratecard.ts`), shown to the customer before booking.
- **Human in the loop:** every finding is approved or waived by the owner before any money is captured.

## Schedule view (Bryntum Scheduler)

`/shop/schedule` shows each item as a row and each booking as a bar, coloured by payment state ([client/src/pages/Schedule.tsx](client/src/pages/Schedule.tsx)).

- A booking waiting for PayPal approval is dashed and counts down its approval window. It turns solid live, over server-sent events, when the authorization arrives.
- Clicking a booking adds two markers: the end of PayPal's honor period and the hold expiry.
- Dragging a held booking moves it, and dragging its end extends it. The server checks every change (`PATCH /api/shop/bookings/:id`, `moveBooking` in [server/bookings.ts](server/bookings.ts)): no overlap on the same item, the end must be before the hold expires, and the new rental fee must leave at least half the deposit covered by the existing hold. A rejected change snaps back and shows the reason. The PayPal hold itself is never changed by a move.
- Sample, pending, returned and settled bookings are read-only.

Bryntum Scheduler is used under its free trial package (`@bryntum/scheduler-trial`), so the view shows a trial watermark.

## Insights (AG Studio)

`/shop/insights` is a dashboard built with AG Studio ([client/src/pages/Insights.tsx](client/src/pages/Insights.tsx)). Its four data sources come from `GET /api/shop/insights` ([server/insights.ts](server/insights.ts)): bookings, AI findings, the PayPal payments ledger and item utilisation.

- Three Handback widgets: **Deposit release time** (median seconds from return check-in to settlement on PayPal, with a per-day trend), **Hold funnel** (authorized → released, charged, voided, refunded or still holding) and **AI vs owner** (share of AI findings the owner approved).
- Built-in widgets: booked days by item, PayPal amounts by call type, and a bookings grid.
- "Edit layout" lets you move, resize, remap or add widgets. The layout is saved in your browser; "Reset layout" restores the default.
- "Real sandbox runs only" hides the labelled sample rows. Every row carries a `run` column ("Sample" or "Sandbox run").

AG Studio runs without a licence key here, so it shows a trial watermark.

## Market prices (Channel3)

On Inventory, "Suggest price" asks Channel3 product search for the item ([server/pricing/channel3.ts](server/pricing/channel3.ts)). It takes the cheapest new, in-stock USD offer of each of the top 10 products and uses the median as the replacement value; the deposit suggestion is 25% of that, rounded to $5, between $20 and $500. The hint shows the number of offers, the price range, the search used and the time checked, and the owner reviews it before saving.

Missing accessories use the market median only when there are at least 3 offers and the median is within 0.5x to 1.5x of the shop's list price; otherwise the shop list price is used and the reason is shown. Quotes are cached for 24 hours. Without `CHANNEL3_API_KEY`, or if the call fails, Handback uses the stored prices and says so.

## Shop assistant

Every shop page has an "Ask the assistant" drawer ([server/agent/assistant.ts](server/agent/assistant.ts), [client/src/components/Assistant.tsx](client/src/components/Assistant.tsx)). It is Gemini function calling over two kinds of tools:

- **Our tools:** `find_bookings`, `get_booking`, `move_booking` (the same payment-aware check as a Schedule drag, logged with actor `agent`), `quote_accessory` (Channel3).
- **PayPal Agent Toolkit reads:** `get_order`, `list_transactions`, `list_disputes`, `get_merchant_insights`.
- **Money actions need a click:** `propose_refund` and `propose_invoice` only return a confirm card. Clicking Confirm runs the same code as the Desk buttons: the refund goes through the Agent Toolkit `create_refund` tool, bounded by the captured charges, and the invoice through `create_invoice` + `send_invoice`. The model never sets the amount that moves.

Limits: 30 messages per IP per day, and it counts toward the global daily AI cap. Without an AI key the drawer says so and the rest of the app works.

## Try it (judge path)

The `/judge` page in the app walks through this.

1. **No login (about 60 s):** open a real settled rental's evidence page from `/judge`, then run a dry-run inspection on the sample photos.
2. **With the sandbox buyer login (about 2 min):** Rent → pick an item → approve the hold on PayPal sandbox → Desk → pickup (sample photos) → return (clean) → watch the deposit release in the live ledger. Repeat with a damaged return and approve the charge as the owner.

The sandbox buyer login is in the Devpost testing field, not in this repo. The first load on the free hosting plan can take about a minute.

## Run locally

Prerequisites: Node 24+ (Node runs the server's TypeScript directly), a PayPal developer account with a **US** sandbox business account and a **US** sandbox personal account, and a Gemini API key.

```bash
npm install
cp .env.example ../secrets.env   # fill in the sandbox keys; the file lives outside the repo
npm run dev                      # API on :8787, UI on :5173
npm test                         # unit tests (vitest)
npm run typecheck
```

The server refuses to start unless `PAYPAL_ENV=sandbox`. Without PayPal keys the UI still runs and says so; without a Gemini key, inspections fall back to labelled cached results or manual review.

## Deploy to Render

`render.yaml` defines one Node web service (`npm ci && npm run build`, `npm start`, health check `/healthz`). In Render: New → Blueprint → pick this repo → paste the secret values marked `sync: false`. On the free plan the disk is ephemeral: the inventory and labelled sample history are seeded on boot.

## Architecture

```
Browser (React, Vite)                     Server (Node, Express, SQLite)
  Rent ─────────── POST /api/bookings ──▶ bookings.ts ──▶ PayPal Orders v2 (create, authorize)
  Desk ─ pickup/return photos ─────────▶ checks/ (deterministic) ──▶ ai/inspect.ts (Gemini) ──▶ ai/decide.ts
       ─ approve / waive / settle ──────▶ bookings.ts settle ──▶ PayPal Payments v2 (capture final / void)
  Evidence ◀── GET /api/evidence/:token         agent/contest.ts ──▶ refund
  Live ledger ◀── SSE /api/events/stream ◀── events table ◀── webhooks (verified, deduped)
```

Data model (SQLite, `server/schema.sql`): `items`, `accessories`, `bookings` (state machine in `server/lib/states.ts`), `payments`, `photos`, `inspections`, `findings`, `contests`, `events`, `webhook_events`, `settings`.

## Limitations

- Sandbox only. The server will not start in live mode.
- One shop and no login: the shop console is open so judges can use it. Production needs shop login and roles.
- AI can miss damage or over-report it. That is why every charge needs a human, and why the customer sees the evidence.
- How fast a released hold shows on a real card depends on the card issuer.
- A reauthorize success cannot be shown inside PayPal's 3-day honor period. The call is tested in the sandbox script only; the app has no reauthorize button or hold keeper.
- Free-tier AI limits apply. Cached AI results, sample history and dry runs are labelled in the UI.

## Production path

Shop login and roles; capture the rental fee at pickup; multi-shop onboarding; dispute handling; object storage for photos; a labelled evaluation set for the model.

## Built with AI

Built with Claude Code (Claude Opus 5.5) from a written plan; every PayPal call was checked against the PayPal developer docs. Notes on the PayPal developer experience are in [`docs/paypal-dx-notes.md`](docs/paypal-dx-notes.md).

## Licence

[MIT](LICENSE)
