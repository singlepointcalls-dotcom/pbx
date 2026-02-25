'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin', 'supervisor'));

// GET /api/audit — list audit log entries, most-recent first, paginated
// Query params: operator_id, action, resource_type, from (ISO date), to (ISO date), page, limit
router.get('/', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;

    const { operator_id, action, resource_type, from, to } = req.query;
    const conditions = [];
    const params     = [];

    if (operator_id)   { params.push(parseInt(operator_id)); conditions.push(`operator_id = $${params.length}`); }
    if (action)        { params.push(action);        conditions.push(`action = $${params.length}`); }
    if (resource_type) { params.push(resource_type); conditions.push(`resource_type = $${params.length}`); }
    if (from)          { params.push(from);          conditions.push(`ts >= $${params.length}`); }
    if (to)            { params.push(to);            conditions.push(`ts <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rowResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, operator_id, operator_name, action, resource_type, resource_id,
                details, ip_address, user_agent, ts
         FROM operator_audit_log
         ${where}
         ORDER BY ts DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM operator_audit_log ${where}`, params),
    ]);

    res.json({
      entries: rowResult.rows,
      total:   parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) { next(err); }
});

module.exports = router;
