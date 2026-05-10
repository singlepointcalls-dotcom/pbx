'use strict';

/**
 * Global search — messages, contacts, clients, call logs.
 * GET /api/search?q=<term>&limit=20
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    const limit = Math.min(parseInt(req.query.limit || '20'), 50);
    const term = `%${q}%`;

    const [messages, contacts, clients, calls] = await Promise.all([
      // Messages — search body, subject, caller name/phone
      pool.query(
        `SELECT 'message' AS type, m.id, m.subject AS title,
                SUBSTRING(m.body, 1, 120) AS snippet,
                m.created_at, c.name AS client_name, m.urgency, m.status
         FROM messages m
         LEFT JOIN clients c ON m.client_id = c.id
         WHERE m.body ILIKE $1 OR m.subject ILIKE $1
            OR m.caller_name ILIKE $1 OR m.caller_phone ILIKE $1
         ORDER BY m.created_at DESC LIMIT $2`,
        [term, limit]
      ),

      // Contacts — search name, email, phone
      pool.query(
        `SELECT 'contact' AS type, ct.id, ct.name AS title,
                ct.email AS snippet,
                ct.created_at, c.name AS client_name, NULL AS urgency, NULL AS status
         FROM contacts ct
         LEFT JOIN clients c ON ct.client_id = c.id
         WHERE ct.name ILIKE $1 OR ct.email ILIKE $1 OR ct.phone ILIKE $1
         ORDER BY ct.name ASC LIMIT $2`,
        [term, limit]
      ),

      // Clients
      pool.query(
        `SELECT 'client' AS type, c.id, c.name AS title,
                c.account_number AS snippet,
                c.created_at, NULL AS client_name, NULL AS urgency,
                CASE WHEN c.is_active THEN 'active' ELSE 'inactive' END AS status
         FROM clients c
         WHERE c.name ILIKE $1 OR c.account_number ILIKE $1
            OR c.phone ILIKE $1
         ORDER BY c.name ASC LIMIT $2`,
        [term, limit]
      ),

      // Call logs — search caller ID, notes
      pool.query(
        `SELECT 'call' AS type, cl.id, cl.caller_id_name AS title,
                cl.disposition AS snippet,
                cl.call_start AS created_at, c.name AS client_name,
                NULL AS urgency, cl.disposition AS status
         FROM call_logs cl
         LEFT JOIN clients c ON cl.client_id = c.id
         WHERE cl.caller_id_name ILIKE $1 OR cl.caller_id_num ILIKE $1
            OR cl.disposition_notes ILIKE $1
         ORDER BY cl.call_start DESC LIMIT $2`,
        [term, limit]
      ),
    ]);

    const all = [
      ...messages.rows,
      ...contacts.rows,
      ...clients.rows,
      ...calls.rows,
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);

    res.json({ results: all, counts: {
      messages: messages.rowCount,
      contacts: contacts.rowCount,
      clients:  clients.rowCount,
      calls:    calls.rowCount,
    }});
  } catch (err) { next(err); }
});

module.exports = router;
