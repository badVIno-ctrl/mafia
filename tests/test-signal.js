/* =========================================================================
   Тест №8 — сигналинг голосового чата.

   Сервер не пропускает через себя звук: он только передаёт участникам
   комнаты записки WebRTC. Проверяем, что записка доходит ровно тому, кому
   адресована, и что посторонний в чужую комнату сигналить не может.
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
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  try {
    const stamp = Date.now().toString(36).slice(-4);
    const mk = async name => (await api('/api/register', { body: { name } })).json.user;
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
