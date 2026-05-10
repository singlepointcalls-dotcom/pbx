# Security and Penetration Test Report

**Application:** SinglePoint Calls — Custom Telephone Answering Service  
**Report Date:** 2026-05-10  
**Report Version:** 1.0  
**Classification:** Confidential  
**Prepared by:** Internal Security Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope](#2-scope)
3. [Methodology](#3-methodology)
4. [Findings Summary](#4-findings-summary)
5. [Detailed Findings](#5-detailed-findings)
6. [Fixed Issues](#6-fixed-issues)
7. [Recommendations](#7-recommendations)
8. [Appendix: Tested Controls](#8-appendix-tested-controls)

---

## 1. Executive Summary

A security code review and targeted penetration test was conducted against the SinglePoint Calls answering service application. The application is a Node.js 18 / Express REST API backed by PostgreSQL, with Socket.io real-time messaging, Asterisk ARI telephony integration, and two separate browser frontends (operator console and client portal).

The review examined authentication and authorisation controls, injection attack surfaces, transport and storage security, business logic protections, and the real-time telephony channel. The application demonstrates a mature security posture for its stage of development. The majority of the OWASP Top 10 categories were either not applicable or adequately mitigated by implemented controls.

**One medium-severity vulnerability was identified and remediated during the review period** (SSRF via webhook URL insertion). No critical or high-severity issues remain open.

The remaining open items consist of one low-severity informational finding (CSP `unsafe-inline` directive) and a set of operational hardening recommendations. The application is considered fit for production deployment once the operational recommendations below have been addressed.

---

## 2. Scope

### 2.1 In Scope

| Component | Description |
|---|---|
| `src/app.js` | Express application bootstrap, security headers, CORS, rate limiting |
| `src/api/middleware/auth.js` | Operator JWT authentication middleware |
| `src/api/routes/auth.js` | Login, TOTP 2FA, password reset, backup codes |
| `src/api/routes/portal.js` | Client portal authentication and portal API |
| `src/api/routes/clients.js` | Client management, webhook CRUD, business hours |
| `src/api/routes/messages.js` | Message creation, CSV export |
| `src/api/routes/calls.js` | Call log access, CSV export |
| `src/api/routes/sms.js` | SMS send, bulk SMS |
| `src/api/routes/operators.js` | Operator CRUD |
| `src/asterisk/ari.js` | Asterisk ARI WebSocket, call handling, DNC enforcement |
| `src/services/delivery.js` | Message fan-out, webhook delivery, SSRF guard, email validation |
| `src/services/audit.js` | Audit log service |
| `src/config/database.js` | PostgreSQL connection pool |
| `src/db/schema.sql` | Database schema |
| `src/db/seed.js` | Database seeding / default credentials |
| `web/` | Static frontend assets (operator console, client portal) |
| `infra/main.bicep` | Azure infrastructure definition |
| `.github/workflows/azure.yml` | CI/CD pipeline |

### 2.2 Out of Scope

- Asterisk / FreePBX host configuration and SIP security
- Azure platform-level controls (WAF, DDoS protection, network security groups)
- Third-party integrations (Twilio, SMTP relays, WhatsApp, Slack, Teams)
- Physical security and social engineering

### 2.3 Application Version

- **Runtime:** Node.js >= 18.0.0 (enforced in `package.json`)
- **Framework:** Express 4.18.2
- **Database client:** pg 8.11.3
- **Auth libraries:** jsonwebtoken 9.0.2, bcryptjs 2.4.3, speakeasy 2.0.0

---

## 3. Methodology

The review followed a white-box approach with full access to source code and infrastructure configuration. Testing was conducted in the following phases:

**Phase 1 — Reconnaissance and Architecture Review**  
Mapping of all API endpoints, authentication boundaries, data flows, and trust relationships between components (ARI WebSocket, Socket.io, PostgreSQL, external webhook targets).

**Phase 2 — Automated Static Analysis**  
Static code review targeting OWASP Top 10 categories: injection (SQL, command, SSRF), broken authentication, sensitive data exposure, XML/JSON injection, broken access control, security misconfiguration, cross-site scripting, and insecure deserialisation.

**Phase 3 — Manual Code Review**  
Deep inspection of authentication flows (login, 2FA, password reset, token lifecycle), authorisation enforcement (middleware chain, role checks), and all external HTTP egress points (webhooks, Slack/Teams integrations).

**Phase 4 — Business Logic Testing**  
Review of rate limiting, input validation, DNC enforcement, audit trail integrity, and privilege boundaries between operator and portal token namespaces.

**Phase 5 — Dependency Review**  
Review of `package.json` dependencies and `overrides` for known vulnerable transitive dependencies.

**Phase 6 — Infrastructure Review**  
Review of Azure Bicep templates, CI/CD workflow, Docker configuration, and environment variable handling.

---

## 4. Findings Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| F-01 | SSRF via Webhook URL Insertion (POST endpoint) | Medium | **Fixed** |
| F-02 | CSP `unsafe-inline` Allows Inline Script Execution | Low | Open |
| F-03 | In-Process Login Rate Limiter Lost on Restart | Low (Informational) | Open — Accepted |
| F-04 | Default Seed Credentials Present in Repository | Low | Open — Remediation Required |
| F-05 | PostgreSQL SSL Disabled by Default | Low (Operational) | Open — Config Change Required |
| F-06 | No Mandatory 2FA Enforcement for Admin Accounts | Low (Operational) | Open — Config Change Required |

**Severity key:**  
- **Critical** — Direct compromise of the system or its data  
- **High** — Significant data exposure or privilege escalation with moderate difficulty  
- **Medium** — Exploitable with meaningful security impact under specific conditions  
- **Low** — Limited direct impact; defence-in-depth or operational gap  
- **Informational** — No direct impact; best-practice observation

---

## 5. Detailed Findings

---

### F-01 — SSRF via Webhook URL Insertion (POST endpoint)

**Severity:** Medium (Resolved)  
**Status:** Fixed  
**CWE:** CWE-918 — Server-Side Request Forgery (SSRF)  
**Affected file:** `src/api/routes/clients.js` — `POST /api/clients/:id/webhooks`

**Description:**  
The application supports per-client outbound webhooks. The `isPrivateUrl()` guard in `src/services/delivery.js` blocks requests to private RFC 1918 address ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.x), and link-local addresses. However, during this review it was confirmed that the guard was invoked on the webhook *delivery* path but was absent from the `POST /api/clients/:id/webhooks` insertion endpoint. An authenticated admin or supervisor could therefore register a webhook URL pointing to an internal address. The URL would pass validation at write time and the SSRF would fire when the system next delivered a message event to that webhook — or when the test-fire endpoint (`POST /api/clients/:id/webhooks/:webhookId/test`) was called.

**Impact:**  
An authenticated insider (admin or supervisor role) could use the application as a pivot to probe internal services on the network hosting the application (e.g., cloud metadata endpoints at 169.254.169.254, internal databases, or adjacent container services). In a cloud environment this is particularly significant as instance metadata services typically return IAM credentials without additional authentication.

**Technical detail:**  
The `isPrivateUrl()` function parses the target URL, resolves any IPv4-mapped IPv6 addresses, extracts octets from the parsed `hostname`, and returns `true` (block) for any address falling within RFC 1918, loopback, or link-local ranges. The fix adds a call to `isPrivateUrl(url)` inside the `POST` handler prior to the `INSERT` statement, mirroring the existing guard on the `PUT` update handler and the delivery-time check.

**Evidence (post-fix, `src/api/routes/clients.js` lines 373–378):**
```js
if (isPrivateUrl(url)) {
  return res.status(400).json({
    error: 'Webhook URL must not point to a private or loopback address',
  });
}
```

**Resolution:** Confirmed fixed in the current codebase. The guard now fires at both write time and delivery time.

---

### F-02 — CSP `unsafe-inline` Allows Inline Script Execution

**Severity:** Low  
**Status:** Open  
**CWE:** CWE-1021 — Improper Restriction of Rendered UI Layers  
**Affected file:** `src/app.js` line 75

**Description:**  
The `Content-Security-Policy` header sent with API responses includes `'unsafe-inline'` in both `script-src` and `style-src` directives:

```
script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
```

The `'unsafe-inline'` directive permits execution of inline `<script>` blocks and inline event handlers (`onclick`, etc.). If a reflected or stored XSS payload were introduced through an unvalidated input, the CSP would not block its execution.

**Impact:**  
The presence of `'unsafe-inline'` eliminates the primary XSS mitigation benefit of a Content Security Policy. In practice, the risk is limited because the API primarily returns JSON (not HTML), and the static frontends are served separately. However, any HTML-context output (e.g., error pages rendered as HTML) would be unprotected.

**Recommendation:**  
Replace `'unsafe-inline'` with per-response nonces (`'nonce-{random}'`) or subresource integrity hashes for any inline scripts that cannot be moved to external files. For API responses that never return HTML, the directive can be simplified to `default-src 'none'` (this is already applied to the `/intake` widget endpoint on line 123 — extend this pattern). For the frontend assets, consider integrating a nonce-based CSP at the reverse proxy layer.

**Note:** This is a defence-in-depth gap rather than an immediate exploitable vulnerability. No XSS injection points were identified in the codebase during this review.

---

### F-03 — In-Process Login Rate Limiter Lost on Restart

**Severity:** Low (Informational)  
**Status:** Open — Accepted  
**CWE:** CWE-307 — Improper Restriction of Excessive Authentication Attempts  
**Affected file:** `src/api/routes/auth.js` lines 15–44

**Description:**  
Login rate limiting for the `POST /api/auth/login`, `POST /api/auth/verify-2fa`, and `POST /api/auth/forgot-password` endpoints is implemented using an in-process `Map` (`loginAttempts`). The limit is 10 attempts per IP per 15-minute window.

Because the counter is stored in process memory, it is reset on every application restart or deployment. An attacker who can induce a process restart (e.g., by triggering an unhandled exception in an unrelated path, or simply by timing a restart during a deployment window) would reset their attempt counter. In a multi-instance deployment (horizontal scaling), each container instance maintains a separate counter, so an attacker with IP rotation or load-balancer awareness can multiply their effective attempt budget by the number of instances.

**Impact:**  
Brute-force of operator passwords is partly attenuated but not eliminated in scaled or frequently-deployed environments. bcrypt with cost factor 12 (~250–300ms per hash) provides a meaningful secondary brake: at 10 attempts per 15 minutes per IP, sustained online guessing is slow. The risk is low but should be noted in a production hardening context.

**Recommendation:**  
Replace the in-process `Map` with a shared counter backed by Redis or PostgreSQL, or use the `express-rate-limit` package with a persistent store adapter (e.g., `rate-limit-postgresql`). Additionally, deploy Fail2Ban or equivalent at the network layer to block IPs with repeated 429 responses. See Recommendations section.

---

### F-04 — Default Seed Credentials Present in Repository

**Severity:** Low  
**Status:** Open — Remediation Required  
**CWE:** CWE-798 — Use of Hard-coded Credentials  
**Affected file:** `src/db/seed.js`

**Description:**  
The database seed script (`npm run seed`) creates a default admin operator account with known credentials documented in the repository (username: `user1`, password: `leon123`). These credentials do not meet the application's own password policy (minimum 12 characters, uppercase, lowercase, number, and special character — enforced in `validatePassword()` in `src/api/routes/auth.js`). The seed script bypasses the policy by inserting a pre-hashed value directly, meaning the seeded password would be rejected by the change-password endpoint if a legitimate operator attempted to re-use it.

**Impact:**  
Any environment where `npm run seed` has been run and the credentials have not been changed is immediately accessible to anyone aware of these defaults. This is a critical configuration step that must be enforced procedurally.

**Recommendation:**  
Change the default seed credentials immediately in all environments. Ideally, update the seed script to either generate a random password on first run and print it to stdout once, or require the administrator to supply credentials via environment variable at seed time. Add a CI/CD check that fails the pipeline if default credentials are detected in a production database.

---

### F-05 — PostgreSQL SSL Disabled by Default

**Severity:** Low (Operational)  
**Status:** Open — Config Change Required  
**CWE:** CWE-319 — Cleartext Transmission of Sensitive Information  
**Affected file:** `src/config/database.js` line 11

**Description:**  
The database connection pool is configured as follows:

```js
ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
```

SSL is disabled unless `DB_SSL=true` is explicitly set in the environment. In the Azure deployment (`infra/main.bicep`), PostgreSQL Flexible Server enforces SSL by default at the server level, which provides some protection. However, the client-side `rejectUnauthorized: false` option — used when `DB_SSL=true` is set — disables certificate verification, making the connection vulnerable to a man-in-the-middle attack between the application container and the database server.

**Impact:**  
In environments where the database is on the same private VNET as the application (typical of the Azure deployment), network-layer interception is unlikely. However, without certificate verification, the MITM protection offered by TLS is incomplete.

**Recommendation:**  
Set `DB_SSL=true` in all production environments. Additionally, change `rejectUnauthorized: false` to `rejectUnauthorized: true` and supply the PostgreSQL CA certificate via a `ca` option (Azure PostgreSQL Flexible Server publishes its CA certificate). This ensures both encryption-in-transit and server identity verification.

---

### F-06 — No Mandatory 2FA Enforcement for Admin Accounts

**Severity:** Low (Operational)  
**Status:** Open — Config Change Required  
**CWE:** CWE-308 — Use of Single-Factor Authentication  
**Affected file:** `src/api/routes/auth.js`, `src/db/schema.sql`

**Description:**  
The application supports a system-wide 2FA enforcement flag (`system_settings.require_2fa`) which, when set to `'true'`, blocks login for any operator who has not enrolled a TOTP authenticator. The default value seeded into the database is `'false'`, meaning 2FA is optional by default.

Separately, the application does not implement a role-specific enforcement path: the `require_2fa` flag applies uniformly to all operators or none. There is no mechanism to enforce 2FA specifically for `admin` role accounts while keeping it optional for `operator` role accounts.

**Impact:**  
Admin accounts protected only by a username and password (bcrypt cost 12) remain susceptible to credential-stuffing or password-reuse attacks if the password is compromised. Admin accounts have full access to all clients, operators, message data, and system configuration.

**Recommendation:**  
Enable `require_2fa = 'true'` in `system_settings` immediately for all production environments. As a follow-on enhancement, consider implementing per-role enforcement so that 2FA can be mandated for `admin` and `supervisor` roles independently of `operator` accounts.

---

## 6. Fixed Issues

### SSRF on Webhook Insertion Endpoint

**Original condition:** The `POST /api/clients/:id/webhooks` endpoint accepted arbitrary URLs from authenticated admin/supervisor users and inserted them into the `client_webhooks` table without validating against RFC 1918 private address ranges. The `isPrivateUrl()` guard existed in `src/services/delivery.js` and was called during webhook delivery, but was not called at write time. This meant a malicious insider could register a private-address webhook that would be fired silently on every subsequent message delivery event.

**Fix applied:** The `isPrivateUrl()` function (imported into `clients.js` from `delivery.js`) is now called at the top of the `POST /api/clients/:id/webhooks` handler, before the `INSERT` query. Any URL that resolves to a loopback, RFC 1918, or link-local address is rejected with HTTP 400. The existing guard on the `PUT` update endpoint and the delivery-time guard are retained, providing defence in depth at three points: insertion, update, and delivery.

**Verification:** The fix was confirmed by code inspection of `src/api/routes/clients.js` lines 373–387.

---

## 7. Recommendations

The following recommendations are ordered by priority. Items marked **[Immediate]** should be addressed before the next production release. Items marked **[Short-term]** should be addressed within 30 days. Items marked **[Ongoing]** are process controls.

### R-01 — Change Default Seed Credentials [Immediate]

Change the `user1` / `leon123` seed account credentials in all environments immediately. Update the seed script to generate random credentials or prompt for them at runtime so this cannot recur.

### R-02 — Enable PostgreSQL SSL with Certificate Verification [Immediate]

Set `DB_SSL=true` in all production `.env` files. Update `src/config/database.js` to use `rejectUnauthorized: true` and provide the Azure PostgreSQL CA certificate. The CA certificate can be downloaded from the Azure portal or the Microsoft PKI repository.

### R-03 — Enable Mandatory 2FA for All Operators [Immediate]

Execute the following SQL to enable global 2FA enforcement:

```sql
UPDATE system_settings SET value = 'true' WHERE key = 'require_2fa';
```

Notify all operators and provide a guided enrollment window before enforcement takes effect. Admin accounts must be enrolled first.

### R-04 — Rotate JWT Secrets on a Regular Schedule [Short-term]

Rotate `JWT_SECRET` and `PORTAL_JWT_SECRET` every 90 days and immediately on any suspected compromise. Rotation invalidates all active sessions, so schedule it during a low-traffic window. Consider implementing token revocation (a short-lived blacklist table) to allow graceful rotation without disrupting all active sessions.

### R-05 — Replace In-Process Auth Rate Limiter with Persistent Store [Short-term]

Migrate the `loginAttempts` Map in `src/api/routes/auth.js` to a Redis-backed or PostgreSQL-backed counter so that rate limits survive process restarts and are shared across all application instances in a horizontally-scaled deployment. The `express-rate-limit` package supports pluggable stores.

### R-06 — Harden Content Security Policy [Short-term]

Remove `'unsafe-inline'` from `script-src` and `style-src` in the CSP header set in `src/app.js`. Migrate any inline scripts in the `web/` frontends to external `.js` files, and use nonces or hashes for any remaining inline scripts. For pure API responses, use `default-src 'none'` as is already done for the `/intake` endpoint.

### R-07 — Deploy Behind a Hardened Reverse Proxy [Short-term]

Deploy the application behind an nginx or Azure Application Gateway reverse proxy configured with:
- TLS 1.2 minimum (prefer TLS 1.3 only)
- HSTS with `max-age=31536000; includeSubDomains; preload`
- HTTP to HTTPS redirect
- Request size limits (e.g., `client_max_body_size 10m`)

The Azure Container App ingress already provides basic TLS termination, but explicit configuration of the above settings should be verified.

### R-08 — Add Network-Level Brute-Force Protection [Short-term]

Deploy Fail2Ban (on a VM-hosted reverse proxy) or configure Azure Front Door / Application Gateway WAF rules to block IPs that produce repeated HTTP 429 responses against the `/api/auth/login` endpoint. This provides a network-layer complement to the application-layer rate limiter.

### R-09 — Run `npm audit` in CI/CD Pipeline [Ongoing]

Add `npm audit --audit-level=high` as a required step in `.github/workflows/azure.yml` so that newly published CVEs in direct and transitive dependencies are caught before deployment. The existing `overrides` in `package.json` (patching `qs`, `tough-cookie`, `cookiejar`, `form-data`) demonstrate that dependency hygiene is already being maintained; formalising it in CI ensures it is not skipped.

### R-10 — Review Webhook Test-Fire SSRF Gap [Short-term]

The `POST /api/clients/:id/webhooks/:webhookId/test` endpoint fires a live HTTP request to the stored webhook URL. While the URL is now validated at insertion and update time, previously stored webhook URLs (created before the fix) may not have been validated. Run a one-time audit query to identify and remove any stored webhook URLs that would be blocked by `isPrivateUrl()`:

```sql
SELECT id, client_id, url FROM client_webhooks
WHERE url ~ '^https?://(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|localhost|::1)';
```

---

## 8. Appendix: Tested Controls

The following controls were reviewed and confirmed to be implemented correctly. No vulnerabilities were identified in these areas.

| Control | Implementation | Verdict |
|---|---|---|
| SQL Injection | All PostgreSQL queries use parameterised placeholders (`$1`, `$2`, ...) via `pg` driver. No string concatenation found in query construction. | Pass |
| JWT Algorithm Confusion | All `jwt.verify()` calls specify `{ algorithms: ['HS256'] }` explicitly. The `none` algorithm attack and RS256/HS256 confusion attack are not applicable. | Pass |
| JWT Expiry | Operator tokens expire at a configurable TTL (system setting). Portal tokens expire after 4 hours. Temporary TOTP tokens expire after 5 minutes. | Pass |
| Password Storage | `bcryptjs` with `saltRounds=12` used for all password hashing. Dummy hash used in login path to ensure constant-time comparison even for unknown usernames (timing enumeration prevention). Passwords are never returned in API responses. | Pass |
| Password Policy | `validatePassword()` enforces minimum 12 characters, uppercase, lowercase, digit, and special character. Applied at registration, password change, and password reset. | Pass |
| Authentication Coverage | `requireAuth` middleware applied at the router level in all operator route files. No unauthenticated paths to operator data were found. | Pass |
| Role-Based Access Control | `requireRole('admin')` and `requireRole('admin', 'supervisor')` applied as second middleware on sensitive operations (operator CRUD, client deletion, webhook management, audit log access). | Pass |
| TOTP 2FA | `speakeasy` TOTP with `window: 1` (allows one step of clock drift). TOTP secret stored only in the database. QR code generated server-side and returned once. 2FA enrollment requires verification of a valid code before enabling. | Pass |
| Backup Code Security | 10 single-use backup codes generated with `crypto.randomBytes(4)`. Returned to the user once in plaintext. Stored as bcrypt hashes (`cost=10`). Consumed codes are removed from the array at use time. | Pass |
| Portal / Operator Token Separation | Portal tokens carry `type:'portal'` claim and are verified against `PORTAL_JWT_SECRET`. The `requirePortalAuth` middleware rejects any token lacking `type:'portal'`. Operator middleware does not accept portal tokens. Separate secrets mean tokens are cryptographically namespaced even if both secrets share the same fallback. | Pass |
| CORS | Configured to allow only explicitly listed origins (`CORS_ORIGINS` env var). Requests without an `Origin` header (server-to-server) are permitted. Unknown origins receive a CORS error. | Pass |
| Security Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-XSS-Protection: 0` (disabled per modern guidance), and `Content-Security-Policy` set on all responses. | Pass (with CSP caveat in F-02) |
| SSRF — Webhook Delivery | `isPrivateUrl()` called at delivery time for all outbound webhook HTTP requests. Blocks loopback, RFC 1918, and link-local addresses. | Pass |
| SSRF — Slack/Teams Webhooks | `isPrivateUrl()` called before outbound requests to Slack webhook URLs (`clients.slack_webhook`) and Teams webhook URLs (`clients.teams_webhook`) in `src/services/delivery.js`. | Pass |
| CSV Injection | `sanitizeCsv()` in `src/api/routes/calls.js` and `src/api/routes/messages.js` prefixes formula-triggering characters (`=`, `+`, `-`, `@`) with a single-quote, preventing spreadsheet formula injection in exported CSV files. | Pass |
| Email Validation | `assertValidEmail()` in `src/services/delivery.js` enforces RFC 5321 limits (local-part <= 64 chars, domain <= 255 chars, total <= 320 chars) before every `sendMail()` call. | Pass |
| Input Length Limits | SMS body capped at 1600 characters. Bulk SMS capped at 200 recipients. Paginated query results capped with `Math.min(parseInt(limit), 500)`. | Pass |
| Rate Limiting | Global API limit: 300 requests per 60 seconds. Login endpoints: 10 attempts per 15-minute window per IP (in-process). Additional per-endpoint limiters on portal login, intake widget, message creation, and ACK. | Pass (with caveat in F-03) |
| DNC Enforcement | `handleStasisStart` in `src/asterisk/ari.js` queries `dnc_numbers` before answering any inbound call. DNC-matched calls are logged with `disposition = 'dnc_blocked'` and a `call:dnc_blocked` Socket.io event is broadcast. | Pass |
| Audit Log Integrity | `src/services/audit.js` performs `INSERT`-only writes to `operator_audit_log`. No `UPDATE` or `DELETE` operations exist on this table in the codebase. Fire-and-forget pattern prevents audit failures from disrupting request handling. | Pass |
| Dependency Patching | `package.json` `overrides` field pins vulnerable transitive dependencies (`qs >= 6.14.1`, `tough-cookie >= 4.1.3`, `cookiejar >= 2.1.4`, `form-data >= 2.5.4`). | Pass |

---

*End of Report*
