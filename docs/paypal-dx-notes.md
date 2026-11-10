# PayPal developer-experience notes

Kept while building Handback. Each entry: what we needed, where the answer came from, how good the answer was, and the time it saved or cost.

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 1 | Can one authorization be captured once with the fee plus charges, and the rest released automatically? | PayPal docs: Payments v2 capture authorized payment (`final_capture`) | Clear: `final_capture: true` closes the authorization and releases the remainder | Saved: no separate void call after a partial capture |
| 2 | How to make capture retries safe | PayPal docs: idempotency (`PayPal-Request-Id`) | Clear; the same request id returns the original result | Saved: idempotent settle without our own locking at PayPal's side |
| 3 | How to verify a webhook | PayPal docs: `POST /v1/notifications/verify-webhook-signature` | Works only with the raw, unmodified body and the webhook id; simulator events do not verify | Cost: the body must be read raw before any JSON parser |

Sandbox runs (approval-session results) are added below as they happen.

## Approval session S1, 10 Nov (sandbox, US buyer, $52.00 holds)
`scripts/approval-session.ts` created 10 AUTHORIZE orders; the user approved them in the browser. All branches passed:

| Branch | Result | What PayPal answered |
|---|---|---|
| A release | PASS | final capture of the fee `COMPLETED`; authorization `CAPTURED`; a second capture → 422 `AUTHORIZATION_ALREADY_CAPTURED` |
| B void | PASS | capture of hold + $100 → 422 `MAX_CAPTURE_AMOUNT_EXCEEDED`; void → 200 (not 204, because we send `Prefer: return=representation`); status `VOIDED`; capture after void → 422 `AUTHORIZATION_VOIDED` |
| C charge | PASS | final capture of fee + charge `COMPLETED`; replaying the same `PayPal-Request-Id` returned the same capture id; $5 partial refund `COMPLETED`; capture `PARTIALLY_REFUNDED` |
| D reauthorize | PASS | reauthorize right after authorize → 422 `REAUTHORIZATION_TOO_SOON` (the 3-day honor period); void afterwards worked |
| P pool | PASS | 6 extra holds authorized, valid 29 days, kept for UI tests |

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 4 | Does void return 204? | Sandbox run | Returns 200 with the body when `Prefer: return=representation` is sent; docs show 204 for the minimal form | Small: accept both |
| 5 | Can the capture exceed the authorized amount? | Sandbox run | Over-capture far above the hold is refused with a clear issue code | Saved: our cap in code is a second guard, not the only one |
| 6 | Logging in to checkout as the seller | Sandbox run | Clear page: "You are logging into the account of the seller"; the buyer must be the Personal sandbox account | Cost: one retry |
| 7 | Network blips while polling an order | Our script | A 5xx or fetch failure while waiting for approval must be retried, not treated as failure | Cost: a resume mode (`--resume`) |

## Agent Toolkit and hosted webhooks, 10 Nov

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 8 | Which Agent Toolkit entry point fits a server that must not let a model choose amounts? | `@paypal/agent-toolkit` 1.11.0 package exports | The `./openai` export has `handleToolCall`, which runs one named tool with JSON arguments; no model or AI SDK is needed at call time. Its own deps (ai, zod 3) install nested, no clash with ours | Saved: deterministic tool calls with the official toolkit |
| 9 | What do `create_invoice` / `send_invoice` return? | Sandbox run | Links, not objects: create gives `{rel:"self", href:".../invoices/INV2-..."}`, send gives the payer-view link. The invoice id has to be parsed from the link | Small: one regex |
| 10 | How does the toolkit report errors? | Sandbox run | No throw: the tool result is `{ok:false, status, code, message}`. We turn it into an error ourselves | Small |
| 11 | Authorize / capture / void in the toolkit? | Package tool list | Not there. With every action turned on, 1.11.0 lists invoices, products, subscriptions, shipment tracking, orders (`create_order`, `get_order`, `pay_order`), disputes and transactions, so the hold lifecycle stays direct REST | None |
| 12 | Do webhooks reach the hosted app? | Hosted run on Render | Yes: after voiding a pooled hold, `PAYMENT.AUTHORIZATION.VOIDED` arrived and passed `verify-webhook-signature`. The free instance restarts with an empty DB, so older events drop out of our ledger (PayPal still has them) | Note: a restart loses ledger history, not money state |

| 13 | Does the toolkit's `create_refund` send `PayPal-Request-Id`? | Package source (`getHeaders`) | Only from `context.request_id`, which is fixed per toolkit instance; tool arguments cannot carry it. We create one toolkit instance per refund with its own request id | Cost: easy to miss; without it a retry could refund twice |
| 14 | Same request id, two refund calls | Sandbox run | One after the other: the same refund id comes back. At the same moment: the second gets 409 "A previous request on this resource is currently in progress". Both are safe; we show the 409 as "already being processed" | Saved: no locking of our own needed at PayPal's side |
| 15 | Is `page_size` on the event list limited? | Sandbox run | Yes, at most 100 (400 above it); the docs page lists only the default (10) | Small |
| 16 | Can the event list rebuild our ledger after a restart? | Sandbox + hosted run | Yes: `GET /v1/notifications/webhooks-events` with `start_time`/`end_time` returned all 27 events of S1 with their resources. The hosted app restores them on boot, labeled "restored" | Saved: no paid disk needed for the ledger |

Sandbox invoice test: two parallel "send" clicks gave one sent invoice and one 409; a later call returned the same invoice.

## JS SDK v6, 11 Nov

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 17 | Does v6 need a server-made client token? | v6 docs (one-time payments page) | No: `createInstance({ clientId, components: ["paypal-payments"] })` works with the public client id, so no extra server endpoint | Saved: one endpoint |
| 18 | How does the click wait for our server order? | v6 docs | Start the order call inside the click without awaiting it and pass the promise to `session.start({ presentationMode: "auto" }, promise)`; awaiting first can get the popup blocked. Clear in the docs | Small |
| 19 | Does v6 work with `intent: AUTHORIZE` orders? | Local run | Yes. The SDK only needs the order id; intent is set by our server. Eligibility check and `<paypal-button>` rendered on first try (SDK 6.72.0). In session S2 a sandbox buyer approved through the popup, `onApprove` fired and our server authorized the hold | None |

## Approval session S2, 11 Nov (local UI, sandbox, $48.00 holds)

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 20 | What happens if a `PayPal-Request-Id` repeats after the database is reset? | Sandbox run | PayPal returned the order from the earlier run (same id, old amount), as idempotency promises. Our ids used only the booking code, which restarts at HB-1 in a new database. Fix: the key now includes part of the booking's random token | Cost: about 20 min to spot |
| 21 | Do a clean return, a charged return, a contest refund and a cancel all settle as expected? | Sandbox run, checked with GET on each id | Clean: $8 captured with `final_capture`, authorization CAPTURED, $40 released. Charged: $17 captured. Contest: $5 refunded through Agent Toolkit `create_refund`, capture PARTIALLY_REFUNDED. Cancel: authorization VOIDED | None |

Testing note: the built-in browser of our coding tool blocks popups that an automated click opens, so the popup was approved by hand in a normal browser.

## Non-PayPal note (AI provider), 10 Nov
- Gemini free tier is per model and small (gemini-2.5-flash: 20 requests/day, 5/min). A model fallback chain kept the demo working. Not a PayPal issue; recorded so the comparison with PayPal sandbox limits is fair (the PayPal sandbox had no such limits in our use).
