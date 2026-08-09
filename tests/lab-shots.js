/* =========================================================================
   Стенд фигур: снимает 3D-людей со всех сторон в настоящем браузере.

   Зачем. Всё, на что жалуется игрок — «руки висят в воздухе», «волосы как
   колбаска», «страшные лица» — видно только глазами. Стенд поднимает сервер,
   открывает /__lab.html в Chromium с программным WebGL и складывает снимки
   в tests/shots/lab-<метка>-<вид>.png. Дальше их смотрят и сравнивают.

       node tests/lab-shots.js before        — снять текущее состояние
       node tests/lab-shots.js after         — снять после правок
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TAG = process.argv[2] || 'now';
const VIEWS = (process.argv[3] || 'table,front,three,side,back,head,hands').split(',');
const PORT = process.env.LAB_PORT ? Number(process.env.LAB_PORT) : 8244;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'shots');

let chromium = null;
try { chromium = require('playwright').chromium; }
catch (e) {
  try { chromium = require(path.join(process.env.HOME || '/root', '.npm-global/lib/node_modules/playwright')).chromium; }
  catch (e2) { /* нет браузера — нет снимков */ }
}
if (!chromium) { console.log('Нет playwright — стенд пропущен.'); process.exit(0); }

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--mute-audio'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-lab.json'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server] ' + d));
  await sleep(800);

  const browser = await chromium.launch({ args: ARGS });
  try {
    for (const view of VIEWS) {
      const size = view === 'head' || view === 'hands'
        ? { width: 900, height: 900 }
        : { width: 1400, height: 900 };
      const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
      const errs = [];
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      page.on('pageerror', e => errs.push(String(e.message)));
      await page.goto(BASE + '/__lab.html?view=' + view +
        '&w=' + size.width + '&h=' + size.height +
        (process.env.LAB_PAINT ? '&paint=1' : '') +
        (process.env.LAB_ARGS ? '&' + process.env.LAB_ARGS : ''), { waitUntil: 'load' });
      await page.waitForFunction('window.__labReady === true', { timeout: 40000 }).catch(() => { });
      await sleep(1200);
      const file = path.join(OUT, 'lab-' + TAG + '-' + view + '.png');
      await page.screenshot({ path: file });
      console.log('  ' + path.basename(file) + (errs.length ? '  ОШИБКИ: ' + errs.join(' | ') : ''));
      await page.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
})();
