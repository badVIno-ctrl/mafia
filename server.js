/* =========================================================================
   Мафия онлайн — сервер без единой внешней зависимости.
   Запуск:  node server.js  (порт по умолчанию 8080, переопределяется PORT)
   Транспорт: REST (действия) + SSE (пуш-обновления состояния)
   ========================================================================= */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./shared/game-config.js');
const { Game } = require('./server/game.js');
const Bots = require('./server/bots.js');

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
/* Бот всегда на связи: его хода ждать не страшно, и он никогда не
   «теряет соединение», из-за которого фаза висела бы до таймаута. */
function isOnline(u) { return !!u.bot || Date.now() - (u.lastSeen || 0) < ONLINE_MS; }

function publicUser(u) {
  return { id: u.id, name: u.name, online: isOnline(u), bot: !!u.bot, roomId: u.roomId || null };
}

/* Сколько живых людей в комнате: по этому числу решаем, жива ли она. */
function humansIn(room) { return room.members.filter(id => !Bots.isBotId(id)); }

function addBots(room, upTo) {
  const want = Math.max(0, Math.min(C.MAX_PLAYERS, upTo) - room.members.length);
  const taken = room.members.map(id => (users.get(id) || {}).name).filter(Boolean);
  for (let i = 0; i < want; i++) {
    const b = Bots.makeBot(taken);
    taken.push(b.name);
    users.set(b.id, { id: b.id, name: b.name, bot: true, trait: b.trait, createdAt: Date.now(), lastSeen: Date.now(), roomId: room.id });
    room.members.push(b.id);
    room.bots.push(b);
  }
  return want;
}

function dropBots(room, count) {
  const ids = room.members.filter(Bots.isBotId);
  const kill = count === undefined ? ids : ids.slice(0, count);
  kill.forEach(id => {
    room.members = room.members.filter(x => x !== id);
    room.bots = room.bots.filter(b => b.id !== id);
    users.delete(id);
  });
  return kill.length;
}

function roomView(room, forUserId) {
  const g = room.game;
  return {
    id: room.id,
    /* Одна ссылка — одна дверь. Общего списка комнат больше нет: войти
       можно только по приглашению, и токен видят лишь те, кто уже внутри. */
    invite: room.invite,
    inviteLink: '/online.html?join=' + room.invite,
    title: room.title,
    hostId: room.hostId,
    hostName: (users.get(room.hostId) || {}).name || '—',
    scenarioId: room.scenarioId,
    size: room.size,
    started: !!g,
    finished: g ? g.finished : false,
    autoStart: room.autoStart,
    /* 'public' — стол объявлен в общем зале, сесть можно без ссылки.
       'invite' — прежнее поведение: одна ссылка, одна дверь. */
    visibility: room.visibility || 'invite',
    members: room.members.map(id => {
      const u = users.get(id);
      return {
        id, name: u ? u.name : '—', online: u ? isOnline(u) : false,
        host: id === room.hostId,
        bot: Bots.isBotId(id),
        voice: !!(u && u.voice)          // микрофон включён — остальные это видят
      };
    }),
    invites: room.invites.map(id => ({ id, name: (users.get(id) || {}).name || '—' })),
    canStart: !g && room.members.length >= C.MIN_PLAYERS,
    bots: room.members.filter(Bots.isBotId).length,
    humans: humansIn(room).length,
    freeSeats: Math.max(0, room.size - room.members.length),
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
      .filter(u => u.id !== userId && !u.bot)
      .sort((a, b) => (isOnline(b) - isOnline(a)) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 200)
      .map(publicUser),
    /* Общий зал: открытые столы, за которые можно сесть без ссылки. Так
       новый игрок находит соперников, ничего ни у кого не спрашивая.
       Закрытый стол в этот список не попадает — он живёт только по ссылке. */
    rooms: [...rooms.values()]
      .filter(r => r.visibility === 'public' && !r.game && humansIn(r).length > 0 &&
        (r.members.length < Math.min(C.MAX_PLAYERS, r.size) || r.members.some(Bots.isBotId)))
      .sort((a, b) => (b.members.length - a.members.length) || (a.createdAt - b.createdAt))
      .slice(0, 40)
      .map(r => ({
        roomId: r.id, invite: r.invite, title: r.title,
        host: (users.get(r.hostId) || {}).name || '—',
        players: r.members.length,
        humans: humansIn(r).length,
        bots: r.members.filter(Bots.isBotId).length,
        size: r.size,
        free: Math.max(0, r.size - r.members.length),
        scenario: (C.scenarioById(r.scenarioId) || {}).title || '—',
        autoStart: r.autoStart,
        waitingSec: Math.round((Date.now() - r.createdAt) / 1000)
      })),
    invites: [...rooms.values()].filter(r => r.invites.indexOf(userId) >= 0).map(r => ({
      roomId: r.id, invite: r.invite, title: r.title,
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
    /* Сначала сообщаем движку, кто пропал со связи: иначе фаза висит до
       полного таймаута из-за одного закрытого ноутбука. */
    const gone = room.members.filter(id => {
      if (Bots.isBotId(id)) return false;
      const u = users.get(id);
      return !u || !isOnline(u);
    });
    const presenceChanged = room.game.setOffline(gone);
    const before = room.game.phase + '|' + room.game.log.length + '|' + room.game.chat.length;
    /* Боты ходят до движка: иначе их ход опаздывал бы на целый такт. */
    const botsMoved = Bots.tick(room, Date.now());
    const changed = room.game.tick() || botsMoved;
    if (presenceChanged || changed ||
        before !== room.game.phase + '|' + room.game.log.length + '|' + room.game.chat.length) pushRoom(room);
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
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
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

/* Кэш. Шрифты и three.js не меняются — им год и immutable; страницам —
   обязательная сверка с сервером. Раньше всё уходило с no-store, и браузер
   заново тянул шестнадцать файлов шрифтов на каждый переход. */
function cacheFor(pathname, ext) {
  if (ext === '.woff2' || ext === '.woff' || /^\/(fonts|vendor)\//.test(pathname))
    return 'public, max-age=31536000, immutable';
  if (ext === '.css' || ext === '.js' || ext === '.svg' || ext === '.png')
    return 'public, max-age=3600, must-revalidate';
  return 'no-cache';
}

function sendAsset(res, code, buf, pathname) {
  const ext = path.extname(pathname);
  res.writeHead(code, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheFor(pathname, ext),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  res.end(buf);
}

/* Канонический адрес берём из запроса (или из SITE_URL за прокси),
   чтобы sitemap и robots были верными на любом домене без правок. */
function siteOrigin(req) {
  if (process.env.SITE_URL) return String(process.env.SITE_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return proto + '://' + host;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  /* Адреса без расширения читаются лучше и лучше индексируются:
     /online и /bots — те же страницы, что и /online.html, /bots.html. */
  if (/^\/(online|bots|rules)$/.test(rel)) rel += '.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      /* Честные 404. Раньше любой мусорный адрес отдавал главную с кодом
         200 — поисковики считают это дублями и режут весь сайт. */
      fs.readFile(path.join(PUBLIC, '404.html'), (e2, page) => {
        if (e2) return send(res, 404, 'Страница не найдена', 'text/plain; charset=utf-8');
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(page);
      });
      return;
    }
    sendAsset(res, 200, buf, file);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  /* ---------- служебные файлы для поисковиков ----------
     Генерируются на лету, чтобы адреса были абсолютными и верными
     на любом домене — ничего не надо править руками при выкладке. */
  if (p === '/robots.txt') {
    const o = siteOrigin(req);
    const txt = 'User-agent: *\n' +
      'Allow: /\n' +
      'Disallow: /api/\n' +
      'Disallow: /online.html?join=\n' +
      '\nSitemap: ' + o + '/sitemap.xml\n';
    res.writeHead(200, { 'Content-Type': MIME['.txt'], 'Cache-Control': 'public, max-age=3600' });
    return res.end(txt);
  }

  if (p === '/sitemap.xml') {
    const o = siteOrigin(req);
    const today = new Date().toISOString().slice(0, 10);
    const pages = [
      { u: '/', pr: '1.0' },
      { u: '/bots.html', pr: '0.9' },
      { u: '/online.html', pr: '0.9' },
      { u: '/rules.html', pr: '0.7' }
    ];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      pages.map(x => '  <url>\n    <loc>' + o + x.u + '</loc>\n' +
        '    <lastmod>' + today + '</lastmod>\n' +
        '    <changefreq>weekly</changefreq>\n' +
        '    <priority>' + x.pr + '</priority>\n  </url>').join('\n') +
      '\n</urlset>\n';
    res.writeHead(200, { 'Content-Type': MIME['.xml'], 'Cache-Control': 'public, max-age=3600' });
    return res.end(xml);
  }

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

    /* ---------- языковой помощник (прокси) ----------
       Ключ живёт только здесь, в переменной окружения MISTRAL_API_KEY.
       Раньше он лежал открытым текстом в public/bots.html и уезжал в
       браузер каждому, кто открыл страницу. Если ключа нет, отвечаем
       503, и клиент тихо играет на своих заготовках — партия не страдает. */
    if (p === '/api/helper' && req.method === 'POST') {
      const key = process.env.MISTRAL_API_KEY || '';
      if (!key) return send(res, 503, { error: 'helper-off' });

      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
      if (!helperAllow(String(ip).split(',')[0].trim()))
        return send(res, 429, { error: 'Слишком много запросов' });

      const msgs = Array.isArray(body.messages) ? body.messages.slice(0, 8) : null;
      if (!msgs) return send(res, 400, { error: 'Нет сообщений' });

      try {
        const upstream = await helperFetch(key, {
          model: body.model === 'spare' ? 'mistral-small-latest' : 'mistral-large-latest',
          temperature: Math.max(0, Math.min(1.5, Number(body.temperature) || 0.8)),
          max_tokens: Math.max(64, Math.min(1200, Number(body.max_tokens) || 700)),
          response_format: { type: 'json_object' },
          messages: msgs.map(m => ({
            role: m.role === 'system' ? 'system' : 'user',
            content: String(m.content || '').slice(0, 6000)
          }))
        });
        res.writeHead(upstream.status || 502, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        return res.end(upstream.body || '{}');
      } catch (e) {
        return send(res, 502, { error: 'helper-unreachable' });
      }
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
        /* Длинный токен вместо четырёх цифр: четырёхзначный код перебирается
           за десять минут, а комната должна оставаться своей. */
        invite: crypto.randomBytes(12).toString('base64url'),
        title: String(body.title || ('Комната ' + me.name)).slice(0, 40),
        hostId: me.id,
        members: [me.id],
        invites: [],
        bots: [],
        size,
        /* По умолчанию стол открыт: иначе новый игрок сидит один и ждёт,
           пока ему кто-нибудь пришлёт ссылку. Закрыть — одним переключателем. */
        visibility: body.visibility === 'invite' ? 'invite' : 'public',
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

    /* ---------- быстрая игра ----------
       Одна кнопка вместо переписки: сажаем игрока за самый полный
       открытый стол — там партия начнётся раньше всего. Если таких нет,
       открываем новый и объявляем его в общем зале. */
    if (p === '/api/rooms/quick' && req.method === 'POST') {
      const best = [...rooms.values()]
        .filter(r => r.visibility === 'public' && !r.game && humansIn(r).length > 0 &&
          r.members.indexOf(me.id) < 0 &&
          (r.members.length < Math.min(C.MAX_PLAYERS, r.size) || r.members.some(Bots.isBotId)))
        .sort((a, b) => (b.members.length - a.members.length) || (a.createdAt - b.createdAt))[0];

      if (best) {
        /* Место живого человека важнее места бота: если свободных
           стульев нет, один сосед-бот встаёт. */
        if (best.members.length >= Math.min(C.MAX_PLAYERS, best.size)) dropBots(best, 1);
        leaveRoom(me);
        best.members.push(me.id);
        best.invites = best.invites.filter(i => i !== me.id);
        best.chat.push({ system: true, text: me.name + ' подсел за стол из общего зала.', ts: Date.now() });
        me.roomId = best.id;
        pushAll(best);
        return send(res, 200, { room: roomView(best, me.id), joined: true });
      }

      leaveRoom(me);
      const size = Math.max(C.MIN_PLAYERS, Math.min(C.MAX_PLAYERS, Number(body.size) || 8));
      const room2 = {
        id: uid('r'),
        invite: crypto.randomBytes(12).toString('base64url'),
        title: 'Стол ' + me.name,
        hostId: me.id,
        members: [me.id],
        invites: [],
        bots: [],
        size,
        visibility: 'public',
        autoStart: true,
        scenarioId: (C.scenariosFor(size)[0] || C.SCENARIOS[0]).id,
        chat: [],
        game: null,
        createdAt: Date.now()
      };
      rooms.set(room2.id, room2);
      me.roomId = room2.id;
      pushAll(room2);
      return send(res, 200, { room: roomView(room2, me.id), joined: false });
    }

    if (p === '/api/rooms/state') {
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      return send(res, 200, { room: roomView(room, me.id) });
    }

    if (p === '/api/rooms/join' && req.method === 'POST') {
      const inviteToken = body.invite ? String(body.invite).trim() : '';
      let target = inviteToken ? [...rooms.values()].find(r => r.invite === inviteToken) : room;
      if (!target) return send(res, 404, { error: 'Комната не найдена — попросите ссылку заново' });
      /* Дверь одна: либо ссылка-приглашение, либо личное приглашение хозяина,
         либо вы уже за этим столом. */
      const allowed = !!inviteToken || target.visibility === 'public' ||
        target.members.indexOf(me.id) >= 0 || target.invites.indexOf(me.id) >= 0;
      if (!allowed) return send(res, 403, { error: 'Этот стол закрыт — попросите у хозяина ссылку-приглашение' });
      if (target.game) return send(res, 409, { error: 'Партия уже идёт' });
      if (target.members.indexOf(me.id) < 0) {
        /* Место, занятое ботом, освобождается для человека: за этим и нужна
           ссылка — друг приходит и садится вместо соседа-бота. */
        if (target.members.length >= Math.min(C.MAX_PLAYERS, target.size)) dropBots(target, 1);
        if (target.members.length >= C.MAX_PLAYERS) return send(res, 409, { error: 'Комната полная (20 человек)' });
        leaveRoom(me);
        target.members.push(me.id);
        target.invites = target.invites.filter(i => i !== me.id);
        target.chat.push({ system: true, text: me.name + ' зашёл в комнату.', ts: Date.now() });
        me.roomId = target.id;
      }
      pushAll(target);
      return send(res, 200, { room: roomView(target, me.id) });
    }

    /* ---------- соседи-боты ----------
       Хозяин добирает пустые места ботами. Они играют по тем же правилам:
       мафия-бот не бьёт своих, доктор-бот не лечит одного и того же две
       ночи подряд, шериф-бот проверяет и раскрывается, когда припечёт. */
    if (p === '/api/rooms/bots' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      if (room.game) return send(res, 409, { error: 'Партия уже идёт' });
      if (body.on === false) {
        const gone = dropBots(room);
        room.chat.push({ system: true, text: 'Соседей-ботов проводили до двери (' + gone + ').', ts: Date.now() });
      } else {
        const want = Math.max(C.MIN_PLAYERS, Math.min(C.MAX_PLAYERS, Number(body.upTo) || room.size));
        const added = addBots(room, want);
        if (!added) return send(res, 400, { error: 'Свободных мест нет' });
        room.chat.push({ system: true, text: 'За стол сели соседи: ' + added + '. Пришедший по ссылке займёт место одного из них.', ts: Date.now() });
      }
      pushAll(room);
      return send(res, 200, { room: roomView(room, me.id) });
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
      room.bots = room.bots.filter(b => b.id !== body.userId);
      if (Bots.isBotId(body.userId)) users.delete(body.userId);
      else if (target) target.roomId = null;
      pushAll(room);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/rooms/config' && req.method === 'POST') {
      if (!room || room.hostId !== me.id) return send(res, 403, { error: 'Только хозяин комнаты' });
      if (room.game) return send(res, 409, { error: 'Партия уже идёт' });
      if (body.scenarioId !== undefined) room.scenarioId = body.scenarioId;
      if (body.size !== undefined) room.size = Math.max(C.MIN_PLAYERS, Math.min(C.MAX_PLAYERS, Number(body.size) || 8));
      if (body.autoStart !== undefined) room.autoStart = !!body.autoStart;
      if (body.visibility !== undefined) room.visibility = body.visibility === 'invite' ? 'invite' : 'public';
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
      room.botPlan = null;
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

    /* ---------- голосовой чат ----------
       Сервер не трогает звук: он только передаёт участникам служебные
       записки WebRTC (offer/answer/candidate). Сам голос идёт напрямую
       между браузерами, поэтому задержка не зависит от сервера. */
    if (p === '/api/rooms/signal' && req.method === 'POST') {
      if (!room) return send(res, 404, { error: 'Комната не найдена' });
      if (room.members.indexOf(me.id) < 0) return send(res, 403, { error: 'Вы не в этой комнате' });
      const to = String(body.to || '');
      if (room.members.indexOf(to) < 0) return send(res, 404, { error: 'Такого игрока нет в комнате' });
      const packet = { from: me.id, name: me.name, kind: String(body.kind || ''), data: body.data };
      let delivered = 0;
      clients.forEach(c => { if (c.userId === to) { sseSend(c, 'signal', packet); delivered++; } });
      return send(res, 200, { ok: true, delivered });
    }

    if (p === '/api/rooms/voice' && req.method === 'POST') {
      me.voice = !!body.on;
      if (room) pushRoom(room);
      return send(res, 200, { ok: true, voice: me.voice });
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

/* Простой ограничитель: чужой ключ не должен стать бесплатным API для всего
   интернета — больше шестидесяти обращений в минуту с одного адреса не пройдёт. */
const helperHits = new Map();
function helperAllow(ip) {
  const now = Date.now();
  const rec = helperHits.get(ip) || { n: 0, until: now + 60000 };
  if (now > rec.until) { rec.n = 0; rec.until = now + 60000; }
  rec.n++;
  helperHits.set(ip, rec);
  if (helperHits.size > 5000) helperHits.clear();
  return rec.n <= 60;
}

function helperFetch(key, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const rq = https.request({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Authorization: 'Bearer ' + key
      }
    }, r => {
      let s = '';
      r.setEncoding('utf8');
      r.on('data', c => { s += c; if (s.length > 2e6) r.destroy(); });
      r.on('end', () => resolve({ status: r.statusCode, body: s }));
    });
    /* Семь секунд — и довольно: долгая тишина за столом хуже короткой реплики. */
    rq.setTimeout(7000, () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    rq.end(data);
  });
}

function leaveRoom(user) {
  if (!user.roomId) return;
  const room = rooms.get(user.roomId);
  user.roomId = null;
  if (!room) return;
  room.members = room.members.filter(i => i !== user.id);
  room.chat.push({ system: true, text: user.name + ' вышел из комнаты.', ts: Date.now() });
  /* Комната без людей закрывается вместе с ботами: сами они играть не будут. */
  if (!humansIn(room).length) {
    dropBots(room);
    rooms.delete(room.id);
    return;
  }
  if (room.hostId === user.id) room.hostId = humansIn(room)[0];
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
