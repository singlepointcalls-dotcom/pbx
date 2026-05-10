'use strict';

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  // Allow token as query param for file download links (GET only)
  const queryToken = req.method === 'GET' ? req.query.token : null;
  if (!queryToken && (!header || !header.startsWith('Bearer '))) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = queryToken || header.slice(7);
  try {
    req.operator = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.operator?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Returns the set of client IDs an operator is allowed to see.
 * Admin/supervisor always see all clients (returns null = no restriction).
 * Operator role: if assignments exist, returns those IDs; else null (all).
 */
async function getAllowedClientIds(operator) {
  if (operator.role === 'admin' || operator.role === 'supervisor') return null;
  const pool = require('../../config/database');
  const r = await pool.query(
    'SELECT client_id FROM operator_client_assignments WHERE operator_id = $1',
    [operator.id]
  );
  if (!r.rows.length) return null; // no restrictions
  return r.rows.map((row) => row.client_id);
}

module.exports = { requireAuth, requireRole, getAllowedClientIds };
