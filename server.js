/* ============================================================
   CYBER CHAT RILL — Backend
   Developed by: Fahril Moonstar
============================================================ */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cyber-rill-secret-ganti-di-production';
const DB_FILE = path.join(__dirname, 'users.json');

/* ---------- Simple JSON DB ---------- */
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); } catch { return []; }
}
function saveDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

const db = {
  findByUsername: (u) => loadDB().find(x => x.username === u),
  findById: (id) => loadDB().find(x => x.id === id),
  create: (user) => { const a = loadDB(); a.push(user); saveDB(a); return user; },
  listExcept: (id, q = '') => {
    q = q.toLowerCase();
    return loadDB()
      .filter(u => u.id !== id &&
        (u.id.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)))
      .map(u => ({ id: u.id, username: u.username }));
  },
  addContact: (uid, cid) => {
    const a = loadDB(); const u = a.find(x => x.id === uid);
    if (!u) return false;
    u.contacts = u.contacts || [];
    if (!u.contacts.includes(cid)) u.contacts.push(cid);
    saveDB(a); return true;
  }
};

/* ---------- App + Socket.IO ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
}

/* ---------- REST API ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'CYBER CHAT RILL' }));

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username & password wajib' });
  if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (db.findByUsername(username)) return res.status(409).json({ error: 'Username sudah dipakai' });

  const hashed = await bcrypt.hash(password, 10);
  const id = 'NW-' + uuid().slice(0, 8).toUpperCase();
  const user = { id, username, password: hashed, contacts: [], createdAt: Date.now() };
  db.create(user);

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = db.findByUsername(username);
  if (!u) return res.status(401).json({ error: 'Username / kata sandi salah' });
  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return res.status(401).json({ error: 'Username / kata sandi salah' });

  const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, username: u.username } });
});

// Profile
app.get('/api/me', auth, (req, res) => {
  const u = db.findById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ id: u.id, username: u.username, contacts: u.contacts || [] });
});

// Search users
app.get('/api/users', auth, (req, res) => {
  res.json(db.listExcept(req.user.id, req.query.q || ''));
});

// Add contact
app.post('/api/contacts', auth, (req, res) => {
  const { contactId } = req.body || {};
  if (!db.findById(contactId)) return res.status(404).json({ error: 'Kontak tidak ditemukan' });
  db.addContact(req.user.id, contactId);
  res.json({ ok: true });
});

/* ---------- Socket.IO Realtime ---------- */
const online = new Map(); // userId -> socketId

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', (socket) => {
  const me = socket.user;
  online.set(me.id, socket.id);
  io.emit('presence', { userId: me.id, status: 'online' });

  // Chat message
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

  // WebRTC signaling (buat voice/video call masa depan)
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

server.listen(PORT, () => {
  console.log(`⚡ CYBER CHAT RILL running → http://localhost:${PORT}`);
});