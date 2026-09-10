# Go-live checklist

## Institution
- [ ] Authorized command approves the portal name and branding.
- [ ] Approved official GIS logo asset supplied.
- [ ] Activation fee approved and entered by Main Admin.
- [ ] Monthly welfare contribution confirmed as GH₵100 or changed by authorized decision.
- [ ] Bank account details confirmed.
- [ ] Initial member roster and Service Numbers verified.

## Infrastructure
- [ ] Production PostgreSQL created.
- [ ] Strong DB password configured.
- [ ] JWT secret generated and stored as a server secret.
- [ ] HTTPS certificate active.
- [ ] Domain points to the application/reverse proxy.
- [ ] Database is not publicly exposed.
- [ ] Automated backups enabled and restoration tested.

## Payments
- [ ] Paystack business account approved for the institution's intended use.
- [ ] Test-mode MTN MoMo transaction completed.
- [ ] Test-mode Telecel transaction completed.
- [ ] Test-mode AirtelTigo transaction completed.
- [ ] Webhook receives `charge.success` and validates the signature.
- [ ] Verification endpoint works for a pending transaction.
- [ ] Live key added only after test sign-off.

## Access control
- [ ] Main Admin password changed from initial seed password.
- [ ] Individual officer accounts created.
- [ ] Least-privilege roles reviewed.
- [ ] No shared officer credentials.
- [ ] Password-change flow tested.

## Operations
- [ ] Bank reconciliation tested.
- [ ] Monthly CSV report tested.
- [ ] Welfare claim workflow tested.
- [ ] Announcement publishing tested.
- [ ] Audit log reviewed.
- [ ] Member activation workflow tested end-to-end.
