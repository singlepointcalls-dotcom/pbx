'use strict';

/**
 * Callback Campaign Execution Service
 *
 * Polls every 60 s for pending callback records whose next_attempt_at <= NOW()
 * and whose parent campaign is 'active'. For each record, it looks for an
 * available (online) operator, then originates the outbound call via ARI.
 *
 * If ARI is not connected the tick is skipped silently — calls will resume
 * when connectivity is restored.
 */

const pool = require('../config/database');
const { originateOutbound, isConnected } = require('../asterisk/ari');

const POLL_INTERVAL_MS = 60_000;
const MAX_CONCURRENT   = parseInt(process.env.CALLBACK_MAX_CONCURRENT || '3', 10);

let _running = 0;

async function executeTick() {
  if (!isConnected()) return;
  if (_running >= MAX_CONCURRENT) return;

  let records;
  try {
    // Fetch pending records that are due, belong to an active campaign
    const result = await pool.query(`
      SELECT cr.id, cr.campaign_id, cr.phone_number, cr.caller_name, cr.attempts,
             cc.max_attempts, cc.retry_interval_minutes, cc.from_number,
             cc.client_id, c.outbound_caller_id
        FROM callback_records cr
        JOIN callback_campaigns cc ON cr.campaign_id = cc.id
        JOIN clients c ON cc.client_id = c.id
       WHERE cr.status = 'pending'
         AND cc.status = 'active'
         AND (cr.next_attempt_at IS NULL OR cr.next_attempt_at <= NOW())
       ORDER BY cr.next_attempt_at ASC NULLS FIRST
       LIMIT $1
    `, [MAX_CONCURRENT - _running]);
    records = result.rows;
  } catch (err) {
    console.error('[CallbackExecutor] DB query error:', err.message);
    return;
  }

  if (!records.length) return;

  // Find an available online operator extension
  let operatorExt;
  try {
    const opResult = await pool.query(`
      SELECT extension FROM operators
      WHERE is_active = true AND current_status = 'available' AND extension IS NOT NULL
      ORDER BY RANDOM() LIMIT 1
    `);
    operatorExt = opResult.rows[0]?.extension;
  } catch { /* skip if operator lookup fails */ }

  for (const rec of records) {
    if (_running >= MAX_CONCURRENT) break;
    _running++;

    // Mark as in_progress immediately to prevent double-dial
    try {
      await pool.query(
        `UPDATE callback_records
            SET status = 'in_progress', last_attempt_at = NOW(), attempts = attempts + 1
          WHERE id = $1 AND status = 'pending'`,
        [rec.id]
      );
    } catch (err) {
      _running--;
      continue;
    }

    // Originate the call
    const callerIdExt = operatorExt || process.env.CALLBACK_DEFAULT_EXTENSION || '100';
    originateOutbound(callerIdExt, rec.phone_number, rec.client_id)
      .then(() => {
        pool.query(
          `UPDATE callback_records SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [rec.id]
        ).catch(() => {});
      })
      .catch(async (err) => {
        console.warn(`[CallbackExecutor] Dial failed for record ${rec.id}: ${err.message}`);
        const nextAttempts = rec.attempts + 1;
        if (nextAttempts >= rec.max_attempts) {
          await pool.query(
            `UPDATE callback_records SET status = 'failed', outcome_notes = $1 WHERE id = $2`,
            [`Failed after ${nextAttempts} attempts: ${err.message}`, rec.id]
          ).catch(() => {});
        } else {
          const retryAfterMs = (rec.retry_interval_minutes || 60) * 60_000;
          await pool.query(
            `UPDATE callback_records
                SET status = 'pending', next_attempt_at = NOW() + $1::interval
              WHERE id = $2`,
            [`${rec.retry_interval_minutes || 60} minutes`, rec.id]
          ).catch(() => {});
        }
      })
      .finally(() => { _running--; });
  }
}

function startCallbackExecutor() {
  console.log('[CallbackExecutor] Started — polling every 60 s');
  setInterval(() => executeTick().catch((err) =>
    console.error('[CallbackExecutor] Tick error:', err.message)
  ), POLL_INTERVAL_MS);
  // Run once at startup after a short delay
  setTimeout(() => executeTick().catch(() => {}), 5000);
}

module.exports = { startCallbackExecutor };
