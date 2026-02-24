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
    notify_webhook BOOLEAN NOT NULL DEFAULT false,
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
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'webhook', 'inapp')),
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
