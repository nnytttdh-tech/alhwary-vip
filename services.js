const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database("nexachat.db");

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  UNIQUE(group_id, username)
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subscriber',
  UNIQUE(channel_id, username)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  image_data TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  UNIQUE(post_id, username)
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  image_data TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
`);

// ---------- helpers ----------
const cleanUser = u => String(u || "").trim().replace(/^@/, "").toLowerCase();
const validUser = u => /^[a-z0-9_]{3,24}$/.test(u);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}
function safeEqual(a, b) {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function createSession(username) {
  const token = makeToken();
  db.prepare("INSERT INTO sessions(token, username) VALUES(?,?)").run(token, username);
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare("SELECT username FROM sessions WHERE token=?").get(token);
  return row ? row.username : null;
}
function requireAuth(req, res, next) {
  const username = sessionUser(req.header("x-auth-token"));
  if (!username) return res.status(401).json({ error: "لازم تسجل الدخول الأول" });
  req.username = username;
  next();
}

// ---------- auth ----------
app.post("/api/register", (req, res) => {
  const username = cleanUser(req.body.username);
  const displayName = String(req.body.displayName || username).trim().slice(0, 40);
  const password = String(req.body.password || "");
  if (!validUser(username)) return res.status(400).json({ error: "اليوزر لازم يكون 3-24 حرفًا: a-z أو 0-9 أو _" });
  if (!displayName) return res.status(400).json({ error: "اكتب اسمًا ظاهرًا" });
  if (password.length < 6) return res.status(400).json({ error: "الباسورد لازم يكون 6 أحرف على الأقل" });

  try {
    const salt = makeSalt();
    const hash = hashPassword(password, salt);
    db.prepare("INSERT INTO users(username, display_name, password_hash, password_salt) VALUES(?,?,?,?)")
      .run(username, displayName, hash, salt);
    const token = createSession(username);
    res.json({ username, displayName, token });
  } catch {
    res.status(409).json({ error: "اليوزر مستخدم بالفعل" });
  }
});

app.post("/api/login", (req, res) => {
  const username = cleanUser(req.body.username);
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user) return res.status(404).json({ error: "الحساب مش موجود" });
  const hash = hashPassword(password, user.password_salt);
  if (!safeEqual(hash, user.password_hash)) return res.status(401).json({ error: "الباسورد غلط" });
  const token = createSession(username);
  res.json({ username: user.username, displayName: user.display_name, token });
});

app.post("/api/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token=?").run(req.header("x-auth-token"));
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT username, display_name FROM users WHERE username=?").get(req.username);
  res.json(user);
});

app.get("/api/user/:username", (req, res) => {
  const username = cleanUser(req.params.username);
  const user = db.prepare("SELECT username, display_name FROM users WHERE username=?").get(username);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
  res.json(user);
});

app.get("/api/search", (req, res) => {
  const q = cleanUser(req.query.q);
  if (!q) return res.json([]);
  const users = db.prepare(
    "SELECT username, display_name FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 20"
  ).all(`%${q}%`, `%${q}%`);
  res.json(users);
});

// ---------- groups (واتس) ----------
app.post("/api/groups", requireAuth, (req, res) => {
  const owner = req.username;
  const name = String(req.body.name || "").trim().slice(0, 60);
  const members = Array.isArray(req.body.members) ? req.body.members.map(cleanUser) : [];
  if (!name) return res.status(400).json({ error: "بيانات المجموعة غير صحيحة" });

  const tx = db.transaction(() => {
    const result = db.prepare("INSERT INTO groups(name, owner) VALUES(?,?)").run(name, owner);
    const gid = result.lastInsertRowid;
    const add = db.prepare("INSERT OR IGNORE INTO group_members(group_id, username) VALUES(?,?)");
    add.run(gid, owner);
    for (const m of members.slice(0, 49)) {
      if (validUser(m)) add.run(gid, m);
    }
    return gid;
  });

  res.json({ id: tx, name });
});

app.get("/api/groups/:username", (req, res) => {
  const username = cleanUser(req.params.username);
  const groups = db.prepare(`
    SELECT g.id, g.name, g.owner
    FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE gm.username=? ORDER BY g.id DESC
  `).all(username);
  res.json(groups);
});

// ---------- channels (واتس - قنوات) ----------
app.post("/api/channels", requireAuth, (req, res) => {
  const owner = req.username;
  const name = String(req.body.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "اسم القناة مطلوب" });

  const tx = db.transaction(() => {
    const result = db.prepare("INSERT INTO channels(name, owner) VALUES(?,?)").run(name, owner);
    const cid = result.lastInsertRowid;
    db.prepare("INSERT INTO channel_members(channel_id, username, role) VALUES(?,?,'owner')").run(cid, owner);
    return cid;
  });

  res.json({ id: tx, name });
});

app.get("/api/channels/:username", (req, res) => {
  const username = cleanUser(req.params.username);
  const channels = db.prepare(`
    SELECT c.id, c.name, c.owner, cm.role
    FROM channels c JOIN channel_members cm ON cm.channel_id=c.id
    WHERE cm.username=? ORDER BY c.id DESC
  `).all(username);
  res.json(channels);
});

app.get("/api/channels-discover", (req, res) => {
  const channels = db.prepare("SELECT id, name, owner FROM channels ORDER BY id DESC LIMIT 50").all();
  res.json(channels);
});

app.post("/api/channels/:id/join", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const channel = db.prepare("SELECT * FROM channels WHERE id=?").get(id);
  if (!channel) return res.status(404).json({ error: "القناة غير موجودة" });
  db.prepare("INSERT OR IGNORE INTO channel_members(channel_id, username, role) VALUES(?,?,'subscriber')").run(id, req.username);
  res.json({ ok: true });
});

// ---------- messages (خاص / جروب / قناة) ----------
app.get("/api/messages/:type/:id", (req, res) => {
  const type = ["group", "channel"].includes(req.params.type) ? req.params.type : "private";
  const id = String(req.params.id);
  const rows = db.prepare(
    "SELECT sender, text, created_at FROM messages WHERE chat_type=? AND chat_id=? ORDER BY id DESC LIMIT 100"
  ).all(type, id).reverse();
  res.json(rows);
});

// ---------- posts (فيس) ----------
app.post("/api/posts", requireAuth, (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 3000);
  const image = req.body.image ? String(req.body.image).slice(0, 7_000_000) : null;
  if (!text && !image) return res.status(400).json({ error: "اكتب حاجة أو ضيف صورة" });
  const result = db.prepare("INSERT INTO posts(username, text, image_data) VALUES(?,?,?)").run(req.username, text, image);
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(result.lastInsertRowid);
  res.json(post);
});

app.get("/api/posts", (req, res) => {
  const viewer = sessionUser(req.header("x-auth-token"));
  const rows = db.prepare(`
    SELECT p.id, p.username, p.text, p.image_data, p.created_at, u.display_name,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) as likes
    FROM posts p JOIN users u ON u.username=p.username
    ORDER BY p.id DESC LIMIT 50
  `).all();
  const liked = viewer ? new Set(
    db.prepare("SELECT post_id FROM post_likes WHERE username=?").all(viewer).map(r => r.post_id)
  ) : new Set();
  res.json(rows.map(r => ({ ...r, likedByMe: liked.has(r.id) })));
});

app.post("/api/posts/:id/like", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT 1 FROM post_likes WHERE post_id=? AND username=?").get(id, req.username);
  if (existing) db.prepare("DELETE FROM post_likes WHERE post_id=? AND username=?").run(id, req.username);
  else db.prepare("INSERT INTO post_likes(post_id, username) VALUES(?,?)").run(id, req.username);
  const likes = db.prepare("SELECT COUNT(*) c FROM post_likes WHERE post_id=?").get(id).c;
  res.json({ likes, likedByMe: !existing });
});

app.delete("/api/posts/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(id);
  if (!post || post.username !== req.username) return res.status(403).json({ error: "مش مسموح" });
  db.prepare("DELETE FROM posts WHERE id=?").run(id);
  db.prepare("DELETE FROM post_likes WHERE post_id=?").run(id);
  res.json({ ok: true });
});

// ---------- stories (فيس - حالات) ----------
app.post("/api/stories", requireAuth, (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  const image = req.body.image ? String(req.body.image).slice(0, 7_000_000) : null;
  if (!text && !image) return res.status(400).json({ error: "اكتب حاجة أو ضيف صورة" });
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const result = db.prepare("INSERT INTO stories(username, text, image_data, expires_at) VALUES(?,?,?,?)")
    .run(req.username, text, image, expires);
  const story = db.prepare("SELECT * FROM stories WHERE id=?").get(result.lastInsertRowid);
  res.json(story);
});

app.get("/api/stories", (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.username, s.text, s.image_data, s.created_at, u.display_name
    FROM stories s JOIN users u ON u.username=s.username
    WHERE s.expires_at > datetime('now')
    ORDER BY s.id DESC
  `).all();
  res.json(rows);
});

// ---------- realtime ----------
io.on("connection", socket => {
  socket.on("join", token => {
    const username = sessionUser(token);
    if (!username) return socket.emit("errorMessage", "لازم تسجل الدخول");
    socket.username = username;
    socket.join(`user:${username}`);
  });

  socket.on("private:send", ({ to, text }) => {
    const from = socket.username;
    to = cleanUser(to);
    text = String(text || "").trim().slice(0, 2000);
    if (!from || !validUser(to) || !text) return;

    const exists = db.prepare("SELECT 1 FROM users WHERE username=?").get(to);
    if (!exists) return socket.emit("errorMessage", "المستخدم غير موجود");

    const chatId = [from, to].sort().join(":");
    db.prepare("INSERT INTO messages(chat_type,chat_id,sender,text) VALUES('private',?,?,?)")
      .run(chatId, from, text);

    const msg = { sender: from, to, text, created_at: new Date().toISOString() };
    io.to(`user:${from}`).to(`user:${to}`).emit("private:message", msg);
  });

  socket.on("group:send", ({ groupId, text }) => {
    const from = socket.username;
    const id = Number(groupId);
    text = String(text || "").trim().slice(0, 2000);
    if (!from || !Number.isInteger(id) || !text) return;

    const member = db.prepare(
      "SELECT 1 FROM group_members WHERE group_id=? AND username=?"
    ).get(id, from);
    if (!member) return socket.emit("errorMessage", "أنت لست عضوًا في هذه المجموعة");

    db.prepare("INSERT INTO messages(chat_type,chat_id,sender,text) VALUES('group',?,?,?)")
      .run(String(id), from, text);

    const members = db.prepare("SELECT username FROM group_members WHERE group_id=?").all(id);
    const msg = { groupId: id, sender: from, text, created_at: new Date().toISOString() };
    for (const m of members) io.to(`user:${m.username}`).emit("group:message", msg);
  });

  socket.on("channel:send", ({ channelId, text }) => {
    const from = socket.username;
    const id = Number(channelId);
    text = String(text || "").trim().slice(0, 2000);
    if (!from || !Number.isInteger(id) || !text) return;

    const member = db.prepare(
      "SELECT role FROM channel_members WHERE channel_id=? AND username=?"
    ).get(id, from);
    if (!member) return socket.emit("errorMessage", "أنت لست مشتركًا في هذه القناة");
    if (member.role !== "owner") return socket.emit("errorMessage", "النشر في القناة لصاحبها فقط");

    db.prepare("INSERT INTO messages(chat_type,chat_id,sender,text) VALUES('channel',?,?,?)")
      .run(String(id), from, text);

    const members = db.prepare("SELECT username FROM channel_members WHERE channel_id=?").all(id);
    const msg = { channelId: id, sender: from, text, created_at: new Date().toISOString() };
    for (const m of members) io.to(`user:${m.username}`).emit("channel:message", msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`NexaChat running on ${PORT}`));
