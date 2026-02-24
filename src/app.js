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

const app = express();

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Serve operator console static files
app.use(express.static(path.join(__dirname, '..', 'web')));

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

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
