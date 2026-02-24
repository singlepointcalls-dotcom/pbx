'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const authRoutes = require('./api/routes/auth');
const clientRoutes = require('./api/routes/clients');
const contactRoutes = require('./api/routes/contacts');
const messageRoutes = require('./api/routes/messages');
const callRoutes = require('./api/routes/calls');
const callControlRoutes = require('./api/routes/callcontrol');
const operatorRoutes = require('./api/routes/operators');
const reportRoutes = require('./api/routes/reports');
const taskRoutes = require('./api/routes/tasks');

const app = express();

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Serve operator console static files
app.use(express.static(path.join(__dirname, '..', 'web')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/clients', contactRoutes);  // /api/clients/:id/contacts
app.use('/api/messages', messageRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/callcontrol', callControlRoutes);
app.use('/api/operators', operatorRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tasks', taskRoutes);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

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
