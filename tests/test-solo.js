/* =========================================================================
   Тест №19 — один движок на всё: стол с соседями и воронка главной.

   Что именно проверяется и почему это важнее, чем кажется.

   План называет первой поломкой проекта не картинку и не баланс, а
   раздвоение: два разных движка и два разных клиента. Партия с ботами жила
   отдельной страницей на 327 КБ со своим движком внутри — и потому не знала
   ни «Следствия», ни последнего слова, ни расширенного набора ролей, ни
   пресетов темпа. Каждая механика приезжала в сетевую игру и не приезжала к
   ботам; любая правка правил делалась дважды или, чаще, один раз и
   расходилась.

   Теперь стол с соседями — обычная комната общего движка. Тест сторожит
   именно это: что с ботами доступно всё то же, что по сети, и что путь с
   главной ведёт в партию, а не в комнату ожидания.

    1. /api/rooms/solo — закрытый стол, соседи уже сидят, партия идёт.
    2. Тот же стол умеет всё: «Следствие», пресеты ролей, темп, размер.
    3. ?solo=setup — стол с соседями, но партию начинает человек.
    4. «Быстро» обещает партию: нет живых столов — начинаем с соседями,
       но стол остаётся объявленным, и пришедший человек садится на место бота.
    5. Воронка главной: одно очевидное действие, три пути, и каждая ссылка
       ведёт туда, где что-то происходит.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const C = require('../shared/game-config.js');

const PORT = 8_254;
const BASE = 'http://127.0.0.1:' + PORT;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: Object.assign({ 'Content-Type': 'application/json' },
      opts.token ? { 'x-token': opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}
const newUser = async name =>
  (await req('/api/register', { body: { name } })).json.user;

(async () => {
  console.log('\n=== ТЕСТ 19: один движок на всё ===');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await sleep(900);

  try {
    /* ---- 1. стол на одного ---- */
    {
      const me = await newUser('Один' + Date.now().toString(36).slice(-3));
      const r = await req('/api/rooms/solo', { token: me.token, body: { size: 8 } });
      ok(r.status === 200, 'стол с соседями открывается одним запросом');
      const room = r.json.room;
      ok(room.started === true, 'и партия в нём уже идёт: с главной играют, а не ждут');
      ok(room.members.length === 8, 'за столом восемь мест');
      ok(room.bots === 7, 'семь из них заняли соседи');
      ok(room.solo === true, 'стол помечен как стол на одного');
      ok(room.visibility === 'invite',
        'и он закрыт: человек сел играть один, объявлять его стол в зале было бы обманом');
      ok(!!room.invite && room.inviteLink.indexOf('?join=') > 0,
        'ссылка при этом есть — передумает и позовёт живого');

      /* Главное: тот же движок, а значит те же механики. */
      const g = room.game;
      ok(!!g && !!g.you && !!g.you.role, 'игрок получил роль');
      ok(g.preset === 'classic', 'по умолчанию классика');
      ok(typeof g.voteOpen === 'boolean' && typeof g.onTie === 'string',
        'правила стола приехали к игроку так же, как в сетевой партии');
      ok(g.timing && g.timing.lastWord > 0, 'последнее слово работает и с соседями');
      ok(Array.isArray(g.log) && g.log.length > 0, 'протокол ведётся');

      /* Не в общем зале. Это и есть «закрытый стол» на деле, а не на словах. */
      const other = await newUser('Чужой' + Date.now().toString(36).slice(-3));
      const lobby = (await req('/api/lobby', { token: other.token })).json;
      const seen = (lobby.rooms || []).some(x => x.invite === room.invite);
      ok(!seen, 'в общем зале стола на одного не видно');
    }

    /* ---- 2. с соседями доступно всё ---- */
    {
      const me = await newUser('Полный' + Date.now().toString(36).slice(-3));
      const r = await req('/api/rooms/solo', {
        token: me.token,
        body: { size: 12, rolePreset: 'extended', mode: 'inquest', speed: 'blitz' }
      });
      const g = r.json.room.game;
      ok(g.preset === 'extended',
        'расширенный набор ролей работает с соседями — раньше это было невозможно в принципе');
      ok(g.mode === 'inquest', '«Следствие» тоже: карточка с главной больше не врёт');
      ok(g.speed === 'blitz', 'и пресет темпа');
      ok(!!g.inquest && Array.isArray(g.inquest.methods), 'приметы и способы на месте');
      ok(g.sides === 3, 'за столом три силы: маньяк раздан');
      ok(r.json.room.members.length === 12, 'двенадцать мест — все заняты');

      /* Пресет не по размеру и здесь не раздаётся молча. */
      const me2 = await newUser('Мал' + Date.now().toString(36).slice(-3));
      const r2 = await req('/api/rooms/solo', {
        token: me2.token, body: { size: 6, rolePreset: 'extended' }
      });
      ok(r2.json.room.game.preset === 'classic',
        'полный набор на шестерых не садится — стол падает в классику');
    }

    /* ---- 3. с соседями, но с настройками ---- */
    {
      const me = await newUser('Настрой' + Date.now().toString(36).slice(-3));
      const r = await req('/api/rooms/solo', { token: me.token, body: { size: 10, start: false } });
      const room = r.json.room;
      ok(room.started === false, 'путь «С ботами» оставляет старт человеку');
      ok(room.bots === 9, 'но соседи уже за столом: настраивать пустую комнату нечего');
      ok(room.canStart === true, 'и кнопка «Начать» доступна сразу');
      ok(Array.isArray(room.presetList) && room.presetList.length === 4,
        'выбор набора ролей на месте');
      ok(Array.isArray(room.scenarios) && room.scenarios.length > 0, 'и выбор сюжета');

      const started = await req('/api/rooms/start', { token: me.token, body: {} });
      ok(started.status === 200 && started.json.room.started, 'партия начинается по кнопке');
    }

    /* ---- 4. «Быстро» обещает партию ---- */
    {
      const me = await newUser('Быстро' + Date.now().toString(36).slice(-3));
      const r = await req('/api/rooms/quick', { token: me.token, body: { size: 8, fill: true } });
      ok(r.status === 200, 'быстрая игра отвечает');
      const room = r.json.room;
      /* Свободных живых столов на этот момент может и не быть, и тогда
         обещание «нажал — играешь» держится соседями. */
      if (r.json.filled) {
        ok(room.started === true, 'живых столов нет — партия начата с соседями');
        ok(room.visibility === 'public',
          'но стол объявлен: пришедший человек сядет на место соседа, живой важнее бота');
        ok(room.bots > 0, 'соседи заняли пустые места');
      } else {
        ok(r.json.joined === true, 'нашёлся живой стол — сели за него');
      }

      /* Обратная совместимость: без fill поведение прежнее. */
      const me2 = await newUser('Тихо' + Date.now().toString(36).slice(-3));
      const r2 = await req('/api/rooms/quick', { token: me2.token, body: { size: 8 } });
      ok(r2.status === 200 && !r2.json.filled,
        'без флага заполнения быстрая игра работает как прежде');
    }

    /* ---- 5. воронка главной ---- */
    {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      ok(html.indexOf('class="funnel"') > 0, 'на главной воронка, а не три равные карточки');
      ok(html.indexOf('?quick=1') > 0, 'большая кнопка ведёт в партию');
      ok(html.indexOf('?solo=setup') > 0, 'путь «С ботами» ведёт на общий движок');
      ok(html.indexOf('?create=1') > 0, 'путь «С друзьями» открывает комнату');
      /* Карточка «Следствия» обещала отдельную игру, которой нет: с ботами в
         неё было нельзя. Обещание снято, а сам режим теперь и правда доступен
         с соседями (проверено выше). */
      ok(html.indexOf('modeInquestCard') < 0,
        '«Следствие» больше не отдельный «режим сайта» на афише');
      ok(html.indexOf('/bots.html') < 0,
        'путь с главной не ведёт в монолит: игра с ботами идёт через общий движок');
      ok(html.indexOf('id="btnGuest"') > 0,
        'играть можно и без имени: одно поле не должно стоить сайту посетителя');

      /* Каждая ссылка воронки обязана открываться. */
      for (const u of ['/', '/online.html?quick=1', '/online.html?solo=setup',
        '/online.html?create=1', '/rules.html', '/rules.html#extra']) {
        const res = await fetch(BASE + u.split('#')[0]);
        ok(res.status === 200, 'открывается ' + u);
      }
    }
  } catch (e) {
    fails++;
    console.log('  FAIL: тест упал — ' + (e && e.message));
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 19 ПРОЙДЕН' : '\n✗ ТЕСТ 19: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
