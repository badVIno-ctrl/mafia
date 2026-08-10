/* =========================================================================
   Слепое сравнение: снимает пары «старый / новый рендер» и складывает в
   tests/shots/ab-*.png. Какой вариант слева — решает номер пары, ответ
   пишется в tests/shots/ab-answers.json, но не на самих снимках.

       node tests/ab-compare.js                 — весь набор
       node tests/ab-compare.js head,face       — только эти виды

   Порядок работы, ради которого стенд и существует: сначала смотришь на
   снимки, не читая ответов, выбираешь, какая половина лучше, и только потом
   сверяешься с файлом ответов. Если «лучше» оказалось старым — правка была
   не улучшением, сколько бы в неё ни вложили.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.AB_PORT ? Number(process.env.AB_PORT) : 8252;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, 'shots');

let chromium = null;
for (const p of ['playwright', path.join(os.homedir(), '.npm-global/lib/node_modules/playwright')]) {
  try { chromium = require(p).chromium; break; } catch (e) { /* дальше */ }
}
if (!chromium) { console.log('Нет playwright — стенд пропущен.'); process.exit(0); }

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--mute-audio'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Набор сцен для сравнения. Каждая проверяет свой вопрос:
     face  — кожа и глаза в упор: главный вопрос «человек или пластик»;
     head  — голова с полуметра: как читается объём лица;
     table — стол целиком: как выглядит компания и свет в комнате;
     three — вид из-за плеча, ночь: держит ли кадр темноту;
     vote  — голосование: руки вверх и жёсткий свет.  */
const SCENES = [
  { name: 'face', view: 'face', phase: 'day', seed: 3, n: 1, w: 1200, h: 760 },
  { name: 'head', view: 'head', phase: 'day', seed: 5, n: 1, w: 1200, h: 760 },
  { name: 'head-night', view: 'head', phase: 'night', seed: 5, n: 1, w: 1200, h: 760 },
  { name: 'table', view: 'table', phase: 'day', seed: 2, n: 8, w: 1600, h: 760 },
  { name: 'three-night', view: 'three', phase: 'night', seed: 2, n: 8, w: 1600, h: 760 },
  { name: 'vote', view: 'table', phase: 'vote', seed: 4, n: 6, w: 1600, h: 760 },
  { name: 'hands', view: 'hands', phase: 'day', seed: 7, n: 1, w: 1200, h: 700 }
];

const only = (process.argv[2] || '').split(',').filter(Boolean);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), MAFIA_DATA: os.tmpdir() + '/mafia-test-users-ab.json'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise(r => setTimeout(r, 700));

  const browser = await chromium.launch({ args: ARGS });
  const answers = {};
  let pair = 1;
  let fails = 0;

  for (const s of SCENES) {
    if (only.length && only.indexOf(s.name) < 0) continue;
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e && e.message)));

    const url = BASE + '/compare.html?view=' + s.view + '&phase=' + s.phase +
      '&seed=' + s.seed + '&n=' + s.n + '&pair=' + pair;
    await page.goto(url, { waitUntil: 'load' });
    /* Программный WebGL медленный: GTAO и SMAA собирают шейдеры секунды. */
    await page.waitForFunction('!!window.__compareReady', { timeout: 120000 }).catch(() => {});
    await sleep(2500);

    const info = await page.evaluate(() => window.__compareReady || null);
    const file = path.join(OUT, 'ab-' + s.name + '.png');
    await page.screenshot({ path: file });
    answers[s.name] = info
      ? { left: info.modernLeft ? 'new' : 'old', right: info.modernLeft ? 'old' : 'new', pair: pair }
      : { error: 'не собралось' };
    if (!info) fails++;
    if (errs.length) { fails++; answers[s.name].errors = errs.slice(0, 4); }
    console.log((info ? '  ✓ ' : '  FAIL ') + s.name + (errs.length ? ' (ошибки: ' + errs.length + ')' : ''));
    await page.close();
    pair++;
  }

  fs.writeFileSync(path.join(OUT, 'ab-answers.json'), JSON.stringify(answers, null, 2));
  await browser.close();
  srv.kill();
  console.log('Снимки: tests/shots/ab-*.png · ответы: tests/shots/ab-answers.json');
  process.exit(fails ? 1 : 0);
})();
