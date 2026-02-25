'use strict';

/**
 * Operator Audit Logging Service
 *
 * Provides a single `log(req, action, opts)` function that appends a row to
 * operator_audit_log. Designed to be fire-and-forget — never throws. Failed
 * audit writes are logged to stderr so they can be caught by the host logging
 * system, but they never interrupt the API response flow.
 *
 * Usage:
 *   const audit = require('../../services/audit');
 *   await audit.log(req, 'message.create', { resourceId: message.id, details: { client_id } });
 *
 * Action naming convention: <resource>.<verb>
 *   operator.login | operator.login_failed | operator.create | operator.update | operator.delete
 *   client.update  | settings.update       | message.create  | message.deliver
 *   csv.export     | portal_user.create    | portal_user.delete | portal_user.password_reset
 */

const pool = require('../config/database');

/**
 * @param {import('express').Request} req
 * @param {string} action   e.g. 'message.create'
 * @param {{ resourceType?: string, resourceId?: string, details?: object }} [opts]
 */
async function log(req, action, opts = {}) {
  try {
    const operator = req.operator;
    // Truncate user-agent to avoid storing excessive PII
    const ua = typeof req.headers?.['user-agent'] === 'string'
      ? req.headers['user-agent'].substring(0, 200)
      : null;

    await pool.query(
      `INSERT INTO operator_audit_log
         (operator_id, operator_name, action, resource_type, resource_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)`,
      [
        operator?.id   ?? null,
        operator?.username ?? opts.actorName ?? null,
        action,
        opts.resourceType ?? null,
        opts.resourceId   ?? null,
        opts.details ? JSON.stringify(opts.details) : null,
        req.ip ?? null,
        ua,
      ]
    );
  } catch (err) {
    // Non-fatal — log to stderr and continue
    console.error('[Audit] Failed to write audit log entry:', err.message,
      { action, ip: req.ip });
  }
}

module.exports = { log };
