'use strict';

const pool = require('../config/database');
const { deliverMessage } = require('./delivery');

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

async function runEscalationCheck() {
  try {
    // Find messages that:
    // 1. Have been delivered (status = 'delivered')
    // 2. Have NOT been acknowledged
    // 3. Were created more than the client's first escalation rule threshold ago
    // 4. Have NOT already been escalated
    const result = await pool.query(`
      SELECT m.id, m.client_id, m.created_at, m.escalated_at,
             c.escalation_rules, c.name AS client_name
      FROM messages m
      JOIN clients c ON m.client_id = c.id
      WHERE m.status = 'delivered'
        AND m.acknowledged_at IS NULL
        AND m.escalated_at IS NULL
        AND c.escalation_rules != '[]'
        AND c.escalation_rules IS NOT NULL
    `);

    for (const msg of result.rows) {
      const rules = msg.escalation_rules || [];
      if (!rules.length) continue;

      // Check if oldest rule threshold has passed
      const firstRule = rules[0];
      const afterMs = (firstRule.after_minutes || 15) * 60 * 1000;
      const msgAge = Date.now() - new Date(msg.created_at).getTime();

      if (msgAge >= afterMs) {
        console.log(`[Escalation] Escalating message ${msg.id} for client ${msg.client_name}`);
        // Mark as escalated to prevent re-escalation
        await pool.query('UPDATE messages SET escalated_at = NOW() WHERE id = $1', [msg.id]);
        // Re-deliver the message (will go to all contacts again)
        try {
          await deliverMessage(msg.id);
        } catch (err) {
          console.error(`[Escalation] Delivery failed for ${msg.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[Escalation] Check failed:', err.message);
  }
}

function startEscalationService() {
  console.log('[Escalation] Service started — checking every 2 minutes');
  setInterval(runEscalationCheck, CHECK_INTERVAL_MS);
  // Run once on startup after a short delay
  setTimeout(runEscalationCheck, 10000);
}

module.exports = { startEscalationService };
