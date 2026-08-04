/* =========================================================================
   Тест №9 — гигиена страниц.

   Ловит ровно те вещи, которые видны игроку и которые легко упустить
   глазами: битые символы, эмодзи вместо знаков, мелкий кегль, обращения
   к внешним CDN (без них сайт обязан открываться в закрытой сети) и
   отсутствие подключённых своих шрифтов.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

console.log('\n=== ТЕСТ 9: гигиена страниц ===');

const PAGES = ['public/index.html', 'public/online.html', 'public/bots.html'];
const CSS = ['public/css/theatre.css', 'public/css/app.css', 'public/css/fonts.css'];
const JS = ['public/js/api.js', 'public/js/hub.js', 'public/js/online.js', 'public/js/icons.js',
  'public/js/voice.js', 'public/js/rtc.js', 'public/js/curtain.js', 'public/js/stage3d.js',
  'public/js/models3d.js', 'public/js/speech.js', 'public/js/scene2d.js'];

/* ---- 1. все файлы на месте ---- */
[].concat(PAGES, CSS, JS).forEach(f => {
  ok(fs.existsSync(path.join(root, f)), 'есть файл ' + f);
});

/* ---- 2. свои шрифты лежат в проекте ---- */
const fontDir = path.join(root, 'public/fonts');
const fonts = fs.existsSync(fontDir) ? fs.readdirSync(fontDir) : [];
ok(fonts.filter(f => /\.woff2$/.test(f)).length >= 8, 'шрифты лежат в public/fonts (' + fonts.length + ' файлов)');
ok(fonts.some(f => /bitter-cyrillic/.test(f)), 'есть кириллический срез Bitter');
ok(fonts.some(f => /golos-text-cyrillic/.test(f)), 'есть кириллический срез Golos Text');
const fontsCss = read('public/css/fonts.css');
fonts.filter(f => /\.woff2$/.test(f)).forEach(f => {
  ok(fontsCss.indexOf(f) >= 0, 'шрифт подключён в fonts.css: ' + f);
});

/* ---- 3. three.js внутри проекта ---- */
ok(fs.existsSync(path.join(root, 'public/vendor/three/three.module.js')), 'three.js лежит в public/vendor');
ok(fs.existsSync(path.join(root, 'public/vendor/three/controls/OrbitControls.js')), 'OrbitControls лежит рядом');

/* ---- 4. ни одного обращения к внешней сети ---- */
const EXTERNAL = /(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|import\s*\(?["']https?:\/\//;
[].concat(PAGES, CSS, JS).forEach(f => {
  const body = read(f);
  ok(!EXTERNAL.test(body), 'нет внешних ссылок на ресурсы: ' + f);
});
PAGES.forEach(f => {
  ok(read(f).indexOf('unpkg.com') < 0 && read(f).indexOf('fonts.googleapis') < 0,
    'нет CDN в разметке: ' + f);
});

/* ---- 5. эмодзи и «тофу»-символы ---- */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
[].concat(PAGES, JS).forEach(f => {
  const body = read(f);
  const bad = [];
  body.split('\n').forEach((line, i) => { if (EMOJI.test(line)) bad.push(i + 1); });
  ok(bad.length === 0, 'нет эмодзи в ' + f + (bad.length ? ' (строки ' + bad.slice(0, 6).join(', ') + ')' : ''));
});

/* ---- 6. битые символы: удвоенные буквы и типичные опечатки ---- */
const TYPOS = [
  /ООбъяв/i, /играетт/i, /оффлайн/i, /онлайне?н/i,
  /\b(\w*)([а-яё])\2{2,}(\w*)\b/i,          // три одинаковые буквы подряд
  /[а-яё]\s+[,.](?=\s|$)/i,                  // пробел перед знаком в русской фразе
  /�/                                        // потерянная кодировка
];
[].concat(PAGES, JS, CSS).forEach(f => {
  const body = read(f);
  TYPOS.forEach((rx, k) => {
    const m = rx.exec(body);
    ok(!m, 'нет опечатки №' + (k + 1) + ' в ' + f + (m ? ' — «' + String(m[0]).slice(0, 40) + '»' : ''));
  });
});

/* ---- 7. кегль: ниже 13px текст на телефоне не читается ---- */
[].concat(PAGES, CSS).forEach(f => {
  const body = read(f);
  const small = [];
  const rx = /font-size:\s*(\d+(?:\.\d+)?)px/g;
  let m;
  while ((m = rx.exec(body))) if (parseFloat(m[1]) < 12) small.push(m[1]);
  ok(small.length === 0, 'нет кегля меньше 12px в ' + f + (small.length ? ' (' + small.join(', ') + ')' : ''));
});

/* ---- 8. типографическая шкала и роли цвета объявлены один раз ---- */
const theatre = read('public/css/theatre.css');
['--tallow', '--ember', '--plaster', '--display', '--sans', '--t-2xs', '--s4', '--ease']
  .forEach(v => ok(theatre.indexOf(v + ':') >= 0, 'в дизайн-системе объявлено ' + v));
ok(theatre.indexOf('#c9a227') < 0, 'старое «золото» из палитры убрано');

/* ---- 9. страницы подключают шрифты и дизайн-систему ---- */
PAGES.forEach(f => {
  const body = read(f);
  ok(body.indexOf('/css/fonts.css') >= 0, 'подключены свои шрифты: ' + f);
});
['public/index.html', 'public/online.html'].forEach(f => {
  ok(read(f).indexOf('/css/theatre.css') >= 0, 'подключена дизайн-система: ' + f);
});

/* ---- 10. доступность: у кнопок-иконок есть подпись для читалки ---- */
PAGES.forEach(f => {
  const body = read(f);
  const iconBtns = body.match(/<button[^>]*class="[^"]*(?:iconbtn|tbtn|panelClose)[^"]*"[^>]*>/g) || [];
  const naked = iconBtns.filter(b => b.indexOf('aria-label') < 0);
  ok(naked.length === 0, 'у всех кнопок-знаков есть aria-label: ' + f +
    (naked.length ? ' (' + naked.length + ' без подписи)' : ''));
});

/* ---- 11. сцена общая для обоих режимов ---- */
ok(read('public/bots.html').indexOf("from '/js/models3d.js'") >= 0, 'бот-режим берёт модели из общего модуля');
ok(read('public/js/stage3d.js').indexOf("from './models3d.js'") >= 0, 'сетевая сцена берёт модели оттуда же');
ok(read('public/js/online.js').indexOf('/js/stage3d.js') >= 0, 'сетевой режим поднимает 3D-сцену');

console.log(fails === 0 ? '\n✓ ТЕСТ 9 ПРОЙДЕН' : '\n✗ ТЕСТ 9: ошибок ' + fails);
process.exit(fails ? 1 : 0);
