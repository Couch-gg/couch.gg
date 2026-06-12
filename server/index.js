// server/index.js — HTTP + WebSocket entry point.
//
// Serves the static client (public/), the shared modules (shared/), and the
// Phaser vendor bundle, and runs a WebSocket server on /ws that drives the
// room/game logic. Server-authoritative: clients send intents, the server
// simulates and broadcasts.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { RoomManager } from './rooms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

// --- HTTP / static ----------------------------------------------------------

const app = express();

// Client app at /.
app.use('/', express.static(path.join(ROOT, 'public')));
// Shared ES modules (constants.js, sim.js) at /shared.
app.use('/shared', express.static(path.join(ROOT, 'shared')));
// Phaser vendor bundle at a stable URL the client can <script>-load.
app.get('/vendor/phaser.min.js', (req, res) => {
  res.sendFile(
    path.join(ROOT, 'node_modules', 'phaser', 'dist', 'phaser.min.js'),
    (err) => {
      if (err && !res.headersSent) res.status(404).end('phaser not found');
    }
  );
});

// SPA fallback: any non-asset GET serves index.html so deep links work.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'), (err) => {
    if (err && !res.headersSent) res.status(404).end('not found');
  });
});

const server = http.createServer(app);

// --- WebSocket --------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });
const manager = new RoomManager();

// Per-connection context. We attach the player id and room code so we can
// route messages and clean up on disconnect without a global socket->player
// lookup map.
function ctxOf(ws) {
  if (!ws._ctx) ws._ctx = { roomCode: null, playerId: null };
  return ws._ctx;
}

function sendError(ws, msg) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', msg }));
  } catch (err) {
    /* socket gone */
  }
}

// Detach a player from whatever room they're in (disconnect or leave). Safe to
// call repeatedly; clears the connection context afterwards.
function detach(ws) {
  const ctx = ctxOf(ws);
  if (!ctx.roomCode || !ctx.playerId) return;
  const room = manager.rooms.get(ctx.roomCode);
  if (room) {
    try {
      room.removePlayer(ctx.playerId);
    } catch (err) {
      // Never let cleanup throw and crash the process.
    }
  }
  ctx.roomCode = null;
  ctx.playerId = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      return; // ignore malformed
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    try {
      handleMessage(ws, msg);
    } catch (err) {
      // A bug in handling must never crash the server for everyone.
      sendError(ws, 'SERVER ERROR');
    }
  });

  ws.on('close', () => {
    detach(ws);
  });

  ws.on('error', () => {
    // ws emits 'error' then 'close'; cleanup happens in close. Swallow here.
  });
});

// Route a validated message object.
function handleMessage(ws, msg) {
  const ctx = ctxOf(ws);

  switch (msg.t) {
    case 'create': {
      if (ctx.roomCode) {
        // Already in a room on this socket — ignore to avoid orphaning rooms.
        sendError(ws, 'ALREADY IN A ROOM');
        return;
      }
      const made = manager.createRoom(ws, msg.name);
      if (made) {
        ctx.roomCode = made.room.code;
        ctx.playerId = made.player.id;
      }
      return;
    }

    case 'join': {
      if (ctx.roomCode) {
        sendError(ws, 'ALREADY IN A ROOM');
        return;
      }
      const joined = manager.joinRoom(msg.code, ws, msg.name);
      if (joined) {
        ctx.roomCode = joined.room.code;
        ctx.playerId = joined.player.id;
      }
      return;
    }

    case 'start': {
      const room = currentRoom(ctx);
      if (!room) return sendError(ws, 'NOT IN A ROOM');
      room.startGame(ctx.playerId);
      return;
    }

    case 'fire': {
      const room = currentRoom(ctx);
      if (!room) return; // silently ignore fire when roomless
      room.fire(ctx.playerId, msg.angle, msg.power);
      return;
    }

    case 'rematch': {
      const room = currentRoom(ctx);
      if (!room) return sendError(ws, 'NOT IN A ROOM');
      room.rematch(ctx.playerId);
      return;
    }

    default:
      // Unknown message type — ignore.
      return;
  }
}

function currentRoom(ctx) {
  if (!ctx.roomCode) return null;
  return manager.rooms.get(ctx.roomCode) || null;
}

// --- Heartbeat: drop dead sockets every 30 s --------------------------------

const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      // Missed the previous ping window — clean up its room, then kill it.
      detach(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (err) {
      /* terminating socket */
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// --- Listen -----------------------------------------------------------------

function lanUrls(port) {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      // Node >=18 may report family as 'IPv4' or 4.
      const isV4 = info.family === 'IPv4' || info.family === 4;
      if (isV4 && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

server.listen(PORT, () => {
  console.log('TREBUCHET server running');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const url of lanUrls(PORT)) {
    console.log(`  Network: ${url}`);
  }
  console.log('Invite players on your LAN with a Network URL.');
});

// Defensive: never let an unexpected error take down the whole process.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});
