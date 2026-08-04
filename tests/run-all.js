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
  ['Тест 5 · сетевой чат и обращения', 'test-chat.js']
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
  'shared/game-config.js', 'server/game.js',
  'public/index.html', 'public/online.html', 'public/bots.html',
  'public/css/app.css', 'public/js/api.js', 'public/js/hub.js', 'public/js/online.js', 'public/js/speech.js',
  'tests/test-speech.js', 'tests/test-chat.js'
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
