'use strict';

/**
 * Real-time Service (Socket.io)
 *
 * Provides live event streaming to the operator console.
 *
 * Events emitted to clients:
 *   call:ringing   — new inbound call
 *   call:answered  — call answered by operator
 *   call:ended     — call ended (hangup)
 *   call:transferred
 *   call:hangup_request
 *   message:new    — new message created
 *
 * Events received from operator clients:
 *   operator:ready — operator is logged in and ready to take calls
 *   operator:busy  — operator is on a call
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

// Track connected operators: socketId -> operatorInfo
const connectedOperators = new Map();

function initSocketIO(httpServer) {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [];
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      credentials: true,
    },
  });

  // Authenticate socket connections using JWT (operator or portal)
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.operator = jwt.verify(token, process.env.JWT_SECRET);
      return next();
    } catch { /* try portal secret */ }
    try {
      const portalSecret = process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET;
      const payload = jwt.verify(token, portalSecret);
      if (payload.type === 'portal') {
        socket.portalUser = payload;
        return next();
      }
    } catch { /* fall through */ }
    next(new Error('Invalid token'));
  });

  io.on('connection', (socket) => {
    // Portal user connection — join client room, no operator tracking
    if (socket.portalUser) {
      const clientRoom = `portal:client:${socket.portalUser.client_id}`;
      socket.join(clientRoom);
      socket.on('disconnect', () => {});
      return;
    }

    const op = socket.operator;
    console.log(`[Socket.io] Operator connected: ${op.username} (${socket.id})`);

    connectedOperators.set(socket.id, {
      id: op.id,
      username: op.username,
      fullName: op.fullName,
      role: op.role,
      status: 'ready',
      socketId: socket.id,
    });

    // Broadcast updated operator list
    broadcastOperatorList();

    socket.on('operator:ready', () => {
      const entry = connectedOperators.get(socket.id);
      if (entry) { entry.status = 'ready'; broadcastOperatorList(); }
    });

    socket.on('operator:busy', () => {
      const entry = connectedOperators.get(socket.id);
      if (entry) { entry.status = 'busy'; broadcastOperatorList(); }
    });

    // Break / status change from operator
    socket.on('operator:status', ({ status }) => {
      const allowed = ['ready', 'busy', 'break', 'lunch', 'training', 'admin', 'offline'];
      if (!allowed.includes(status)) return;
      const entry = connectedOperators.get(socket.id);
      if (entry) {
        entry.status = status;
        broadcastOperatorList();
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket.io] Operator disconnected: ${op.username}`);
      connectedOperators.delete(socket.id);
      broadcastOperatorList();
    });
  });

  return io;
}

function broadcast(event, data) {
  if (!io) return;
  io.emit(event, data);
}

function broadcastToPortalClient(clientId, event, data) {
  if (!io) return;
  io.to(`portal:client:${clientId}`).emit(event, data);
}

function broadcastOperatorList() {
  broadcast('operators:list', { operators: Array.from(connectedOperators.values()) });
}

function getConnectedOperators() {
  return Array.from(connectedOperators.values());
}

module.exports = { initSocketIO, broadcast, broadcastToPortalClient, getConnectedOperators };
