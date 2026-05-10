'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/qa/scores — paginated list of all QA scores (admin/supervisor)
router.get('/scores', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { operator_id, client_id, date_from, date_to, limit = 50, offset = 0 } = req.query;
    const safeLimit  = Math.min(Math.max(1, parseInt(limit) || 50), 200);
    const safeOffset = Math.max(0, parseInt(offset) || 0);
    const params = [];
    let filter = '';
    if (operator_id) { params.push(operator_id); filter += ` AND cl.operator_id = $${params.length}`; }
    if (client_id)   { params.push(client_id);   filter += ` AND cl.client_id   = $${params.length}`; }
    if (date_from)   { params.push(date_from);   filter += ` AND q.created_at  >= $${params.length}`; }
    if (date_to)     { params.push(date_to);     filter += ` AND q.created_at  <= $${params.length}`; }
    params.push(safeLimit, safeOffset);
    const result = await pool.query(
      `SELECT q.*,
              cl.caller_id_num, cl.call_start, cl.duration_seconds,
              c.name AS client_name,
              op.full_name AS operator_name,
              scorer.full_name AS scored_by_name
       FROM call_qa_scores q
       JOIN call_logs cl ON q.call_log_id = cl.id
       LEFT JOIN clients c ON cl.client_id = c.id
       LEFT JOIN operators op ON cl.operator_id = op.id
       JOIN operators scorer ON q.scored_by = scorer.id
       WHERE 1=1 ${filter}
       ORDER BY q.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const totResult = await pool.query(
      `SELECT COUNT(*) FROM call_qa_scores q
       JOIN call_logs cl ON q.call_log_id = cl.id
       WHERE 1=1 ${filter}`,
      params.slice(0, params.length - 2)
    );
    res.json({ scores: result.rows, total: parseInt(totResult.rows[0].count) });
  } catch (err) { next(err); }
});

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
