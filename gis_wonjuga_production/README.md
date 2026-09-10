# GIS Wonjuga Sector Command Warfare Portal — v2.1 FINAL

Private member welfare/contribution portal for:

**GHANA IMMIGRATION SERVICE WONJUGA SECTOR COMMAND WARFARE**

Motto: **Friendship with Vigilance**

## What is included

- Private member and officer authentication
- Main Administrator + role-based officer accounts
- Member registration / activation-fee workflow
- Payment-first activation: activation fee is verified before Service Number assignment
- Self-activation after Service Number assignment
- GH₵100 default monthly contribution, configurable by Main Admin
- MTN MoMo, Telecel and AirtelTigo through Paystack server-side API
- Paystack webhook signature verification and transaction verification endpoint
- Bank transfer instructions and Finance reconciliation
- Monthly reconciliation report and CSV export
- Welfare claim submission, review and status tracking
- Announcements with publish/unpublish controls
- Member profile and password change
- Officer enable/disable and role management
- Audit log for administrative and payment events
- PostgreSQL database
- Docker deployment
- Responsive web UI and basic PWA shell
- Health endpoint: `/api/health`

## Important institutional setup

The software is complete. Only institution-owned configuration and live credentials remain before real-money/public deployment:

1. Approved activation fee.
2. Official bank name, account name, account number and branch.
3. Paystack merchant account and live secret key.
4. Public HTTPS domain for the portal and Paystack webhook.
5. Institution-approved official GIS logo asset. The UI deliberately uses a text emblem placeholder rather than fabricating or misrepresenting an official crest.
6. Final member list and Service Numbers.

Do not send passwords, database credentials or payment secret keys in chat. Put them in the server environment only.

## Local deployment with Docker

1. Install Docker Desktop.
2. Copy `.env.example` to `.env` and replace the required values. The compose file now reads the database password and secrets from `.env`.
3. Run:

```bash
docker compose up -d --build
```

5. Seed the Main Administrator. The easiest route is to run the seed command inside the app container after setting the same environment values:

```bash
docker compose exec app npm run seed
```

6. Open `http://localhost:8080`. On Windows you can use `START-WINDOWS.bat` for the same workflow.

## Non-Docker deployment

Requirements: Node.js 20+, PostgreSQL 16+.

```bash
npm install
npm run check
npm run seed
npm start
```

Create the database and apply `db/schema.sql` before running the seed command.

## Payment configuration

The member portal sends Mobile Money charges from the server. Paystack currently documents Ghana support for MTN (`mtn`), Telecel (`vod`) and AirtelTigo/ATMoney (`atl`). Mobile Money completion is asynchronous, so the portal accepts the provider webhook and also provides a verification route for a pending transaction.

Webhook URL after deployment:

`https://YOUR-DOMAIN/api/payments/paystack/webhook`

Configure that URL in the Paystack dashboard. Use the live secret key only on the server.

## Activation workflow

1. Applicant opens Member → Start Activation Payment.
2. Applicant selects Mobile Money or Bank Transfer.
3. Payment record is created.
4. Mobile Money is confirmed by provider webhook/verification; bank payment is reconciled by Finance.
5. `activation_paid` becomes true.
6. Main Admin or Member Manager assigns the Service Number.
7. Member uses Service Number + phone + new password to activate their portal account.
8. Member can then make the monthly GH₵100 contribution.

## Roles

- `MAIN_ADMIN`: full control.
- `FINANCE_OFFICER`: payments, bank reconciliation and reports.
- `WELFARE_OFFICER`: welfare claims and announcements.
- `MEMBER_MANAGER`: member records and activation/service-number management.
- `REPORT_VIEWER`: reports only.
- `MEMBER`: own dashboard, payments, welfare claims and profile.

## Production security checklist

- Use HTTPS only.
- Use a long random JWT secret (32+ characters; preferably much longer).
- Use a strong database password.
- Keep Paystack secret key server-side.
- Configure CORS to the exact portal origin if a separate frontend is introduced.
- Back up PostgreSQL regularly and test restoration.
- Restrict database network access; do not expose PostgreSQL publicly.
- Use a reverse proxy such as Nginx/Caddy/Cloudflare for TLS and rate limiting.
- Create named officer accounts; do not share the Main Admin password.
- Review the official GIS branding asset before public release.
- Run a real test-mode payment from each supported Mobile Money network before switching to live mode.

## Official reference

The official Ghana Immigration Service website lists Wonjuga Sector Command under the North East Region and publishes the Service's institutional information and emblem. Verify branding and institutional approval with the authorized command before public release.

Official GIS website: https://gis.gov.gh/

Official North East Region page: https://gis.gov.gh/north-east-region/
