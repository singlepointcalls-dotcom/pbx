'use strict';

/**
 * GDPR Data Retention Service
 *
 * Runs once per day and automatically deletes personal data older than each
 * client's configured retention period.  Every purge is recorded in
 * data_deletion_log to satisfy GDPR Art. 30 (records of processing) and
 * Art. 17 (right to erasure / storage limitation).
 *
 * Tables purged:
 *   messages          — caller name/phone/company, message body (PII)
 *   call_logs         — caller ID number/name, recording URL (PII)
 *   message_deliveries — destination email/phone/webhook URLs (personal data)
 *   call_qa_scores    — linked to call_logs; deleted on FK CASCADE
 *
 * Billing reports are NOT purged (financial records, legitimate basis for
 * retention beyond the call-data period — typically 7 years under UK law).
 *
 * Operator chat / breaks / shifts are internal operational records and are
 * not subject to the client-level retention policy (separate DSAR process).
 */

const pool = require('../config/database');

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24 hours

// Tables to purge, in dependency order (children before parents to avoid FK
// violations for tables that don't cascade).
// message_deliveries cascade from messages — handled automatically.
// call_qa_scores cascade from call_logs — handled automatically.
const PURGE_STEPS = [
  {
    table:    'messages',
    // client_id direct column, age based on created_at
    buildSql: (clientId, cutoff) => ({
      sql:    `DELETE FROM messages WHERE client_id = $1 AND created_at < $2`,
      params: [clientId, cutoff],
    }),
  },
  {
    table:    'call_logs',
    buildSql: (clientId, cutoff) => ({
      sql:    `DELETE FROM call_logs WHERE client_id = $1 AND call_start < $2`,
      params: [clientId, cutoff],
    }),
  },
];

async function runRetentionPurge() {
  console.log('[Retention] Starting GDPR retention purge');

  let clients;
  try {
    const result = await pool.query(
      `SELECT id, name, data_retention_months
       FROM clients
       WHERE is_active = true
       ORDER BY name`
    );
    clients = result.rows;
  } catch (err) {
    console.error('[Retention] Failed to load clients:', err.message);
    return;
  }

  for (const client of clients) {
    const months  = client.data_retention_months || 12;
    const cutoff  = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    for (const step of PURGE_STEPS) {
      try {
        const { sql, params } = step.buildSql(client.id, cutoff);
        const result = await pool.query(sql, params);
        const count  = result.rowCount || 0;

        if (count > 0) {
          // Write GDPR audit record — do not suppress errors on this
          await pool.query(
            `INSERT INTO data_deletion_log
               (client_id, client_name, table_name, records_deleted,
                retention_months, cutoff_date)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              client.id,
              client.name,
              step.table,
              count,
              months,
              cutoff.toISOString().split('T')[0],
            ]
          );
          console.log(
            `[Retention] ${client.name}: deleted ${count} rows from ${step.table} ` +
            `(retention=${months}m, cutoff=${cutoff.toISOString().split('T')[0]})`
          );
        }
      } catch (err) {
        // Log but continue — do not abort the entire run for one client/table
        console.error(
          `[Retention] Error purging ${step.table} for client ${client.name}:`,
          err.message
        );
      }
    }
  }

  console.log('[Retention] Purge run complete');
}

function startRetentionService() {
  console.log('[Retention] GDPR data retention service started — runs every 24 hours');
  // Stagger first run: 1 minute after startup (avoids hammering DB on boot)
  setTimeout(runRetentionPurge, 60 * 1000);
  setInterval(runRetentionPurge, RUN_INTERVAL_MS);
}

module.exports = { startRetentionService, runRetentionPurge };
