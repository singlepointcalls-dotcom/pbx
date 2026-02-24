'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/qa/call/:callId — get QA score for a call
router.get('/call/:callId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT q.*, o.full_name AS scored_by_name
       FROM call_qa_scores q
       JOIN operators o ON q.scored_by = o.id
       WHERE q.call_log_id = $1`,
      [req.params.callId]
    );
    res.json({ score: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/qa/call/:callId — upsert QA score for a call
router.post(
  '/call/:callId',
  requireRole('admin', 'supervisor'),
  async (req, res, next) => {
    try {
      const {
        greeting_correct,
        script_followed,
        info_accurate,
        professional_tone,
        message_complete,
        overall,
        notes,
      } = req.body;

      const result = await pool.query(
        `INSERT INTO call_qa_scores
           (call_log_id, scored_by, greeting_correct, script_followed,
            info_accurate, professional_tone, message_complete, overall, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (call_log_id) DO UPDATE SET
           scored_by          = EXCLUDED.scored_by,
           greeting_correct   = EXCLUDED.greeting_correct,
           script_followed    = EXCLUDED.script_followed,
           info_accurate      = EXCLUDED.info_accurate,
           professional_tone  = EXCLUDED.professional_tone,
           message_complete   = EXCLUDED.message_complete,
           overall            = EXCLUDED.overall,
           notes              = EXCLUDED.notes,
           updated_at         = NOW()
         RETURNING *`,
        [
          req.params.callId,
          req.operator.id,
          greeting_correct,
          script_followed,
          info_accurate,
          professional_tone,
          message_complete,
          overall,
          notes || null,
        ]
      );
      res.status(201).json({ score: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
