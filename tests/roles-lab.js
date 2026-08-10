/* =========================================================================
   Стенд расширенного набора: настоящий браузер, все пять новых карт.

   Зачем отдельно от tests/shot.js. Тот стенд смотрит на сцену: свет, фигуры,
   отсутствие прокрутки. Здесь проверяется другое — то, что игрок читает в
   момент своего хода. Пять новых ролей означают пять новых ночей, и каждая
   из них должна отвечать на один вопрос: «что от меня сейчас нужно».
   Обычный тест этого не поймает: он проверит, что действие принято, но не
   то, что человек понял, какое действие от него ждут.

   Как это устроено. Стенд поднимает сервер, делает аккаунт через API, сажает
   за стол ботов и перезапускает партию по новому семени, пока игроку не
   достанется нужная карта. Дальше он ждёт ночь и снимает док действия —
   ту самую строку, в которой написано, чего от игрока хотят.

       node tests/roles-lab.js            — весь прогон
       node tests/roles-lab.js maniac     — только одна карта

   Браузер берётся из playwright. Нет его в системе — стенд честно говорит
   об этом и выходит с нулём, чтобы не красить общий тест.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.LAB_PORT ? Number(process.env.LAB_PORT) : 8244;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'shots');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* стенд просто не поедет */ }
if (!chromium) {
  console.log('Стенд пропущен: в системе нет playwright. Установите его — и снимки появятся.');
  process.exit(0);
}

const only = process.argv[2] || '';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--mute-audio'];

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.body ? 'POST' : 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { 'x-token': opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = {}; }
  return { status: res.status, json: j };
}

function watch(page, errs) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/i.test(m.text())) return;
    errs.push(m.text());
  });
  page.on('pageerror', e => errs.push('исключение: ' + (e && e.message)));
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name + '.png') });
}

/* Что должно быть написано в доке, когда ход за этой картой. Проверяем
   именно текст: «действие принято» ничего не говорит о понятности. */
const WANT = {
  maniac: { act: 'slay', hint: 'заберёте этой ночью', role: 'Маньяк' },
  lover: { act: 'block', hint: 'не до дела', role: 'Любовница' },
  lawyer: { act: 'shield', hint: 'от изгнания', role: 'Адвокат' },
  journalist: { act: 'press', hint: 'вместе они или врозь', role: 'Журналист' },
  werewolf: { act: null, hint: '', role: 'Оборотень' }
};

/**
 * Перезапускать партию, пока игроку не достанется нужная карта.
 * Роли раздаются по семени партии, поэтому «ещё раз» — это честный способ
 * получить любую из них, не подкручивая движок под стенд.
 */
async function dealUntil(token, role, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    await api('/api/rooms/restart', { token, body: {} });
    const r = await api('/api/rooms/start', { token, body: {} });
    const g = r.json && r.json.room && r.json.room.game;
    if (g && g.you && g.you.role === role) return g;
  }
  return null;
}

/** Дождаться ночи, в которой на ход остаётся хотя бы двенадцать секунд. */
async function waitNight(page) {
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate(() => ({
      phase: (document.getElementById('gPhase') || {}).textContent || '',
      left: (document.getElementById('gTimer') || {}).textContent || ''
    })).catch(() => ({ phase: '', left: '' }));
    const secs = (function (t) {
      const m = String(t).match(/(\d+)\D+(\d+)/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    })(st.left);
    if (/Ночь/.test(st.phase) && secs >= 12) return st.phase;
    await sleep(1000);
  }
  return '';
}

async function roleScene(browser, role) {
  const stamp = Date.now().toString(36).slice(-4);
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  watch(page, errs);

  const user = (await api('/api/register', { body: { name: 'Карта' + stamp } })).json.user;
  const token = user.token;

  /* Стол на двенадцать: меньше полный набор не садится. */
  await api('/api/rooms/create', { token, body: { size: 12, rolePreset: 'extended', autoStart: false } });
  const cfg = await api('/api/rooms/config', { token, body: { rolePreset: 'extended', onTie: 'table', fouls: true } });
  ok(cfg.json.room && cfg.json.room.rolePreset === 'extended', role + ': стол принял полный набор');
  await api('/api/rooms/bots', { token, body: {} });

  const dealt = await dealUntil(token, role);
  if (!dealt) {
    ok(false, role + ': карта так и не досталась за сорок раздач');
    await page.close();
    return;
  }

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(u => localStorage.setItem('mafia.online.user', JSON.stringify(u)), user);
  await page.goto(BASE + '/online.html', { waitUntil: 'load' });
  await sleep(2600);

  /* Ждём не просто ночь, а ночь, в которой ещё есть время на ход: сорок
     раздач подряд занимают секунды, и первая ночь к моменту открытия
     страницы может доживать последние восемь. Снимок такой ночи показал бы
     утро, а не док действия. */
  const phase = await waitNight(page);
  ok(/Ночь/.test(phase || ''), role + ': партия дошла до ночи (фаза «' + phase + '»)');

  const want = WANT[role];
  const roleText = await page.textContent('#rolePane').catch(() => '');
  ok((roleText || '').indexOf(want.role) >= 0, role + ': карта роли называет себя «' + want.role + '»');

  const hint = await page.textContent('#gHint').catch(() => '');
  if (want.hint) {
    ok((hint || '').indexOf(want.hint) >= 0,
      role + ': док говорит, что от игрока нужно — «' + String(hint).slice(0, 78) + '…»');
  } else {
    ok((hint || '').indexOf('Ждите утра') >= 0,
      role + ': оборотню честно сказано, что ночью от него ничего не нужно');
  }

  /* Кликабельные места. Роль без действия не должна их иметь, роль с
     действием — обязана: иначе игрок сидит и не понимает, куда тыкать. */
  const pickable = await page.evaluate(() => document.querySelectorAll('#marks .mark.pickable').length);
  if (want.act) ok(pickable > 0, role + ': места, по которым можно ходить, подсвечены (' + pickable + ')');
  else ok(pickable === 0, role + ': ночью выбирать нечего, и подсвеченных мест нет');

  await shot(page, 'role-' + role);

  /* Ход подаётся кликом по месту — тем же жестом, что и у классических карт.
     Проверяем не класс на месте, а ответ сервера. Причина тонкая и её стоит
     назвать: ход игрока часто оказывается последним ночным ходом, ночь
     закрывается в ту же секунду, и подсветка «выбрано» законно исчезает
     вместе с ночью. Стенд, смотрящий на подсветку, ловил бы не ошибку
     интерфейса, а собственную удачливость. */
  if (want.act) {
    const clickSeat = () => page.evaluate(() => {
      const el = document.querySelector('#marks .mark.pickable');
      if (el) el.click();
    });

    if (role === 'journalist') {
      await clickSeat();
      await sleep(900);
      const dock = await page.textContent('#actions').catch(() => '');
      ok(/Первый/.test(dock || ''), 'журналист: после первого клика док просит второго');
      await shot(page, 'role-' + role + '-half');
    }

    const wait = page.waitForResponse(
      r => r.url().indexOf('/api/rooms/action') >= 0, { timeout: 12000 }).catch(() => null);
    await clickSeat();
    const res = await wait;
    let body = null;
    if (res) { try { body = await res.json(); } catch (e) { body = null; } }
    ok(!!res && res.status() === 200 && body && !body.error,
      role + ': клик по месту подаёт ход, и сервер его принимает' +
      (body && body.error ? ' (' + body.error + ')' : ''));
    await sleep(900);
    await shot(page, 'role-' + role + '-picked');
  }

  ok(errs.length === 0, role + ': нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
/* правила стола: настройки видны и доезжают до сервера                */
/* ------------------------------------------------------------------ */
async function rulesScene(browser) {
  const stamp = Date.now().toString(36).slice(-4);
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  watch(page, errs);

  const user = (await api('/api/register', { body: { name: 'Правила' + stamp } })).json.user;
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(u => localStorage.setItem('mafia.online.user', JSON.stringify(u)), user);
  await page.goto(BASE + '/online.html', { waitUntil: 'load' });
  await sleep(1600);
  await page.click('#btnCreate');
  await sleep(1400);

  const presets = await page.evaluate(() =>
    [...document.querySelectorAll('#presetPick [data-preset]')].map(b => ({
      id: b.dataset.preset, off: b.classList.contains('off'), on: b.classList.contains('on')
    })));
  ok(presets.length === 4, 'в комнате четыре пресета ролей (' + presets.length + ')');
  ok(presets.some(p => p.id === 'classic' && p.on), 'по умолчанию выбрана классика');
  /* Стол по умолчанию на восемь человек: полный набор на него не садится, и
     кнопка обязана это показывать, а не молча отказывать по нажатию. */
  ok(presets.some(p => p.id === 'extended' && p.off),
    'пресет не по размеру стола показан погашенным, а не спрятан');

  await page.click('[data-preset="maniac"]');
  await sleep(1200);
  const note = await page.textContent('#presetNote');
  ok(/маньяк/i.test(note || ''), 'выбранный пресет подписан своими словами: «' + note + '»');
  const compo = await page.textContent('#compo');
  ok(/маньяк/i.test(compo || ''), 'состав стола сразу показывает новую карту: «' + compo + '»');
  ok(/доктора|2 доктора/i.test(compo || '') || /доктор/i.test(compo || ''),
    'и поправку по врачам тоже');

  /* Три правила стола. Каждое должно доехать до сервера, а не остаться
     галочкой на экране. */
  await page.click('#onTieTable');
  await sleep(900);
  await page.click('#foulsOn');
  await sleep(900);
  await page.click('#voteOpenOn');
  await sleep(900);
  const state = (await api('/api/rooms/state', { token: user.token })).json.room;
  ok(state.onTie === 'table', 'правило ничьей доехало до сервера');
  ok(state.fouls === true, 'фолы доехали до сервера');
  ok(state.voteOpen === false, 'закрытое голосование доехало до сервера');
  await shot(page, 'room-rules');

  ok(errs.length === 0, 'в настройках стола нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
/* ночная доска мафии: договориться, не выходя в общий чат                */
/* ------------------------------------------------------------------ */
async function boardScene(browser) {
  const stamp = Date.now().toString(36).slice(-4);
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  watch(page, errs);

  const user = (await api('/api/register', { body: { name: 'Доска' + stamp } })).json.user;
  const token = user.token;
  await api('/api/rooms/create', { token, body: { size: 12, autoStart: false } });
  await api('/api/rooms/bots', { token, body: {} });
  /* Доска нужна мафии, значит ждём мафию. Дон тоже подходит: доска общая. */
  let dealt = null;
  for (let i = 0; i < 40 && !dealt; i++) {
    await api('/api/rooms/restart', { token, body: {} });
    const r = await api('/api/rooms/start', { token, body: {} });
    const g = r.json && r.json.room && r.json.room.game;
    if (g && g.you && (g.you.role === 'mafia' || g.you.role === 'don')) dealt = g;
  }
  if (!dealt) { ok(false, 'доска: карта мафии так и не досталась'); await page.close(); return; }

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(u => localStorage.setItem('mafia.online.user', JSON.stringify(u)), user);
  await page.goto(BASE + '/online.html', { waitUntil: 'load' });
  await sleep(2600);
  const phase = await waitNight(page);
  ok(/Ночь/.test(phase || ''), 'доска: партия дошла до ночи');

  /* Метку ставит бот-сообщник: доска общая, и увидеть чужую метку — весь её
     смысл. Ждём её появления в доке. */
  let dock = '';
  for (let i = 0; i < 14; i++) {
    dock = await page.textContent('#actions').catch(() => '');
    if (/Доска/.test(dock || '') && !/пусто/.test(dock || '')) break;
    await sleep(1000);
  }
  ok(/Доска/.test(dock || ''), 'доска мафии видна в доке действия');
  ok(!/пусто/.test(dock || ''), 'и на ней есть метка сообщника: «' + String(dock).slice(0, 90) + '»');
  await shot(page, 'mafia-board');

  ok(errs.length === 0, 'доска: нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
(async () => {
  console.log('\n=== СТЕНД: расширенный набор ролей ===');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  await sleep(1400);

  const browser = await chromium.launch({ args: ARGS });
  try {
    if (!only || only === 'rules') await rulesScene(browser);
    if (!only || only === 'board') await boardScene(browser);
    for (const role of Object.keys(WANT)) {
      if (only && only !== role) continue;
      await roleScene(browser, role);
    }
  } catch (e) {
    fails++;
    console.log('  FAIL: стенд упал — ' + (e && e.message));
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(fails === 0 ? '\n✓ СТЕНД ПРОЙДЕН' : '\n✗ СТЕНД: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
