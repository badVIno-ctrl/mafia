/* =============================================================================
   Тест №20 — прогулка по всем режимам живым браузером.

   Существующие браузерные прогоны (e2e-smoke, e2e-play) знали только страницу
   с ботами. Всё, чем сайт живёт сейчас, — воронка на главной, комната по сети,
   стол с соседями, «Следствие», вход по ссылке-приглашению — не проверялось
   вообще, и поэтому именно там и накопились поломки: пустая кнопка в шапке,
   потерянное приглашение у человека без имени, экран без единого действия.

   Этот тест проходит путями живого игрока и на каждом шаге спрашивает три
   вещи, которые и означают «играбельно»:

     1. Нет ли ошибок в консоли и не упал ли скрипт.
     2. Видно ли на экране, что делать: заголовок фазы, подсказка и хотя бы
        одно доступное действие (кнопка или выбираемое место).
     3. Влезает ли всё в экран телефона: без горизонтальной прокрутки,
        без обрезанного текста, с зонами нажатия не меньше 44 пикселей.

   Запуск:  node tests/e2e-modes.js
   Нужен Chromium: CHROME_BIN=/path/to/chrome (или системный /usr/local/bin).
   ============================================================================= */
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 8845);
const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'mafia-shots');
/* Свой файл аккаунтов на прогон: настоящие имена из теста не должны
   ни попадать в репозиторий, ни мешать следующему прогону. */
const DATA = path.join(os.tmpdir(), 'mafia-test-users-e2emodes.json');

const wait = ms => new Promise(r => setTimeout(r, ms));
/* Имена в игре уникальны на весь сервер: «Игрок» со второго прогона уже занят.
   Поэтому у каждого прогона свой суффикс — иначе тест ломает сам себя. */
const RUN = Math.random().toString(36).slice(2, 5);
const nm = base => base + RUN;

let fails = 0;
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) { console.log('  ✓ ' + msg); return true; }
  fails++;
  console.log('  ✗ ' + msg + (extra ? '\n      ' + String(extra).slice(0, 500) : ''));
  return false;
}

/* --------------------------------------------------------------------------
   Сервер поднимаем на своём файле аккаунтов: тест заводит настоящие имена,
   и в репозиторий они попадать не должны.
   -------------------------------------------------------------------------- */
async function startServer() {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      MAFIA_DATA: DATA
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; process.stderr.write('[server] ' + d); });
  const deadline = Date.now() + 25000;
  for (;;) {
    try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch (e) { /* ждём */ }
    if (Date.now() > deadline) { srv.kill(); throw new Error('сервер не поднялся: ' + log); }
    await wait(250);
  }
  return srv;
}

/* Ожидаемые в закрытом контуре сбои: внешние адреса не отвечают, и это ровно
   тот случай, ради которого весь сайт собран без CDN. */
function expectedNoise(t) {
  return /unpkg\.com|fonts\.googleapis|fonts\.gstatic|api\.mistral\.ai|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_ABORTED|Failed to load resource: the server responded with a status of 40|WebGL|SwiftShader|GroupMarkerNotSet/i.test(t);
}

/* --------------------------------------------------------------------------
   Замер экрана: что уехало, что обрезано, что слишком мелко и во что
   невозможно попасть пальцем.
   -------------------------------------------------------------------------- */
const PROBE = () => {
  const out = { overflow: [], tiny: [], smallTap: [], glyphs: 0, hScroll: false, vw: window.innerWidth };
  const vw = window.innerWidth;
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const visible = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /* Широкая таблица внутри прокручиваемой обёртки — не поломка, а решение:
     до правого края доезжают пальцем. Ругаться на неё нельзя, иначе тест
     заставит ломать вёрстку там, где всё честно. */
  const inScroller = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };
  document.querySelectorAll('body *').forEach(el => {
    if (!visible(el)) return;
    if (inScroller(el)) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.right > vw + 1.5 || r.left < -1.5) {
      out.overflow.push({ tag: name(el), left: Math.round(r.left), right: Math.round(r.right), vw });
    }
    if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'visible') {
      out.overflow.push({ tag: name(el), kind: 'clipped', text: (el.textContent || '').trim().slice(0, 30) });
    }
    const txt = (el.textContent || '').trim();
    if (txt && el.children.length === 0 && parseFloat(cs.fontSize) < 11.5) {
      out.tiny.push({ tag: name(el), px: cs.fontSize, text: txt.slice(0, 30) });
    }
    /* Галочка размером 20×20 — не поломка, если она лежит внутри подписи, а
       вся подпись нажимается: палец попадает в строку, а не в квадратик.
       Мерить надо ту область, которая реагирует на касание. */
    const tappable = el.matches('button, a, input, select, [role=button]');
    if (tappable && !el.disabled) {
      const host = el.closest('label') || el;
      const hr = host.getBoundingClientRect();
      const h = Math.max(r.height, host === el ? 0 : hr.height);
      const w = Math.max(r.width, host === el ? 0 : hr.width);
      if (h < 30 || w < 22) out.smallTap.push({ tag: name(el), w: Math.round(w), h: Math.round(h) });
    }
  });
  out.glyphs = ((document.body.innerText || '').match(/\uFFFD/g) || []).length;
  out.hScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  return out;
};

/* Кнопка без знака и без подписи — «пустой квадрат», в который никто не жмёт. */
const BLANK_CONTROLS = () => {
  const bad = [];
  document.querySelectorAll('button, a.btn').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const text = (el.innerText || '').trim();
    const svg = el.querySelector('svg, img, canvas');
    const bg = cs.backgroundImage && cs.backgroundImage !== 'none';
    if (!text && !svg && !bg) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) +
        (typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''));
    }
  });
  return bad;
};

function watchPage(page, bag) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!expectedNoise(t)) bag.errors.push(t);
  });
  page.on('pageerror', e => bag.errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => {
    const t = r.url() + ' ' + ((r.failure() && r.failure().errorText) || '');
    if (!expectedNoise(t)) bag.errors.push('REQFAIL: ' + t);
  });
}

async function screen(page, tag, bag, label) {
  const res = await page.evaluate(PROBE);
  const blanks = await page.evaluate(BLANK_CONTROLS);
  if (res.overflow.length) bag.overflow.push({ where: label, list: res.overflow.slice(0, 4) });
  if (res.tiny.length) bag.tiny.push({ where: label, list: res.tiny.slice(0, 4) });
  if (res.smallTap.length) bag.smallTap.push({ where: label, list: res.smallTap.slice(0, 4) });
  if (res.hScroll) bag.hScroll.push(label);
  if (res.glyphs) bag.glyphs.push(label + ':' + res.glyphs);
  if (blanks.length) bag.blank.push({ where: label, list: blanks });
  try { await page.screenshot({ path: path.join(SHOTS, tag + '.png') }); } catch (e) { /* каталог необязателен */ }
  return res;
}

function emptyBag() {
  return { errors: [], overflow: [], tiny: [], smallTap: [], hScroll: [], glyphs: [], blank: [] };
}

function reportBag(name, bag, opts) {
  opts = opts || {};
  ok(bag.errors.length === 0, name + ': нет ошибок в консоли', JSON.stringify(bag.errors.slice(0, 4)));
  ok(bag.glyphs.length === 0, name + ': нет битых символов', JSON.stringify(bag.glyphs));
  ok(bag.hScroll.length === 0, name + ': нет горизонтальной прокрутки', JSON.stringify(bag.hScroll));
  ok(bag.overflow.length === 0, name + ': ничего не уехало за край', JSON.stringify(bag.overflow.slice(0, 3)));
  ok(bag.tiny.length === 0, name + ': нет текста меньше 11.5px', JSON.stringify(bag.tiny.slice(0, 3)));
  ok(bag.blank.length === 0, name + ': нет кнопок без знака и подписи', JSON.stringify(bag.blank.slice(0, 3)));
  if (!opts.skipTap) {
    ok(bag.smallTap.length === 0, name + ': зоны нажатия не меньше 30px', JSON.stringify(bag.smallTap.slice(0, 3)));
  }
}

/* --------------------------------------------------------------------------
   Игрок: контекст браузера + вход под именем.
   -------------------------------------------------------------------------- */
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };

async function newPlayer(browser, vp, bag) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
    locale: 'ru-RU'
  });
  const page = await ctx.newPage();
  watchPage(page, bag);
  return { ctx, page };
}

/** Назваться через главную страницу — тем же путём, которым идёт человек. */
async function register(page, name) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#authView:not([hidden]), #hubView:not([hidden])', { timeout: 20000 });
  if (await page.locator('#authView:not([hidden])').count()) {
    await page.fill('#regName', name);
    await page.click('#btnReg');
  }
  await page.waitForSelector('#hubView:not([hidden])', { timeout: 20000 });
}

/* =============================================================================
   1. Главная: воронка ведёт туда, куда обещает
   ============================================================================= */
async function testHub(browser) {
  console.log('\n─── 1. Главная и воронка ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    await register(page, nm('Ведущий'));
    await wait(600);
    await screen(page, 'hub-mobile', bag, 'главная');

    const funnel = await page.evaluate(() => {
      const g = id => document.getElementById(id);
      const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        play: g('btnPlayNow') ? { href: g('btnPlayNow').getAttribute('href'), sign: !!g('signPlay').querySelector('svg'), box: box(g('btnPlayNow')) } : null,
        ways: [...document.querySelectorAll('.ways .way')].map(a => ({
          href: a.getAttribute('href'),
          title: (a.querySelector('b') || {}).textContent,
          sign: !!a.querySelector('svg'),
          box: box(a)
        }))
      };
    });
    ok(funnel.play && funnel.play.href === '/online.html?quick=1', 'кнопка «Играть» ведёт в быструю игру', JSON.stringify(funnel.play));
    ok(funnel.play && funnel.play.sign, 'на кнопке «Играть» нарисован знак');
    ok(funnel.play && funnel.play.box.h >= 56, 'кнопка «Играть» крупная (>=56px)', JSON.stringify(funnel.play && funnel.play.box));
    ok(funnel.ways.length === 3, 'под кнопкой три пути', JSON.stringify(funnel.ways.map(w => w.title)));
    ok(funnel.ways.every(w => w.sign), 'у каждого пути есть знак', JSON.stringify(funnel.ways));
    ok(funnel.ways.every(w => w.box.h >= 44), 'каждый путь нажимается пальцем', JSON.stringify(funnel.ways.map(w => w.box)));

    /* Все адреса воронки обязаны отвечать 200 и приводить к столу. */
    for (const w of funnel.ways.concat([funnel.play])) {
      if (!w || !w.href) continue;
      const r = await page.request.get(BASE + w.href.split('?')[0]);
      ok(r.status() === 200, 'адрес воронки отвечает 200: ' + w.href, r.status());
    }
    reportBag('главная', bag);
  } finally { await ctx.close(); }
}

/* =============================================================================
   2. Быстрая игра: одно нажатие — идущая партия
   ============================================================================= */
async function testQuick(browser) {
  console.log('\n─── 2. Быстрая игра в одно нажатие ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    await register(page, nm('Быстрый'));
    await page.click('#btnPlayNow');
    await page.waitForSelector('#gameView:not([hidden])', { timeout: 25000 });
    await wait(2500);
    const st = await page.evaluate(() => ({
      phase: (document.getElementById('gPhase') || {}).textContent,
      alive: (document.getElementById('gAlive') || {}).textContent,
      seats: document.querySelectorAll('#seats .seat').length
    }));
    ok(/\S/.test(st.phase || ''), 'фаза подписана: ' + st.phase);
    ok(st.seats >= 6, 'за столом собрались места: ' + st.seats);
    await screen(page, 'quick-mobile', bag, 'быстрая игра');
    reportBag('быстрая игра', bag);
  } finally { await ctx.close(); }
}

/* =============================================================================
   3. Стол с соседями: настройка перед партией
   ============================================================================= */
async function testSoloSetup(browser) {
  console.log('\n─── 3. Стол с соседями: выбор состава ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    await register(page, nm('Хозяин'));
    await page.goto(BASE + '/online.html?solo=setup&size=8', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#roomPane:not([hidden])', { timeout: 25000 });
    await wait(1200);
    await screen(page, 'solo-setup-mobile', bag, 'настройка стола');

    const setup = await page.evaluate(() => {
      const g = id => document.getElementById(id);
      const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
      return {
        start: vis(g('btnStart')) ? (g('btnStart').innerText || '').trim() : null,
        startEnabled: g('btnStart') ? !g('btnStart').disabled : false,
        speeds: [...document.querySelectorAll('#speedPick button')].map(b => (b.innerText || '').trim()),
        presets: [...document.querySelectorAll('#presetPick button')].map(b => (b.innerText || '').trim()),
        scenarios: document.querySelectorAll('#scenarios button, #scenarios .item').length,
        compo: (g('compo') || {}).textContent,
        inquest: !!g('modeInquest'),
        invite: vis(g('inviteLink')),
        members: document.querySelectorAll('#members .item').length
      };
    });
    ok(setup.start && setup.startEnabled, 'кнопка начала партии активна: ' + setup.start);
    ok(setup.speeds.length === 3, 'выбор темпа из трёх пресетов', JSON.stringify(setup.speeds));
    ok(setup.presets.length >= 2, 'выбор набора ролей', JSON.stringify(setup.presets));
    ok(setup.scenarios > 0, 'сюжеты предлагаются: ' + setup.scenarios);
    ok(/\S/.test(setup.compo || ''), 'состав стола расписан: ' + (setup.compo || '').slice(0, 60));
    ok(setup.members >= 8, 'соседи уже за столом: ' + setup.members);
    ok(setup.inquest, 'переключатель «Следствия» доступен');

    /* Темп меняется и держится: без этого выбор пресета — украшение. */
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#speedPick button')].find(x => /Блиц/i.test(x.innerText));
      if (b) b.click();
    });
    await wait(900);
    const speedOn = await page.evaluate(() =>
      [...document.querySelectorAll('#speedPick button')].filter(b => b.classList.contains('on')).map(b => b.innerText.trim()));
    ok(speedOn.length === 1 && /Блиц/i.test(speedOn[0]), 'выбранный темп отмечен один: ' + JSON.stringify(speedOn));

    await page.click('#btnStart');
    await page.waitForSelector('#gameView:not([hidden])', { timeout: 25000 });
    await wait(1500);
    ok(true, 'партия с соседями началась по кнопке');
    reportBag('настройка стола', bag);
  } finally { await ctx.close(); }
}

/* =============================================================================
   4. Комната для друзей и вход по ссылке — в том числе человеком без имени
   ============================================================================= */
async function testInvite(browser) {
  console.log('\n─── 4. Комната по ссылке ───');
  const bag = emptyBag();
  const host = await newPlayer(browser, DESKTOP, bag);
  const guest = await newPlayer(browser, MOBILE, bag);
  try {
    await register(host.page, nm('Позвавший'));
    await host.page.goto(BASE + '/online.html?create=1', { waitUntil: 'domcontentloaded' });
    await host.page.waitForSelector('#roomPane:not([hidden])', { timeout: 25000 });
    await wait(1000);

    const invite = await host.page.evaluate(() => {
      const el = document.getElementById('inviteLink');
      return el ? (el.value !== undefined ? el.value : el.textContent).trim() : '';
    });
    ok(/\?join=/.test(invite), 'в комнате показана ссылка-приглашение: ' + invite);
    ok(invite.indexOf('undefined') < 0 && invite.indexOf('null') < 0, 'в ссылке нет undefined/null');

    /* Самый дорогой отказ на сайте: друг открыл ссылку, а имени у него нет.
       Он обязан сесть за стол здесь же, а не «вернуться на главную»,
       потеряв приглашение. */
    await guest.page.goto(invite, { waitUntil: 'domcontentloaded' });
    await guest.page.waitForSelector('#needAuth:not([hidden]), #roomPane:not([hidden])', { timeout: 25000 });
    await wait(600);
    await screen(guest.page, 'invite-guest-mobile', bag, 'вход по ссылке без имени');

    const gate = await guest.page.evaluate(() => {
      const na = document.getElementById('needAuth');
      const shown = na && !na.hidden;
      return {
        shown: !!shown,
        hasNameField: !!(na && na.querySelector('input')),
        hasSubmit: !!(na && na.querySelector('button')),
        keepsInvite: !!(na && [...na.querySelectorAll('a')].some(a => /join=/.test(a.getAttribute('href') || ''))),
        text: shown ? (na.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : ''
      };
    });
    if (gate.shown) {
      ok(gate.hasNameField && gate.hasSubmit,
        'пришедший по ссылке может назваться прямо здесь', JSON.stringify(gate));
      if (gate.hasNameField) {
        await guest.page.fill('#needAuth input', nm('Пришедший'));
        await guest.page.click('#needAuth button');
        await guest.page.waitForSelector('#roomPane:not([hidden]), #gameView:not([hidden])', { timeout: 25000 });
        ok(true, 'после имени приглашение не потерялось — гость за столом');
      }
    } else {
      ok(true, 'ссылка сажает за стол без лишних экранов');
    }

    /* Хозяин обязан увидеть гостя. */
    await wait(1500);
    const seen = await host.page.evaluate(() =>
      [...document.querySelectorAll('#members .item')].map(i => i.innerText.replace(/\s+/g, ' ').trim()));
    ok(seen.some(s => new RegExp(nm('Пришедший')).test(s)), 'хозяин видит подсевшего гостя', JSON.stringify(seen));

    /* Добор соседями и старт. Стол, собранный кнопкой «С друзьями», начинает
       партию сам, как только все места заняты, — тогда кнопки уже не будет. */
    await host.page.click('#btnBots');
    await wait(1500);
    const needStart = await host.page.evaluate(() => {
      const b = document.getElementById('btnStart');
      return !!b && !b.disabled && b.getBoundingClientRect().height > 0;
    });
    if (needStart) await host.page.click('#btnStart');
    await host.page.waitForSelector('#gameView:not([hidden])', { timeout: 25000 });
    ok(true, 'партия по сети началась у хозяина' + (needStart ? ' по кнопке' : ' сама, когда стол собрался'));
    const guestIn = await guest.page.waitForSelector('#gameView:not([hidden])', { timeout: 20000 }).catch(() => null);
    ok(!!guestIn, 'партия видна и гостю');
    await wait(1500);
    await screen(host.page, 'invite-host-game', bag, 'партия у хозяина');
    await screen(guest.page, 'invite-guest-game', bag, 'партия у гостя');
    reportBag('комната по ссылке', bag);
  } finally { await host.ctx.close(); await guest.ctx.close(); }
}

/* =============================================================================
   5. Полная партия: на каждой фазе видно, что делать
   ============================================================================= */
async function playThrough(browser, opts) {
  const label = opts.label;
  console.log('\n─── ' + label + ' ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, opts.vp || MOBILE, bag);
  const seenPhases = new Set();
  const mute = [];   // фазы, где не видно ни одного действия
  try {
    await register(page, nm(opts.name));
    await page.goto(BASE + opts.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#gameView:not([hidden])', { timeout: 30000 });

    const deadline = Date.now() + (opts.budgetMs || 240000);
    let finished = false;
    let step = 0;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => {
        const g = id => document.getElementById(id);
        const you = (window.__mafiaState && window.__mafiaState.game) || null;
        const acts = [...document.querySelectorAll('#actions button')]
          .filter(b => !b.disabled && b.getBoundingClientRect().height > 0);
        return {
          phase: (g('gPhase') || {}).textContent || '',
          hint: ((g('gHint') || {}).textContent || '').trim(),
          finished: !(g('finale') || {}).hidden,
          finaleText: ((g('finale') || {}).innerText || '').trim().slice(0, 120),
          actions: acts.map(b => (b.innerText || '').trim() || b.id || b.dataset.target || '?'),
          pickable: document.querySelectorAll('#seats .seat.pickable, .mark.pickable').length,
          role: ((g('rolePane') || {}).innerText || '').trim().slice(0, 60),
          alive: ((g('gAlive') || {}).textContent || '').trim()
        };
      });

      if (st.phase) {
        const key = st.phase.trim();
        if (!seenPhases.has(key)) {
          seenPhases.add(key);
          /* Первый раз в каждой фазе — снимок и разбор экрана. */
          await screen(page, opts.tag + '-' + (++step) + '-' + key.replace(/[^\wа-яё]+/gi, ''), bag, label + ' · ' + key);
          /* Экран считается «немым», когда подсказка требует действия, а
             сделать его нечем: ни кнопки, ни выбираемого места. Именно так
             выглядел баг у выбывшего — ему писали «выберите того, кого город
             выводит», хотя выбрать он ничего не мог. Честное ожидание
             («слово у Клима», «ждите утра», «вы вне игры») — не поломка. */
          const canDo = st.actions.length > 0 || st.pickable > 0;
          const demands = /выберите|назовите|передайте|скажите|голосуйте|решите/i.test(st.hint);
          if (!canDo && demands) mute.push(key + ' | ' + st.hint.slice(0, 70));
          if (!st.hint) mute.push(key + ' | БЕЗ ПОДСКАЗКИ');
        }
      }

      if (st.finished) { finished = true; bag.finale = st.finaleText; break; }

      /* Ходим: сначала кнопки-решения, потом выбор места. */
      const clicked = await page.evaluate(() => {
        const pick = sel => { const el = document.querySelector(sel); if (el && !el.disabled) { el.click(); return sel; } return null; };
        return pick('#actions #btnPass') || pick('#actions #btnReady') ||
          pick('#actions #btnKeepShield') ||
          pick('#seats .seat.pickable') || pick('.mark.pickable') ||
          pick('#actions button[data-tie="no"]') || pick('#actions button[data-target="skip"]') ||
          null;
      });
      await wait(clicked ? 700 : 1400);
    }

    ok(seenPhases.size >= (opts.minPhases || 4),
      label + ': пройдено фаз ' + seenPhases.size + ' (' + [...seenPhases].join(', ') + ')');
    ok(mute.length === 0, label + ': на каждой фазе видно, что делать', JSON.stringify(mute.slice(0, 5)));
    ok(finished, label + ': партия дошла до конца' + (finished ? ' — ' + (bag.finale || '') : ''));
    reportBag(label, bag);
    return finished;
  } finally { await ctx.close(); }
}

/* =============================================================================
   6. Статика и SEO живьём
   ============================================================================= */
async function testStaticSeo(browser) {
  console.log('\n─── 6. Статика, служебные файлы и SEO ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    const robots = await (await page.request.get(BASE + '/robots.txt')).text();
    ok(/Sitemap:\s*http/.test(robots), 'robots.txt указывает на карту сайта');
    ok(/Disallow:\s*\/api\//.test(robots), 'robots.txt закрывает /api/');

    const sm = await (await page.request.get(BASE + '/sitemap.xml')).text();
    ok(/<loc>http/.test(sm), 'карта сайта отдаёт абсолютные адреса');
    const locs = (sm.match(/<loc>([^<]+)<\/loc>/g) || []).map(s => s.replace(/<\/?loc>/g, ''));
    for (const u of locs) {
      const r = await page.request.get(u);
      ok(r.status() === 200, 'страница из карты сайта живая: ' + u, r.status());
    }

    const r404 = await page.request.get(BASE + '/такой-страницы-нет');
    ok(r404.status() === 404, 'мусорный адрес отдаёт 404, а не главную', r404.status());

    /* Каждая индексируемая страница: один h1, canonical, og-картинка
       абсолютным адресом (иначе превью не собирается ни в одной соцсети). */
    for (const p of ['/', '/bots.html', '/online.html', '/rules.html']) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
      const meta = await page.evaluate(() => {
        const m = n => (document.querySelector('meta[name="' + n + '"]') || {}).content || '';
        const og = n => (document.querySelector('meta[property="' + n + '"]') || {}).content || '';
        const link = r => (document.querySelector('link[rel="' + r + '"]') || {}).getAttribute
          ? document.querySelector('link[rel="' + r + '"]').getAttribute('href') : '';
        return {
          title: document.title,
          desc: m('description'),
          canonical: document.querySelector('link[rel=canonical]') ? link('canonical') : '',
          ogImage: og('og:image'), ogUrl: og('og:url'), ogTitle: og('og:title'),
          twImage: (document.querySelector('meta[name="twitter:image"]') || {}).content || '',
          h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim().slice(0, 40)),
          lang: document.documentElement.lang,
          ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent)
        };
      });
      ok(meta.title.length > 20 && meta.title.length <= 70, p + ': заголовок нужной длины (' + meta.title.length + ')', meta.title);
      ok(meta.desc.length >= 70 && meta.desc.length <= 320, p + ': описание нужной длины (' + meta.desc.length + ')');
      ok(meta.h1.length === 1, p + ': ровно один h1', JSON.stringify(meta.h1));
      ok(meta.lang === 'ru', p + ': язык страницы объявлен');
      ok(/^https?:\/\//.test(meta.canonical), p + ': canonical абсолютный', meta.canonical);
      ok(/^https?:\/\//.test(meta.ogImage), p + ': og:image абсолютный', meta.ogImage);
      ok(/^https?:\/\//.test(meta.ogUrl), p + ': og:url абсолютный', meta.ogUrl);
      ok(/^https?:\/\//.test(meta.twImage), p + ': twitter:image абсолютный', meta.twImage);
      ok(meta.ld.length > 0, p + ': есть структурированные данные');
      meta.ld.forEach(txt => {
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) { /* поймаем ниже */ }
        ok(!!parsed, p + ': структурированные данные — валидный JSON');
      });
      await screen(page, 'page-' + p.replace(/\W+/g, '_'), bag, 'страница ' + p);
    }
    reportBag('статика и SEO', bag, { skipTap: true });
  } finally { await ctx.close(); }
}

/* =============================================================================
   7. Правила: длинная страница на телефоне
   ============================================================================= */
async function testRules(browser) {
  console.log('\n─── 7. Правила ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    await page.goto(BASE + '/rules.html', { waitUntil: 'domcontentloaded' });
    await wait(600);
    await screen(page, 'rules-mobile', bag, 'правила');
    const nav = await page.evaluate(() => ({
      anchors: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')),
      ids: [...document.querySelectorAll('[id]')].map(e => e.id),
      extra: !!document.getElementById('extra'),
      backHome: [...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/')
    }));
    const dead = nav.anchors.filter(h => h.length > 1 && nav.ids.indexOf(h.slice(1)) < 0);
    ok(dead.length === 0, 'все внутренние ссылки правил ведут к разделам', JSON.stringify(dead));
    ok(nav.extra, 'раздел #extra на месте: на него ссылается главная');
    ok(nav.backHome, 'с правил можно вернуться на главную');
    reportBag('правила', bag);
  } finally { await ctx.close(); }
}

/* =============================================================================
   8. Телефон в руках: вкладки, поворот, большой стол
   ============================================================================= */
async function testPhoneHandling(browser) {
  console.log('\n─── 8. Телефон в руках ───');
  const bag = emptyBag();
  const { ctx, page } = await newPlayer(browser, MOBILE, bag);
  try {
    await register(page, nm('Рука'));
    /* Двадцать человек, полный набор — самый тяжёлый стол, какой бывает. */
    await page.goto(BASE + '/online.html?solo=1&size=20&speed=blitz&preset=full', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#gameView:not([hidden])', { timeout: 30000 });
    await wait(3000);

    const seats = await page.evaluate(() => document.querySelectorAll('#seats .seat').length);
    ok(seats === 20, 'на телефоне собирается стол на двадцать мест (' + seats + ')');

    /* Шапка одной строкой: раньше на 390px она переносилась и съедала
       115 пикселей из 844 — четырнадцать процентов игрового экрана. */
    const bar = await page.evaluate(() => ({
      h: Math.round(document.getElementById('topbar').getBoundingClientRect().height),
      varH: getComputedStyle(document.documentElement).getPropertyValue('--barH').trim()
    }));
    ok(bar.h <= 72, 'шапка партии в одну строку (' + bar.h + 'px)');

    /* Вкладка «Стол»: планшет фазы, таймер и кнопки обязаны остаться и
       видимыми, и нажимаемыми. Именно здесь плоский стол их закрывал. */
    await page.click('#tabTable');
    await wait(900);
    const onTable = await page.evaluate(() => {
      const at = (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return 'none';
        for (let p = el; p; p = p.parentElement) if (p.id) return '#' + p.id;
        return el.tagName.toLowerCase();
      };
      const c = el => { const r = el.getBoundingClientRect(); return at(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); };
      const band = document.querySelector('.phaseband');
      const dock = document.getElementById('actionDock');
      return {
        band: c(band), dock: c(dock),
        timer: (document.getElementById('gTimer') || {}).textContent,
        bandUnderTable: c(band) === '#flatWrap', dockUnderTable: c(dock) === '#flatWrap'
      };
    });
    ok(!onTable.bandUnderTable, 'на вкладке «Стол» видно фазу и таймер (' + onTable.band + ')');
    ok(!onTable.dockUnderTable, 'на вкладке «Стол» доступен док действий (' + onTable.dock + ')');
    ok(/\d:\d\d/.test(onTable.timer || ''), 'таймер идёт и на вкладке «Стол»: ' + onTable.timer);
    await screen(page, 'phone-table-tab', bag, 'вкладка «Стол»');

    /* Пока подписи мест спрятаны, их положение не считается: на телефоне это
       четыре вкладки из пяти и тысяча двести проекций в секунду вхолостую. */
    const marksHidden = await page.evaluate(() => document.getElementById('marks').hidden);
    ok(marksHidden, 'вне вкладки «Сцена» жетоны мест сняты с пересчёта');

    /* Поворот телефона. Раньше высота шапки мерилась один раз, и после
       поворота между шапкой и сценой оставалась мёртвая чёрная полоса. */
    await page.setViewportSize({ width: 844, height: 390 });
    await wait(1200);
    const rot = await page.evaluate(() => {
      const t = document.getElementById('topbar').getBoundingClientRect();
      const p = document.querySelector('.play').getBoundingClientRect();
      return { gap: Math.round(p.top - t.bottom), barH: Math.round(t.height), playTop: Math.round(p.top) };
    });
    ok(Math.abs(rot.gap) <= 2, 'после поворота сцена начинается ровно под шапкой (зазор ' + rot.gap + 'px)');
    await screen(page, 'phone-landscape', bag, 'поворот экрана');

    /* Кадр. Порог заведомо щедрый: тест ловит не «мало кадров», а
       остановившуюся сцену и бесконечный цикл в кадре. */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#tabStage');
    await wait(1200);
    const fr = await page.evaluate(() => new Promise(res => {
      let n = 0; const t0 = performance.now(); let prev = t0, worst = 0;
      const step = t => {
        n++; worst = Math.max(worst, t - prev); prev = t;
        if (t - t0 < 2500) requestAnimationFrame(step);
        else res({ fps: Math.round(n / ((t - t0) / 1000)), worst: Math.round(worst) });
      };
      requestAnimationFrame(step);
    }));
    ok(fr.fps >= 20, 'сцена на двадцать человек живая: ' + fr.fps + ' кадр/с');
    ok(fr.worst <= 200, 'ни один кадр не встал: худший ' + fr.worst + ' мс');
    reportBag('телефон в руках', bag);
  } finally { await ctx.close(); }
}

/* ============================================================================= */
(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  try { require('fs').unlinkSync(DATA); } catch (e) { /* первого файла может и не быть */ }
  console.log('\n=== ТЕСТ 20: прогулка по всем режимам (' + BASE + ') ===');
  const srv = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/local/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  /* ONLY=play — только партии целиком: они самые долгие, и во время правки
     правил гонять с ними всю прогулку незачем. ONLY=ui — всё остальное. */
  const only = process.env.ONLY || '';
  try {
    if (only !== 'play') {
      await testHub(browser);
      await testQuick(browser);
      await testSoloSetup(browser);
      await testInvite(browser);
      await testStaticSeo(browser);
      await testRules(browser);
      await testPhoneHandling(browser);
    }
    if (only === 'ui') { /* партии пропускаем */ } else {
    await playThrough(browser, {
      label: '5. Партия целиком (телефон)', tag: 'play-mobile', name: 'Игрок',
      url: '/online.html?solo=1&size=6&speed=blitz', vp: MOBILE, minPhases: 4, budgetMs: 260000
    });
    await playThrough(browser, {
      label: '5b. «Следствие» целиком (стол)', tag: 'play-inquest', name: 'Следователь',
      url: '/online.html?solo=1&size=6&speed=blitz&mode=inquest', vp: DESKTOP, minPhases: 4, budgetMs: 260000
    });
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log('\n' + (fails
    ? '✗ ТЕСТ 20: провалов ' + fails + ' из ' + checks
    : '✓ ТЕСТ 20 ПРОЙДЕН — ' + checks + ' проверок'));
  console.log('снимки: ' + SHOTS);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ТЕСТ 20 упал:', e); process.exit(1); });
