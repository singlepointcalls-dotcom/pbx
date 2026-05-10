-- Custom Answering Service Schema

-- Operators (agents who answer calls)
CREATE TABLE IF NOT EXISTS operators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator', 'supervisor')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients (businesses that subscribe to the answering service)
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    account_number VARCHAR(50) UNIQUE NOT NULL,
    -- Call routing: which DID(s) map to this client
    -- Stored as a text array of E.164 phone numbers e.g. {+15551234567}
    dids TEXT[] NOT NULL DEFAULT '{}',
    -- Operator script shown when this client's call comes in
    script TEXT,
    -- Greeting to play or show operator
    greeting TEXT,
    -- Timezone for on-call schedule evaluation
    timezone VARCHAR(50) NOT NULL DEFAULT 'Europe/London',
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contacts (people to notify for a client)
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    title VARCHAR(100),
    phone VARCHAR(20),
    email VARCHAR(255),
    -- Delivery preferences
    notify_email BOOLEAN NOT NULL DEFAULT true,
    notify_sms BOOLEAN NOT NULL DEFAULT false,
    notify_webhook BOOLEAN NOT NULL DEFAULT false,
    sms_number VARCHAR(20),
    -- Private flag — shown in red to operators only, never shared externally
    is_private BOOLEAN NOT NULL DEFAULT false,
    -- Priority order for on-call escalation
    priority INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- On-call schedules (which contact is on-call at a given time)
CREATE TABLE IF NOT EXISTS oncall_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    -- Day of week: 0=Sunday, 6=Saturday, NULL=any day
    day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
    -- Time range in HH:MM format (in client timezone)
    start_time TIME,
    end_time TIME,
    -- Override: specific date range
    override_start TIMESTAMPTZ,
    override_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Call logs (every inbound call)
CREATE TABLE IF NOT EXISTS call_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asterisk_channel_id VARCHAR(255),
    client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
    operator_id UUID REFERENCES operators(id) ON DELETE SET NULL,
    -- Caller info
    caller_id_num VARCHAR(20),
    caller_id_name VARCHAR(100),
    -- DID dialed
    did VARCHAR(20),
    -- Call lifecycle
    call_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    call_answered TIMESTAMPTZ,
    call_end TIMESTAMPTZ,
    duration_seconds INTEGER,
    -- Outcome
    disposition VARCHAR(50) CHECK (disposition IN ('answered', 'no_answer', 'busy', 'transferred', 'voicemail')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages (taken during or after a call)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_log_id UUID REFERENCES call_logs(id) ON DELETE SET NULL,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    operator_id UUID REFERENCES operators(id) ON DELETE SET NULL,
    -- Caller info (may differ from call_log if entered manually)
    caller_name VARCHAR(100),
    caller_phone VARCHAR(20),
    caller_company VARCHAR(100),
    -- Message body
    subject VARCHAR(255),
    body TEXT NOT NULL,
    urgency VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'urgent', 'emergency')),
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'read')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Message deliveries (each delivery attempt per message)
CREATE TABLE IF NOT EXISTS message_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    -- Delivery channel
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'webhook', 'inapp')),
    -- Destination (email address or webhook URL)
    destination TEXT,
    -- Result
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook configurations per client
CREATE TABLE IF NOT EXISTS client_webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clients_dids ON clients USING GIN (dids);
CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_client ON call_logs(client_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_start ON call_logs(call_start DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON message_deliveries(message_id);
CREATE INDEX IF NOT EXISTS idx_oncall_client ON oncall_schedules(client_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER operators_updated_at
    BEFORE UPDATE ON operators
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER clients_updated_at
    BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Tasks / reminders assigned to operators per client or call
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    operator_id UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    call_log_id UUID REFERENCES call_logs(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    notes TEXT,
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_client    ON tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_operator  ON tasks(operator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due       ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);

CREATE OR REPLACE TRIGGER tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================
-- v2 Feature additions
-- =============================================================

-- Departments (per client)
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_client ON departments(client_id);

-- VIP numbers (per client) — flag incoming callers
CREATE TABLE IF NOT EXISTS client_vip_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phone VARCHAR(30) NOT NULL,
    label VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_vip_client ON client_vip_numbers(client_id);

-- Ignore list (per client) — suppress notifications for these numbers
CREATE TABLE IF NOT EXISTS client_ignore_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phone VARCHAR(30) NOT NULL,
    label VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_ignore_client ON client_ignore_numbers(client_id);

-- Client availability (set by client or admin via portal)
CREATE TABLE IF NOT EXISTS client_availability (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'out_of_office', 'annual_leave', 'meeting')),
    note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id)
);
CREATE INDEX IF NOT EXISTS idx_availability_client ON client_availability(client_id);

-- Clients: extended fields
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS opening_times JSONB NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS info_sheets JSONB NOT NULL DEFAULT '[]';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS custom_form JSONB NOT NULL DEFAULT '[]';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS delivery_actions JSONB NOT NULL DEFAULT '{"phone_call":true,"email":true,"sms":false}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smtp_user VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smtp_pass VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS smtp_from VARCHAR(255);

-- Contacts: department, call action, transfer
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS call_action VARCHAR(20) NOT NULL DEFAULT 'message'
    CHECK (call_action IN ('message', 'transfer', 'both'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS transfer_extension VARCHAR(20);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS message_note TEXT;

-- Contact availability timeframe
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS availability_type VARCHAR(20) NOT NULL DEFAULT 'always'
    CHECK (availability_type IN ('always', 'business_hours', 'custom', 'unavailable'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS availability_schedule JSONB NOT NULL DEFAULT '{}';

-- Client web links (quick-access URLs shown to operators during calls)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS web_links JSONB NOT NULL DEFAULT '[]';

-- Messages: rename urgency values to low / normal / high
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_urgency_check;
ALTER TABLE messages ADD CONSTRAINT messages_urgency_check
    CHECK (urgency IN ('low', 'normal', 'high'));
UPDATE messages SET urgency = 'high' WHERE urgency IN ('urgent', 'emergency');

-- Message deliveries: add phone_call channel
ALTER TABLE message_deliveries DROP CONSTRAINT IF EXISTS message_deliveries_channel_check;
ALTER TABLE message_deliveries ADD CONSTRAINT message_deliveries_channel_check
    CHECK (channel IN ('email', 'sms', 'webhook', 'inapp', 'phone_call'));

-- =============================================================
-- v3 Feature additions
-- =============================================================

-- Operators: TOTP 2FA support
ALTER TABLE operators ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(100);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Clients: DID labels (map from DID -> friendly name) + HIPAA flag
ALTER TABLE clients ADD COLUMN IF NOT EXISTS did_labels JSONB NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_hipaa BOOLEAN NOT NULL DEFAULT false;

-- Client portal users (clients can log in to view messages/stats)
CREATE TABLE IF NOT EXISTS client_portal_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_users_client ON client_portal_users(client_id);
CREATE OR REPLACE TRIGGER portal_users_updated_at
    BEFORE UPDATE ON client_portal_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- System settings (key-value store for admin configuration)
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billing plans (per client subscription)
CREATE TABLE IF NOT EXISTS billing_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
    plan_name VARCHAR(100) NOT NULL DEFAULT 'Standard',
    monthly_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
    included_calls INTEGER NOT NULL DEFAULT 0,
    included_minutes INTEGER NOT NULL DEFAULT 0,
    included_admin_minutes INTEGER NOT NULL DEFAULT 0,
    extra_call_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    extra_minute_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    extra_admin_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'GBP',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE TRIGGER billing_plans_updated_at
    BEFORE UPDATE ON billing_plans FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Monthly billing reports (generated per client per month)
CREATE TABLE IF NOT EXISTS billing_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    total_calls INTEGER NOT NULL DEFAULT 0,
    answered_calls INTEGER NOT NULL DEFAULT 0,
    missed_calls INTEGER NOT NULL DEFAULT 0,
    total_minutes INTEGER NOT NULL DEFAULT 0,
    admin_minutes INTEGER NOT NULL DEFAULT 0,
    total_messages INTEGER NOT NULL DEFAULT 0,
    amount_due NUMERIC(10,2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'GBP',
    breakdown JSONB NOT NULL DEFAULT '{}',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_billing_reports_client ON billing_reports(client_id);
CREATE INDEX IF NOT EXISTS idx_billing_reports_period ON billing_reports(year DESC, month DESC);

-- Insert default settings
INSERT INTO system_settings (key, value) VALUES
    ('freepbx_url', ''),
    ('company_name', 'SinglePoint Calls'),
    ('company_logo', ''),
    ('default_timezone', 'Europe/London'),
    ('session_timeout_hours', '12'),
    ('require_2fa', 'false'),
    ('min_password_length', '12'),
    ('outbound_caller_id', '')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- v4: call types, no-charge, outbound CLI, email templates
-- ============================================================

-- Clients: outbound caller ID (masks our number on outbound calls)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS outbound_caller_id VARCHAR(30);

-- Clients: per-client HTML/text email template with {{variable}} placeholders
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_template TEXT;

-- Messages: call type classification + no-charge flag for billing exclusion
ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_type VARCHAR(30) NOT NULL DEFAULT 'standard'
    CHECK (call_type IN ('standard','no_information','sales','wrong_number','transferred','voicemail'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_no_charge BOOLEAN NOT NULL DEFAULT false;

-- v2 availability (already added in previous commit — guards)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS availability_type VARCHAR(20) NOT NULL DEFAULT 'always';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS availability_schedule JSONB NOT NULL DEFAULT '{}';
ALTER TABLE clients  ADD COLUMN IF NOT EXISTS web_links JSONB NOT NULL DEFAULT '[]';

-- Call logs: add recording URL, call direction, billable flag
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_direction VARCHAR(10) NOT NULL DEFAULT 'inbound'
    CHECK (call_direction IN ('inbound', 'outbound'));
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS is_billable BOOLEAN NOT NULL DEFAULT true;

-- Messages: read receipt tracking
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- ============================================================
-- v5: nCall/EVS7 feature parity — noticeboard, client news,
--     client files, operator shifts, call disposition notes
-- ============================================================

-- Noticeboard (company-wide announcements visible on operator home page)
CREATE TABLE IF NOT EXISTS noticeboard (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    priority VARCHAR(10) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    created_by UUID REFERENCES operators(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client news (per-client news items visible during calls)
CREATE TABLE IF NOT EXISTS client_news (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_by UUID REFERENCES operators(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_news_client ON client_news(client_id);

-- Client files (uploaded documents: timesheets, pricing, forms, etc.)
CREATE TABLE IF NOT EXISTS client_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes INTEGER,
    description TEXT,
    uploaded_by UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id);

-- Operator shift schedules
CREATE TABLE IF NOT EXISTS operator_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operator_shifts_op ON operator_shifts(operator_id);

-- Call disposition notes (operator notes after each call)
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS disposition_notes TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS follow_up_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;

-- Quick links per client (embedded web pages, local files, bookmarks)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS quick_links JSONB NOT NULL DEFAULT '[]';

-- Client greeting per DID + time-of-day rules
ALTER TABLE clients ADD COLUMN IF NOT EXISTS greeting_rules JSONB NOT NULL DEFAULT '[]';

-- Clients: private notes (separate from public notes — shown in red, not shared with callers)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS private_notes TEXT;

-- Client logo (stored filename from uploads directory)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- ============================================================
-- MARKET-LEADING FEATURE ADDITIONS
-- ============================================================

-- Canned responses (operator text snippets / quick-fill)
CREATE TABLE IF NOT EXISTS canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shortcode VARCHAR(30) NOT NULL,
    title VARCHAR(100) NOT NULL,
    body TEXT NOT NULL,
    client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
    created_by UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canned_global ON canned_responses (lower(shortcode)) WHERE client_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_canned_client ON canned_responses (lower(shortcode), client_id) WHERE client_id IS NOT NULL;

-- Operator break / status log
CREATE TABLE IF NOT EXISTS operator_breaks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    break_type VARCHAR(20) NOT NULL DEFAULT 'break',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_breaks_op ON operator_breaks(operator_id, started_at DESC);

-- Operator team chat
CREATE TABLE IF NOT EXISTS operator_chat (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operator_chat_ts ON operator_chat(created_at DESC);

-- QA scoring per call
CREATE TABLE IF NOT EXISTS call_qa_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_log_id UUID NOT NULL REFERENCES call_logs(id) ON DELETE CASCADE,
    scored_by UUID NOT NULL REFERENCES operators(id),
    greeting_correct  BOOLEAN NOT NULL DEFAULT false,
    script_followed   BOOLEAN NOT NULL DEFAULT false,
    info_accurate     BOOLEAN NOT NULL DEFAULT false,
    professional_tone BOOLEAN NOT NULL DEFAULT false,
    message_complete  BOOLEAN NOT NULL DEFAULT false,
    overall INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 10),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_call ON call_qa_scores(call_log_id);

-- Message acknowledgement tokens
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ack_token TEXT UNIQUE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- Client: extra delivery channels + escalation + SLA target
ALTER TABLE clients ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(30);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slack_webhook TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS teams_webhook TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS escalation_rules JSONB NOT NULL DEFAULT '[]';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sla_answer_seconds INTEGER NOT NULL DEFAULT 30;

-- Call SLA tracking
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sla_met BOOLEAN;

-- Operator status persistence
ALTER TABLE operators ADD COLUMN IF NOT EXISTS current_status VARCHAR(20) NOT NULL DEFAULT 'offline';
ALTER TABLE operators ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- v6: GDPR data retention, Web Push notifications
-- ============================================================

-- Clients: configurable data retention period (GDPR Art. 5(1)(e) — storage limitation)
-- Allowed values: 3, 5, 9, 12 months. Default 12.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS data_retention_months INTEGER NOT NULL DEFAULT 12
    CHECK (data_retention_months IN (3, 5, 9, 12));

-- GDPR Art. 30 / Art. 17 — audit log for all data purges carried out under retention policy
CREATE TABLE IF NOT EXISTS data_deletion_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- client may be deleted later; preserve name for audit continuity
    client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
    client_name VARCHAR(255) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    records_deleted INTEGER NOT NULL DEFAULT 0,
    retention_months INTEGER NOT NULL,
    cutoff_date DATE NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deletion_log_client ON data_deletion_log(client_id);
CREATE INDEX IF NOT EXISTS idx_deletion_log_ts ON data_deletion_log(deleted_at DESC);

-- Web Push subscription storage (personal data — GDPR lawful basis: legitimate interest / consent)
-- endpoint is device-unique PII and must be protected accordingly
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exactly one of operator_id / portal_user_id must be set (enforced by CHECK below)
    operator_id UUID REFERENCES operators(id) ON DELETE CASCADE,
    portal_user_id UUID REFERENCES client_portal_users(id) ON DELETE CASCADE,
    -- Web Push fields (IETF RFC 8030 / RFC 8292)
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    -- GDPR: record when consent was given and subscriber's browser context
    consent_given_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent_hint VARCHAR(255),     -- browser family only — no full UA stored
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_push_subscriber CHECK (
        (operator_id IS NOT NULL AND portal_user_id IS NULL) OR
        (operator_id IS NULL  AND portal_user_id IS NOT NULL)
    )
);
-- One row per endpoint (device); upsert on re-subscribe
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_endpoint ON push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS idx_push_operator  ON push_subscriptions(operator_id);
CREATE INDEX IF NOT EXISTS idx_push_portal    ON push_subscriptions(portal_user_id);

-- ============================================================
-- v7: operator audit log, portal password reset tokens
-- ============================================================

-- Operator action audit log (GDPR Art. 30 / general compliance)
-- Append-only — never UPDATE or DELETE rows in this table.
CREATE TABLE IF NOT EXISTS operator_audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id   UUID REFERENCES operators(id) ON DELETE SET NULL,
    operator_name VARCHAR(100),          -- snapshot in case operator is later deleted
    action        VARCHAR(100) NOT NULL, -- e.g. 'operator.create', 'client.update', 'message.create'
    resource_type VARCHAR(50),           -- e.g. 'operator', 'client', 'message'
    resource_id   UUID,
    details       JSONB,                 -- additional context: changed fields, new values, etc.
    ip_address    INET,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_operator ON operator_audit_log(operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON operator_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON operator_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts       ON operator_audit_log(created_at DESC);

-- Portal password reset tokens (admin-generated; 24h TTL; single use)
CREATE TABLE IF NOT EXISTS portal_reset_tokens (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_user_id UUID NOT NULL REFERENCES client_portal_users(id) ON DELETE CASCADE,
    token_hash     VARCHAR(255) NOT NULL UNIQUE, -- bcrypt of random token — never store plaintext
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    used_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reset_token_user ON portal_reset_tokens(portal_user_id);

-- Additional system setting defaults (ON CONFLICT DO NOTHING — safe to re-run)
INSERT INTO system_settings (key, value) VALUES
    ('token_lifetime_hours', '2'),
    ('portal_token_lifetime_hours', '4')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- v8: HaloPSA per-client ticketing integration
-- ============================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS halo_psa_url VARCHAR(500);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS halo_oauth_client_id VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS halo_oauth_client_secret TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS halo_customer_id INTEGER;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS halo_ticket_type_id INTEGER;

-- ============================================================
-- v9: Appointment scheduling
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    message_id       UUID REFERENCES messages(id) ON DELETE SET NULL,
    operator_id      UUID REFERENCES operators(id) ON DELETE SET NULL,
    caller_name      VARCHAR(255),
    caller_phone     VARCHAR(50),
    caller_email     VARCHAR(255),
    appointment_at   TIMESTAMPTZ NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    service_type     VARCHAR(255),
    notes            TEXT,
    status           VARCHAR(30) NOT NULL DEFAULT 'confirmed'
                         CHECK (status IN ('confirmed','cancelled','completed','no_show','rescheduled')),
    reminder_sent_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appt_client  ON appointments(client_id, appointment_at);
CREATE INDEX IF NOT EXISTS idx_appt_status  ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appt_at      ON appointments(appointment_at);

-- ============================================================
-- v10: Two-way SMS inbox
-- ============================================================
CREATE TABLE IF NOT EXISTS sms_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
    direction           VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
    from_number         VARCHAR(50) NOT NULL,
    to_number           VARCHAR(50) NOT NULL,
    body                TEXT NOT NULL,
    provider            VARCHAR(30) NOT NULL DEFAULT 'twilio',
    provider_message_id VARCHAR(255),
    status              VARCHAR(30) NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received','read','replied','sent','failed')),
    operator_id         UUID REFERENCES operators(id) ON DELETE SET NULL,
    related_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_client  ON sms_messages(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_from    ON sms_messages(from_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_thread  ON sms_messages(from_number, to_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_provider_id ON sms_messages(provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- ============================================================
-- v11: Outbound callback campaigns
-- ============================================================
CREATE TABLE IF NOT EXISTS callback_campaigns (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id              UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name                   VARCHAR(255) NOT NULL,
    description            TEXT,
    status                 VARCHAR(30) NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','active','paused','completed','cancelled')),
    script                 TEXT,
    from_number            VARCHAR(50),
    max_attempts           INTEGER NOT NULL DEFAULT 3,
    retry_interval_minutes INTEGER NOT NULL DEFAULT 60,
    created_by             UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_client ON callback_campaigns(client_id);

CREATE TABLE IF NOT EXISTS callback_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id     UUID NOT NULL REFERENCES callback_campaigns(id) ON DELETE CASCADE,
    phone_number    VARCHAR(50) NOT NULL,
    caller_name     VARCHAR(255),
    notes           TEXT,
    status          VARCHAR(30) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_progress','completed','failed','opted_out')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    outcome_notes   TEXT,
    operator_id     UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cbrecord_campaign ON callback_records(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_cbrecord_next     ON callback_records(next_attempt_at)
    WHERE status = 'pending';

-- ============================================================
-- v12: Script template library
-- ============================================================
CREATE TABLE IF NOT EXISTS script_templates (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry         VARCHAR(100) NOT NULL,
    name             VARCHAR(255) NOT NULL,
    greeting         TEXT,
    script           TEXT NOT NULL,
    custom_form      JSONB NOT NULL DEFAULT '[]',
    delivery_actions JSONB NOT NULL DEFAULT '{"email":true,"sms":false,"phone_call":true}',
    is_system        BOOLEAN NOT NULL DEFAULT false,
    created_by       UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_template_industry ON script_templates(industry);

-- Seed built-in industry templates (idempotent)
INSERT INTO script_templates (industry, name, greeting, script, is_system) VALUES
('medical',
 'GP Surgery / Medical Practice',
 'Thank you for calling {{client_name}}. You''re through to the out-of-hours answering service.',
 E'Please take:\n- Patient full name\n- Date of birth\n- Contact number\n- Symptom / reason for calling\n- Whether they consider this urgent or can wait\n\nFor life-threatening emergencies: advise caller to dial 999 immediately.\nFor urgent (non-999): page the on-call GP and pass the message.\nFor routine: take message, advise callback within 2 working hours.',
 true),
('legal',
 'Law Firm / Solicitors',
 'Good {{time_of_day}}, you have reached {{client_name}}. Our office is currently closed. I''m taking messages on their behalf.',
 E'Please take:\n- Caller full name\n- Company / organisation (if applicable)\n- Contact number and best time to call\n- Matter reference number (if known)\n- Nature of enquiry (brief description)\n- Urgency: routine / today / urgent\n\nDo NOT give legal advice.\nFor urgent matters involving court deadlines or custody: escalate to on-call solicitor immediately.',
 true),
('property',
 'Estate Agency / Property Management',
 'Hello, you''re through to the answering service for {{client_name}}.',
 E'Please take:\n- Caller full name\n- Contact number\n- Property address or reference (if applicable)\n- Nature of enquiry:\n  □ Viewing request\n  □ Maintenance / repair\n  □ Rent / payment query\n  □ General enquiry\n\nFor maintenance emergencies (gas leak, flood, no heating in winter): contact the on-call maintenance team immediately.',
 true),
('veterinary',
 'Veterinary Practice',
 'Thank you for calling {{client_name}} out-of-hours service.',
 E'Please take:\n- Owner full name and contact number\n- Pet name, species and breed\n- Description of the problem\n- How long the animal has been unwell\n- Whether the animal is conscious and breathing normally\n\nFor life-threatening emergencies (difficulty breathing, collapse, suspected poisoning, road accident): direct to the nearest emergency vet or advise on-call vet immediately.\nFor non-emergency: take message, advise callback within 1 hour.',
 true),
('funeral',
 'Funeral Directors',
 'Good {{time_of_day}}, you''ve reached the answering service for {{client_name}}. I''m sorry for your loss.',
 E'Please take:\n- Caller name and relationship to the deceased\n- Contact telephone number\n- Name of the deceased (if known)\n- Location of the deceased (home / hospital / care home)\n- Whether a doctor has been called / death certified\n\nBe compassionate and patient. Do not rush the caller.\nAlert the on-call funeral director immediately for all first calls.',
 true),
('finance',
 'Financial Services / IFA',
 'Thank you for calling {{client_name}}. Our office is currently closed.',
 E'Please take:\n- Caller full name\n- Contact number\n- Client / policy reference (if known)\n- Nature of enquiry (general / urgent)\n\nDo NOT give financial advice.\nDo NOT discuss account balances or policy values.\nFor fraud or suspected unauthorised transactions: escalate to on-call compliance officer immediately.',
 true),
('utilities',
 'Utilities / Energy Provider',
 'You''ve reached the out-of-hours service for {{client_name}}.',
 E'Please take:\n- Customer name and account number\n- Contact telephone number\n- Service address / postcode\n- Nature of fault or enquiry\n\nFor gas emergencies: advise caller to call National Gas Emergency Service on 0800 111 999 immediately.\nFor power outages: advise caller to check their area on the network operator''s website.',
 true),
('it_support',
 'IT Support / Managed Services',
 'Thank you for calling {{client_name}} support line.',
 E'Please take:\n- Caller full name and company\n- Contact number\n- Ticket / asset reference (if known)\n- Description of the issue\n- Severity: P1 (system down / business critical) / P2 (major impact) / P3 (minor)\n\nFor P1 incidents: page on-call engineer immediately and escalate to account manager.\nFor P2/P3: take message and advise response within SLA.',
 true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- v13: Knowledge base, DNC list, CRM config, inbound email log
-- ============================================================

-- Per-client knowledge base articles (FAQs, procedures, reference)
CREATE TABLE IF NOT EXISTS knowledge_articles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,  -- NULL = global
    title       VARCHAR(500) NOT NULL,
    body        TEXT NOT NULL,
    category    VARCHAR(100),
    tags        TEXT[] NOT NULL DEFAULT '{}',
    is_published BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES operators(id) ON DELETE SET NULL,
    updated_by  UUID REFERENCES operators(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_client    ON knowledge_articles(client_id);
CREATE INDEX IF NOT EXISTS idx_kb_category  ON knowledge_articles(client_id, category);
CREATE INDEX IF NOT EXISTS idx_kb_published ON knowledge_articles(is_published);
CREATE INDEX IF NOT EXISTS idx_kb_fts       ON knowledge_articles
    USING gin(to_tsvector('english', title || ' ' || body));

-- Do Not Call list (per-client or global)
CREATE TABLE IF NOT EXISTS dnc_numbers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id  UUID REFERENCES clients(id) ON DELETE CASCADE,  -- NULL = global
    phone      VARCHAR(50) NOT NULL,
    reason     VARCHAR(255),
    added_by   UUID REFERENCES operators(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,  -- NULL = permanent
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_client_phone ON dnc_numbers(COALESCE(client_id::text,'global'), phone);
CREATE INDEX IF NOT EXISTS idx_dnc_phone ON dnc_numbers(phone);

-- CRM config per client (type + opaque JSONB to store creds without extra columns)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS crm_type      VARCHAR(50);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS crm_config    JSONB;
-- Inbound email address for this client (e.g. demo001@answers.spcalls.co.uk)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS inbound_email VARCHAR(500);

-- Inbound email log (emails received via webhook, converted to messages)
CREATE TABLE IF NOT EXISTS inbound_emails (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
    message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
    from_address  VARCHAR(500) NOT NULL,
    to_address    VARCHAR(500) NOT NULL,
    subject       VARCHAR(1000),
    body_text     TEXT,
    provider      VARCHAR(30) NOT NULL DEFAULT 'generic',
    provider_id   VARCHAR(500),
    raw_headers   JSONB,
    processed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbound_email_client ON inbound_emails(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_email_from   ON inbound_emails(from_address);

-- ============================================================
-- v14: Skills, routing rules, voicemail transcripts, DIDs, API keys
-- ============================================================

-- Operator skills (e.g. languages, certifications, verticals)
ALTER TABLE operators ADD COLUMN IF NOT EXISTS skills           TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE operators ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(20) DEFAULT 'en';

-- Voicemail transcript on call_logs
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_transcript TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcript_summary   TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS transcribed_at       TIMESTAMPTZ;

-- Geographic / area-code routing rules
CREATE TABLE IF NOT EXISTS routing_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    match_area_code VARCHAR(20),    -- e.g. '01604' (UK Northampton) or '+44'
    match_country   VARCHAR(10),    -- ISO country code, e.g. 'GB', 'US'
    match_did       VARCHAR(50),    -- match by called DID
    client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
    target_skills   TEXT[] NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 100,  -- lower = higher priority
    is_active       BOOLEAN NOT NULL DEFAULT true,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_routing_priority ON routing_rules(priority) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_routing_area     ON routing_rules(match_area_code);
CREATE INDEX IF NOT EXISTS idx_routing_did      ON routing_rules(match_did);

-- DID (number) management — central registry of every phone number this service answers
CREATE TABLE IF NOT EXISTS did_numbers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number            VARCHAR(50) NOT NULL UNIQUE,
    label             VARCHAR(255),
    client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
    greeting_override TEXT,
    routing_profile   VARCHAR(100),
    provider          VARCHAR(50),       -- 'twilio', 'sipgate', 'gradwell', etc.
    provider_sid      VARCHAR(255),      -- provider's number SID
    monthly_cost      DECIMAL(10,2),
    is_active         BOOLEAN NOT NULL DEFAULT true,
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_did_client ON did_numbers(client_id);
CREATE INDEX IF NOT EXISTS idx_did_active ON did_numbers(is_active);

-- API keys for client portal users (programmatic access to their own data)
CREATE TABLE IF NOT EXISTS portal_api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_user_id  UUID NOT NULL REFERENCES client_portal_users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    key_hash        VARCHAR(255) NOT NULL UNIQUE,  -- bcrypt of plaintext key
    key_prefix      VARCHAR(20) NOT NULL,          -- first 8 chars shown in UI
    scopes          JSONB NOT NULL DEFAULT '["messages:read"]',
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                   -- NULL = never expires
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_key_user ON portal_api_keys(portal_user_id);
CREATE INDEX IF NOT EXISTS idx_portal_key_active ON portal_api_keys(portal_user_id) WHERE revoked_at IS NULL;




-- ============================================================
-- v15 — Operator scheduling, time-off, voicemail boxes, IVR flows
-- ============================================================

-- Operator shift schedule
CREATE TABLE IF NOT EXISTS operator_shifts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id  UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    shift_date   DATE NOT NULL,
    start_time   TIME NOT NULL,
    end_time     TIME NOT NULL,
    shift_type   TEXT NOT NULL DEFAULT 'regular' CHECK (shift_type IN ('regular','oncall','training')),
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shifts_operator ON operator_shifts(operator_id);
CREATE INDEX IF NOT EXISTS idx_shifts_date     ON operator_shifts(shift_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_op_date_time
    ON operator_shifts(operator_id, shift_date, start_time);

-- Time-off requests
CREATE TABLE IF NOT EXISTS time_off_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id  UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    from_date    DATE NOT NULL,
    to_date      DATE NOT NULL,
    reason       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
    reviewed_by  UUID REFERENCES operators(id),
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_timeoff_operator ON time_off_requests(operator_id);
CREATE INDEX IF NOT EXISTS idx_timeoff_status   ON time_off_requests(status);

-- Per-client voicemail box definitions
CREATE TABLE IF NOT EXISTS voicemail_boxes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    mailbox_number      TEXT NOT NULL UNIQUE,
    pin                 TEXT NOT NULL,
    greeting_url        TEXT,
    max_message_seconds INT NOT NULL DEFAULT 120,
    retention_days      INT NOT NULL DEFAULT 30,
    notify_email        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voicemail_client ON voicemail_boxes(client_id);

-- IVR flow builder (JSONB node graph → exported to Asterisk dialplan)
CREATE TABLE IF NOT EXISTS ivr_flows (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    nodes      JSONB NOT NULL DEFAULT '[]',
    is_active  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ivr_client ON ivr_flows(client_id);

-- ============================================================
-- v16 — Webhook dead-letter log, per-client SLA abandon threshold
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_delivery_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    attempt     INT NOT NULL DEFAULT 1,
    status_code INT,
    error       TEXT,
    sent_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wdl_message ON webhook_delivery_log(message_id);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS sla_abandon_threshold INT NOT NULL DEFAULT 3;

-- ============================================================
-- v17 — Operator self-service password reset
-- ============================================================

CREATE TABLE IF NOT EXISTS operator_reset_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    token_hash    VARCHAR(255) NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_op_reset_token_op ON operator_reset_tokens(operator_id);


-- ============================================================
-- v18 — TOTP backup codes column
-- ============================================================

ALTER TABLE operators ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================
-- v19 — Operator notification preferences
-- ============================================================

ALTER TABLE operators ADD COLUMN IF NOT EXISTS notify_new_message BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS notify_missed_call BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS notify_sla_breach  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS notify_escalation  BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- v20 — CSAT surveys, scheduled reports, contact tags
-- ============================================================

CREATE TABLE IF NOT EXISTS csat_surveys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id  UUID REFERENCES call_logs(id) ON DELETE SET NULL,
  client_id    UUID REFERENCES clients(id) ON DELETE CASCADE,
  token        UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  sent_at      TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  rating       SMALLINT CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_csat_surveys_call_log ON csat_surveys(call_log_id);
CREATE INDEX IF NOT EXISTS idx_csat_surveys_client ON csat_surveys(client_id);
CREATE INDEX IF NOT EXISTS idx_csat_surveys_token ON csat_surveys(token);

CREATE TABLE IF NOT EXISTS report_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type   TEXT NOT NULL CHECK (report_type IN ('calls','messages','performance','sla')),
  frequency     TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  recipients    TEXT[] NOT NULL DEFAULT '{}',
  client_id     UUID REFERENCES clients(id) ON DELETE CASCADE,
  last_sent_at  TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES operators(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run_at) WHERE is_active = true;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS csat_enabled BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- v21 — Custom form data in messages, operator performance targets
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS form_data JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'operator';

CREATE TABLE IF NOT EXISTS operator_targets (
  operator_id       UUID PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  calls_per_day     INT NOT NULL DEFAULT 0,
  messages_per_day  INT NOT NULL DEFAULT 0,
  qa_score_target   INT NOT NULL DEFAULT 0 CHECK (qa_score_target BETWEEN 0 AND 100),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- v22 — Client message templates
-- ============================================================

CREATE TABLE IF NOT EXISTS message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  subject     TEXT,
  body        TEXT NOT NULL DEFAULT '',
  call_type   TEXT NOT NULL DEFAULT 'standard',
  urgency     TEXT NOT NULL DEFAULT 'normal',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msg_templates_client ON message_templates(client_id);

-- ============================================================
-- v23 — Client holidays/closures, SLA alert log
-- ============================================================

CREATE TABLE IF NOT EXISTS client_holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID REFERENCES clients(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL,
  closure_type TEXT NOT NULL DEFAULT 'closed' CHECK (closure_type IN ('closed','reduced','emergency_only')),
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_holidays_date ON client_holidays(client_id, holiday_date);

CREATE TABLE IF NOT EXISTS sla_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
  alert_type  TEXT NOT NULL DEFAULT 'pre_breach',
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sla_alerts_msg ON sla_alerts(message_id);

-- Message acknowledgment SLA in minutes (distinct from call answer SLA in seconds)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sla_minutes INTEGER NOT NULL DEFAULT 60;

-- v24 — Message tags
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_messages_tags ON messages USING GIN(tags);

-- v25 — Internal operator notes on messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- v26 — Message assignment (distinct from operator_id who took the call)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES operators(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_assigned_to ON messages(assigned_to) WHERE assigned_to IS NOT NULL;

-- v27 — Portal message replies (operator responses to portal enquiries)
CREATE TABLE IF NOT EXISTS message_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  operator_id UUID REFERENCES operators(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_replies_msg ON message_replies(message_id);

-- v28 — Portal message ratings (client-side CSAT for message interactions)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS portal_rating         SMALLINT CHECK (portal_rating BETWEEN 1 AND 5);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS portal_rating_comment TEXT;

-- v29 — Two-way portal replies + message flagging
ALTER TABLE message_replies ADD COLUMN IF NOT EXISTS portal_user_id UUID REFERENCES client_portal_users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(is_flagged) WHERE is_flagged = true;

-- v30 — Contact custom fields + broadcast message tracking
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source VARCHAR(50);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id) WHERE broadcast_id IS NOT NULL;

-- v31 — Public widget token per client + KB article helpfulness ratings + widget callback source
ALTER TABLE clients ADD COLUMN IF NOT EXISTS widget_token           VARCHAR(64) UNIQUE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_reply_enabled     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_reply_subject     TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_reply_body        TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS disposition_notes    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS archived_at           TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS portal_read_at        TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_classification     JSONB;
CREATE INDEX IF NOT EXISTS idx_messages_archived ON messages(archived_at) WHERE archived_at IS NOT NULL;

-- v32 — Operator-to-client assignment (restricts which clients an operator sees)
CREATE TABLE IF NOT EXISTS operator_client_assignments (
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES clients(id)   ON DELETE CASCADE,
  PRIMARY KEY (operator_id, client_id)
);
ALTER TABLE knowledge_articles ADD COLUMN IF NOT EXISTS helpful_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_articles ADD COLUMN IF NOT EXISTS not_helpful_count INTEGER NOT NULL DEFAULT 0;
-- Allow campaign_id to be NULL for widget/ad-hoc callback requests
ALTER TABLE callback_records ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE callback_records ADD COLUMN IF NOT EXISTS client_id  UUID REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE callback_records ADD COLUMN IF NOT EXISTS caller_phone VARCHAR(50);
ALTER TABLE callback_records ADD COLUMN IF NOT EXISTS source VARCHAR(30) NOT NULL DEFAULT 'campaign';
CREATE INDEX IF NOT EXISTS idx_cbrecord_client ON callback_records(client_id) WHERE client_id IS NOT NULL;

-- ============================================================
-- v33 — Call queue + Intake form submissions
-- ============================================================

-- call_queue: tracks inbound calls waiting for an available operator
CREATE TABLE IF NOT EXISTS call_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL,
  caller_number   VARCHAR(50),
  caller_name     TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  position        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','connecting','answered','abandoned','timed_out')),
  operator_id     UUID REFERENCES operators(id) ON DELETE SET NULL,
  answered_at     TIMESTAMPTZ,
  abandoned_at    TIMESTAMPTZ,
  wait_seconds    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_call_queue_status  ON call_queue(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_call_queue_client  ON call_queue(client_id);

-- intake_form_submissions: stores public widget intake form responses
CREATE TABLE IF NOT EXISTS intake_form_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
  form_data     JSONB NOT NULL DEFAULT '{}',
  submitter_ip  TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intake_submissions_client  ON intake_form_submissions(client_id);
CREATE INDEX IF NOT EXISTS idx_intake_submissions_msg     ON intake_form_submissions(message_id);

-- ============================================================
-- v34 — Operator SIP extensions + conference bridge log
-- ============================================================
ALTER TABLE operators ADD COLUMN IF NOT EXISTS sip_extension VARCHAR(20);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS display_name  VARCHAR(100);

CREATE TABLE IF NOT EXISTS conference_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_id       TEXT NOT NULL,
  initiator_id    UUID REFERENCES operators(id) ON DELETE SET NULL,
  call_log_id     UUID REFERENCES call_logs(id) ON DELETE SET NULL,
  participants    JSONB NOT NULL DEFAULT '[]',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conf_sessions_call ON conference_sessions(call_log_id);
