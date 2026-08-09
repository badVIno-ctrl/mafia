/* Playwright-прогон: запуск игры, ошибки консоли, переполнение текста */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 8791;
const ROOT = path.join(__dirname, '..');

const VIEWPORTS = [
  { name: 'iPhone SE   320x568', width: 320, height: 568, mobile: true },
  { name: 'iPhone 12   390x844', width: 390, height: 844, mobile: true },
  { name: 'Pixel 7     412x915', width: 412, height: 915, mobile: true },
  { name: 'iPad        768x1024', width: 768, height: 1024, mobile: true },
  { name: 'Laptop     1280x800', width: 1280, height: 800, mobile: false },
  { name: 'Desktop    1920x1080', width: 1920, height: 1080, mobile: false }
];

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

async function startServer(){
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-e2esmoke.json' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server timeout')), 8000);
    srv.stdout.on('data', d => { if(String(d).includes(String(PORT))){ clearTimeout(t); res(); } });
    srv.stderr.on('data', d => process.stderr.write(String(d)));
  });
  await wait(300);
  return srv;
}

/* Любой видимый элемент, выехавший за край экрана или обрезанный по ширине */
const OVERFLOW_PROBE = () => {
  const bad = [];
  const vw = window.innerWidth;
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if(cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return;
    const r = el.getBoundingClientRect();
    if(r.width === 0 || r.height === 0) return;
    const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '');
    if(r.right > vw + 1.5 || r.left < -1.5){
      bad.push({ kind: 'out-of-screen', tag, left: Math.round(r.left), right: Math.round(r.right), vw });
    }
    // горизонтальное обрезание текста без прокрутки/многоточия
    if(el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'visible' && el.children.length === 0){
      bad.push({ kind: 'clipped-text', tag, scrollW: el.scrollWidth, clientW: el.clientWidth,
        text: (el.textContent || '').trim().slice(0, 40) });
    }
  });
  return {
    bad,
    docScroll: document.documentElement.scrollWidth,
    vw,
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1
  };
};

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/local/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader']
  });
  let failures = 0;

  try {
    for(const vp of VIEWPORTS){
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.mobile ? 3 : 1,
        isMobile: vp.mobile, hasTouch: vp.mobile
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

      await page.goto(`http://127.0.0.1:${PORT}/bots.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#startscreen.on', { timeout: 15000 });
      await wait(900);

      const mode = await page.evaluate(() => document.body.dataset.sceneMode || '?');
      const res = await page.evaluate(OVERFLOW_PROBE);

      // битые символы в живом DOM
      const glyphs = await page.evaluate(() => (document.body.innerText.match(/\uFFFD/g) || []).length);

      const ok = errors.length === 0 && res.bad.length === 0 && !res.hScroll && glyphs === 0;
      if(!ok) failures++;
      console.log(`${ok ? '  \u2713' : '  \u2717'} ${vp.name}  сцена:${mode}` +
        `  ошибок:${errors.length}  съехавших:${res.bad.length}` +
        `  h-scroll:${res.hScroll ? 'ЕСТЬ' : 'нет'}  битых:${glyphs}`);
      if(errors.length) errors.slice(0, 5).forEach(e => console.log('      ! ' + e.slice(0, 160)));
      if(res.bad.length) res.bad.slice(0, 8).forEach(b => console.log('      → ' + JSON.stringify(b)));

      await page.screenshot({ path: `/data/shots/${vp.width}x${vp.height}-start.png` });
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(failures ? `\n✗ ПРОВАЛОВ: ${failures}` : '\n✅ ВСЕ ЭКРАНЫ ЧИСТЫЕ');
  process.exit(failures ? 1 : 0);
})();
