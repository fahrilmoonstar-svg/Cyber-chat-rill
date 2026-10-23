const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET || 'cyber-rill-secret-keren';

const app = express();
app.use(express.json());

// Database sementara di memori (tanpa KV)
const usersDB = {}; // { username: { id, username, password, contacts } }
const online = new Map(); // { userId: socketId }

/* ---------- Auth Middleware ---------- */
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
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username & password wajib' });
  if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
  if (usersDB[username]) return res.status(409).json({ error: 'Username sudah dipakai' });

  const hashed = await bcrypt.hash(password, 10);
  const id = 'NW-' + uuid().slice(0, 8).toUpperCase();
  usersDB[username] = { id, username, password: hashed, contacts: [] };

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = usersDB[username];
  if (!u) return res.status(401).json({ error: 'Username / kata sandi salah' });
  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return res.status(401).json({ error: 'Username / kata sandi salah' });

  const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, username: u.username } });
});

app.get('/api/me', auth, (req, res) => {
  const u = Object.values(usersDB).find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  res.json({ id: u.id, username: u.username, contacts: u.contacts || [] });
});

app.get('/api/users', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const list = Object.values(usersDB)
    .filter(u => u.id !== req.user.id && (u.id.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)))
    .map(u => ({ id: u.id, username: u.username }));
  res.json(list);
});

app.post('/api/contacts', auth, (req, res) => {
  const { contactId } = req.body || {};
  const target = Object.values(usersDB).find(u => u.id === contactId);
  if (!target) return res.status(404).json({ error: 'Kontak tidak ditemukan' });

  const me = Object.values(usersDB).find(u => u.id === req.user.id);
  if (!me.contacts.includes(contactId)) me.contacts.push(contactId);
  res.json({ ok: true });
});

/* ---------- Socket.IO ---------- */
const server = http.createServer(app);
const io = new Server(server, {
  path: '/api/socket.io',
  transports: ['websocket'],
  cors: { origin: '*' }
});

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

  socket.on('message:send', ({ to, text }) => {
    if (!to || !text) return;
    const payload = { type: 'nova_msg', from: me.id, fromName: me.username, to, text, at: Date.now() };
    const target = online.get(to);
    if (target) io.to(target).emit('message:new', payload);
    socket.emit('message:sent', payload);
  });

  socket.on('disconnect', () => {
    online.delete(me.id);
    io.emit('presence', { userId: me.id, status: 'offline' });
  });
});

module.exports = server;