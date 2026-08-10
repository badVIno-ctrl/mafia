/* =============================================================================
   Полный прогон реальной партии в браузере.
   Проверяется на каждой фазе:
     • ошибки в консоли (кроме ожидаемого оффлайн-CDN);
     • текст, уехавший за край экрана или обрезанный;
     • горизонтальная прокрутка;
     • битые символы;
     • слишком мелкий шрифт на телефоне;
     • маленькие зоны нажатия.
   ============================================================================= */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 8833;
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || '/data/shots';

/* Ожидаемые сетевые сбои: в закрытом контуре CDN недоступен — это ровно тот
   случай, ради которого сделана запасная сцена. Игра обязана работать. */
function expectedOffline(text){
  return /unpkg\.com|fonts\.googleapis|fonts\.gstatic|api\.mistral\.ai|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(text);
}

const VIEWPORTS = [
  { name: 'iPhone SE    320×568', width: 320, height: 568, mobile: true },
  { name: 'iPhone 12    390×844', width: 390, height: 844, mobile: true },
  { name: 'Pixel 7      412×915', width: 412, height: 915, mobile: true },
  { name: 'iPad         768×1024', width: 768, height: 1024, mobile: true },
  { name: 'Laptop      1280×800', width: 1280, height: 800, mobile: false },
  { name: 'Desktop     1920×1080', width: 1920, height: 1080, mobile: false }
];

const wait = ms => new Promise(r => setTimeout(r, ms));

async function startServer(){
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-e2eplay.json' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  /* Ждём не строку в логе, а реальный ответ по HTTP. */
  const deadline = Date.now() + 25000;
  for(;;){
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/bots.html`);
      if(r.ok) break;
    } catch(e){}
    if(Date.now() > deadline){ srv.kill(); throw new Error('server timeout'); }
    await wait(300);
  }
  return srv;
}

/* Зонд вёрстки — выполняется в странице */
const PROBE = (isMobile) => {
  const out = { overflow: [], tiny: [], smallTap: [], glyphs: 0, hScroll: false };
  const vw = window.innerWidth, vh = window.innerHeight;
  out.hScroll = document.documentElement.scrollWidth > vw + 1;

  const name = el => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

  const visible = el => {
    const cs = getComputedStyle(el);
    if(cs.display === 'none' || cs.visibility === 'hidden') return false;
    if(parseFloat(cs.opacity) < 0.05) return false;
    let p = el;
    while(p){
      const pc = getComputedStyle(p);
      if(pc.display === 'none' || pc.visibility === 'hidden') return false;
      if(parseFloat(pc.opacity) < 0.05) return false;
      p = p.parentElement;
    }
    return true;
  };

  document.querySelectorAll('body *').forEach(el => {
    if(el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'CANVAS') return;
    if(!visible(el)) return;
    const r = el.getBoundingClientRect();
    if(r.width < 1 || r.height < 1) return;
    const cs = getComputedStyle(el);

    /* выехал за боковой край экрана */
    if(r.right > vw + 1.5 || r.left < -1.5){
      out.overflow.push({ kind: 'out', el: name(el), left: Math.round(r.left), right: Math.round(r.right), vw });
    }
    /* текст обрезан по ширине без прокрутки и многоточия */
    const leaf = el.children.length === 0 && (el.textContent || '').trim().length > 0;
    if(leaf && el.scrollWidth > el.clientWidth + 2 &&
       cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis'){
      out.overflow.push({ kind: 'clip', el: name(el), sw: el.scrollWidth, cw: el.clientWidth,
        text: (el.textContent || '').trim().slice(0, 36) });
    }
    /* вертикальное обрезание текста */
    if(leaf && el.scrollHeight > el.clientHeight + 3 &&
       cs.overflowY === 'visible' && !/clip|ellipsis/.test(cs.textOverflow) &&
       cs.webkitLineClamp === 'none'){
      out.overflow.push({ kind: 'clipY', el: name(el), sh: el.scrollHeight, ch: el.clientHeight,
        text: (el.textContent || '').trim().slice(0, 36) });
    }
    /* читаемость на телефоне */
    if(leaf && isMobile){
      const fs = parseFloat(cs.fontSize);
      if(fs && fs < 10.5) out.tiny.push({ el: name(el), fs: +fs.toFixed(1), text: (el.textContent || '').trim().slice(0, 30) });
    }
    /* зона нажатия */
    if(isMobile && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')){
      if(r.height < 32 || r.width < 32){
        out.smallTap.push({ el: name(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
  });

  out.glyphs = ((document.body.innerText || '').match(/\uFFFD/g) || []).length;
  return out;
};

async function checkPhase(page, vp, label, agg){
  const res = await page.evaluate(PROBE, vp.mobile);
  res.overflow.forEach(o => agg.overflow.push({ phase: label, ...o }));
  res.tiny.forEach(o => agg.tiny.push({ phase: label, ...o }));
  res.smallTap.forEach(o => agg.smallTap.push({ phase: label, ...o }));
  agg.glyphs += res.glyphs;
  if(res.hScroll) agg.hScroll.push(label);
}

async function runViewport(browser, vp){
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.mobile ? 3 : 1,
    isMobile: vp.mobile, hasTouch: vp.mobile
  });
  const page = await ctx.newPage();
  const agg = { overflow: [], tiny: [], smallTap: [], glyphs: 0, hScroll: [], errors: [], phases: [] };

  page.on('console', m => {
    if(m.type() !== 'error') return;
    const t = m.text();
    if(!expectedOffline(t)) agg.errors.push(t);
  });
  page.on('pageerror', e => {
    if(!expectedOffline(e.message)) agg.errors.push('PAGEERROR: ' + e.message);
  });

  await page.goto(`http://127.0.0.1:${PORT}/bots.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#startscreen.on', { timeout: 20000 });
  await wait(700);

  const mode = await page.evaluate(() => document.body.dataset.sceneMode || '?');
  await checkPhase(page, vp, 'старт', agg);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-1-start.png` });

  /* Правила — самый текстовый экран */
  if(await page.locator('#btnRules').count()){
    await page.click('#btnRules').catch(() => {});
    await wait(500);
    await checkPhase(page, vp, 'правила', agg);
    await page.screenshot({ path: `${SHOTS}/${vp.width}-2-rules.png` });
    await page.click('#rulesClose').catch(() => {});
    await wait(350);
  }

  /* Быстрый темп + режим без сети — партия идёт на движке, без внешних запросов */
  await page.evaluate(() => {
    const off = document.querySelector('#optMode .opt[data-v="offline"]');
    if(off) off.click();
    const fast = document.querySelector('#optPace .pc[data-v="0.7"]');
    if(fast) fast.click();
  });
  await wait(200);

  const nameBox = page.locator('#fName');
  if(await nameBox.count() && await nameBox.isVisible().catch(() => false)){
    await nameBox.fill('Александра-Длинное').catch(() => {});
  }

  await page.click('#btnStart');
  await wait(2500);
  await checkPhase(page, vp, 'раздача карт', agg);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-3-deal.png` });

  /* Проходим партию: жмём «Дальше» / сюжетные кнопки, пока не конец */
  const seen = new Set();
  for(let step = 0; step < 150; step++){
    const clicked = await page.evaluate(() => {
      const vis = el => el && el.offsetParent !== null && !el.disabled;
      const order = ['#storyGo', '#nextBtn', '#speechSkip', '#showEndBtn'];
      for(const sel of order){
        const el = document.querySelector(sel);
        if(vis(el)){ el.click(); return sel; }
      }
      /* голосование / ночной выбор — берём первую цель */
      const tgt = document.querySelector('#bbBody .tgt:not(.dead)');
      if(vis(tgt)){ tgt.click(); return 'target'; }
      return null;
    });

    const phase = await page.evaluate(() => (document.querySelector('#stPhase') || {}).textContent || '');
    if(phase && !seen.has(phase)){
      seen.add(phase);
      await checkPhase(page, vp, 'фаза: ' + phase.trim(), agg);
      agg.phases.push(phase.trim());
      if(seen.size <= 6) await page.screenshot({ path: `${SHOTS}/${vp.width}-p${seen.size}.png` });
    }

    const over = await page.evaluate(() =>
      !!document.querySelector('#endOverlay.on, #endOverlay.show') ||
      ((document.querySelector('#stPhase') || {}).textContent || '').includes('Конец'));
    if(over) break;
    await wait(clicked ? 260 : 550);
  }

  await wait(800);
  await checkPhase(page, vp, 'финал', agg);
  await page.screenshot({ path: `${SHOTS}/${vp.width}-9-end.png` });

  await ctx.close();
  return { vp, mode, agg };
}

/* Путь к браузеру передаём только если файл существует: иначе playwright не
   может воспользоваться своим собственным Chromium (см. tests/e2e-modes.js). */
function launchOptions() {
  const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'] };
  const bin = process.env.CHROME_BIN || '/usr/local/bin/chromium';
  if (require('fs').existsSync(bin)) opts.executablePath = bin;
  return opts;
}

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch(launchOptions());

  let failures = 0;
  try {
    const only = process.env.VP_ONLY ? process.env.VP_ONLY.split(',').map(Number) : null;
    const list = only ? VIEWPORTS.filter(v => only.includes(v.width)) : VIEWPORTS;
    for(const vp of list){
      const { mode, agg } = await runViewport(browser, vp);
      const bad = agg.errors.length + agg.overflow.length + agg.tiny.length +
                  agg.smallTap.length + agg.glyphs + agg.hScroll.length;
      if(bad) failures++;
      console.log(`${bad ? '  \u2717' : '  \u2713'} ${vp.name}  сцена:${mode}  фаз:${agg.phases.length}` +
        `  ошибок:${agg.errors.length}  съехало:${agg.overflow.length}` +
        `  мелкого:${agg.tiny.length}  малых кнопок:${agg.smallTap.length}` +
        `  h-scroll:${agg.hScroll.length}  битых:${agg.glyphs}`);
      agg.errors.slice(0, 4).forEach(e => console.log('       ! ' + e.slice(0, 150)));
      agg.overflow.slice(0, 8).forEach(o => console.log('       → ' + JSON.stringify(o)));
      agg.tiny.slice(0, 6).forEach(o => console.log('       · мелко ' + JSON.stringify(o)));
      agg.smallTap.slice(0, 6).forEach(o => console.log('       · кнопка ' + JSON.stringify(o)));
      agg.hScroll.slice(0, 4).forEach(o => console.log('       · h-scroll на фазе: ' + o));
    }
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(failures ? `\n✗ Экранов с замечаниями: ${failures}` : '\n✅ ПОЛНЫЙ ПРОГОН ЧИСТЫЙ');
  process.exit(failures ? 1 : 0);
})();
