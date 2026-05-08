# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev        # Start with nodemon (auto-reload)
npm start          # Production start

# Database
npm run migrate    # Apply schema.sql to the database (idempotent — safe to re-run)
npm run seed       # Create default admin operator

# Tests
npm test                                        # Run all tests
node --test tests/screenpop.test.js             # Run a single test file
node --test --test-name-pattern="assertValid"   # Run tests matching a name pattern
```

## Environment

Copy `.env.example` to `.env`. The critical variables:

| Variable | Purpose |
|---|---|
| `DB_*` | PostgreSQL connection |
| `JWT_SECRET` | Operator JWT signing |
| `PORTAL_JWT_SECRET` | Portal JWT signing (falls back to JWT_SECRET) |
| `ARI_HOST/PORT/USER/PASSWORD/APP` | Asterisk ARI connection |
| `SMTP_*` | Email delivery (global SinglePoint transport) |
| `TWILIO_*` | SMS delivery |
| `APP_URL` | Used in password reset email links |

## Architecture

```
Asterisk (FreePBX) ──ARI WebSocket──► src/asterisk/ari.js
                                           │
                                     broadcast() ──► src/services/realtime.js (Socket.io)
                                                          │
                                                    operator browser (web/app.js)

HTTP requests ──► src/app.js (Express)
                       │
                  src/api/routes/*.js
                       │
                  src/config/database.js (pg Pool, max 20 connections)
```

**Two separate frontends, both served as static files from `web/`:**
- `web/index.html` + `web/app.js` — operator console (JWT auth via `JWT_SECRET`)
- `web/portal.html` + `web/portal.js` — client portal (JWT auth via `PORTAL_JWT_SECRET`)

**Two separate JWT namespaces:** Operator tokens carry `{ id, username, role }` and are verified by `src/api/middleware/auth.js`. Portal tokens carry `{ id, client_id, type: 'portal' }` and are verified inline in `src/api/routes/portal.js`. A portal token cannot access operator endpoints, and vice versa.

**Real-time flow:** `src/services/realtime.js` exposes `broadcast(event, data)` which calls `io.emit()` to all connected sockets. ARI events in `src/asterisk/ari.js` and API route handlers (e.g. availability PUT) call `broadcast()` directly.

**Call flow:** Asterisk sends all inbound calls into the `answering-service` Stasis app → `handleStasisStart` in `ari.js` looks up the client by DID (`clients.dids` GIN-indexed text array), logs the call, starts MOH, and broadcasts `call:ringing`. Operators see the call in real-time and click Answer → `POST /api/callcontrol/answer` → `answerCall()` in `ari.js` bridges the inbound channel to the operator's SIP extension.

**Message delivery:** `src/services/delivery.js:deliverMessage()` fans out to all enabled channels (email, SMS, webhook, inapp) based on `clients.delivery_actions` and `contacts.notify_*` flags. Each client can override SMTP credentials (`clients.smtp_host/user/pass`); falls back to global `SMTP_*` env vars.

## Database

Schema lives entirely in `src/db/schema.sql` — it's append-only with `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` guards, so `npm run migrate` is idempotent. All IDs are UUIDs. Key tables:

- `clients` — subscribing businesses; `dids[]` routes inbound calls; `opening_times` JSONB stores business hours by day name
- `contacts` — people to notify per client; `priority` drives escalation order
- `messages` + `message_deliveries` — message and per-channel delivery tracking
- `call_logs` — every call; `disposition` set to `no_answer` on hangup if not answered
- `operators` — agents; roles: `admin | supervisor | operator`
- `client_portal_users` — portal logins; separate from operators
- `portal_reset_tokens` — bcrypt-hashed single-use tokens, 24h TTL
- `operator_audit_log` — append-only compliance log; never UPDATE or DELETE rows
- `system_settings` — key/value admin config (token lifetime, company name, etc.)

## Key Patterns

**Route auth:** Most operator routes use `router.use(requireAuth)` at the top of the file. Role checks use `requireRole('admin', 'supervisor')` as a second middleware. Portal routes use the inline `requirePortalAuth` middleware defined in `portal.js`.

**Password validation:** `validatePassword()` is defined in both `src/api/routes/auth.js` (operator) and `src/api/routes/portal.js` (portal). Min 12 chars, upper, lower, number, special char.

**Email validation:** `assertValidEmail()` in `src/services/delivery.js` enforces RFC 5321 limits (local ≤64, domain ≤255, total ≤320). Called before every `sendMail`. Exported as `_assertValidEmail` for tests.

**Business hours:** `isWithinBusinessHours(openingTimes, timezone)` in `src/api/routes/clients.js` uses `Intl.DateTimeFormat` for timezone-aware day/time lookup. Exported as `_isWithinBusinessHours` for tests. An empty `opening_times` object means always open.

**Audit logging:** `src/services/audit.js` provides fire-and-forget `audit.log(req, 'resource.verb', opts)`. Never throws. Action naming: `<resource>.<verb>` (e.g. `message.create`, `operator.login`).

**Background services started in `src/index.js`:**
- `startEscalationService()` — polls every 2 min for unacknowledged messages past escalation threshold
- `startRetentionService()` — GDPR purge of data older than `clients.data_retention_months`
- `pushService.init()` — loads VAPID keys for Web Push

## Testing

Tests use Node.js built-in `node:test` runner (no Jest/Mocha). Test files live in `tests/`. To expose internal functions for testing, export them with an underscore prefix: `module.exports = { ..., _myFn: myFn }`.

## Azure Deployment

Infrastructure is defined in `infra/main.bicep` (Azure Container Apps + PostgreSQL Flexible Server + ACR). CI/CD pipeline in `.github/workflows/azure.yml` runs tests → builds Docker image → deploys Bicep → runs migrations. Required GitHub secrets are documented in the workflow file.

Asterisk must be hosted separately (Azure VM or on-premises). Set `ARI_HOST` to its IP/FQDN. Socket.io sticky sessions are enabled in the Container App ingress config.
