'use strict';

require('dotenv').config();

const http = require('http');
const app = require('./app');
const { initSocketIO } = require('./services/realtime');
const { connectARI } = require('./asterisk/ari');
const { startEscalationService } = require('./services/escalation');
const { startRetentionService }  = require('./services/retention');
const pushService                = require('./services/push');

const PORT = parseInt(process.env.PORT || '3000');

const server = http.createServer(app);

// Initialize Socket.io
initSocketIO(server);

// Start HTTP server
server.listen(PORT, () => {
  console.log(`SinglePoint Calls answering service running on port ${PORT}`);
  console.log(`Operator console: http://localhost:${PORT}`);
});

// Connect to Asterisk ARI (non-fatal if Asterisk is not yet available)
connectARI().catch((err) => {
  console.warn('ARI connection failed (will retry):', err.message);
});

// Start escalation background service
startEscalationService();

// Initialise Web Push (VAPID keys from env — non-fatal if not configured)
pushService.init();

// Start GDPR data retention purge service
startRetentionService();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
