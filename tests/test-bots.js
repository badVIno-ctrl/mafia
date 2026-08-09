/* =========================================================================
   Тест №10 — комната с ботами и вход только по приглашению.

   Проверяем две вещи, из которых состоит просьба игрока:

   1. Соседи-боты доигрывают партию до конца по тем же правилам, что люди:
      мафия-бот никогда не бьёт своего, доктор-бот не лечит одного и того же
      две ночи подряд, шериф-бот проверяет и голосует по проверке, и партия
      всегда доходит до занавеса, а не встаёт на середине.

   2. Закрытый стол остаётся закрытым: его нет в общем зале, четырёхзначного
      кода нет, войти можно только по длинной ссылке-приглашению. А открытый —
      наоборот, виден всем и пускает без приглашения, и переключается одной
      галочкой. Друг, пришедший по ссылке, садится на место соседа-бота.

   Первая часть гоняет движок напрямую с ускоренным временем — так полная
   партия занимает миллисекунды. Вторая идёт через живой сервер.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { Game } = require('../server/game.js');
const Bots = require('../server/bots.js');
const C = require('../shared/game-config.js');

const PORT = 8207;
const BASE = 'http://127.0.0.1:' + PORT;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
   ЧАСТЬ 1 · полная партия одних ботов на ускоренном времени
   --------------------------------------------------------------------------- */
function fullBotGame(n) {
  const members = [];
  for (let i = 0; i < n; i++) members.push({ id: Bots.PREFIX + 'p' + i, name: 'Бот' + (i + 1) });
  const room = { members: members.map(m => m.id), bots: members.map(m => ({ id: m.id, name: m.name, trait: null })), game: null };
  room.game = new Game(members, null);
  const g = room.game;

  let now = Date.now();
  let guard = 0, held = 0, key = '', votes = 0;
  const killLog = [];
  while (!g.finished && guard++ < 6000) {
    now += 900;                       // условное время: боты живут по нему
    const k = g.phase + ':' + g.day;
    if (k === key) held++; else { held = 0; key = k; }

    const mafiaBefore = g.alive().filter(p => g.isMafia(p.id)).map(p => p.id);
    Bots.tick(room, now);
    Object.entries(g.nightActions.kill).forEach(([from, to]) => {
      killLog.push({ from, to, mafia: mafiaBefore.indexOf(to) >= 0 });
    });
    votes = Math.max(votes, Object.keys(g.votes || {}).length);
    /* Фазе даём прожить её срок в условном времени (около 35 «секунд»),
       и только потом торопим таймер: иначе ход ботов не успевает случиться. */
    if (held > 38) g.deadline = Math.min(g.deadline, Date.now() - 1);
    g.tick();
  }
  return { g, killLog, guard, votes };
}

/* ---------------------------------------------------------------------------
   ЧАСТЬ 2 · живой сервер
   --------------------------------------------------------------------------- */
async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.body ? 'POST' : 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { 'x-token': opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = {}; }
  return { status: res.status, json };
}

/** Один ход за живого игрока: делаем то, что от него ждут прямо сейчас. */
async function humanMove(user, view) {
  const you = view.you;
  if (!you || !you.alive || !you.canAct) return;
  const others = view.players.filter(p => p.alive && p.id !== you.id);
  const mates = (you.partners || []).map(p => p.id);
  if (you.canAct === 'kill' && !you.myKill) {
    const t = others.find(p => mates.indexOf(p.id) < 0);
    if (t) await api('/api/rooms/action', { token: user.token, body: { type: 'kill', target: t.id } });
  } else if (you.canAct === 'heal' && !you.myHeal) {
    const t = view.players.find(p => p.alive && p.id !== you.healBlocked);
    if (t) await api('/api/rooms/action', { token: user.token, body: { type: 'heal', target: t.id } });
  } else if (you.canAct === 'check' && !you.myCheck) {
    if (others[0]) await api('/api/rooms/action', { token: user.token, body: { type: 'check', target: others[0].id } });
  } else if (you.canAct === 'vote' && you.myVote === null) {
    await api('/api/rooms/action', { token: user.token, body: { type: 'vote', target: 'skip' } });
  } else if (you.canAct === 'talk' && !you.ready) {
    await api('/api/rooms/action', { token: user.token, body: { type: 'ready', target: null } });
  } else if (you.canAct === 'speak') {
    /* Слово по кругу: живой игрок говорит и передаёт слово дальше. Без этого
       круг держался бы на таймауте по сорок пять секунд за каждого человека. */
    await api('/api/rooms/chat', { token: user.token, body: { text: 'коротко: пока никого не подозреваю', channel: 'town' } });
    await api('/api/rooms/action', { token: user.token, body: { type: 'pass', target: null } });
  }
}

(async () => {
  console.log('\n=== ТЕСТ 10: соседи-боты и вход по приглашению ===');

  /* ---- часть 1 ---- */
  for (const n of [6, 8, 12]) {
    const { g, killLog, guard, votes } = fullBotGame(n);
    ok(g.finished, 'партия одних ботов на ' + n + ' игроков дошла до конца (шагов ' + guard + ')');
    ok(g.winner === 'town' || g.winner === 'mafia', 'у партии на ' + n + ' есть победитель: ' + g.winner);
    ok(killLog.length > 0, 'мафия-боты ходили ночью (' + killLog.length + ' выборов жертвы)');
    const friendlyFire = killLog.filter(k => k.mafia);
    ok(friendlyFire.length === 0, 'мафия-бот ни разу не выбрал своего' +
      (friendlyFire.length ? ' (промахов ' + friendlyFire.length + ')' : ''));
    ok(votes > 0, 'боты подавали голоса на голосовании (максимум за раз: ' + votes + ')');
    ok(g.chat.filter(m => m.channel === 'town').length > 0, 'боты разговаривали за столом (' +
      g.chat.filter(m => m.channel === 'town').length + ' реплик)');
  }

  /* доктор-бот не лечит одного и того же две ночи подряд — это правило движка,
     и бот обязан его соблюдать сам, без отказов от сервера */
  {
    const { g } = fullBotGame(10);
    ok(!g.log.some(l => /две ночи подряд/.test(l.text)), 'доктор-бот не пытается лечить одного и того же две ночи подряд');
  }

  /* ---- часть 2 ---- */
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-bots.json' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  try {
    const stamp = Date.now().toString(36).slice(-4);
    const mk = async (name) => (await api('/api/register', { body: { name: name + stamp } })).json.user;
    const host = await mk('Хозяин');
    const friend = await mk('Друг');
    const stranger = await mk('Чужой');

    const created = await api('/api/rooms/create', { token: host.token, body: { size: 6, autoStart: false, visibility: 'invite' } });
    const room = created.json.room;
    ok(!!room.invite && room.invite.length >= 12, 'у комнаты длинный токен-приглашение (' + (room.invite || '').length + ' символов)');
    ok(!/^\d{4}$/.test(String(room.invite)), 'четырёхзначного кода больше нет');
    ok(room.inviteLink.indexOf('?join=') > 0, 'ссылка-приглашение ведёт на ?join=');
    ok(room.visibility === 'invite', 'закрытый стол так и помечен: visibility=' + room.visibility);

    /* Закрытый стол — только по ссылке, как и было. */
    const lobby = await api('/api/lobby', { token: stranger.token });
    ok(Array.isArray(lobby.json.rooms) && !lobby.json.rooms.some(r => r.roomId === room.id),
      'закрытого стола нет в общем зале');

    const sneak = await api('/api/rooms/join', { token: stranger.token, body: { roomId: room.id } });
    ok(sneak.status === 403, 'без приглашения в закрытый стол не пускают');

    /* А открытый стол виден всем — иначе новичку не с кем играть.
       Открываем, смотрим, что видно в строке, и закрываем обратно. */
    await api('/api/rooms/config', { token: host.token, body: { visibility: 'public' } });
    const openLobby = await api('/api/lobby', { token: stranger.token });
    const shown = (openLobby.json.rooms || []).find(r => r.roomId === room.id);
    ok(!!shown, 'открытый стол виден в общем зале');
    ok(!!shown && shown.humans === 1 && shown.size === 6,
      'в строке сразу видно, сколько людей и сколько мест');
    ok(!!shown && typeof shown.waitingSec === 'number' && !!shown.host && !!shown.title,
      'видно хозяина, название и сколько стол уже ждёт');

    await api('/api/rooms/config', { token: host.token, body: { visibility: 'invite' } });
    const hidden = await api('/api/lobby', { token: stranger.token });
    ok(!(hidden.json.rooms || []).some(r => r.roomId === room.id),
      'стол снова прячется одной галочкой');

    const filled = await api('/api/rooms/bots', { token: host.token, body: { on: true } });
    ok(filled.json.room.members.length === 6, 'пустые места заняли соседи-боты (за столом ' + filled.json.room.members.length + ')');
    ok(filled.json.room.bots === 5, 'ботов ровно столько, сколько не хватало людей: ' + filled.json.room.bots);
    ok(filled.json.room.canStart === true, 'партию уже можно начинать');
    ok(filled.json.room.members.filter(m => m.bot).every(m => m.online), 'соседи-боты всегда на связи');

    const joined = await api('/api/rooms/join', { token: friend.token, body: { invite: room.invite } });
    ok(joined.status === 200, 'друг вошёл по ссылке-приглашению');
    const seats = joined.json.room.members;
    ok(seats.length === 6, 'стол не раздулся: по-прежнему 6 мест');
    ok(seats.filter(m => m.bot).length === 4, 'один сосед-бот уступил место человеку (ботов осталось ' +
      seats.filter(m => m.bot).length + ')');
    ok(seats.some(m => m.name === friend.name), 'друг сидит за столом');

    const dropped = await api('/api/rooms/bots', { token: host.token, body: { on: false } });
    ok(dropped.json.room.bots === 0, 'ботов можно выпроводить');
    await api('/api/rooms/bots', { token: host.token, body: { on: true } });

    const started = await api('/api/rooms/start', { token: host.token, body: {} });
    ok(started.json.room.started === true, 'партия с ботами началась');

    /* Ждём, пока стол проживёт ночь, утро и день. Люди отвечают сразу,
       боты — со своими задержками. */
    const humans = [host, friend];
    let view = started.json.room.game;
    let seenVote = false, botLines = 0, botReady = 0, botSpoke = 0;
    let deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const st = await api('/api/rooms/state', { token: host.token });
      view = st.json.room.game;
      for (const u of humans) {
        const v = (await api('/api/rooms/state', { token: u.token })).json.room.game;
        await humanMove(u, v);
      }
      botLines = view.chat.filter(m => m.channel === 'town' && String(m.from).indexOf(Bots.PREFIX) === 0).length;
      botReady = view.players.filter(p => p.ready && String(p.id).indexOf(Bots.PREFIX) === 0).length;
      if (view.phase === 'speech' && String(view.speakerId || '').indexOf(Bots.PREFIX) === 0) botSpoke++;
      if (view.phase === 'vote' || view.phase === 'runoff') seenVote = true;
      if (view.finished || (seenVote && view.day >= 1 && view.log.some(l => l.kind === 'execution' || /никого не выбрал|Снова ничья/.test(l.text)))) break;
    }
    ok(view.day >= 1 && view.log.some(l => l.kind === 'morning'), 'ночь с ботами разрешилась, утро наступило');
    ok(botLines > 0, 'соседи-боты говорили в общем чате (' + botLines + ' реплик)');
    ok(botReady > 0 || view.phase !== 'day', 'соседи-боты нажимают «я высказался», и день не висит');
    ok(botSpoke > 0, 'соседи-боты берут слово в свою очередь и передают его дальше (' + botSpoke + ')');
    ok(seenVote, 'дошло до голосования');
    ok(view.players.filter(p => p.offline).every(p => String(p.id).indexOf(Bots.PREFIX) !== 0),
      'бота никогда не считают потерявшим связь');

    /* комната закрывается вместе с людьми, боты не остаются висеть */
    await api('/api/rooms/leave', { token: friend.token, body: {} });
    await api('/api/rooms/leave', { token: host.token, body: {} });
    const after = await api('/api/lobby', { token: host.token });
    ok(!(after.json.users || []).some(u => u.bot), 'боты не попадают в список игроков сайта');
  } catch (e) {
    fails++;
    console.log('  ИСКЛЮЧЕНИЕ: ' + e.stack);
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 10 ПРОЙДЕН' : '\n✗ ТЕСТ 10: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
