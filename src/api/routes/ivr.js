'use strict';

/**
 * IVR flow builder.
 * Stores visual flow definitions as JSONB; exports to Asterisk dialplan text.
 * Actual Asterisk wiring requires ARI/AGI integration (Tier 2 — stub here).
 */

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin', 'supervisor'));

// GET /api/ivr — list IVR flows
router.get('/', async (req, res, next) => {
  try {
    const { client_id } = req.query;
    const params = client_id ? [client_id] : [];
    const filter = client_id ? 'WHERE f.client_id = $1' : '';
    const result = await pool.query(
      `SELECT f.id, f.client_id, f.name, f.is_active, f.created_at, f.updated_at,
              c.name AS client_name, jsonb_array_length(f.nodes) AS node_count
       FROM ivr_flows f
       JOIN clients c ON f.client_id = c.id
       ${filter}
       ORDER BY c.name, f.name`,
      params
    );
    res.json({ flows: result.rows });
  } catch (err) { next(err); }
});

// GET /api/ivr/:id — get full flow including nodes
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT f.*, c.name AS client_name
       FROM ivr_flows f
       JOIN clients c ON f.client_id = c.id
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'IVR flow not found' });
    res.json({ flow: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/ivr — create a new IVR flow
router.post('/', async (req, res, next) => {
  try {
    const { client_id, name, nodes = [] } = req.body;
    if (!client_id || !name) {
      return res.status(400).json({ error: 'client_id and name are required' });
    }
    if (!Array.isArray(nodes)) {
      return res.status(400).json({ error: 'nodes must be an array' });
    }
    const result = await pool.query(
      `INSERT INTO ivr_flows (client_id, name, nodes)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [client_id, name, JSON.stringify(nodes)]
    );
    res.status(201).json({ flow: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/ivr/:id — update flow definition
router.put('/:id', async (req, res, next) => {
  try {
    const { name, nodes, is_active } = req.body;
    if (nodes !== undefined && !Array.isArray(nodes)) {
      return res.status(400).json({ error: 'nodes must be an array' });
    }
    const result = await pool.query(
      `UPDATE ivr_flows SET
         name       = COALESCE($1, name),
         nodes      = COALESCE($2, nodes),
         is_active  = COALESCE($3, is_active),
         updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name || null, nodes ? JSON.stringify(nodes) : null, is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'IVR flow not found' });
    res.json({ flow: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/ivr/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM ivr_flows WHERE id = $1', [req.params.id]);
    res.json({ message: 'IVR flow deleted' });
  } catch (err) { next(err); }
});

// GET /api/ivr/:id/export — export flow as Asterisk dialplan text
router.get('/:id/export', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT f.*, c.name AS client_name FROM ivr_flows f JOIN clients c ON f.client_id = c.id WHERE f.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'IVR flow not found' });
    const flow = result.rows[0];
    const dialplan = exportToDialplan(flow);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ivr-${flow.id}.conf"`);
    res.send(dialplan);
  } catch (err) { next(err); }
});

function exportToDialplan(flow) {
  const lines = [
    `; IVR flow: ${flow.name} (client: ${flow.client_name})`,
    `; Generated: ${new Date().toISOString()}`,
    `; Flow ID: ${flow.id}`,
    '',
    `[ivr-${flow.id}]`,
    '',
  ];

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];

  if (nodes.length === 0) {
    lines.push('; No nodes defined — add nodes via the IVR builder UI');
    lines.push('exten => s,1,Hangup()');
    return lines.join('\n');
  }

  lines.push('exten => s,1,Answer()');
  let priority = 2;

  for (const node of nodes) {
    switch (node.type) {
      case 'play':
        lines.push(`exten => s,${priority},Playback(${node.file || 'beep'})`);
        break;
      case 'menu': {
        const prompt = node.prompt || 'silence/1';
        lines.push(`exten => s,${priority},Background(${prompt})`);
        priority++;
        lines.push(`exten => s,${priority},WaitExten(${node.timeout || 5})`);
        if (node.options) {
          for (const [digit, target] of Object.entries(node.options)) {
            lines.push(`exten => ${digit},1,Goto(ivr-${flow.id},s,1) ; → ${target}`);
          }
        }
        break;
      }
      case 'queue':
        lines.push(`exten => s,${priority},Queue(${node.queue || 'default'},t,,,,60)`);
        break;
      case 'transfer':
        lines.push(`exten => s,${priority},Dial(SIP/${node.extension},30,tT)`);
        break;
      case 'voicemail':
        lines.push(`exten => s,${priority},VoiceMail(${node.mailbox || '100'}@default,u)`);
        break;
      case 'hangup':
        lines.push(`exten => s,${priority},Hangup()`);
        break;
      default:
        lines.push(`; Unknown node type: ${node.type}`);
    }
    priority++;
  }

  return lines.join('\n');
}

module.exports = router;
module.exports._exportToDialplan = exportToDialplan;
