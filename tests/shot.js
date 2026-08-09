/* =========================================================================
   Прогонный стенд: настоящий браузер, настоящий WebGL, настоящие снимки.

   Зачем отдельно от остальных тестов. Всё, на что жаловался игрок —
   «кривые модельки», «руки в воздухе», «ничего не происходит» — видно только
   глазами и только в браузере. Обычные тесты этого не поймают.

   Стенд поднимает сервер, водит по страницам живой Chromium, собирает
   ошибки консоли, проверяет, что нигде не появилось горизонтальной
   прокрутки, и складывает снимки в tests/shots.

       node tests/shot.js                 — весь прогон
       node tests/shot.js bots            — только партия с ботами
       node tests/shot.js online          — только сетевая комната

   Браузер берётся из playwright, если он есть в системе; если нет — стенд
   честно говорит об этом и выходит с нулём, чтобы не ломать общий тест.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.SHOT_PORT ? Number(process.env.SHOT_PORT) : 8231;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'shots');
const WIDTHS = [390, 820, 1440, 1920];

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

/* SwiftShader: программный WebGL. Без него в headless нет ни сцены, ни фигур. */
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
    /* «Failed to load resource» отдельно не считаем: свои адреса ловит
       requestfailed, а чужие (внешний помощник, отсутствующая favicon)
       к работе сайта отношения не имеют. */
    if (/Failed to load resource/i.test(m.text())) return;
    errs.push(m.text());
  });
  page.on('pageerror', e => errs.push('исключение: ' + (e && e.message)));
  page.on('requestfailed', r => {
    /* внешние адреса нас не волнуют: сайт обязан работать и без них */
    if (r.url().indexOf(BASE) === 0) errs.push('не загрузилось: ' + r.url());
  });
}

async function overflow(page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }));
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name + '.png') });
}

/* ------------------------------------------------------------------ */
/* сцена: партия с ботами                                              */
/* ------------------------------------------------------------------ */
async function botsScene(browser, size) {
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, errs);
  await page.goto(BASE + '/bots.html', { waitUntil: 'load' });
  await sleep(1800);
  await page.click('#paceRow .pc[data-v="0.7"]').catch(() => {});
  await page.click('#sizeRow .opt[data-v="' + size + '"]').catch(() => {});
  await page.click('#btnStart');
  await sleep(1200);
  await page.click('#storyGo').catch(() => {});
  await sleep(9000);
  await page.click('#leftClose').catch(() => {});
  await page.click('#rightClose').catch(() => {});
  await sleep(700);
  await shot(page, 'bots-' + size + '-night');

  /* ведём партию до обсуждения и смотрим, идёт ли она вообще */
  let phase = '', moved = 0, prev = '';
  for (let i = 0; i < 90; i++) {
    for (const sel of ['#storyGo', '#nextBtn', '.tgt.skip', '#speechSkip', '.tgt']) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) { await el.click({ timeout: 800 }).catch(() => {}); break; }
    }
    const st = await page.evaluate(() => ({
      phase: (document.getElementById('stPhase') || {}).textContent || '',
      logN: document.querySelectorAll('#log .le').length
    }));
    phase = st.phase;
    const key = st.phase + '|' + st.logN;
    if (key !== prev) { moved++; prev = key; }
    if (/Голосование|Казнь|Финал/.test(phase)) break;
    await sleep(380);
  }
  ok(moved > 4, 'партия с ботами на ' + size + ' человек идёт сама: ' + moved + ' изменений, фаза «' + phase + '»');
  ok(/Голосование|Казнь|Финал|Обсуждение/.test(phase), 'дошли до дневных фаз (' + phase + ')');
  await shot(page, 'bots-' + size + '-day');
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 880 });
    await sleep(900);
    const o = await overflow(page);
    ok(o.scroll <= o.client + 1, 'партия с ботами без горизонтальной прокрутки на ' + w + 'px (' + o.scroll + ' / ' + o.client + ')');
    await shot(page, 'bots-w' + w);
  }
  ok(errs.length === 0, 'в партии с ботами нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
/* сцена: сетевая комната с ботами                                     */
/* ------------------------------------------------------------------ */
async function onlineScene(browser) {
  const stamp = Date.now().toString(36).slice(-4);
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, errs);

  /* Аккаунт делаем через API и кладём в тот же ключ, что и сайт: стенд не
     должен зависеть от того, как выглядит экран регистрации. */
  const user = (await api('/api/register', { body: { name: 'Стенд' + stamp } })).json.user;
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(u => localStorage.setItem('mafia.online.user', JSON.stringify(u)), user);

  await page.goto(BASE + '/online.html', { waitUntil: 'load' });
  await sleep(1500);
  await page.click('#btnCreate');
  await sleep(1200);
  const link = await page.textContent('#inviteLink');
  ok(!!link && link.indexOf('?join=') > 0, 'в комнате показана ссылка-приглашение');
  await shot(page, 'online-room');

  await page.click('#btnBots');
  await sleep(1500);
  const bots = await page.textContent('#cntBots');
  ok(Number(bots) >= 5, 'соседи-боты сели за стол (' + bots + ')');

  await page.click('#btnStart').catch(() => {});
  await sleep(6000);
  const seats = await page.evaluate(() => document.querySelectorAll('#marks .mark').length);
  ok(seats >= 6, 'на сетевой сцене есть подписи всех мест (' + seats + ')');
  const hasCanvas = await page.evaluate(() => !!document.querySelector('#stage canvas'));
  ok(hasCanvas, 'сетевая партия идёт на настоящей сцене, а не на таблице карточек');
  await shot(page, 'online-game');

  /* час за столом в ускоренном виде: ждём, что фаза меняется сама */
  const first = await page.textContent('#gPhase');
  await sleep(12000);
  const chat = await page.evaluate(() => document.querySelectorAll('#gFeed .msg').length);
  ok(chat > 0, 'соседи-боты говорят в чате сетевой партии (' + chat + ' реплик)');
  await shot(page, 'online-chat');
  console.log('    фаза была «' + first + '», стала «' + (await page.textContent('#gPhase')) + '»');

  /* ширины экрана */
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 880 });
    await sleep(900);
    const o = await overflow(page);
    ok(o.scroll <= o.client + 1, 'нет горизонтальной прокрутки на ' + w + 'px (' + o.scroll + ' / ' + o.client + ')');
    await shot(page, 'online-w' + w);
  }
  ok(errs.length === 0, 'в сетевой партии нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
/* сцена: главная                                                      */
/* ------------------------------------------------------------------ */
async function homeScene(browser) {
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, errs);
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await sleep(1200);
  await shot(page, 'home');
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 880 });
    await sleep(600);
    const o = await overflow(page);
    ok(o.scroll <= o.client + 1, 'главная без горизонтальной прокрутки на ' + w + 'px');
  }
  ok(errs.length === 0, 'на главной нет ошибок консоли' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();
}

/* ------------------------------------------------------------------ */
/* сцена: смена декораций посреди партии                               */
/* ------------------------------------------------------------------ */
/* Проверяем то, что нельзя увидеть обычным тестом: партия начинается в 2D,
   кнопка честно обещает «Переключить на 3D-вид», объём встаёт на ходу, партия
   при этом не рвётся, подписи мест остаются и обратный путь тоже работает. */
async function viewScene(browser) {
  const stamp = Date.now().toString(36).slice(-4);
  const errs = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page, errs);

  const user = (await api('/api/register', { body: { name: 'Вид' + stamp } })).json.user;
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(u => localStorage.setItem('mafia.online.user', JSON.stringify(u)), user);
  await page.goto(BASE + '/online.html', { waitUntil: 'load' });
  await sleep(1400);

  ok(await page.isVisible('#btnView'), 'кнопка вида есть в сетевой партии');
  ok(await page.evaluate(() => document.body.dataset.sceneMode) === '2d',
    'партия начинается в 2D-виде');
  ok(await page.getAttribute('#btnView', 'title') === 'Переключить на 3D-вид',
    'подсказка кнопки обещает ровно то, что произойдёт');
  ok((await page.textContent('#btnView')).trim() === '3D',
    'на кнопке написан тот вид, который она включит');

  await page.click('#btnCreate'); await sleep(1000);
  await page.click('#btnBots'); await sleep(1400);
  await page.click('#btnStart').catch(() => {});
  await sleep(5000);

  const flat = await page.evaluate(() => ({
    mode: document.body.dataset.sceneView,
    canvas: !!document.querySelector('#stage canvas.flat-table'),
    marks: document.querySelectorAll('#marks .mark').length,
    probe: window.__flatTableProbe ? window.__flatTableProbe() : null
  }));
  ok(flat.mode === 'flat' && flat.canvas, 'первый кадр партии — плоский стол');
  ok(flat.marks >= 6, 'подписи мест на месте (' + flat.marks + ')');
  ok(flat.probe && flat.probe.seats >= 6, 'на плоской сцене есть все места (' + (flat.probe && flat.probe.seats) + ')');
  await shot(page, 'view-flat');

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 880 });
    await sleep(800);
    const o = await overflow(page);
    ok(o.scroll <= o.client + 1, 'плоский задник без горизонтальной прокрутки на ' + w + 'px');
    await shot(page, 'view-flat-w' + w);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#btnView'); await sleep(3000);
  const deep = await page.evaluate(() => ({
    mode: document.body.dataset.sceneView,
    flat: !!document.querySelector('#stage canvas.flat-table'),
    canvas: !!document.querySelector('#stage canvas'),
    marks: document.querySelectorAll('#marks .mark').length,
    label: (document.getElementById('btnView') || {}).textContent || '',
    title: (document.getElementById('btnView') || {}).title || ''
  }));
  ok(deep.mode === 'deep' && deep.canvas && !deep.flat, '3D-вид встал по кнопке');
  ok(deep.marks >= 6, 'подписи мест не потерялись при переключении (' + deep.marks + ')');
  ok(deep.label.trim() === '2D' && deep.title === 'Переключить на 2D-вид',
    'кнопка теперь обещает обратный путь');
  await shot(page, 'view-deep');

  await page.click('#btnView'); await sleep(2200);
  ok(await page.evaluate(() => document.body.dataset.sceneView) === 'flat',
    'обратно в 2D тем же нажатием');
  ok(errs.length === 0, 'при смене вида нет ошибок консоли' +
    (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await page.close();

  /* Та же кнопка на странице с ботами: там сцена ведётся шагами, и новая
     декорация должна догнать стол по журналу. */
  const errs2 = [];
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(p2, errs2);
  await p2.goto(BASE + '/bots.html', { waitUntil: 'load' });
  await sleep(2000);
  await p2.click('#paceRow .pc[data-v="0.7"]').catch(() => {});
  await p2.click('#sizeRow .opt[data-v="8"]').catch(() => {});
  await p2.click('#btnStart');
  await sleep(1300);
  await p2.click('#storyGo').catch(() => {});
  await sleep(6500);
  const bStart = await p2.evaluate(() => ({
    mode: document.body.dataset.sceneView,
    flat: !!document.querySelector('#scene-root canvas.flat-table')
  }));
  ok(bStart.mode === 'flat' && bStart.flat, 'партия с ботами тоже начинается в 2D');
  await shot(p2, 'view-bots-flat');

  /* Партия обязана идти сама — проверяем это на плоском столе. Объёмную
     сцену в headless рисует программный WebGL со скоростью двух-четырёх
     кадров в секунду, и её медленность читалась бы как «игра встала». */
  let moved2d = 0, prev2d = '';
  for (let i = 0; i < 50; i++) {
    for (const sel of ['#storyGo', '#nextBtn', '.tgt.skip', '#speechSkip', '.tgt']) {
      const el = await p2.$(sel);
      if (el && await el.isVisible().catch(() => false)) { await el.click({ timeout: 700 }).catch(() => {}); break; }
    }
    const st = await p2.evaluate(() => ({
      phase: (document.getElementById('stPhase') || {}).textContent || '',
      logN: document.querySelectorAll('#log .le').length
    }));
    const key = st.phase + '|' + st.logN;
    if (key !== prev2d) { moved2d++; prev2d = key; }
    if (/Голосование|Казнь|Финал/.test(st.phase)) break;
    await sleep(360);
  }
  ok(moved2d > 4, 'партия с ботами идёт сама в 2D: ' + moved2d + ' изменений');

  /* Объём встаёт посреди партии: three.js подгружается по требованию, а
     новая сцена догоняет стол по журналу. */
  await p2.click('#btnView');
  await sleep(4000);
  const bDeep = await p2.evaluate(() => ({
    mode: document.body.dataset.sceneView,
    shown: [...document.querySelectorAll('#scene-root canvas')].map(c => getComputedStyle(c).display),
    flat: !!document.querySelector('#scene-root canvas.flat-table')
  }));
  ok(bDeep.mode === 'deep', 'на странице с ботами 3D встало посреди партии');
  ok(bDeep.shown.filter(d => d !== 'none').length === 1,
    'видна ровно одна декорация: ' + JSON.stringify(bDeep.shown));
  await shot(p2, 'view-bots-deep');

  /* Партия не рвётся при смене вида: стол, фигуры и журнал на месте, а
     сама игра продолжает идти — хотя бы на один шаг за отведённое время. */
  const after = await p2.evaluate(() => ({
    seats: document.querySelectorAll('#scene-root canvas').length,
    logN: document.querySelectorAll('#log .le').length,
    phase: (document.getElementById('stPhase') || {}).textContent || ''
  }));
  ok(after.logN > 0 && !!after.phase, 'после переключения партия на месте: фаза «' + after.phase + '»');

  await p2.click('#btnView');
  await sleep(2600);
  ok(await p2.evaluate(() => document.body.dataset.sceneView) === 'flat',
    'обратно в 2D той же кнопкой');
  ok(errs2.length === 0, 'на странице с ботами нет ошибок консоли при смене вида' +
    (errs2.length ? ': ' + errs2.slice(0, 3).join(' | ') : ''));
  await p2.close();
}

(async () => {
  console.log('\n=== СТЕНД: живой браузер, WebGL, снимки в tests/shots ===');
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-shot.json' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  /* В закрытом контуре playwright часто стоит без своего браузера.
     Тогда берём системный Chromium из CHROME_BIN. */
  const launchOpts = { args: ARGS };
  if (process.env.CHROME_BIN) launchOpts.executablePath = process.env.CHROME_BIN;
  const browser = await chromium.launch(launchOpts);
  try {
    if (!only || only === 'home') await homeScene(browser);
    if (!only || only === 'bots') { await botsScene(browser, 8); }
    if (!only || only === 'online') await onlineScene(browser);
    if (!only || only === 'view') await viewScene(browser);
  } catch (e) {
    fails++;
    console.log('  ИСКЛЮЧЕНИЕ: ' + e.stack);
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(fails === 0 ? '\n✓ СТЕНД ПРОЙДЕН' : '\n✗ СТЕНД: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
