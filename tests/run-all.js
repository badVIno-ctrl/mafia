/* Общий тест: последовательно запускает все проверки проекта */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const suites = [
  ['Тест 1 · баланс ролей 6–20', 'test-balance.js'],
  ['Тест 2 · движок партии', 'test-engine.js'],
  ['Тест 3 · сетевой слой и статика', 'test-server.js'],
  ['Тест 4 · живая речь и реакция стола', 'test-speech.js'],
  ['Тест 5 · сетевой чат и обращения', 'test-chat.js'],
  ['Тест 7 · обрывы связи не держат фазу', 'test-offline.js'],
  ['Тест 8 · сигналинг голосового чата', 'test-signal.js'],
  ['Тест 9 · гигиена страниц', 'test-assets.js'],
  ['Тест 10 · соседи-боты и вход по приглашению', 'test-bots.js'],
  ['Тест 11 · общий зал, быстрая игра и SEO', 'test-lobby.js'],
  ['Тест 12 · доступ к столу и возвращение в партию', 'test-access.js'],
  ['Тест 13 · слово по кругу', 'test-speeches.js'],
  ['Тест 14 · семя партии и устойчивость ботов', 'test-seed.js'],
  ['Тест 15 · режим «Следствие»', 'test-inquest.js']
];

let bad = 0;
suites.forEach(([title, file]) => {
  console.log('\n─── ' + title + ' ───');
  const r = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
});

// тест 6 · целостность сборки
console.log('\n─── Тест 6 · состав пакета ───');
const must = [
  'server.js', 'package.json', 'README.md',
  'shared/game-config.js', 'shared/inquest.js', 'server/game.js', 'server/bots.js',
  'public/index.html', 'public/online.html', 'public/bots.html',
  'public/rules.html', 'public/404.html', 'public/manifest.webmanifest',
  'public/img/og-image.png', 'public/img/icon-192.png', 'public/img/icon-512.png',
  'public/css/app.css', 'public/css/theatre.css', 'public/css/fonts.css',
  'public/js/api.js', 'public/js/hub.js', 'public/js/online.js', 'public/js/speech.js',
  'public/js/icons.js', 'public/js/voice.js', 'public/js/rtc.js', 'public/js/curtain.js',
  'public/js/models3d.js', 'public/js/stage3d.js', 'public/js/view-mode.js',
  'public/vendor/three/three.module.js',
  'tests/test-speech.js', 'tests/test-chat.js', 'tests/test-offline.js',
  'tests/test-signal.js', 'tests/test-assets.js', 'tests/test-bots.js',
  'tests/test-lobby.js', 'tests/test-access.js', 'tests/test-speeches.js',
  'tests/test-seed.js', 'tests/test-inquest.js', 'tests/shot.js', 'tests/lab-shots.js',
  'public/figure-lab.html'
];
let miss = 0;
must.forEach(f => {
  const ok = fs.existsSync(path.join(__dirname, '..', f));
  console.log((ok ? '  ✓ ' : '  FAIL: нет файла ') + f);
  if (!ok) miss++;
});
if (miss) bad++;

console.log(bad === 0
  ? '\n✅ ОБЩИЙ ТЕСТ ПРОЙДЕН — все проверки зелёные'
  : '\n❌ ОБЩИЙ ТЕСТ: провалено блоков — ' + bad);
process.exit(bad ? 1 : 0);
