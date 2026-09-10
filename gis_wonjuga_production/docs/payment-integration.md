# Payment integration runbook

## Supported Ghana Mobile Money channels

The portal maps:

- MTN MoMo → Paystack provider `mtn`
- Telecel → Paystack provider `vod`
- AirtelTigo / ATMoney → Paystack provider `atl`

## Flow

1. Portal creates a local `payments` row with `PENDING` status.
2. Server calls Paystack Charge API.
3. Paystack returns a provider reference and a status such as `pay_offline`.
4. Member authorizes the request on the phone.
5. Paystack sends `charge.success` to `/api/payments/paystack/webhook`.
6. Server verifies the `x-paystack-signature` HMAC SHA-512 signature using the Paystack secret key.
7. Server marks the local payment `SUCCESS` and, for activation payments, sets `members.activation_paid=true`.
8. A member can also use the portal's Check button, which calls Paystack Verify Transaction for a pending provider reference.

## Webhook

Production webhook:

`https://YOUR-DOMAIN/api/payments/paystack/webhook`

The webhook must be publicly reachable over HTTPS. Never expose the Paystack secret key in browser JavaScript.

## Bank transfer

Bank payments are intentionally manual/reconciled. Main Admin or Finance Officer selects the member, enters the exact configured amount and unique bank reference, and the system records the transaction as `RECONCILED`.

For activation bank payments, reconciliation also sets `activation_paid=true`, after which an authorized administrator can assign the Service Number.

## Test before live mode

Test each network separately, confirm the webhook is received, confirm the payment appears in the admin transaction list, and confirm the monthly report changes from NOT PAID to PAID. Only then switch the Paystack integration to live credentials.
