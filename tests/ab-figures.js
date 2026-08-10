/* =============================================================================
   ab-figures.js — слепое сравнение двух сборок человека.

   Сравниваются не пайплайны кадра (это делает tests/ab-compare.js), а сами
   фигуры: классическая, выросшая из примитивов, и скиннингованная из
   human.js — при одном свете, одной камерой, в одном пайплайне.

   Правило простое: два варианта фигуры снимаются одной камерой, при одном
   свете, в одном кадре — и складываются рядом в случайном порядке. Кто где,
   написано только в файле-ключе, который открывают ПОСЛЕ того, как выбор
   сделан. Иначе сравнение превращается в самообман: глаз всегда находит
   достоинства в том варианте, который считает своим.

       node tests/ab-figures.js            все виды
       node tests/ab-figures.js table,head только нужные
       node tests/ab-figures.js head key   показать ключ

   Кадры складываются в tests/shots/ab-<вид>.png, ключ — в tests/shots/ab-key.txt
   ============================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const VIEWS = (process.argv[2] || 'table,three,head,face,prof').split(',');
const PORT = process.env.AB_PORT ? Number(process.env.AB_PORT) : 8247;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'shots');

let chromium = null, sharp = null;
try { chromium = require('playwright').chromium; }
catch (e) {
  try { chromium = require(path.join(process.env.HOME || '/root', '.npm-global/lib/node_modules/playwright')).chromium; }
  catch (e2) { /* нет браузера */ }
}
try { sharp = require('sharp'); }
catch (e) {
  try { sharp = require(path.join(process.env.HOME || '/root', '.npm-global/lib/node_modules/sharp')); }
  catch (e2) { /* нет склейки */ }
}
if (!chromium) { console.log('Нет playwright — сравнение пропущено.'); process.exit(0); }

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--mute-audio'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), MAFIA_DATA: require('os').tmpdir() + '/mafia-test-users-ab.json'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server] ' + d));
  await sleep(900);

  const browser = await chromium.launch({ args: ARGS });
  const key = [];
  try {
    for (const view of VIEWS) {
      const size = /head|face|prof/.test(view) ? { width: 900, height: 900 } : { width: 1200, height: 800 };
      const shots = {};
      for (const variant of ['classic', 'skinned']) {
        const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
        const url = BASE + '/figure-lab.html?view=' + view +
          '&w=' + size.width + '&h=' + size.height + '&freeze=1' +
          (variant === 'skinned' ? '&rig=skinned' : '');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction('window.__labReady === true', { timeout: 45000 }).catch(() => { });
        await sleep(1500);
        shots[variant] = await page.screenshot();
        await page.close();
      }
      /* Случайный порядок: монетка от криптографического источника, чтобы её
         нельзя было угадать по номеру прогона. */
      const flipLeftIsNew = crypto.randomBytes(1)[0] % 2 === 0;
      const left = flipLeftIsNew ? shots['skinned'] : shots['classic'];
      const right = flipLeftIsNew ? shots['classic'] : shots['skinned'];
      const file = path.join(OUT, 'ab-' + view + '.png');
      if (sharp) {
        await sharp({
          create: {
            width: size.width * 2 + 12, height: size.height,
            channels: 3, background: { r: 12, g: 10, b: 11 }
          }
        }).composite([
          { input: left, left: 0, top: 0 },
          { input: right, left: size.width + 12, top: 0 }
        ]).png().toFile(file);
      } else {
        fs.writeFileSync(path.join(OUT, 'ab-' + view + '-A.png'), left);
        fs.writeFileSync(path.join(OUT, 'ab-' + view + '-B.png'), right);
      }
      key.push(view + ': слева ' + (flipLeftIsNew ? 'СКИННИНГ' : 'КЛАССИКА') +
        ', справа ' + (flipLeftIsNew ? 'КЛАССИКА' : 'СКИННИНГ'));
      console.log('  ab-' + view + '.png');
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  fs.writeFileSync(path.join(OUT, 'ab-key.txt'), key.join('\n') + '\n');
  console.log('\nКлюч записан в tests/shots/ab-key.txt — открывать после выбора.');
})();
