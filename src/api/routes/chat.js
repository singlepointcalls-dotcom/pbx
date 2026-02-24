'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');
const { broadcast } = require('../../services/realtime');

router.use(requireAuth);

// GET /api/chat — last 100 operator team chat messages
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT oc.*, o.full_name AS sender_name, o.username AS sender_username
       FROM operator_chat oc
       JOIN operators o ON oc.sender_id = o.id
       ORDER BY oc.created_at ASC
       LIMIT 100`
    );
    res.json({ messages: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat — post a new team chat message
router.post('/', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'body is required' });
    }

    const result = await pool.query(
      `INSERT INTO operator_chat (sender_id, body)
       VALUES ($1, $2)
       RETURNING *`,
      [req.operator.id, body.trim()]
    );
    const message = result.rows[0];

    // Fetch sender details for the broadcast payload
    const operatorResult = await pool.query(
      'SELECT full_name FROM operators WHERE id = $1',
      [req.operator.id]
    );
    const sender_name = operatorResult.rows[0]?.full_name || req.operator.username;

    broadcast('chat:message', {
      id:          message.id,
      body:        message.body,
      sender_id:   message.sender_id,
      sender_name,
      created_at:  message.created_at,
    });

    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
