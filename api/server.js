/* ============================================================
   CYBER CHAT RILL — Backend for Vercel
   Developed by: Fahril Moonstar
   Catatan: pakai Vercel KV untuk persistence user.
   Socket.IO jalan di Function Vercel (WebSocket support).
============================================================ */
const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');
const { kv } = require('@vercel/kv');

const JWT_SECRET = process.env.JWT_SECRET || 'cyber-rill-secret-ganti-di-production';

const app = express();
app.use(express.json());

/* ---------- Helper KV ---------- */
const USER_KEY = (username) => `user:${username}`;
const ID_KEY = (id) => `id:${id}`;

async function findByUsername(username) {
  const user = await kv.get(USER_KEY(username));
  return user || null;
}
async function findById(id) {
  const username = await kv.get(ID_KEY(id));
  if (!username) return null;
  return await kv.get(USER_KEY(username));
}
async function saveUser(user) {
  await kv.set(USER_KEY(user.username), user);
  await kv.set(ID_KEY(user.id), user.username);
}

/* ---------- Auth middleware ---------- */
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/* ---------- REST API ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'CYBER CHAT RILL' }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username & password wajib' });
    if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

    const existing = await findByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username sudah dipakai' });

    const hashed = await bcrypt.hash(password, 10);
    const id = 'NW-' + uuid().slice(0, 8).toUpperCase();
    const user = { id, username, password: hashed, contacts: [], createdAt: Date.now() };
    await saveUser(user);

    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username } });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = await findByUsername(username);
    if (!u) return res.status(401).json({ error: 'Username / kata sandi salah' });
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: 'Username / kata sandi salah' });

    const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: u.id, username: u.username } });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const u = await findById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ id: u.id, username: u.username, contacts: u.contacts || [] });
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    // Scan semua key user (untuk demo; production sebaiknya pakai index)
    const keys = await kv.keys('user:*');
    const users = [];
    for (const key of keys) {
      const u = await kv.get(key);
      if (u && u.id !== req.user.id &&
          (u.id.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))) {
        users.push({ id: u.id, username: u.username });
      }
    }
    res.json(users.slice(0, 20));
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.post('/api/contacts', auth, async (req, res) => {
  try {
    const { contactId } = req.body || {};
    const target = await findById(contactId);
    if (!target) return res.status(404).json({ error: 'Kontak tidak ditemukan' });

    const me = await findById(req.user.id);
    me.contacts = me.contacts || [];
    if (!me.contacts.includes(contactId)) me.contacts.push(contactId);
    await saveUser(me);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

/* ---------- Socket.IO di Vercel Function ---------- */
const server = http.createServer(app);
const io = new Server(server, {
  path: '/api/socket.io',
  transports: ['websocket'], // WAJIB untuk Vercel [citation:7]
  cors: { origin: '*' }
});

const online = new Map(); // userId -> socketId

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const me = socket.user;
  online.set(me.id, socket.id);
  io.emit('presence', { userId: me.id, status: 'online' });

  socket.on('message:send', ({ to, text }) => {
    if (!to || !text) return;
    const payload = {
      type: 'nova_msg',
      from: me.id,
      fromName: me.username,
      to,
      text,
      at: Date.now()
    };
    const target = online.get(to);
    if (target) io.to(target).emit('message:new', payload);
    socket.emit('message:sent', payload);
  });

  // Signaling WebRTC (buat call masa depan)
  ['call:offer', 'call:answer', 'call:ice', 'call:end'].forEach(evt => {
    socket.on(evt, (data) => {
      const target = online.get(data.to);
      if (target) io.to(target).emit(evt, { ...data, from: me.id, fromName: me.username });
    });
  });

  socket.on('disconnect', () => {
    online.delete(me.id);
    io.emit('presence', { userId: me.id, status: 'offline' });
  });
});

/* ---------- Export untuk Vercel (JANGAN app.listen) ---------- */
module.exports = server;
