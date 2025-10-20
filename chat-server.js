// chat-server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/* ---------- Defaults / env ---------- */
const DEFAULTS = {
  PORT: Number(process.env.CHAT_PORT || process.env.PORT || 4000),
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  RETENTION_MS: Number(process.env.RETENTION_MS || 24 * 60 * 60 * 1000), // 24h
  CLEANUP_INTERVAL_MS: Number(process.env.CLEANUP_INTERVAL_MS || 10 * 60 * 1000), // 10m
  WS_PATH: process.env.WS_PATH || '/ws-chat',
  BASE_PATH: process.env.CHAT_BASE_PATH || '/chat', // HTTP API mount path when app is provided
};

/* ---------- Files ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'chat.json');           // [{id,from,to,content,ts}]
const UND_FILE = path.join(DATA_DIR, 'undelivered.json');    // { userId: [message,...] }
const CONV_FILE = path.join(DATA_DIR, 'conversations.json'); // { userId: [{peerId,peerName,ts}] }

function ensureFile(file, init) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, init, 'utf8');
}
ensureFile(MSG_FILE, '[]');
ensureFile(UND_FILE, '{}');
ensureFile(CONV_FILE, '{}');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || fallback); }
  catch { return JSON.parse(fallback); }
};
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));

/* ---------- Stores ---------- */
function loadMessages() { return readJson(MSG_FILE, '[]'); }
function saveMessages(list) { writeJson(MSG_FILE, list); }
function addMessage(msg) { const list = loadMessages(); list.push(msg); saveMessages(list); }
function cleanupMessages(retentionMs) {
  const cutoff = Date.now() - retentionMs;
  const list = loadMessages();
  const keep = list.filter(m => new Date(m.ts).getTime() > cutoff);
  if (keep.length !== list.length) saveMessages(keep);
}

function loadUndelivered() { return readJson(UND_FILE, '{}'); }
function saveUndelivered(map) { writeJson(UND_FILE, map); }
function queueUndelivered(toUserId, msg) {
  const map = loadUndelivered();
  if (!map[toUserId]) map[toUserId] = [];
  map[toUserId].push(msg);
  saveUndelivered(map);
}
function drainUndelivered(toUserId) {
  const map = loadUndelivered();
  const list = map[toUserId] || [];
  map[toUserId] = [];
  saveUndelivered(map);
  return list;
}

function loadConvs() { return readJson(CONV_FILE, '{}'); }
function saveConvs(obj) { writeJson(CONV_FILE, obj); }
function touchConversation(userId, peerId, peerName) {
  const convs = loadConvs();
  if (!convs[userId]) convs[userId] = [];
  const arr = convs[userId];
  const now = Date.now();
  const i = arr.findIndex(x => x.peerId === peerId);
  if (i === -1) arr.unshift({ peerId, peerName: peerName || '', ts: now });
  else {
    const updated = { ...arr[i], peerName: peerName || arr[i].peerName, ts: now };
    arr.splice(i, 1);
    arr.unshift(updated);
  }
  saveConvs(convs);
}

/* ---------- Auth helpers ---------- */
function verifyTokenFromBearer(bearer, jwtSecret) {
  const token = (bearer || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('missing_token');
  return jwt.verify(token, jwtSecret);
}

/* ============================================================
 * initChat(httpServer, options)
 * Attaches Socket.IO to an existing HTTP server and (optionally)
 * mounts HTTP chat APIs onto an existing Express app.
 * ============================================================ */
function initChat(
  httpServer,
  {
    app,                         // optional: pass your Express app to mount HTTP APIs
    jwtSecret = DEFAULTS.JWT_SECRET,
    path = DEFAULTS.WS_PATH,     // WebSocket path (match on client)
    corsOrigin = DEFAULTS.CORS_ORIGIN,
    basePath = DEFAULTS.BASE_PATH, // HTTP APIs mount path (e.g., '/chat')
    retentionMs = DEFAULTS.RETENTION_MS,
    cleanupIntervalMs = DEFAULTS.CLEANUP_INTERVAL_MS,
  } = {}
) {
  // --- Socket.IO ---
  const io = new Server(httpServer, {
    path,
    cors: { origin: corsOrigin },
  });

  // Socket auth
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('invalid_token'));
      const payload = jwt.verify(token, jwtSecret);
      socket.user = payload;
      next();
    } catch {
      next(new Error('invalid_token'));
    }
  });

  // Socket events
  io.on('connection', (socket) => {
    const me = socket.user;
    if (!me?.id) return socket.disconnect();

    const room = `user:${me.id}`;
    socket.join(room);
    const queued = drainUndelivered(me.id);
    queued.forEach(m => socket.emit('message', m));
    io.to(room).emit('presence', { userId: me.id, status: 'online' });

    socket.on('message', (payload) => {
      const { to, content, tempId, peerName } = payload || {};
      if (!to || !content) return;

      const msg = {
        id: uuidv4(),
        from: me.id,
        to,
        content,
        ts: new Date().toISOString(),
      };

      addMessage(msg);
      touchConversation(me.id, to, peerName || '');
      touchConversation(to, me.id, me.name || '');

      const recipientRoom = `user:${to}`;
      const roomSize = io.sockets.adapter.rooms.get(recipientRoom)?.size || 0;
      if (roomSize > 0) io.to(recipientRoom).emit('message', msg);
      else queueUndelivered(to, msg);

      socket.emit('message:sent', { tempId: tempId || null, serverId: msg.id, ts: msg.ts });
      // console.log(`💬 ${msg.from} -> ${msg.to}: ${msg.content}${roomSize ? '' : ' (queued)'}`);
    });

    socket.on('disconnect', () => {
      io.to(room).emit('presence', { userId: me.id, status: 'offline' });
    });
  });

  // Cleanup task
  const timer = setInterval(() => cleanupMessages(retentionMs), cleanupIntervalMs);
  timer.unref?.();

  // --- Optional HTTP APIs on existing app ---
  if (app && typeof app.use === 'function') {
    const router = express.Router();

    // simple HTTP auth middleware that uses the same JWT
    router.use((req, res, next) => {
      try {
        const payload = verifyTokenFromBearer(req.headers.authorization || '', jwtSecret);
        req.user = payload;
        next();
      } catch (e) {
        res.status(401).json({ error: 'invalid_token', details: e.message });
      }
    });

    // Health
    router.get('/health', (_req, res) => res.json({ ok: true }));

    // Conversations for Home
    router.get('/conversations/:userId', (req, res) => {
      const convs = loadConvs();
      res.json(convs[req.params.userId] || []);
    });

    // History between two users (within retention)
    router.get('/messages', (req, res) => {
      const { userA, userB } = req.query;
      if (!userA || !userB) return res.status(400).json({ error: 'missing_params' });
      const now = Date.now();
      const msgs = loadMessages().filter(m => {
        const inPair = (m.from === userA && m.to === userB) || (m.from === userB && m.to === userA);
        const fresh = now - new Date(m.ts).getTime() <= retentionMs;
        return inPair && fresh;
      });
      res.json({ ok: true, messages: msgs });
    });

    app.use(basePath, router);
  }

  console.log('✅ Chat server initialized (Socket.IO).');
  return io;
}

module.exports = { initChat };

/* ============================================================
 * Standalone mode (optional):
 * If you run: node chat-server.js
 * it will create its own Express app and listen by itself.
 * ============================================================ */
if (require.main === module) {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  initChat(server, {
    app,
    jwtSecret: DEFAULTS.JWT_SECRET,
    path: DEFAULTS.WS_PATH,
    corsOrigin: DEFAULTS.CORS_ORIGIN,
    basePath: DEFAULTS.BASE_PATH,
  });
  server.listen(DEFAULTS.PORT, () => {
    console.log(`🚀 Chat server running on ${DEFAULTS.PORT}`);
  });
}

