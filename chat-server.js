// chat-server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.CHAT_PORT || process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RETENTION_MS = Number(process.env.RETENTION_MS || 24 * 60 * 60 * 1000); // 24h
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 10 * 60 * 1000); // 10m

/* ---------- Files ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'chat.json');             // [{id,from,to,content,ts}]
const UND_FILE = path.join(DATA_DIR, 'undelivered.json');      // { userId: [message,...] }
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');   // { userId: [{peerId,peerName,ts}] }

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
function addMessage(msg) {
  const list = loadMessages(); list.push(msg); saveMessages(list);
}
function cleanupMessages() {
  const cutoff = Date.now() - RETENTION_MS;
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
    // move to top + update name/time
    const updated = { ...arr[i], peerName: peerName || arr[i].peerName, ts: now };
    arr.splice(i, 1);
    arr.unshift(updated);
  }
  saveConvs(convs);
}

/* ---------- App / IO ---------- */
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

/* ---------- Auth (HTTP & Socket) ---------- */
function verifyToken(bearer) {
  const token = (bearer || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('missing_token');
  return jwt.verify(token, JWT_SECRET);
}
function httpAuth(req, res, next) {
  try {
    const payload = verifyToken(req.headers.authorization || '');
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token', details: e.message });
  }
}
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = verifyToken(`Bearer ${token}`);
    socket.user = payload;
    next();
  } catch (e) { next(new Error('invalid_token')); }
});

/* ---------- Socket events ---------- */
io.on('connection', (socket) => {
  const me = socket.user;
  if (!me?.id) return socket.disconnect();

  const room = `user:${me.id}`;
  socket.join(room);
  console.log(`🔵 CONNECT ${me.id}`);

  // 1) Drain any queued undelivered messages
  const queued = drainUndelivered(me.id);
  if (queued.length) {
    queued.forEach(m => socket.emit('message', m));
  }
  // 2) Tell clients I'm online (optional)
  io.to(room).emit('presence', { userId: me.id, status: 'online' });

  // Handle send
  socket.on('message', (payload) => {
    const { to, content, tempId, peerName } = payload || {};
    if (!to || !content) return;

    const msg = {
      id: uuidv4(),
      from: me.id,
      to,
      content,
      ts: new Date().toISOString()
    };

    // persist
    addMessage(msg);

    // ensure both conversation lists updated (so first-time chats appear)
    touchConversation(me.id, to, peerName || '');
    touchConversation(to, me.id, me.name || '');

    // deliver now if recipient is connected, else queue
    const recipientRoom = `user:${to}`;
    const roomSize = io.sockets.adapter.rooms.get(recipientRoom)?.size || 0;

    if (roomSize > 0) {
      io.to(recipientRoom).emit('message', msg);
    } else {
      queueUndelivered(to, msg);
    }

    // ACK back to sender
    socket.emit('message:sent', { tempId: tempId || null, serverId: msg.id, ts: msg.ts });
    console.log(`💬 ${msg.from} -> ${msg.to}: ${msg.content}${roomSize ? '' : ' (queued)'}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔴 DISCONNECT ${me.id}`);
    // optional presence event
    io.to(room).emit('presence', { userId: me.id, status: 'offline' });
  });
});

/* ---------- HTTP APIs ---------- */
// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Conversations for Home
app.get('/conversations/:userId', httpAuth, (req, res) => {
  const convs = loadConvs();
  res.json(convs[req.params.userId] || []);
});

// History between two users (within retention)
app.get('/messages', httpAuth, (req, res) => {
  const { userA, userB } = req.query;
  if (!userA || !userB) return res.status(400).json({ error: 'missing_params' });
  const now = Date.now();
  const msgs = loadMessages().filter(m => {
    const inPair = (m.from === userA && m.to === userB) || (m.from === userB && m.to === userA);
    const fresh = now - new Date(m.ts).getTime() <= RETENTION_MS;
    return inPair && fresh;
  });
  res.json({ ok: true, messages: msgs });
});

/* ---------- Cleanup timer ---------- */
setInterval(cleanupMessages, CLEANUP_INTERVAL_MS);

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on ${PORT}`);
});