'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/scripts/templates — list templates, optionally filtered by industry
router.get('/templates', async (req, res, next) => {
  try {
    const { industry } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (industry) { params.push(industry); where += ` AND industry = $${params.length}`; }

    const result = await pool.query(
      `SELECT * FROM script_templates ${where} ORDER BY is_system DESC, industry ASC, name ASC`,
      params
    );
    res.json({ templates: result.rows });
  } catch (err) { next(err); }
});

// GET /api/scripts/industries — distinct industry list
router.get('/industries', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT industry FROM script_templates ORDER BY industry ASC`
    );
    res.json({ industries: result.rows.map((r) => r.industry) });
  } catch (err) { next(err); }
});

// GET /api/scripts/templates/:id
router.get('/templates/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM script_templates WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/scripts/templates — create custom template
router.post('/templates', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { industry, name, greeting, script, custom_form = [], delivery_actions } = req.body;
    if (!industry || !name || !script) {
      return res.status(400).json({ error: 'industry, name and script are required' });
    }

    const result = await pool.query(
      `INSERT INTO script_templates
         (industry, name, greeting, script, custom_form, delivery_actions, is_system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7)
       RETURNING *`,
      [
        industry, name, greeting || null, script,
        JSON.stringify(custom_form),
        delivery_actions ? JSON.stringify(delivery_actions) : '{"email":true,"sms":false,"phone_call":true}',
        req.operator.id,
      ]
    );
    res.status(201).json({ template: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/scripts/templates/:id — update custom template (system templates locked)
router.put('/templates/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT is_system FROM script_templates WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Template not found' });
    if (existing.rows[0].is_system) return res.status(403).json({ error: 'System templates cannot be modified' });

    const { industry, name, greeting, script, custom_form, delivery_actions } = req.body;
    const result = await pool.query(
      `UPDATE script_templates SET
         industry         = COALESCE($1, industry),
         name             = COALESCE($2, name),
         greeting         = COALESCE($3, greeting),
         script           = COALESCE($4, script),
         custom_form      = COALESCE($5, custom_form),
         delivery_actions = COALESCE($6, delivery_actions)
       WHERE id = $7
       RETURNING *`,
      [
        industry||null, name||null, greeting||null, script||null,
        custom_form !== undefined ? JSON.stringify(custom_form) : null,
        delivery_actions !== undefined ? JSON.stringify(delivery_actions) : null,
        req.params.id,
      ]
    );
    res.json({ template: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/scripts/templates/:id
router.delete('/templates/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT is_system FROM script_templates WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Template not found' });
    if (existing.rows[0].is_system) return res.status(403).json({ error: 'System templates cannot be deleted' });

    await pool.query('DELETE FROM script_templates WHERE id = $1', [req.params.id]);
    res.json({ message: 'Template deleted' });
  } catch (err) { next(err); }
});

// POST /api/scripts/apply/:templateId/client/:clientId
// Apply a template's script/greeting/form/delivery to a client
router.post('/apply/:templateId/client/:clientId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const tmpl = await pool.query('SELECT * FROM script_templates WHERE id = $1', [req.params.templateId]);
    if (!tmpl.rows[0]) return res.status(404).json({ error: 'Template not found' });

    const t = tmpl.rows[0];
    const overwrite = req.body.overwrite_existing !== false; // default true

    const sets = [];
    const params = [];

    if (t.script && overwrite) {
      params.push(t.script); sets.push(`script = $${params.length}`);
    }
    if (t.greeting && overwrite) {
      params.push(t.greeting); sets.push(`greeting = $${params.length}`);
    }
    if (t.custom_form && overwrite) {
      params.push(JSON.stringify(t.custom_form)); sets.push(`custom_form = $${params.length}`);
    }
    if (t.delivery_actions && overwrite) {
      params.push(JSON.stringify(t.delivery_actions)); sets.push(`delivery_actions = $${params.length}`);
    }

    if (sets.length === 0) return res.json({ message: 'Nothing to apply', client: null });

    params.push(req.params.clientId);
    const result = await pool.query(
      `UPDATE clients SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, name`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });

    res.json({ message: 'Template applied', client: result.rows[0], template: t.name });
  } catch (err) { next(err); }
});

module.exports = router;
