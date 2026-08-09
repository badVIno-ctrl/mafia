/* =========================================================================
   Тест №8 — сигналинг голосового чата.

   Сервер не пропускает через себя звук: он только передаёт участникам
   комнаты записки WebRTC. Проверяем, что записка доходит ровно тому, кому
   адресована, и что посторонний в чужую комнату сигналить не может.

   Отдельная и более важная часть — фазы. Голосовой чат раньше не знал ни о
   ночи, ни о смерти: стол соединялся «каждый с каждым» один раз и так и
   оставался. Ночью это значило, что мафия договаривается вслух при всём
   городе. Правило исполняет сервер: записку о знакомстве между городом и
   мафией он ночью просто не передаёт, и обойти это правкой клиента нельзя.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8203;
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

/** Подписка на SSE: собираем события нужного типа. */
function listen(token) {
  const box = { events: [], stop: null };
  const ctrl = new AbortController();
  box.stop = () => ctrl.abort();
  fetch(BASE + '/api/events?token=' + encodeURIComponent(token), { signal: ctrl.signal })
    .then(async res => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        parts.forEach(chunk => {
          const ev = /event: (\w+)/.exec(chunk);
          const data = /data: (.*)/.exec(chunk);
          if (!ev || !data) return;
          let parsed = null;
          try { parsed = JSON.parse(data[1]); } catch (e) { return; }
          box.events.push({ type: ev[1], data: parsed });
        });
      }
    })
    .catch(() => { /* поток закрыли — это нормально */ });
  return box;
}

(async () => {
  console.log('\n=== ТЕСТ 8: сигналинг голосового чата ===');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-signal.json' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  try {
    const stamp = Date.now().toString(36).slice(-4);
    const mk = async name => {
      const r = await api('/api/register', { body: { name } });
      if (!r.json || !r.json.user) throw new Error('регистрация не удалась: ' + JSON.stringify(r.json));
      return r.json.user;
    };
    const a = await mk('Голос' + stamp + 'A');
    const b = await mk('Голос' + stamp + 'B');
    const c = await mk('Голос' + stamp + 'C');
    const outsider = await mk('Мимо' + stamp);

    const room = (await api('/api/rooms/create', { token: a.token, body: { size: 6 } })).json.room;
    await api('/api/rooms/join', { token: b.token, body: { invite: room.invite } });
    await api('/api/rooms/join', { token: c.token, body: { invite: room.invite } });

    const earB = listen(b.token);
    const earC = listen(c.token);
    await sleep(400);

    /* --- записка доходит адресату --- */
    const sent = await api('/api/rooms/signal', {
      token: a.token,
      body: { to: b.id, kind: 'offer', data: { sdp: 'v=0 тестовый', type: 'offer' } }
    });
    ok(sent.status === 200, 'записка принята сервером');
    ok(sent.json.delivered >= 1, 'сервер сообщает, что доставил её');
    await sleep(400);

    const gotB = earB.events.filter(e => e.type === 'signal');
    ok(gotB.length === 1, 'адресат получил ровно одну записку');
    ok(gotB[0].data.from === a.id, 'в записке виден отправитель');
    ok(gotB[0].data.kind === 'offer', 'тип записки сохранён');
    ok(gotB[0].data.data.sdp === 'v=0 тестовый', 'тело записки не изменилось');

    const gotC = earC.events.filter(e => e.type === 'signal');
    ok(gotC.length === 0, 'третьему игроку чужая записка не пришла');

    /* --- защита --- */
    const toStranger = await api('/api/rooms/signal', { token: a.token, body: { to: outsider.id, kind: 'offer', data: {} } });
    ok(toStranger.status === 404, 'сигналить тому, кого нет за столом, нельзя');

    const fromStranger = await api('/api/rooms/signal', { token: outsider.token, body: { to: b.id, kind: 'offer', data: {} } });
    ok(fromStranger.status === 404 || fromStranger.status === 403, 'посторонний в чужую комнату не сигналит');

    const noToken = await api('/api/rooms/signal', { body: { to: b.id, kind: 'offer', data: {} } });
    ok(noToken.status === 401, 'без токена сигналинг закрыт');

    /* --- микрофон видно за столом --- */
    const voiceOn = await api('/api/rooms/voice', { token: a.token, body: { on: true } });
    ok(voiceOn.status === 200 && voiceOn.json.voice === true, 'микрофон включается');
    await sleep(300);
    const st = await api('/api/rooms/state', { token: b.token });
    const me = st.json.room.members.find(m => m.id === a.id);
    ok(me && me.voice === true, 'остальные видят, что у него включён микрофон');

    const voiceOff = await api('/api/rooms/voice', { token: a.token, body: { on: false } });
    ok(voiceOff.json.voice === false, 'микрофон выключается');

    /* --- сервера ICE площадки --- */
    const ice = await api('/api/ice', { token: a.token });
    ok(ice.status === 200 && Array.isArray(ice.json.iceServers),
      'площадка отдаёт список серверов ICE (' + ice.status + ')');
    ok(ice.json.iceServers.length === 0,
      'без переменных окружения список пуст: игра остаётся замкнутой');

    /* ==================================================================== */
    /* ГОЛОС ПО ФАЗАМ                                                       */
    /* ==================================================================== */
    /* Стол собираем из живых людей, а не добираем ботами: на шести игроках
       мафия ровно одна, и она обязана достаться человеку. Иначе проверка
       «записка между городом и мафией не проходит» зависела бы от случая и
       молча пропускалась бы в большинстве прогонов. */
    const d = await mk('Голос' + stamp + 'D');
    const e6 = await mk('Голос' + stamp + 'E');
    const f = await mk('Голос' + stamp + 'F');
    for (const u of [d, e6, f]) {
      await api('/api/rooms/join', { token: u.token, body: { invite: room.invite } });
    }
    const play = await api('/api/rooms/start', { token: a.token, body: {} });
    ok(play.status === 200, 'партия из шести живых началась (' + play.status + ')');

    const view = (tok) => api('/api/rooms/state', { token: tok }).then(r => r.json.room.game);
    const gA = await view(a.token);
    ok(gA.phase === 'prologue' || gA.phase === 'night', 'партия в начальной фазе: ' + gA.phase);

    /* Знакомство: до ночи говорят все живые. */
    const humans = [a, b, c, d, e6, f];
    const townVoice = await Promise.all(humans.map(u => view(u.token).then(g => g.you.voice)));
    townVoice.forEach((v, i) => {
      ok(v.channel === 'town', 'до ночи ' + humans[i].name + ' говорит со всем столом (' + v.channel + ')');
    });

    /* Дожидаемся ночи: пролог короткий. */
    let g = await view(a.token);
    for (let i = 0; i < 40 && g.phase !== 'night'; i++) { await sleep(600); g = await view(a.token); }
    ok(g.phase === 'night', 'дошли до ночи (' + g.phase + ')');

    const nightVoices = {};
    for (const u of humans) {
      const gg = await view(u.token);
      nightVoices[u.id] = { role: gg.you.role, voice: gg.you.voice, alive: gg.you.alive };
    }
    const alive = humans.filter(u => nightVoices[u.id].alive);
    const mafia = alive.filter(u => /mafia|don/.test(nightVoices[u.id].role));
    const town = alive.filter(u => !/mafia|don/.test(nightVoices[u.id].role));

    town.forEach(u => {
      const v = nightVoices[u.id].voice;
      ok(v.channel === null, 'ночью мирный молчит: канала нет (' + u.name + ' → ' + v.channel + ')');
      ok(v.peers.length === 0, 'и собеседников у него ночью нет');
      ok(!!v.why, 'игроку объясняют, почему микрофон закрыт: «' + v.why + '»');
    });
    mafia.forEach(u => {
      const v = nightVoices[u.id].voice;
      ok(v.channel === 'mafia', 'ночью мафия говорит со своими (' + u.name + ' → ' + v.channel + ')');
      const outsiders = v.peers.filter(id => town.some(t => t.id === id));
      ok(outsiders.length === 0, 'в её кругу нет ни одного мирного');
    });

    /* Главное: сервер не передаёт записку между городом и мафией ночью. */
    if (mafia.length && town.length) {
      const bad = await api('/api/rooms/signal', {
        token: mafia[0].token, body: { to: town[0].id, kind: 'offer', data: {} }
      });
      ok(bad.status === 403, 'ночью записка от мафии к городу не проходит (' + bad.status + ')');
      const back = await api('/api/rooms/signal', {
        token: town[0].token, body: { to: mafia[0].id, kind: 'offer', data: {} }
      });
      ok(back.status === 403, 'и обратно тоже (' + back.status + ')');
    } else {
      ok(true, 'на этом столе живых людей по одну сторону — проверку записки пропускаем');
    }

    earB.stop(); earC.stop();
  } catch (e) {
    fails++;
    console.log('  FAIL: исключение — ' + e.message);
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 8 ПРОЙДЕН' : '\n✗ ТЕСТ 8: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
