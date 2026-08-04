/* Тест №3 — сетевой слой: регистрация, комната, приглашения, партия на 8 и 20 игроков */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8199;
const BASE = 'http://127.0.0.1:' + PORT;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.body ? 'POST' : 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { 'x-token': opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = { raw: true }; }
  return { status: res.status, json };
}

(async () => {
  console.log('\n=== ТЕСТ 3: сетевой слой ===');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  try {
    /* --- регистрация --- */
    const stamp = Date.now().toString(36);
    const mk = async (name) => {
      const r = await api('/api/register', { body: { name } });
      if (!r.json.user) throw new Error('регистрация не удалась: ' + JSON.stringify(r.json));
      return r.json.user;
    };
    const host = await mk('Хост' + stamp.slice(-3));
    ok(!!host.token, 'регистрация по одному имени выдаёт токен');

    const dup = await api('/api/register', { body: { name: host.name } });
    ok(dup.status === 409, 'повторное имя отклоняется');
    const short = await api('/api/register', { body: { name: 'Я' } });
    ok(short.status === 400, 'слишком короткое имя отклоняется');
    const noAuth = await api('/api/lobby');
    ok(noAuth.status === 401, 'без токена лобби закрыто');

    /* --- комната и друзья --- */
    const guests = [];
    for (let i = 1; i <= 7; i++) guests.push(await mk('Гость' + stamp.slice(-3) + i));

    const created = await api('/api/rooms/create', { token: host.token, body: { size: 8, autoStart: false } });
    const roomId = created.json.room.id;
    ok(!!roomId, 'комната создана');
    ok(created.json.room.members.length === 1, 'хозяин сразу в комнате');

    const lob = await api('/api/lobby', { token: guests[0].token });
    ok(lob.json.users.length >= 7, 'список зарегистрированных игроков виден');

    await api('/api/rooms/invite', { token: host.token, body: { roomId, userId: guests[0].id } });
    const lob2 = await api('/api/lobby', { token: guests[0].token });
    ok(lob2.json.invites.length === 1, 'приглашённый видит приглашение');

    const strangerInvite = await api('/api/rooms/invite', { token: guests[1].token, body: { roomId, userId: guests[2].id } });
    ok(strangerInvite.status === 403, 'приглашать может только хозяин');

    for (const g of guests) await api('/api/rooms/join', { token: g.token, body: { roomId } });
    const st = await api('/api/rooms/state', { token: host.token, body: null });
    ok(st.json.room.members.length === 8, 'в комнате 8 игроков');
    ok(st.json.room.canStart === true, 'кнопка старта активна');
    ok(st.json.room.scenarios.length >= 1, 'сюжеты подобраны под состав');

    const notHostStart = await api('/api/rooms/start', { token: guests[0].token, body: { roomId } });
    ok(notHostStart.status === 403, 'чужой не может начать партию');

    /* --- партия --- */
    const started = await api('/api/rooms/start', { token: host.token, body: { roomId } });
    ok(started.json.room.started === true, 'партия началась');
    const gv = started.json.room.game;
    ok(gv.you && gv.you.role, 'игрок знает свою роль');
    const shown = gv.players.filter(p => p.role).length;
    ok(shown === 1 + gv.you.partners.length, 'видны только своя роль и роли сообщников (показано ' + shown + ')');

    // все игроки комнаты
    const all = [host, ...guests];
    const views = {};
    for (const u of all) {
      const r = await api('/api/rooms/state', { token: u.token });
      views[u.id] = r.json.room.game;
    }
    const mafias = all.filter(u => ['mafia', 'don'].includes(views[u.id].you.role));
    const docs = all.filter(u => views[u.id].you.role === 'doctor');
    const shs = all.filter(u => views[u.id].you.role === 'sheriff');
    ok(mafias.length === 2, 'на 8 игроков ровно 2 мафии, выдано ' + mafias.length);
    ok(docs.length === 1 && shs.length === 1, 'один доктор и один шериф');
    ok(views[mafias[0].id].you.partners.length === 1, 'мафия видит сообщника');

    // пролог → ночь (ждём таймер пролога 12 с — сокращаем через ожидание не более 14 с)
    let phase = 'prologue', waited = 0;
    while (phase === 'prologue' && waited < 16000) {
      await sleep(1000); waited += 1000;
      const r = await api('/api/rooms/state', { token: host.token });
      phase = r.json.room.game.phase;
    }
    ok(phase === 'night', 'через пролог игра перешла в ночь (' + phase + ')');

    // ночные действия
    const victim = all.find(u => !['mafia', 'don'].includes(views[u.id].you.role));
    const badKill = await api('/api/rooms/action', { token: victim.token, body: { type: 'kill', target: mafias[0].id } });
    ok(badKill.status === 400, 'мирному нельзя убивать');
    for (const m of mafias) await api('/api/rooms/action', { token: m.token, body: { type: 'kill', target: victim.id } });
    await api('/api/rooms/action', { token: shs[0].token, body: { type: 'check', target: mafias[0].id } });
    const healed = await api('/api/rooms/action', { token: docs[0].token, body: { type: 'heal', target: docs[0].id } });
    ok(healed.status === 200, 'доктор лечит');
    await sleep(1500);

    const afterNight = (await api('/api/rooms/state', { token: host.token })).json.room.game;
    ok(['morning', 'day'].includes(afterNight.phase), 'ночь разрешилась сразу после всех ходов (' + afterNight.phase + ')');
    ok(afterNight.players.find(p => p.id === victim.id).alive === false, 'жертва ночи мертва');
    const shView = (await api('/api/rooms/state', { token: shs[0].token })).json.room.game;
    ok(shView.you.checks.length === 1 && shView.you.checks[0].isMafia === true, 'шериф получил верный результат проверки');
    const civView = (await api('/api/rooms/state', { token: docs[0].token })).json.room.game;
    ok(!civView.you.checks.length, 'доктор не видит проверок шерифа');

    // чат: мёртвый пишет в «загробный» канал и живые его не видят
    await api('/api/rooms/chat', { token: victim.token, body: { text: 'я всё вижу оттуда', channel: 'town' } });
    const liveWitness = all.find(u => u.id !== victim.id && !['mafia','don'].includes(views[u.id].you.role));
    const liveView = (await api('/api/rooms/state', { token: liveWitness.token })).json.room.game;
    ok(!liveView.chat.some(m => m.text === 'я всё вижу оттуда'), 'живые не видят чат мёртвых');
    const deadView = (await api('/api/rooms/state', { token: victim.token })).json.room.game;
    ok(deadView.chat.some(m => m.text === 'я всё вижу оттуда'), 'мёртвый видит свой канал');

    /* --- большая комната на 20 --- */
    const big = [];
    for (let i = 0; i < 20; i++) big.push(await mk('Смена' + stamp.slice(-3) + i));
    const bigRoom = (await api('/api/rooms/create', { token: big[0].token, body: { size: 20, autoStart: true, scenarioId: 'shift' } })).json.room;
    for (let i = 1; i < 20; i++) await api('/api/rooms/join', { token: big[i].token, body: { roomId: bigRoom.id } });
    await sleep(1500);
    const bigState = (await api('/api/rooms/state', { token: big[0].token })).json.room;
    ok(bigState.started === true, 'автостарт при 20 игроках сработал');
    ok(bigState.game.players.length === 20, 'за столом 20 человек');
    ok(bigState.game.scenario.id === 'shift', 'выбран сюжет «Ночная смена»');
    ok(bigState.game.compositionLabel.includes('11 мирных'), 'состав на 20: ' + bigState.game.compositionLabel);

    const c21 = await api('/api/rooms/join', { token: guests[0].token, body: { roomId: bigRoom.id } });
    ok(c21.status === 409, '21-го игрока в идущую партию не пускает');

    /* --- SSE --- */
    const ctrl = new AbortController();
    const sse = await fetch(BASE + '/api/events?token=' + host.token, { signal: ctrl.signal });
    ok(sse.headers.get('content-type').includes('text/event-stream'), 'SSE-поток отдаётся');
    const reader = sse.body.getReader();
    const chunk = await reader.read();
    ok(new TextDecoder().decode(chunk.value).length > 0, 'SSE присылает первый кадр');
    ctrl.abort();

    /* --- статика --- */
    for (const f of ['/', '/online.html', '/bots.html', '/css/app.css', '/js/online.js']) {
      const r = await fetch(BASE + f);
      ok(r.status === 200, 'отдаётся ' + f);
    }
  } catch (e) {
    fails++;
    console.log('  ИСКЛЮЧЕНИЕ: ' + e.stack);
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 3 ПРОЙДЕН' : `\n✗ ТЕСТ 3: ошибок ${fails}`);
  process.exit(fails ? 1 : 0);
})();
