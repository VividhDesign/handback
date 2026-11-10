# PayPal developer-experience notes

Kept while building Handback. Each entry: what we needed, where the answer came from, how good the answer was, and the time it saved or cost.

| # | Question | Source | Answer quality | Time |
|---|---|---|---|---|
| 1 | Can one authorization be captured once with the fee plus charges, and the rest released automatically? | PayPal docs: Payments v2 capture authorized payment (`final_capture`) | Clear: `final_capture: true` closes the authorization and releases the remainder | Saved: no separate void call after a partial capture |
| 2 | How to make capture retries safe | PayPal docs: idempotency (`PayPal-Request-Id`) | Clear; the same request id returns the original result | Saved: idempotent settle without our own locking at PayPal's side |
| 3 | How to verify a webhook | PayPal docs: `POST /v1/notifications/verify-webhook-signature` | Works only with the raw, unmodified body and the webhook id; simulator events do not verify | Cost: the body must be read raw before any JSON parser |

Sandbox runs (approval-session results) are added below as they happen.

## Non-PayPal note (AI provider), 10 Nov
- Gemini free tier is per model and small (gemini-2.5-flash: 20 requests/day, 5/min). A model fallback chain kept the demo working. Not a PayPal issue; recorded so the comparison with PayPal sandbox limits is fair (the PayPal sandbox had no such limits in our use).
