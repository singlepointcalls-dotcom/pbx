'use strict';

/**
 * IMAP email polling service — pull-based fallback when webhooks aren't an option.
 *
 * Required env vars (all optional — if any missing, polling is disabled):
 *   IMAP_HOST          - e.g. imap.gmail.com
 *   IMAP_PORT          - default 993
 *   IMAP_USER          - mailbox username
 *   IMAP_PASS          - mailbox password / app password
 *   IMAP_TLS           - 'true' | 'false' (default true)
 *   IMAP_POLL_SECONDS  - poll interval (default 60)
 *   IMAP_MAILBOX       - mailbox name (default 'INBOX')
 */

const { ImapFlow } = require('imapflow');
const pool = require('../config/database');
const ai = require('./ai');
const { broadcast } = require('./realtime');

let pollTimer = null;

function isConfigured() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

async function processOne(client, seq) {
  const { content, envelope } = await client.fetchOne(seq, { envelope: true, source: true });
  if (!envelope) return;

  const from = envelope.from?.[0]?.address || 'unknown';
  const to   = envelope.to?.[0]?.address || 'unknown';
  const subject = envelope.subject || '';
  const body = content?.toString('utf8') || '';

  // Strip headers from raw source — naive: take after first blank line
  const blankIdx = body.indexOf('\r\n\r\n');
  const text = blankIdx >= 0 ? body.slice(blankIdx + 4) : body;

  // Match client by inbound_email or account_number prefix
  const toLocal = (to.split('@')[0] || '').toUpperCase();
  const cr = await pool.query(
    `SELECT id FROM clients
     WHERE (inbound_email = $1 OR UPPER(account_number) = $2) AND is_active = true
     LIMIT 1`,
    [to.toLowerCase(), toLocal]
  );
  const clientId = cr.rows[0]?.id || null;

  // AI urgency
  let urgency = 'normal';
  if (text) {
    const c = await ai.classifyMessage({ subject, body: text }).catch(() => null);
    if (c?.urgency) urgency = c.urgency;
  }

  // Log inbound email
  const logRes = await pool.query(
    `INSERT INTO inbound_emails (client_id, from_address, to_address, subject, body_text, provider, processed_at)
     VALUES ($1,$2,$3,$4,$5,'imap',NOW())
     RETURNING id`,
    [clientId, from, to, subject, text]
  );

  if (!clientId) return;

  // Create message
  const msg = await pool.query(
    `INSERT INTO messages (client_id, caller_name, subject, body, urgency, status, call_type)
     VALUES ($1,$2,$3,$4,$5,'pending','email_inbound')
     RETURNING id`,
    [clientId, envelope.from?.[0]?.name || from, subject || 'Email enquiry', text || '(no body)', urgency]
  );

  await pool.query('UPDATE inbound_emails SET message_id = $1 WHERE id = $2',
    [msg.rows[0].id, logRes.rows[0].id]);

  broadcast('message:new', { messageId: msg.rows[0].id, clientId, source: 'email_imap' });
}

async function pollOnce() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: process.env.IMAP_TLS !== 'false',
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX');
    try {
      // Fetch all UNSEEN messages
      const seqs = await client.search({ seen: false }, { uid: true });
      for (const uid of seqs) {
        try {
          await processOne(client, { uid });
          await client.messageFlagsAdd({ uid }, ['\\Seen']);
        } catch (err) {
          console.warn(`IMAP message ${uid} failed:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function startImapPolling() {
  if (!isConfigured()) {
    console.log('IMAP polling disabled (IMAP_HOST/USER/PASS not set)');
    return;
  }
  const intervalMs = parseInt(process.env.IMAP_POLL_SECONDS || '60') * 1000;
  console.log(`IMAP polling every ${intervalMs / 1000}s on ${process.env.IMAP_HOST}`);

  // Run immediately, then on interval
  pollOnce().catch((e) => console.warn('IMAP poll failed:', e.message));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => console.warn('IMAP poll failed:', e.message));
  }, intervalMs);
}

function stopImapPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = { startImapPolling, stopImapPolling, _pollOnce: pollOnce };
