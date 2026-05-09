'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const { router: authRoutes } = require('./api/routes/auth');
const clientRoutes = require('./api/routes/clients');
const contactRoutes = require('./api/routes/contacts');
const messageRoutes = require('./api/routes/messages');
const callRoutes = require('./api/routes/calls');
const callControlRoutes = require('./api/routes/callcontrol');
const operatorRoutes = require('./api/routes/operators');
const reportRoutes = require('./api/routes/reports');
const taskRoutes = require('./api/routes/tasks');
const departmentRoutes = require('./api/routes/departments');
const vipRoutes = require('./api/routes/vip');
const availabilityRoutes = require('./api/routes/availability');
const portalRoutes = require('./api/routes/portal');
const settingsRoutes = require('./api/routes/settings');
const billingRoutes = require('./api/routes/billing');
const noticeboardRoutes = require('./api/routes/noticeboard');
const clientNewsRoutes = require('./api/routes/client-news');
const clientFilesRoutes = require('./api/routes/client-files');
const cannedRoutes     = require('./api/routes/canned');
const wallboardRoutes  = require('./api/routes/wallboard');
const chatRoutes       = require('./api/routes/chat');
const qaRoutes         = require('./api/routes/qa');
const ackRoutes        = require('./api/routes/ack');
const pushRoutes       = require('./api/routes/push');
const auditRoutes         = require('./api/routes/audit-log');
const appointmentRoutes   = require('./api/routes/appointments');
const smsRoutes           = require('./api/routes/sms');
const callbackRoutes      = require('./api/routes/callbacks');
const scriptRoutes        = require('./api/routes/scripts');
const whatsappRoutes      = require('./api/routes/whatsapp');
const { rateLimit }       = require('express-rate-limit');

const app = express();

// ── Security headers (lightweight alternative to helmet) ──────────────────
app.use((_req, res, next) => {
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Deny framing to prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Force HTTPS for 1 year (only effective in production behind TLS)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Disable FLoC / interest cohort tracking
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
  // Minimal CSP for API responses — full CSP for HTML set below
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

// ── CORS — only allow explicitly configured origins ────────────────────────
// If CORS_ORIGINS is unset the app runs same-origin (no cross-origin requests
// allowed with credentials). This prevents a misconfigured deployment from
// accidentally opening the API to all origins.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : null; // null = same-origin only (no CORS header emitted)
app.use(cors({
  origin: (origin, callback) => {
    // Requests without an Origin header (same-origin, server-to-server) are
    // always allowed — they cannot be made by cross-origin scripts.
    if (!origin) return callback(null, true);
    if (allowedOrigins && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Global API rate limit (backs up per-endpoint limits) ──────────────────
// 300 requests per minute per IP across all /api/* routes.
// Per-endpoint limits (auth, ack) apply their own stricter windows.
const globalApiLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many requests — please slow down.' },
});
app.use('/api', globalApiLimit);

app.use(morgan('combined'));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Serve operator console static files
app.use(express.static(path.join(__dirname, '..', 'web')));

// Serve uploaded files — force download (prevents in-browser rendering/XSS from SVGs, PDFs)
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment');
  next();
}, express.static(path.join(__dirname, '..', 'uploads')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/clients', contactRoutes);      // /api/clients/:id/contacts, /oncall
app.use('/api/clients', departmentRoutes);   // /api/clients/:id/departments
app.use('/api/clients', vipRoutes);          // /api/clients/:id/vip, /ignore
app.use('/api/clients', availabilityRoutes); // /api/clients/:id/availability
app.use('/api/messages', messageRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/callcontrol', callControlRoutes);
app.use('/api/operators', operatorRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tasks', taskRoutes);
// All-clients availability dashboard
app.use('/api/availability', availabilityRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/noticeboard', noticeboardRoutes);
app.use('/api/clients', clientNewsRoutes);     // /api/clients/:id/news
app.use('/api/clients', clientFilesRoutes);    // /api/clients/:id/files
app.use('/api/canned',    cannedRoutes);
app.use('/api/wallboard', wallboardRoutes);
app.use('/api/chat',      chatRoutes);
app.use('/api/qa',        qaRoutes);
app.use('/api/ack',       ackRoutes);         // public — no auth
app.use('/api/push',         pushRoutes);
app.use('/api/audit',        auditRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/sms',          smsRoutes);
app.use('/api/callbacks',    callbackRoutes);
app.use('/api/scripts',      scriptRoutes);
app.use('/api/whatsapp',     whatsappRoutes);  // public webhook + auth routes

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Client portal
app.get('/portal', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'portal.html'));
});
app.get('/portal.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'portal.js'));
});
app.get('/portal.css', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'portal.css'));
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

// Error handler — avoid leaking stack traces in production
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

module.exports = app;
