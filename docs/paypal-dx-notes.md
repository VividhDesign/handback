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

## Non-PayPal note (AI provider), 10 Nov
- Gemini free tier is per model and small (gemini-2.5-flash: 20 requests/day, 5/min). A model fallback chain kept the demo working. Not a PayPal issue; recorded so the comparison with PayPal sandbox limits is fair (the PayPal sandbox had no such limits in our use).
