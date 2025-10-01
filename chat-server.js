// chat-server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/* ---------------- Config ---------------- */
const PORT           = Number(process.env.CHAT_PORT || 4000);
const JWT_SECRET     = process.env.JWT_SECRET || 'dev_secret';
const CORS_ORIGIN    = process.env.CORS_ORIGIN || '*';
const SERVER_TOKEN   = process.env.SERVER_TOKEN || ''; // optional for /emit
const RETENTION_MS   = Number(process.env.RETENTION_MS || 24*60*60*1000); // 24h
const CLEAN_EVERY_MS = Number(process.env.CLEAN_EVERY_MS || 10*60*1000);   // 10m

/* ---------------- App / IO ---------------- */
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN }});

/* ---------------- File storage ---------------- */
const CHAT_FILE = path.join(__dirname, 'data', 'chat', 'chat.json');
fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, '[]', 'utf8');

function loadMessages() {
  try { return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8') || '[]'); }
  catch { return []; }
}
function saveMessages(list) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(list || [], null, 2));
}
function addMessage(m) {
  const list = loadMessages();
  list.push(m);
  saveMessages(list);
}
function cleanup() {
  const now = Date.now();
  let list = loadMessages();
  const before = list.length;
  list = list.filter(m => now - new Date(m.ts).getTime() < RETENTION_MS);
  if (before !== list.length) {
    console.log(`🧹 cleanup: removed ${before - list.length} expired`);
    saveMessages(list);
  }
}
setInterval(cleanup, CLEAN_EVERY_MS);

/* ---------------- Helpers ---------------- */
function verifyHttp(req, res, next) {
  // Allow internal calls via x-server-token (optional)
  const st = req.headers['x-server-token'];
  if (st && SERVER_TOKEN && st === SERVER_TOKEN) {
    req.caller = { id: 'server', type: 'server' };
    return next();
  }
  const hdr = req.headers.authorization || '';
  const token = hdr.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.caller = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token', details: e.message });
  }
}

/* ---------------- Socket auth ---------------- */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('missing_token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('invalid_token'));
  }
});

/* ---------------- Presence (very simple) ---------------- */
const online = new Set(); // userId set

function broadcastPresence(userId, state) {
  // emit to everyone who cares; simplest: broadcast globally
  io.emit('presence', { userId, state }); // 'online' | 'offline'
}

/* ---------------- Socket handlers ---------------- */
io.on('connection', (socket) => {
  const user = socket.user;
  if (!user?.id) return socket.disconnect();

  const myRoom = `user:${user.id}`;
  socket.join(myRoom);
  online.add(user.id);
  broadcastPresence(user.id, 'online');
  console.log(`🔵 CONNECT ${user.id}`);

  // 1) On connect, dump recent messages involving this user (creates first-time chats)
  const all = loadMessages();
  const cutoff = Date.now() - RETENTION_MS;
  const recent = all.filter(m =>
    new Date(m.ts).getTime() >= cutoff && (m.to === user.id || m.from === user.id)
  );
  socket.emit('recent', { items: recent }); // client stores & touches conversations

  // 2) Pull sync (client can request everything after a timestamp)
  socket.on('sync', ({ since }) => {
    const sinceMs = typeof since === 'number' ? since : Date.parse(since || 0);
    const all2 = loadMessages();
    const items = all2.filter(m =>
      (m.to === user.id || m.from === user.id) &&
      new Date(m.ts).getTime() > (sinceMs || 0)
    );
    socket.emit('recent', { items });
  });

  // 3) Send message
  socket.on('message', (payload = {}) => {
    const { to, content, tempId } = payload;
    if (!to || !content) return;
    const msg = {
      id: uuidv4(),
      from: user.id,
      to,
      content,
      ts: new Date().toISOString()
    };
    addMessage(msg);

    // deliver to recipient (even if it's their first conversation)
    io.to(`user:${to}`).emit('message', msg);

    // ack back to sender
    socket.emit('message:sent', { tempId: tempId || null, serverId: msg.id, ts: msg.ts });
    console.log(`💬 ${msg.from} -> ${msg.to}: ${msg.content}`);
  });

  socket.on('disconnect', () => {
    online.delete(user.id);
    broadcastPresence(user.id, 'offline');
    console.log(`🔴 DISCONNECT ${user.id}`);
  });
});

/* ---------------- HTTP endpoints ---------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

// last message per peer for a user (seed Home list)
app.get('/conversations', verifyHttp, (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'missing_user' });

  const cutoff = Date.now() - RETENTION_MS;
  const msgs = loadMessages().filter(m =>
    new Date(m.ts).getTime() >= cutoff && (m.to === userId || m.from === userId)
  );

  const map = new Map(); // peerId -> msg
  for (const m of msgs) {
    const peerId = m.from === userId ? m.to : m.from;
    const prev = map.get(peerId);
    if (!prev || new Date(m.ts).getTime() > new Date(prev.ts).getTime()) {
      map.set(peerId, m);
    }
  }
  const items = Array.from(map.entries()).map(([peerId, m]) => ({
    peerId,
    last: { id: m.id, from: m.from, to: m.to, content: m.content, ts: m.ts }
  }));
  res.json({ ok: true, items });
});

// pull all messages between A and B within retention (for opening thread cold)
app.get('/messages', verifyHttp, (req, res) => {
  const { userA, userB } = req.query;
  if (!userA || !userB) return res.status(400).json({ error: 'missing_params' });
  const cutoff = Date.now() - RETENTION_MS;
  const items = loadMessages().filter(m =>
    new Date(m.ts).getTime() >= cutoff &&
    ((m.from === userA && m.to === userB) || (m.from === userB && m.to === userA))
  );
  res.json({ ok: true, items });
});

// emit a message via HTTP (server-to-user or service use)
app.post('/emit', verifyHttp, (req, res) => {
  const { to, content } = req.body || {};
  if (!to || !content) return res.status(400).json({ error: 'missing_fields' });

  const from = req.caller?.id || 'server';
  const msg = { id: uuidv4(), from, to, content, ts: new Date().toISOString() };
  addMessage(msg);
  io.to(`user:${to}`).emit('message', msg);
  res.json({ ok: true, message: msg });
});

/* ---------------- Start ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Chat server listening on ${PORT}`);
});