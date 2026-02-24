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
