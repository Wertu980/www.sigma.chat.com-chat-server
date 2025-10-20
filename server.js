// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bcrypt = require('bcryptjs'); // pure-JS bcrypt (no native build)
const jwt = require('jsonwebtoken');
const http = require('http'); // ⬅️ use a shared HTTP server for REST + WebSocket

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data', 'instance');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TEMP_FILE = path.join(DATA_DIR, 'users.json.tmp');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 3000;

/** Ensure data dir & users file exist **/
async function ensureDataDir() {
await fsp.mkdir(DATA_DIR, { recursive: true });
    try {
        await fsp.access(USERS_FILE, fs.constants.F_OK);
       } catch (err) {
              // create empty array file
                  await safeWriteFile(USERS_FILE, JSON.stringify([], null, 2));
                    }
                    }

                    /** Safe write: write temp, then rename (minimize corruption) **/
                    async function safeWriteFile(dest, content) {
                      await fsp.writeFile(TEMP_FILE, content, 'utf8');
                        await fsp.rename(TEMP_FILE, dest);
                        }

                        /** Load users array from file **/
                        async function loadUsers() {
                          try {
                              const raw = await fsp.readFile(USERS_FILE, 'utf8');
                                  return JSON.parse(raw);
                                    } catch (err) {
                                        return [];
                                          }
                                          }

                                          /** Save users array **/
                                          async function saveUsers(users) {
                                            await safeWriteFile(USERS_FILE, JSON.stringify(users, null, 2));
                                            }

                                            /** Find user by phone (exact match) **/
                                            async function findUserByPhone(phone) {
                                              const users = await loadUsers();
                                                return users.find(u => (u.phone || '') === phone);
                                                }

                                                /** Sign JWT **/
                                                function signToken(user) {
                                                  const payload = { id: user.id, name: user.name, phone: user.phone };
                                                    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
                                                    }

                                                    /** Auth middleware **/
                                                    function authMiddleware(req, res, next) {
                                                      const auth = req.headers.authorization;
                                                        if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
                                                          const parts = auth.split(' ');
                                                            if (parts.length !== 2) return res.status(401).json({ error: 'Bad auth header' });
                                                              const token = parts[1];
                                                                try {
                                                                    const payload = jwt.verify(token, JWT_SECRET);
                                                                        req.user = payload;
                                                                            return next();
                                                                              } catch (err) {
                                                                                  return res.status(401).json({ error: 'Invalid token' });
                                                                                    }
                                                                                    }

                                                                                    /** --- REST Routes --- **/

                                                                                    // Health
                                                                                    app.get('/', (req, res) => res.send('Auth + Chat server running'));

                                                                                    // Register: expects { name, phone, password }
                                                                                    app.post('/register', async (req, res) => {
                                                                                      const { name, phone, password } = req.body || {};
                                                                                        if (!name || !phone || !password) return res.status(400).json({ error: 'Missing fields' });

                                                                                          try {
                                                                                              await ensureDataDir();

                                                                                                  // check existing phone
                                                                                                      const existing = await findUserByPhone(phone);
                                                                                                          if (existing) return res.status(409).json({ error: 'Phone already registered' });

                                                                                                              // hash password
                                                                                                                  const hashed = await bcrypt.hash(password, 10);

                                                                                                                      // create simple unique id
                                                                                                                          const id = Date.now().toString() + '-' + Math.floor(Math.random() * 10000);

                                                                                                                              const user = {
                                                                                                                                    id,
                                                                                                                                          name,
                                                                                                                                                phone,
                                                                                                                                                      password_hash: hashed,
                                                                                                                                                            created_at: new Date().toISOString()
                                                                                                                                                                };

                                                                                                                                                                    const users = await loadUsers();
                                                                                                                                                                        users.push(user);
                                                                                                                                                                            await saveUsers(users);

                                                                                                                                                                                const token = signToken(user);

                                                                                                                                                                                    return res.json({
                                                                                                                                                                                          access_token: token,
                                                                                                                                                                                                user_id: user.id,
                                                                                                                                                                                                      name: user.name,
                                                                                                                                                                                                            phone: user.phone
                                                                                                                                                                                                                });
                                                                                                                                                                                                                  } catch (err) {
                                                                                                                                                                                                                      console.error('Register error', err);
                                                                                                                                                                                                                          return res.status(500).json({ error: 'Server error' });
                                                                                                                                                                                                                            }
                                                                                                                                                                                                                            });

                                                                                                                                                                                                                            // Login: expects { phone, password }
                                                                                                                                                                                                                            app.post('/login', async (req, res) => {
                                                                                                                                                                                                                              const { phone, password } = req.body || {};
                                                                                                                                                                                                                                if (!phone || !password) return res.status(400).json({ error: 'Missing fields' });

                                                                                                                                                                                                                                  try {
                                                                                                                                                                                                                                      await ensureDataDir();
                                                                                                                                                                                                                                          const user = await findUserByPhone(phone);
                                                                                                                                                                                                                                              if (!user) return res.status(401).json({ error: 'Invalid credentials' });

                                                                                                                                                                                                                                                  const match = await bcrypt.compare(password, user.password_hash);
                                                                                                                                                                                                                                                      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

                                                                                                                                                                                                                                                          const token = signToken(user);
                                                                                                                                                                                                                                                              return res.json({
                                                                                                                                                                                                                                                                    access_token: token,
                                                                                                                                                                                                                                                                          user_id: user.id,
                                                                                                                                                                                                                                                                                name: user.name,
                                                                                                                                                                                                                                                                                      phone: user.phone
                                                                                                                                                                                                                                                                                          });
                                                                                                                                                                                                                                                                                            } catch (err) {
                                                                                                                                                                                                                                                                                                console.error('Login error', err);
                                                                                                                                                                                                                                                                                                    return res.status(500).json({ error: 'Server error' });
                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                      });

                                                                                                                                                                                                                                                                                                      // Protected example: /me
                                                                                                                                                                                                                                                                                                      app.get('/me', authMiddleware, async (req, res) => {
                                                                                                                                                                                                                                                                                                        try {
                                                                                                                                                                                                                                                                                                            const user = await findUserByPhone(req.user.phone);
                                                                                                                                                                                                                                                                                                                if (!user) return res.status(404).json({ error: 'User not found' });
                                                                                                                                                                                                                                                                                                                    return res.json({ id: user.id, name: user.name, phone: user.phone });
                                                                                                                                                                                                                                                                                                                      } catch (err) {
                                                                                                                                                                                                                                                                                                                          console.error('Me error', err);
                                                                                                                                                                                                                                                                                                                              return res.status(500).json({ error: 'Server error' });
                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                });

                                                                                                                                                                                                                                                                                                                                /** Optional: wipe all users (for testing) **/
                                                                                                                                                                                                                                                                                                                                app.post('/reset-users', async (req, res) => {
                                                                                                                                                                                                                                                                                                                                  try {
                                                                                                                                                                                                                                                                                                                                      await ensureDataDir();
                                                                                                                                                                                                                                                                                                                                          await saveUsers([]);
                                                                                                                                                                                                                                                                                                                                              return res.json({ ok: true });
                                                                                                                                                                                                                                                                                                                                                } catch (err) {
                                                                                                                                                                                                                                                                                                                                                    console.error('Reset error', err);
                                                                                                                                                                                                                                                                                                                                                        return res.status(500).json({ error: 'Server error' });
                                                                                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                                                                                          });

                                                                                                                                                                                                                                                                                                                                                          /** --- Start combined HTTP + WebSocket server --- **/

                                                                                                                                                                                                                                                                                                                                                          // 1) Create a single HTTP server that backs both Express and Socket.IO
                                                                                                                                                                                                                                                                                                                                                          const server = http.createServer(app);

                                                                                                                                                                                                                                                                                                                                                          // 2) Initialize your chat server on the SAME HTTP server
                                                                                                                                                                                                                                                                                                                                                          //    chat-server.js should export: function initChat(httpServer, { jwtSecret, path? })
                                                                                                                                                                                                                                                                                                                                                          const { initChat } = require('./chat-server');
                                                                                                                                                                                                                                                                                                                                                          initChat(server, {
                                                                                                                                                                                                                                                                                                                                                            jwtSecret: JWT_SECRET, // same secret as REST
                                                                                                                                                                                                                                                                                                                                                              // path: '/ws-chat',   // optional custom WS path; comment to use socket.io default
                                                                                                                                                                                                                                                    });

                                                                                                                                                                                                                                                                                                                                                              // 3) Listen once (do NOT call app.listen elsewhere)
server.listen(PORT, () => {
    console.log(`Auth + Chat server listening at http://localhost:${PORT}`);
});