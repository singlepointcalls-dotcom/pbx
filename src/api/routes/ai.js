'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth } = require('../middleware/auth');
const ai = require('../../services/ai');

router.use(requireAuth);

// POST /api/ai/summarise — summarise a message
router.post('/summarise', async (req, res, next) => {
  try {
    const { message_id, text, client_name, caller_name, subject } = req.body;
    let message;

    if (message_id) {
      const r = await pool.query(
        `SELECT m.*, c.name AS client_name, o.full_name AS operator_name
         FROM messages m
         JOIN clients c ON m.client_id = c.id
         LEFT JOIN operators o ON m.operator_id = o.id
         WHERE m.id = $1`, [message_id]
      );
      message = r.rows[0];
      if (!message) return res.status(404).json({ error: 'Message not found' });
    } else {
      message = { body: text, client_name, caller_name, subject };
    }

    const summary = await ai.summariseMessage(message);
    if (!summary) return res.status(503).json({ error: 'AI not available (ANTHROPIC_API_KEY not set)' });
    res.json({ summary });
  } catch (err) { next(err); }
});

// POST /api/ai/classify — classify urgency + call type
router.post('/classify', async (req, res, next) => {
  try {
    const { subject, body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });
    const result = await ai.classifyMessage({ subject, body });
    if (!result) return res.status(503).json({ error: 'AI not available' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/ai/suggest-reply — suggest an SMS or email reply
router.post('/suggest-reply', async (req, res, next) => {
  try {
    const { message_id, body, client_name, caller_name, channel = 'sms' } = req.body;
    let message;

    if (message_id) {
      const r = await pool.query(
        `SELECT m.*, c.name AS client_name FROM messages m JOIN clients c ON m.client_id = c.id WHERE m.id = $1`,
        [message_id]
      );
      message = r.rows[0];
      if (!message) return res.status(404).json({ error: 'Message not found' });
    } else {
      message = { body, client_name, caller_name };
    }

    const reply = await ai.suggestReply(message, channel);
    if (!reply) return res.status(503).json({ error: 'AI not available' });
    res.json({ reply });
  } catch (err) { next(err); }
});

// POST /api/ai/sentiment — analyse sentiment of text
router.post('/sentiment', async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const result = await ai.detectSentiment(text);
    if (!result) return res.status(503).json({ error: 'AI not available' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/ai/extract — extract entities from caller text
router.post('/extract', async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const result = await ai.extractEntities(text);
    if (!result) return res.status(503).json({ error: 'AI not available' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/ai/generate-script — generate a call script for a client
router.post('/generate-script', async (req, res, next) => {
  try {
    const { client_id, industry, notes, name } = req.body;
    let clientInfo = { name, industry, notes };

    if (client_id) {
      const r = await pool.query('SELECT name, notes FROM clients WHERE id = $1', [client_id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Client not found' });
      clientInfo = { ...r.rows[0], industry, notes: notes || r.rows[0].notes };
    }

    if (!clientInfo.name) return res.status(400).json({ error: 'client_id or name is required' });
    const script = await ai.generateScript(clientInfo);
    if (!script) return res.status(503).json({ error: 'AI not available' });
    res.json({ script });
  } catch (err) { next(err); }
});

module.exports = router;
