'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../../services/audit');

router.use(requireAuth);

// GET /api/settings — fetch all system settings
router.get('/', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT key, value FROM system_settings ORDER BY key');
    const settings = {};
    result.rows.forEach((r) => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/settings — upsert one or many settings
router.put('/', requireRole('admin'), async (req, res, next) => {
  try {
    const updates = req.body; // { key: value, ... }
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Body must be key-value object' });
    }
    const entries = Object.entries(updates);
    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    audit.log(req, 'settings.update', {
      resourceType: 'settings',
      details: { keys: Object.keys(updates) },
    });
    res.json({ message: 'Settings saved' });
  } catch (err) { next(err); }
});

module.exports = router;
