'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../../services/audit');

router.use(requireAuth);

// Normalise phone — strip all non-digits and leading zeros for comparison
function normalisePhone(phone) {
  return (phone || '').replace(/\D/g, '').replace(/^0+/, '');
}

// GET /api/dnc?client_id=
router.get('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const params = [];
    let filter = '';
    if (client_id) { params.push(client_id); filter = `AND (client_id = $${params.length} OR client_id IS NULL)`; }

    const result = await pool.query(
      `SELECT d.*, o.full_name AS added_by_name
       FROM dnc_numbers d
       LEFT JOIN operators o ON d.added_by = o.id
       WHERE (expires_at IS NULL OR expires_at > NOW()) ${filter}
       ORDER BY d.created_at DESC`,
      params
    );
    res.json({ numbers: result.rows });
  } catch (err) { next(err); }
});

// POST /api/dnc/check — check if a number is on the DNC list (all operators)
router.post('/check', async (req, res, next) => {
  try {
    const { phone, client_id } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const norm = normalisePhone(phone);
    const result = await pool.query(
      `SELECT id, reason, expires_at, client_id
       FROM dnc_numbers
       WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') LIKE $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (client_id IS NULL OR client_id = $2)
       LIMIT 1`,
      [`%${norm}`, client_id || null]
    );
    res.json({ on_dnc: result.rows.length > 0, entry: result.rows[0] || null });
  } catch (err) { next(err); }
});

// POST /api/dnc — add number(s)
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    const inserted = [];

    for (const entry of entries) {
      if (!entry.phone) continue;
      const r = await pool.query(
        `INSERT INTO dnc_numbers (client_id, phone, reason, added_by, expires_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (COALESCE(client_id::text,'global'), phone) DO UPDATE
           SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, added_by = EXCLUDED.added_by
         RETURNING *`,
        [entry.client_id || null, entry.phone, entry.reason || null, req.operator.id, entry.expires_at || null]
      );
      inserted.push(r.rows[0]);
    }
    await audit.log(req, 'dnc.add', { count: inserted.length });
    res.status(201).json({ numbers: inserted, count: inserted.length });
  } catch (err) { next(err); }
});

// DELETE /api/dnc/:id
router.delete('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM dnc_numbers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'DNC entry not found' });
    await audit.log(req, 'dnc.remove', { resourceId: req.params.id });
    res.json({ message: 'Removed from DNC list' });
  } catch (err) { next(err); }
});

// DELETE /api/dnc/phone/:phone — remove by phone number
router.delete('/phone/:phone', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM dnc_numbers WHERE phone = $1 RETURNING id', [req.params.phone]
    );
    res.json({ removed: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
