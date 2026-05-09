'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../../services/audit');

router.use(requireAuth);

// GET /api/operator-skills/catalog — list of all skills currently in use
router.get('/catalog', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT UNNEST(skills) AS skill FROM operators WHERE is_active = true ORDER BY skill ASC`
    );
    res.json({ skills: result.rows.map((r) => r.skill) });
  } catch (err) { next(err); }
});

// GET /api/operator-skills/me — current operator's skills
router.get('/me', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT skills, preferred_language FROM operators WHERE id = $1',
      [req.operator.id]
    );
    res.json({ skills: result.rows[0]?.skills || [], preferred_language: result.rows[0]?.preferred_language || 'en' });
  } catch (err) { next(err); }
});

// PUT /api/operator-skills/me — update own preferred language
router.put('/me', async (req, res, next) => {
  try {
    const { preferred_language } = req.body;
    const result = await pool.query(
      `UPDATE operators SET preferred_language = COALESCE($1, preferred_language)
       WHERE id = $2 RETURNING skills, preferred_language`,
      [preferred_language || null, req.operator.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/operator-skills/:operatorId
router.get('/:operatorId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, skills, preferred_language FROM operators WHERE id = $1',
      [req.params.operatorId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Operator not found' });
    res.json({ operator: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/operator-skills/:operatorId — admin assigns skills
router.put('/:operatorId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { skills, preferred_language } = req.body;
    if (skills && !Array.isArray(skills)) return res.status(400).json({ error: 'skills must be an array' });

    const result = await pool.query(
      `UPDATE operators SET
         skills             = COALESCE($1, skills),
         preferred_language = COALESCE($2, preferred_language)
       WHERE id = $3
       RETURNING id, full_name, skills, preferred_language`,
      [skills || null, preferred_language || null, req.params.operatorId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Operator not found' });
    await audit.log(req, 'operator.skills_update', { resourceId: req.params.operatorId, skills });
    res.json({ operator: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/operator-skills/match?skill=... — list operators matching a skill (for routing)
router.get('/match/find', async (req, res, next) => {
  try {
    const { skill, all_skills } = req.query;
    const requiredSkills = all_skills ? all_skills.split(',') : (skill ? [skill] : []);
    if (requiredSkills.length === 0) return res.status(400).json({ error: 'skill or all_skills required' });

    const result = await pool.query(
      `SELECT id, full_name, current_status, skills, preferred_language
       FROM operators
       WHERE is_active = true
         AND skills @> $1::text[]
       ORDER BY
         CASE current_status WHEN 'ready' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END,
         full_name ASC`,
      [requiredSkills]
    );
    res.json({ operators: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
