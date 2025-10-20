// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Pool } = require('pg');            // Neon/Postgres
const { initChat } = require('./chat-server'); // MUST export { initChat } from chat-server.js

// -------------------- App Setup --------------------
const app = express();
app.use(cors());           // tighten origins later for production
app.use(express.json());

// -------------------- Config -----------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const DATABASE_URL = process.env.DATABASE_URL; // e.g. postgres://user:pass@host/db?sslmode=require

if (!DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is not set in .env (Neon/Postgres connection string).');
}

// -------------------- Database ---------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Many managed Postgres (incl. Neon/Render) require SSL. If your DATABASE_URL
  // already has ?sslmode=require you can omit this; otherwise keep it:
  ssl: { rejectUnauthorized: false },
});

// Create extension/table if missing (idempotent)
async function ensureSchema() {
  const sql = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await pool.query(sql);
}

// DB helpers
async function findUserByPhone(phone) {
  const { rows } = await pool.query(
    'SELECT id, name, phone, password_hash FROM users WHERE phone = $1 LIMIT 1',
    [phone]
  );
  return rows[0] || null;
}

async function createUser({ name, phone, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, phone, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, phone, created_at`,
    [name, phone, passwordHash]
  );
  return rows[0];
}

async function resetUsers() {
  await pool.query('TRUNCATE TABLE users');
}

// -------------------- Auth helpers -----------------
function signToken(user) {
  const payload = { id: user.id, name: user.name, phone: user.phone };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Bad auth header' });

  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// -------------------- Routes -----------------------

// Health
app.get('/', (_req, res) => res.send('✅ Auth + Chat Server (Neon DB) Running'));

// Register: { name, phone, password }
app.post('/register', async (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const existing = await findUserByPhone(phone);
    if (existing) return res.status(409).json({ error: 'Phone already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await createUser({ name, phone, passwordHash: hashed });

    const token = signToken(user);
    res.json({
      access_token: token,
      user_id: user.id,
      name: user.name,
      phone: user.phone,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login: { phone, password }
app.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const user = await findUserByPhone(phone);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({
      access_token: token,
      user_id: user.id,
      name: user.name,
      phone: user.phone,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Me (protected)
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await findUserByPhone(req.user.phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, phone: user.phone });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Testing helper (optional)
app.post('/reset-users', async (_req, res) => {
  try {
    await resetUsers();
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// -------------------- Start Server -----------------
(async () => {
  try {
    await ensureSchema(); // ensure DB ready before accepting requests
  } catch (e) {
    console.error('❌ Failed to ensure DB schema:', e);
    process.exit(1);
  }

  // ONE HTTP server for both Express and Socket.IO
  const server = http.createServer(app);

  // IMPORTANT: pass the HTTP server object here (NOT a string or variable named "chat")
  initChat(server, {
    jwtSecret: JWT_SECRET,
    // path: '/ws-chat', // keep if you customized the WS path; match on client
  });

  server.listen(PORT, () => {
    console.log(`🚀 Auth + Chat Server (Neon DB) listening on http://localhost:${PORT}`);
  });
})();