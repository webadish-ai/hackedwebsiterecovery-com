# Assisted Recovery Storefront and Portal Plan

## Summary

Extend the existing Astro 6 SSR site on `hackedwebsiterecovery.com` into an India-focused service storefront. Customers choose a package, see GST and the final amount, pay through PayU, submit website access securely, and track the recovery. WebAdish staff perform recovery manually and update each case through an operator portal.

Keep all existing high-intent landing pages and permanent redirects. Do not automate malware deletion or database repair in this release, and do not promise a completion time before assessment.

### Confirmed launch offers

| Offer | Price before GST | Billing | Coverage |
| --- | ---: | --- | --- |
| Recovery | ₹7,999 | One time | One standard WordPress incident, pre-change snapshot, cleanup/hardening report, 30-day follow-up |
| Recovery + Care | ₹14,999 | Annual, paid upfront | Initial standard cleanup, monitoring, one additional standard incident in the term, 30-day follow-up per cleanup |
| Agency Care | ₹4,999 | Monthly PayU mandate | Up to 10 sites, portfolio monitoring and reports; recovery bought separately |

Show GST separately before payment. Multisite, hosting-account compromise, cross-site infection, missing-data restoration, custom applications, and complex WooCommerce cases require a separate quote. For unsupported paid work that has not started, offer a separately approved quote or a full refund.

Start the four-hour, 24/7 first-response deadline only after payment is confirmed and usable access is received. Completion time is estimated after assessment.

## Existing implementation and required architecture

- Preserve the Astro 6 App/SSR architecture, `@astrojs/vercel`, Tailwind 3, Resend, existing SEO pages, sitemap, server API routes, and `vercel.json` redirects/security headers.
- Refactor the current pricing component from USD lead-generation prices to the three versioned INR products above. Preserve other recovery services as informational landing pages that route into product selection or request-a-quote.
- Add interactive islands only where needed for cart, checkout, authentication, onboarding, case tracking, and staff tools. Keep marketing pages server-rendered and fast.
- Use Supabase Postgres, Auth, and private Storage. Customers use email magic links. Staff use TOTP MFA. Enable Row Level Security on every exposed table and private-storage policy.
- Use PayU Hosted Checkout. Recovery is one-time. Agency Care uses monthly standing instructions after mandate confirmation. Recovery + Care is paid upfront and renewed through an authenticated pay-to-renew checkout because its total with GST can exceed some automatic-debit limits.
- Keep payment, database, service-role, and encryption secrets server-only. Error monitoring and analytics must redact form bodies, credentials, billing details, authorization headers, cookies, and PayU secret material.

## Customer experience

1. Pricing cards present one primary action per offer, exact inclusions/exclusions, site limits, billing frequency, price before GST, and a clear refund/quote rule.
2. Checkout collects email, phone, billing name, company/GSTIN if applicable, website URL, symptoms, plan/quantity, and acceptance of versioned terms/privacy/refund policies.
3. The server calculates subtotal and GST in paise, creates a pending order with a unique PayU transaction ID, and sends the customer to hosted checkout. Client totals are never trusted.
4. The return page says payment is being confirmed until reverse-hash validation and the PayU Verify Payment API confirm transaction ID, amount, and status. A browser redirect never starts fulfilment.
5. After confirmation, send a receipt and magic-link portal invitation. Recovery purchases open the secure access checklist. Agency Care opens portfolio onboarding.
6. The customer dashboard shows orders, sites, subscription/renewal state, required actions, and cases with these states: `awaiting_payment`, `awaiting_access`, `triage`, `awaiting_approval`, `in_progress`, `verification`, `monitoring`, `completed`, `quoted_separately`, `refunded`, `cancelled`.
7. The timeline contains customer-safe updates. Quotes require explicit acceptance. Completion includes findings, work performed, remaining risks, a password-rotation checklist, report download, and follow-up dates.

## Secure access workflow

- Collect structured temporary access for WordPress admin, hosting panel, SFTP/SSH, database, CDN/DNS, and optional hosting support PIN. Every access type can be marked unavailable.
- Encrypt each credential payload server-side with AES-256-GCM using a random per-record nonce, authentication tag, and key-version metadata. The 32-byte production master key lives only in Vercel secrets and never reaches the browser.
- Credentials never appear in URLs, logs, analytics, email, notifications, case events, error payloads, or attachments.
- Customer can replace or revoke access. Delete ciphertext seven days after case completion and retain only non-secret audit metadata.
- Staff reveal requires staff role, case assignment, recent MFA assurance, explicit reason, short-lived display, and an append-only audit event.
- Use a private Supabase Storage bucket for host reports and final reports with ownership RLS, type/size allowlists, short-lived signed downloads, retention, and a scan/quarantine state.

## Staff operations

- Queue paid/access-ready cases by response deadline; show missing-customer-action cases separately.
- Assign an operator, request missing access, write separate internal/customer updates, classify scope, issue a quote, move through valid states, upload the report, and close the case.
- Admin-only operations: staff roles, plan version activation, refunds, subscription overrides, and audit log access.
- Refund actions require confirmation and store the PayU/external refund reference. No surprise charges or automatic quote acceptance.

## Data model and server interfaces

Create migrations and generated types for:

- `profiles`, `organizations`, `organization_members`
- `plans`, `orders`, `order_items`, `payments`, `subscriptions`
- `sites`, `cases`, `case_events`, `quotes`
- `credential_sets`, `attachments`, `webhook_events`, `audit_logs`

Orders store an immutable plan/price/GST/terms snapshot. Provider transaction IDs and webhook fingerprints are unique for idempotency. Case events and audit logs are append-only; neither may contain secrets.

Required endpoints/actions:

- `POST /api/checkout`: validate plan and input, calculate price/GST, create pending order, return signed PayU hosted-checkout fields.
- `POST /api/payments/payu/return`: validate reverse hash, record provisional status, request PayU verification, redirect to order status.
- `POST /api/payments/payu/webhook`: validate, deduplicate, verify with PayU, compare transaction/amount, and transition payment/order atomically.
- Scheduled reconciliation: retry pending/in-progress transactions and flag mismatches.
- Credential submit/revoke/reveal actions: enforce tenancy, assignment, MFA, encryption, retention, and audit rules.
- Subscription jobs: confirm mandate registration, persist `mihpayid`/`authpayuid`, check mandate state, send required pre-debit notification, execute recurring charge, reconcile pending results, apply a defined grace period, and revoke mandate on cancellation.

Before live subscriptions, confirm with PayU whether this account uses standard standing-instruction APIs or Zion, supported methods and limits, webhook configuration, pre-debit timing, mandate-revoke APIs, refund access, and GST invoice responsibilities.

## Implementation sequence

### Milestone 1 — Storefront foundation and mocked purchase

1. Add `lint`, `typecheck`, unit-test, browser-test, and build scripts around the existing Astro project. Add environment validation and a test-safe mocked payment adapter.
2. Centralize versioned plan definitions, paise/GST calculations, quantities, inclusions, exclusions, and site allowances. Replace the current USD pricing grid with the three shopping-style product cards.
3. Build product-detail/compare, cart/order-summary, checkout, simulated payment-confirmation, and simulated paid-order/onboarding pages. All transactional/portal pages are `noindex`.
4. Add privacy, terms, refund, service-scope, and emergency-support pages/links needed at checkout. Preserve all existing SEO pages and redirects.
5. Add privacy-safe events: `view_plan`, `select_plan`, `begin_checkout`, `payment_confirmed`, `onboarding_started`, `credentials_completed`. Never attach a submitted URL or form value.

Exit criteria: all three offers can be selected; server calculations produce exact GST-inclusive totals; a mocked checkout reaches a simulated paid order; existing landing pages and API routes still build; no live PayU/Supabase calls or credential fields exist.

### Milestone 2 — Identity, tenancy, and manual case workflow

Add Supabase migrations/types, RLS tests, magic-link customers, MFA staff, organizations/agencies, order/site/case state machines, queue/assignment, response-deadline calculation, timeline, notifications, attachments, and reports.

Exit criteria: tenant isolation is proven at route and RLS layers; simulated paid orders can be completed by staff; each transition is authorized and audited.

### Milestone 3 — Secure credentials

Add encryption/key-versioning, credential submission/replacement/revoke/retention, assigned-staff recent-MFA reveal, attachment quarantine, redaction, rate limiting, and audit trails. Perform security review for IDOR/RLS bypass, CSRF, XSS, SSRF through site URLs, upload attacks, key/log leakage, and brute force.

Exit criteria: only the owner and authorized assigned staff can operate on a credential; plaintext never appears in persisted/logged/emailed data; ciphertext tampering fails; expiry deletion is idempotent.

### Milestone 4 — PayU and billing

Implement hosted checkout, hash/verification/webhooks/reconciliation/refunds in test mode, then monthly mandate lifecycle. Keep annual care pay-to-renew with reminders at 30/14/7/1 days. Perform PayU test cases and a controlled low-value live transaction/refund before public enablement.

Exit criteria: only verified payments grant entitlement; duplicate, pending, delayed, and out-of-order events are safe; cancellation/refund agree between PayU and the app.

### Milestone 5 — Pilot and cutover

Validate copy/legal/trust claims, configure production secrets/email/monitoring/backups, preserve every live URL, run internal and invited owner/agency pilots, test rollback/payment-disable/database-restore procedures, then enable public buying.

Measure conversion, onboarding completion, time to usable access, first response, human minutes/case, quotes/refunds, completion, reinfection, subscription failures, and renewal.

## Test plan

- Pricing: plan/quantity → correct subtotal, GST, total, and site allowance; tampered client price → rejected.
- Payment: success redirect without verification, invalid hash, amount mismatch, unknown ID, duplicate webhook, pending settlement, late failure, refund, and timeout → defined safe state with no duplicate entitlement.
- Authorization: cross-organization access, unassigned staff, staff without recent MFA, and expired sessions → denied at application and RLS layers.
- Secrets: tampered ciphertext → authentication failure; replace/revoke/expiry → old secret unavailable; logs/analytics/email/errors → no plaintext.
- Workflow: allowed and forbidden case transitions, access-readiness response clock, quote acceptance, refund, report/follow-up, and internal-note isolation.
- Browser: owner purchase/onboarding/tracking, agency site limit, staff triage/completion, payment failure/retry, cancellation, and accessibility-critical paths.
- Quality gates: lint, Astro check/typecheck, unit/integration tests, production build, dependency audit, secret scan, migration/RLS tests, and browser smoke suite.

## Assumptions and guardrails

- Canonical repository: `webadish-ai/hackedwebsiterecovery-com`, branch `feat/assisted-recovery-storefront`, based on `main` commit `defcd2895067f016b0344c19d90fb201bf80c64f`.
- PayU is active with subscriptions, but its exact recurring product is not yet verified. Use adapter boundaries and mocks/test mode until verified.
- The confirmed prices, coverage, GST display, owner-and-agency audience, 24/7 four-hour first response, and quote-or-refund policy bind the implementation.
- Do not deploy, change DNS, process live payments, provision production data resources, or collect real credentials without a separate release step.
- Do not add automated malware deletion/database repair or imply universal/same-day completion.
- Preserve unrelated working-tree changes and existing marketing/SEO routes. Implement Milestone 1 as the first bounded pull request.
- Pre-production dependency gate: the current Astro `6.4.8` and `@astrojs/vercel` `10.0.8` line retains production audit advisories whose fixes require an Astro 7 and Vercel 11 compatibility migration. Complete that migration, including resolving the current `@astrojs/tailwind` 6 peer declaration (`^3 || ^4 || ^5`) against Astro 7, and rerun the full audit/build/browser gate before launch. Do not treat the current branch as production-ready solely because non-major audit fixes pass.
