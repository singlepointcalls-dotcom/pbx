'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../../services/audit');

router.use(requireAuth);

// GET /api/routing-rules
router.get('/', async (req, res, next) => {
  try {
    const { client_id, active } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (client_id)        { params.push(client_id); where += ` AND r.client_id = $${params.length}`; }
    if (active === 'true')  where += ' AND r.is_active = true';
    if (active === 'false') where += ' AND r.is_active = false';

    const result = await pool.query(
      `SELECT r.*, c.name AS client_name
       FROM routing_rules r
       LEFT JOIN clients c ON r.client_id = c.id
       ${where}
       ORDER BY r.priority ASC, r.created_at DESC`,
      params
    );
    res.json({ rules: result.rows });
  } catch (err) { next(err); }
});

// POST /api/routing-rules/match — given an inbound caller context, find the best routing rule
router.post('/match', async (req, res, next) => {
  try {
    const { caller_number, did, country } = req.body;
    if (!caller_number && !did) return res.status(400).json({ error: 'caller_number or did is required' });

    // Build candidate area-code prefixes from caller_number (longest first)
    const prefixes = [];
    if (caller_number) {
      const norm = caller_number.replace(/\s+/g, '');
      for (let len = norm.length; len >= 3; len--) prefixes.push(norm.slice(0, len));
    }

    const result = await pool.query(
      `SELECT * FROM routing_rules
       WHERE is_active = true
         AND (
           ($1::text IS NOT NULL AND match_did = $1)
           OR ($2::text IS NOT NULL AND match_country = $2)
           OR ($3::text[] IS NOT NULL AND match_area_code = ANY($3))
         )
       ORDER BY priority ASC, length(COALESCE(match_did, match_area_code, '')) DESC
       LIMIT 1`,
      [did || null, country || null, prefixes.length ? prefixes : null]
    );

    if (!result.rows[0]) return res.json({ rule: null });

    // Find available operators for this rule's target_skills
    const rule = result.rows[0];
    let operators = [];
    if (rule.target_skills?.length > 0) {
      const opRes = await pool.query(
        `SELECT id, full_name, current_status FROM operators
         WHERE is_active = true AND skills @> $1::text[]
         ORDER BY CASE current_status WHEN 'ready' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END`,
        [rule.target_skills]
      );
      operators = opRes.rows;
    }

    res.json({ rule, eligible_operators: operators });
  } catch (err) { next(err); }
});

// POST /api/routing-rules
router.post('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, match_area_code, match_country, match_did, client_id,
      target_skills = [], priority = 100, notes,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await pool.query(
      `INSERT INTO routing_rules
         (name, match_area_code, match_country, match_did, client_id, target_skills, priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [name, match_area_code || null, match_country || null, match_did || null,
       client_id || null, target_skills, parseInt(priority), notes || null]
    );
    await audit.log(req, 'routing_rule.create', { resourceId: result.rows[0].id });
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/routing-rules/:id
router.put('/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const {
      name, match_area_code, match_country, match_did, client_id,
      target_skills, priority, is_active, notes,
    } = req.body;

    const result = await pool.query(
      `UPDATE routing_rules SET
         name            = COALESCE($1, name),
         match_area_code = COALESCE($2, match_area_code),
         match_country   = COALESCE($3, match_country),
         match_did       = COALESCE($4, match_did),
         client_id       = COALESCE($5, client_id),
         target_skills   = COALESCE($6, target_skills),
         priority        = COALESCE($7, priority),
         is_active       = COALESCE($8, is_active),
         notes           = COALESCE($9, notes)
       WHERE id = $10 RETURNING *`,
      [name||null, match_area_code||null, match_country||null, match_did||null,
       client_id||null, target_skills||null,
       priority ? parseInt(priority) : null,
       is_active !== undefined ? is_active : null,
       notes||null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Rule not found' });
    await audit.log(req, 'routing_rule.update', { resourceId: req.params.id });
    res.json({ rule: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/routing-rules/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM routing_rules WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Rule not found' });
    await audit.log(req, 'routing_rule.delete', { resourceId: req.params.id });
    res.json({ message: 'Rule deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
