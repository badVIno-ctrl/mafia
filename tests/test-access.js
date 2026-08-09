/* =========================================================================
   Тест 12 — доступ к столу и возвращение в партию.

   Все проверки здесь написаны по следам настоящих поломок, каждая из которых
   выглядела для игрока как «игра сломалась», а на самом деле была дырой в
   правилах доступа или в учёте состава:

   1. Человек, вышедший посреди партии, продолжал держать фазу: список тех,
      кого не ждём, собирался по составу комнаты, а вышедший из комнаты уже
      исчез. Каждая ночь и каждое голосование доигрывались до полного
      таймаута, и это читалось как «лаги».
   2. Вернуться было нельзя: проверка «партия уже идёт» стояла выше проверки
      состава, и свой же игрок после перезагрузки страницы получал 409 и
      терял партию, за которой сидел час.
   3. Состояние комнаты отдавалось любому, кто знал roomId, — а roomId лежал
      в открытом списке столов вместе с токеном-приглашением. То есть чужую
      партию можно было читать целиком: раскрытые роли выбывших и их чат.
   4. Выбывшие читали ночной шёпот мафии. За одним столом в одной комнате это
      означает, что расклад знает вся комната.
   5. Ключ внешнего помощника выдавался без авторизации (проверяется в тесте 11).
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.ACCESS_PORT ? Number(process.env.ACCESS_PORT) : 8219;
const BASE = 'http://127.0.0.1:' + PORT;

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.body ? 'POST' : 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { 'x-token': opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

async function mk(name) {
  const r = await req('/api/register', { body: { name } });
  if (!r.json || !r.json.user) throw new Error('регистрация не удалась: ' + JSON.stringify(r.json));
  return r.json.user;
}

(async () => {
  console.log('\n=== ТЕСТ 12: доступ к столу и возвращение в партию ===');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [сервер] ' + d));
  await sleep(700);

  try {
    const stamp = Date.now().toString(36).slice(-3);
    const host = await mk('Хозяин' + stamp);
    const guest = await mk('Гость' + stamp);
    const stranger = await mk('Чужой' + stamp);

    /* ---- стол на двоих и шести ботах ---- */
    const created = await req('/api/rooms/create', {
      token: host.token, body: { size: 8, autoStart: false, visibility: 'public' }
    });
    const room = created.json.room;
    ok(!!room, 'стол создан');

    await req('/api/rooms/join', { token: guest.token, body: { roomId: room.id } });
    await req('/api/rooms/bots', { token: host.token, body: { upTo: 8 } });
    const started = await req('/api/rooms/start', { token: host.token, body: {} });
    ok(started.status === 200 && started.json.room.started, 'партия началась');

    /* ---- 1. общий зал не раздаёт токены-приглашения ---- */
    const zal = await req('/api/lobby', { token: stranger.token });
    const rows = (zal.json.rooms || []);
    ok(rows.every(r => !r.invite), 'в общем зале нет токенов-приглашений');

    /* ---- 2. чужой не читает состояние стола ---- */
    const peek = await req('/api/rooms/state?roomId=' + room.id, { token: stranger.token });
    ok(peek.status === 403, 'чужому по roomId отвечают «это чужой стол» (' + peek.status + ')');
    ok(!peek.json || !peek.json.room, 'в ответе чужому нет ни состава, ни чата');

    /* ---- 3. чужой не сядет в идущую партию ---- */
    const late = await req('/api/rooms/join', { token: stranger.token, body: { roomId: room.id } });
    ok(late.status === 409, 'в идущую партию посторонний не садится (' + late.status + ')');

    /* ---- 4. свой выходит: место остаётся, фаза его не ждёт ---- */
    const before = await req('/api/rooms/state?roomId=' + room.id, { token: guest.token });
    const mySeat = before.json.room.game.you;
    ok(!!mySeat && !!mySeat.role, 'у гостя есть роль: ' + (mySeat && mySeat.roleRu));

    const leave = await req('/api/rooms/leave', { token: guest.token, body: {} });
    ok(leave.status === 200, 'гость вышел из-за стола');

    await sleep(1600);
    const hostView = await req('/api/rooms/state?roomId=' + room.id, { token: host.token });
    const gone = (hostView.json.room.game.players || []).find(p => p.id === guest.id);
    ok(!!gone, 'место вышедшего осталось за столом');
    ok(gone && gone.left === true, 'вышедший помечен как вставший из-за стола');
    ok(gone && gone.offline === true, 'его хода больше не ждут');

    /* ---- 5. свой возвращается на своё место с той же ролью ---- */
    const back = await req('/api/rooms/join', { token: guest.token, body: { invite: room.invite } });
    ok(back.status === 200, 'вернуться по своей ссылке можно (' + back.status + ')');
    ok(back.status === 200 && back.json.returned === true, 'сервер понял, что это возвращение, а не новый игрок');
    const seatBack = back.json.room && back.json.room.game && back.json.room.game.you;
    ok(!!seatBack && seatBack.role === mySeat.role,
      'роль сохранилась: было ' + mySeat.role + ', стало ' + (seatBack && seatBack.role));

    const backView = await req('/api/rooms/state?roomId=' + room.id, { token: guest.token });
    const backP = (backView.json.room.game.players || []).find(p => p.id === guest.id);
    ok(backP && backP.left === false, 'пометка об уходе снята');

    /* ---- 6. возврат по roomId тоже работает ---- */
    await req('/api/rooms/leave', { token: guest.token, body: {} });
    const back2 = await req('/api/rooms/join', { token: guest.token, body: { roomId: room.id } });
    ok(back2.status === 200 && back2.json.returned === true, 'вернуться по roomId тоже можно');

    /* ---- 7. выбывшие не читают шёпот мафии ---- */
    /* Собираем отдельную партию, где мафия успевает пошептаться, а один из
       игроков выбывает. Проще всего — прямо на движке: сеть здесь ничего
       нового не проверяет, а поведение зависит только от viewFor. */
    const { Game } = require('../server/game.js');
    const members = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, name: 'Игрок' + i }));

    const closed = new Game(members, 'deck');
    const mafia = closed.players.find(p => closed.isMafia(p.id));
    const town = closed.players.find(p => !closed.isMafia(p.id) && p.id !== mafia.id);
    closed.startNight();
    closed.say(mafia.id, 'берём третьего', 'mafia');
    closed.kill(town.id, 'night');
    const deadView = closed.viewFor(town.id);
    ok(!deadView.chat.some(m => m.channel === 'mafia'),
      'по умолчанию выбывший не видит шёпот мафии');
    ok(deadView.channels.indexOf('mafia') < 0, 'и канала мафии у него в списке нет');
    ok(deadView.channels.indexOf('ghost') >= 0, 'свой канал выбывших у него есть');

    const openGame = new Game(members, 'deck', { deadSeeAll: true });
    const m2 = openGame.players.find(p => openGame.isMafia(p.id));
    const t2 = openGame.players.find(p => !openGame.isMafia(p.id));
    openGame.startNight();
    openGame.say(m2.id, 'берём третьего', 'mafia');
    openGame.kill(t2.id, 'night');
    const openView = openGame.viewFor(t2.id);
    ok(openView.chat.some(m => m.channel === 'mafia'),
      'с разрешения хозяина выбывший шёпот видит');

    /* ---- 8. наблюдателю не отдают чат выбывших ---- */
    closed.say(town.id, 'я был мирным', 'ghost');
    const spectator = closed.viewFor('никого-такого-нет');
    ok(!spectator.chat.some(m => m.channel === 'ghost'),
      'наблюдатель не читает чат выбывших');
    ok(spectator.channels.indexOf('ghost') < 0, 'и канала выбывших ему не дают');
    ok(spectator.chat.every(m => m.channel === 'town'), 'наблюдателю остаётся только общий чат');

    /* ---- 9. живой мафии шёпот виден ---- */
    const mafiaView = closed.viewFor(mafia.id);
    ok(mafiaView.chat.some(m => m.channel === 'mafia'), 'мафия свой шёпот читает');
  } catch (e) {
    fails++;
    console.log('  ИСКЛЮЧЕНИЕ: ' + e.stack);
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 12 ПРОЙДЕН' : '\n✗ ТЕСТ 12: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
