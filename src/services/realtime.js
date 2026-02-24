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
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  // Authenticate socket connections using JWT
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.operator = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
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

function broadcastOperatorList() {
  broadcast('operators:list', { operators: Array.from(connectedOperators.values()) });
}

function getConnectedOperators() {
  return Array.from(connectedOperators.values());
}

module.exports = { initSocketIO, broadcast, getConnectedOperators };
