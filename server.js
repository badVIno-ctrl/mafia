/* =========================================================================
   Мафия онлайн — сервер без единой внешней зависимости.
   Запуск:  node server.js  (порт по умолчанию 8080, переопределяется PORT)
   Транспорт: REST (действия) + SSE (пуш-обновления состояния)
   ========================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./shared/game-config.js');
const { Game } = require('./server/game.js');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'users.json');

const ONLINE_MS = 45000;          // считаем человека онлайн, если был активен в это окно

/* ============================= хранилище ============================= */
const users = new Map();    // id -> { id, name, token, createdAt, lastSeen, roomId }
const rooms = new Map();    // id -> room
const clients = new Set();  // { userId, res }

function uid(p) { return p + '_' + crypto.randomBytes(6).toString('hex'); }

function loadUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    raw.forEach(u => users.set(u.id, Object.assign({ lastSeen: 0, roomId: null }, u)));
    console.log('Загружено аккаунтов: ' + users.size);
  } catch (e) { /* первый запуск */ }
}
let saveTimer = null;
function saveUsers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...users.values()].map(u => ({
        id: u.id, name: u.name, token: u.token, createdAt: u.createdAt
      })), null, 1));
    } catch (e) { console.warn('Не удалось сохранить аккаунты:', e.message); }
  }, 400);
}

/* ============================= помощники ============================= */
function isOnline(u) { return Date.now() - (u.lastSeen || 0) < ONLINE_MS; }

function publicUser(u) {
  return { id: u.id, name: u.name, online: isOnline(u), roomId: u.roomId || null };
}

function roomView(room, forUserId) {
  const g = room.game;
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    hostId: room.hostId,
    hostName: (users.get(room.hostId) || {}).name || '—',
    scenarioId: room.scenarioId,
    size: room.size,
    started: !!g,
    finished: g ? g.finished : false,
    autoStart: room.autoStart,
    members: room.members.map(id => {
      const u = users.get(id);
      return { id, name: u ? u.name : '—', online: u ? isOnline(u) : false, host: id === room.hostId };
    }),
    invites: room.invites.map(id => ({ id, name: (users.get(id) || {}).name || '—' })),
    canStart: !g && room.members.length >= C.MIN_PLAYERS,
    scenarios: C.scenariosFor(Math.max(C.MIN_PLAYERS, room.members.length))
      .map(s => ({ id: s.id, title: s.title, place: s.place, min: s.min, max: s.max, prologue: s.prologue })),
    composition: C.composition(Math.max(C.MIN_PLAYERS, room.members.length)),
    compositionLabel: C.compositionLabel(Math.max(C.MIN_PLAYERS, room.members.length)),
    chat: room.chat.slice(-60),
    game: g ? g.viewFor(forUserId) : null
  };
}

function lobbyView(userId) {
  const me = users.get(userId);
  return {
    me: me ? publicUser(me) : null,
    users: [...users.values()]
      .filter(u => u.id !== userId)
      .sort((a, b) => (isOnline(b) - isOnline(a)) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 200)
      .map(publicUser),
    rooms: [...rooms.values()].map(r => ({
      id: r.id, code: r.code, title: r.title,
      hostName: (users.get(r.hostId) || {}).name || '—',
      players: r.members.length, size: r.size,
      started: !!r.game,
      scenario: (C.scenarioById(r.scenarioId) || {}).title || 'Случайный',
      invited: r.invites.indexOf(userId) >= 0,
      mine: r.members.indexOf(userId) >= 0
    })),
    invites: [...rooms.values()].filter(r => r.invites.indexOf(userId) >= 0).map(r => ({
      roomId: r.id, code: r.code, title: r.title,
      from: (users.get(r.hostId) || {}).name || '—', players: r.members.length, size: r.size
    }))
  };
}

/* ============================= SSE ============================= */
function sseSend(client, event, data) {
  try {
    client.res.write('event: ' + event + '\n');
    client.res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (e) { /* клиент отвалился */ }
}

function pushLobby() {
  clients.forEach(c => sseSend(c, 'lobby', lobbyView(c.userId)));
}
function pushRoom(room) {
  clients.forEach(c => {
    if (room.members.indexOf(c.userId) >= 0 || room.invites.indexOf(c.userId) >= 0) {
      sseSend(c, 'room', roomView(room, c.userId));
    }
  });
}
function pushAll(room) { pushRoom(room); pushLobby(); }

/* ============================= такт игр ============================= */
setInterval(() => {
  rooms.forEach(room => {
    if (!room.game) {
      // автостарт, когда набралось нужное число игроков
      if (room.autoStart && room.members.length >= room.size) startGame(room);
      return;
    }
    const before = room.game.phase + '|' + room.game.log.length + '|' + room.game.chat.length;
    const changed = room.game.tick();
    if (changed || before !== room.game.phase + '|' + room.game.log.length + '|' + room.game.chat.length) pushRoom(room);
  });
}, 1000);

// раз в 5 секунд — пуш таймеров и онлайн-статусов
setInterval(() => {
  rooms.forEach(room => { if (room.game && !room.game.finished) pushRoom(room); });
  pushLobby();
}, 5000);

function startGame(room) {
  const members = room.members.map(id => ({ id, name: (users.get(id) || {}).name || 'Игрок' }));
  if (members.length < C.MIN_PLAYERS) return { error: 'Нужно минимум ' + C.MIN_PLAYERS + ' игроков' };
  if (members.length > C.MAX_PLAYERS) return { error: 'Максимум ' + C.MAX_PLAYERS + ' игроков' };
  const sc = C.scenarioById(room.scenarioId);
  const fits = sc && members.length >= sc.min && members.length <= sc.max;
  room.game = new Game(members, fits ? room.scenarioId : null);
  room.chat.push({ system: true, text: 'Партия началась: «' + room.game.scenario.title + '».', ts: Date.now() });
  pushAll(room);
  return { ok: true };
}

/* ============================= HTTP ============================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Битый JSON')); } });
    req.on('error', reject);
  });
}

function auth(req, url) {
  const token = req.headers['x-token'] || url.searchParams.get('token');
  if (!token) return null;
  const u = [...users.values()].find(x => x.token === token);
  if (u) u.lastSeen = Date.now();
  return u || null;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // всё неизвестное — на главную
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, home) => {
        if (e2) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
        send(res, 200, home, MIME['.html']);
      });
      return;
    }
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  /* ---------- SSE ---------- */
  if (p === '/api/events') {
    const me = auth(req, url);
    if (!me) return send(res, 401, { error: 'Нет авторизации' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const client = { userId: me.id, res };
    clients.add(client);
    sseSend(client, 'lobby', lobbyView(me.id));
    const room = me.roomId ? rooms.get(me.roomId) : null;
    if (room) sseSend(client, 'room', roomView(room, me.id));
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(client); });
    return;
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  try {
    /* ---------- аккаунты ---------- */
    if (p === '/api/register' && req.method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 16);
      if (name.length < 2) return send(res, 400, { error: 'Имя от 2 до 16 символов' });
      const taken = [...users.values()].some(u => u.name.toLowerCase() === name.toLowerCase());
      if (taken) return send(res, 409, { error: 'Такое имя уже занято — возьмите другое' });
      const u = { id: uid('u'), name, token: crypto.randomBytes(16).toString('hex'), createdAt: Date.now(), lastSeen: Date.now(), roomId: null };
      users.set(u.id, u);
      saveUsers(); pushLobby();
      return send(res, 200, { user: { id: u.id, name: u.name, token: u.token } });
    }

    if (p === '/api/me') {
      const me = auth(req, url);
      if (!me) return send(res, 401, { error: 'Нет авторизации' });
      return send(res, 200, { user: { id: me.id, name: me.name, token: me.token }, lobby: lobbyView(me.id) });
    }

    if (p === '/api/rename' && req.method === 'POST') {
      const me = auth(req, url);
      if (!me) return send(res, 401, { error: 'Нет авторизации' });
      const name = String(body.name || '').trim().slice(0, 16);
      if (name.length < 2) return send(res, 400, { error: 'Имя от 2 до 16 символов' });
      if ([...users.values()].some(u => u.id !== me.id && u.name.toLowerCase() === name.toLowerCase()))
        return send(res, 409, { error: 'Имя занято' });
      me.name = name; saveUsers(); pushLobby();
      return send(res, 200, { ok: true, user: { id: me.id, name: me.name, token: me.token } });
    }

    /* ---------- лобби ---------- */
    const me = auth(req, url);
    if (!me) return send(res, 401, { error: 'Нет авторизации' });

    if (p === '/api/lobby') return send(res, 200, lobbyView(me.id));

    if (p === '/api/rooms/create' && req.method === 'POST') {
      // один человек — одна комната
      leaveRoom(me);
      const size = Math.max(C.MIN_PLAYERS, Math.min(C.MAX_PLAYERS, Number(body.size) || 8));
      const room = {
        id: uid('r'),
        code: String(Math.floor(1000 + Math.random() * 9000)),
        title: String(body.title || ('Комната ' + me.name)).slice(0, 40),
        hostId: me.id,
        members: [me.id],
        invites: [],
        size,
        autoStart: body.autoStart !== false,
        scenarioId: body.scenarioId || (C.scenariosFor(size)[0] || C.SCENARIOS[0]).id,
        chat: [],
        game: null,
        createdAt: Date.now()
      };
      rooms.set(room.id, room);
      me.roomId = room.id;
      pushAll(room);
      return send(res, 200, { room: roomView(room, me.id) });
    }

    const roomId = body.roomId || url.searchParams.get('roomId');
    const room = roomId ? rooms.get(roomId) : (me.roomId ? rooms.get(me.roomId) : null);

    if (p === '/api/rooms/state') {
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      return send(res, 200, { room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/join' && req.method === 'POST') {
      let target = room;
      if (!target && body.code) target = [...rooms.values()].find(r => r.code === String(body.code).trim());
      if (!target) return send(res, 404, { error: 'Комната не найдена' });
      if (target.game) return send(res, 409, { error: 'Партия уже идёт' });
      if (target.members.length >= C.MAX_PLAYERS) return send(res, 409, { error: 'Комната полная (20 человек)' });
      if (target.members.indexOf(me.id) < 0) {
        leaveRoom(me);
        target.members.push(me.id);
        target.invites = target.invites.filter(i => i !== me.id);
        target.chat.push({ system: true, text: me.name + ' зашёл в комнату.', ts: Date.now() });
        me.roomId = target.id;
      }
      pushAll(target);
      return send(res, 200, { room: roomView(target, me.id) });
    }

    if (p === '/api/rooms/invite' && req.method === 'POST') {
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      if (room.hostId !== me.id) return send(res, 403, { error: 'Приглашать может только хозяин комнаты' });
      const target = users.get(body.userId);
      if (!target) return send(res, 404, { error: 'Игрок не найден' });
      if (room.members.indexOf(target.id) >= 0) return send(res, 409, { error: 'Уже в комнате' });
      if (room.invites.indexOf(target.id) < 0) room.invites.push(target.id);
      pushAll(room);
      return send(res, 200, { ok: true, room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/kick' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      if (room.game) return send(res, 409, { error: 'Партия уже идёт' });
      const target = users.get(body.userId);
      room.members = room.members.filter(i => i !== body.userId);
      room.invites = room.invites.filter(i => i !== body.userId);
      if (target) target.roomId = null;
      pushAll(room);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/rooms/config' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      if (room.game) return send(res, 409, { error: 'Партия уже идёт' });
      if (body.scenarioId !== undefined) room.scenarioId = body.scenarioId;
      if (body.size !== undefined) room.size = Math.max(C.MIN_PLAYERS, Math.min(C.MAX_PLAYERS, Number(body.size) || 8));
      if (body.autoStart !== undefined) room.autoStart = !!body.autoStart;
      if (body.title !== undefined) room.title = String(body.title).slice(0, 40);
      pushAll(room);
      return send(res, 200, { room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/start' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      if (room.game) return send(res, 409, { error: 'Партия уже идёт' });
      const r = startGame(room);
      if (r.error) return send(res, 400, r);
      return send(res, 200, { room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/restart' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      room.game = null;
      room.chat.push({ system: true, text: 'Хозяин собирает новую партию.', ts: Date.now() });
      pushAll(room);
      return send(res, 200, { room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/leave' && req.method === 'POST') {
      const r = room;
      leaveRoom(me);
      if (r) pushAll(r); else pushLobby();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/rooms/chat' && req.method === 'POST') {
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      const text = String(body.text || '').trim().slice(0, 400);
      if (!text) return send(res, 400, { error: 'Пустое сообщение' });
      if (room.game) {
        const r = room.game.say(me.id, text, body.channel || 'town');
        if (r.error) return send(res, 400, r);
      } else {
        room.chat.push({ from: me.id, name: me.name, text, ts: Date.now() });
        if (room.chat.length > 200) room.chat.shift();
      }
      pushRoom(room);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/rooms/action' && req.method === 'POST') {
      if (!room || !room.game) return send(res, 404, { error: 'Партия не идёт' });
      const r = room.game.action(me.id, body.type, body.target);
      if (r.error) return send(res, 400, r);
      room.game.tick();
      pushRoom(room);
      return send(res, 200, { ok: true, game: room.game.viewFor(me.id) });
    }

    return send(res, 404, { error: 'Нет такого метода' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Внутренняя ошибка: ' + e.message });
  }
});

function leaveRoom(user) {
  if (!user.roomId) return;
  const room = rooms.get(user.roomId);
  user.roomId = null;
  if (!room) return;
  room.members = room.members.filter(i => i !== user.id);
  room.chat.push({ system: true, text: user.name + ' вышел из комнаты.', ts: Date.now() });
  if (!room.members.length) { rooms.delete(room.id); return; }
  if (room.hostId === user.id) room.hostId = room.members[0];
}

loadUsers();
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('\n  Мафия онлайн запущена');
    console.log('  На этом компьютере:  http://localhost:' + PORT);
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal)
      .forEach(n => console.log('  В локальной сети:    http://' + n.address + ':' + PORT));
    console.log('');
  });
}

module.exports = { server, users, rooms, startGame };
