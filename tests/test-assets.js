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
const ok = (c, m, extra) => {
  if (!c) {
    fails++;
    console.log('  FAIL: ' + m + (extra ? '\n        ' + String(extra).slice(0, 400) : ''));
  } else console.log('  ✓ ' + m);
};
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

console.log('\n=== ТЕСТ 9: гигиена страниц ===');

const PAGES = ['public/index.html', 'public/online.html', 'public/bots.html',
  'public/rules.html', 'public/404.html'];
const CSS = ['public/css/theatre.css', 'public/css/app.css', 'public/css/fonts.css'];
const SHARED = ['shared/game-config.js', 'shared/rng.js', 'shared/roles.js', 'shared/inquest.js'];
/* Серверная часть проверялась только тестами поведения, и потому потерянный
   байт в комментарии («роли уже роздан?ы») прожил в server.js до ручного
   вычитывания. Битые символы ищем во всём тексте проекта, а не в трёх
   страницах: терять их одинаково легко везде. */
const SERVER = ['server.js', 'server/game.js', 'server/bots.js'];
const JS = ['public/js/api.js', 'public/js/hub.js', 'public/js/online.js', 'public/js/icons.js',
  'public/js/voice.js', 'public/js/rtc.js', 'public/js/curtain.js', 'public/js/stage3d.js',
  'public/js/models3d.js', 'public/js/speech.js', 'public/js/scene2d.js',
  'public/js/flat-table.js', 'public/js/stage2d.js', 'public/js/view-mode.js'];

/* ---- 1. все файлы на месте ---- */
[].concat(PAGES, CSS, JS, SHARED).forEach(f => {
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
[].concat(PAGES, CSS, JS, SHARED).forEach(f => {
  const body = read(f);
  ok(!EXTERNAL.test(body), 'нет внешних ссылок на ресурсы: ' + f);
});
PAGES.forEach(f => {
  ok(read(f).indexOf('unpkg.com') < 0 && read(f).indexOf('fonts.googleapis') < 0,
    'нет CDN в разметке: ' + f);
});

/* ---- 5. эмодзи и «тофу»-символы ----
   Различаем две вещи. Цветной эмодзи (U+1F000 и выше, а также любой знак с
   селектором начертания) рисуется системным шрифтом, на каждом телефоне
   по-своему и всегда мимо палитры — его в проекте быть не должно нигде.
   Типографские знаки вроде ♠ ✚ ★ ☾ — это обычные символы шрифта, они
   набраны в цвет текста и стоят в правилах и в описаниях ролей по делу. */
const PICTO = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u;
[].concat(PAGES, JS, CSS, SHARED, SERVER).forEach(f => {
  const body = read(f);
  const bad = [];
  body.split('\n').forEach((line, i) => { if (PICTO.test(line)) bad.push(i + 1); });
  ok(bad.length === 0, 'нет цветных эмодзи в ' + f + (bad.length ? ' (строки ' + bad.slice(0, 6).join(', ') + ')' : ''));
});

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
['public/index.html', 'public/online.html', 'public/bots.html'].concat(JS).forEach(f => {
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

/* ---- 6b. потерянная кодировка во всём тексте проекта ----
   Обход по каталогам, а не по списку: файл, забытый в списке, — это ровно
   тот файл, в котором битый символ и живёт. */
const TEXT_EXT = /\.(js|mjs|html|css|json|md|webmanifest|txt|xml)$/i;
const SKIP_DIR = /^(\.git|node_modules|fonts|img|vendor)$/;
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(path.join(dir, e.name), out); }
    else if (TEXT_EXT.test(e.name)) out.push(path.join(dir, e.name));
  });
  return out;
}
const allText = walk(root, []);
const broken = [];
allText.forEach(abs => {
  const rel = path.relative(root, abs);
  /* Сам тест содержит символ-образец, иначе искать было бы нечем. */
  if (rel === path.join('tests', 'test-assets.js')) return;
  const body = fs.readFileSync(abs, 'utf8');
  const at = body.indexOf('\uFFFD');
  if (at >= 0) broken.push(rel + ':' + (body.slice(0, at).split('\n').length));
  if (body.charCodeAt(0) === 0xFEFF) broken.push(rel + ': BOM');
});
ok(broken.length === 0, 'ни одного битого символа во всём проекте (' + allText.length + ' файлов)',
  broken.slice(0, 8).join(', '));

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

/* ---- 11. партия не может замолчать на середине ----
   Дневной цикл зовёт UI.armInterject: если функции нет, на первом же ходе
   бота вылетает TypeError и партия молча встаёт. Проверяем, что она
   объявлена, экспортирована и что отказы промисов больше не глушатся. */
const bots = read('public/bots.html');
ok(bots.indexOf('function armInterject') > 0, 'реплика вне очереди действительно реализована');
ok(bots.indexOf('function disarmInterject') > 0, 'снятие реплики вне очереди реализовано');
ok(/return \{[^}]*armInterject/s.test(bots) || bots.indexOf('armInterject, disarmInterject') > 0,
  'armInterject виден снаружи модуля UI');
ok(!/unhandledrejection['"]?\s*,\s*\(\)\s*=>\s*\{\}\s*\)/.test(bots),
  'отказы промисов больше не глушатся пустой заглушкой');
ok(bots.indexOf('const Watch') > 0, 'у партии есть сторож против зависаний');

/* ---- 12. комната только по приглашению ---- */
const onlineHtml = read('public/online.html');
const onlineJs = read('public/js/online.js');
ok(onlineHtml.indexOf('inviteLink') > 0, 'в комнате есть ссылка-приглашение');
ok(onlineHtml.indexOf('joinCode') < 0, 'ввода четырёхзначного кода больше нет');
ok(onlineJs.indexOf("q.get('join')") > 0, 'клиент понимает ссылку ?join=');
ok(onlineHtml.indexOf('btnBots') > 0, 'в комнате есть кнопка добора ботами');
ok(fs.existsSync(path.join(root, 'server/bots.js')), 'соседи-боты живут в server/bots.js');

/* ---- 13. одна линейка на всю сцену ----
   Стол, стул и фигура должны мериться одними числами: иначе руки снова
   окажутся в воздухе. */
const models = read('public/js/models3d.js');
ok(models.indexOf('METRICS') > 0, 'в мастерской моделей объявлена общая метрика сцены');
ok(models.indexOf('tableRadiusFor') > 0, 'радиус стола считается от числа игроков');
ok(models.indexOf('function loft') > 0, 'торс собирается лофтом, а не сплющенной капсулой');
ok(models.indexOf('function buildHand') > 0, 'кисть собирается отдельно: ладонь, пальцы, большой');

/* ---- 14. сцена общая для обоих режимов ---- */
ok(read('public/bots.html').indexOf("from '/js/models3d.js'") >= 0, 'бот-режим берёт модели из общего модуля');
ok(read('public/js/stage3d.js').indexOf("from './models3d.js'") >= 0, 'сетевая сцена берёт модели оттуда же');
ok(read('public/js/online.js').indexOf('/js/stage3d.js') >= 0, 'сетевой режим поднимает 3D-сцену');

/* ---- 15. поломки, найденные прогулкой по режимам ----
   Каждая проверка ниже стоит на месте настоящего бага: они держат не «стиль»,
   а конкретные вещи, которые игрок видел на экране. */

/* Правило с !important и идентификатором перебивает [hidden] и оставляет
   элемент на экране там, где скрипт его прячет. */
const HIDDEN_BREAKER = /#[\w-]+\s*\{[^}]*display\s*:\s*(?!none)[a-z-]+\s*!important/;
/* Комментарии выкидываем: в них разобран как раз тот случай, который правило
   и запрещает, и ловить сам себя тест не должен. */
const noComments = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ');

/* Кнопки чата в шапке больше нет: она открывала ту же шторку, что вкладка
   «Чат», и жила ровно на тех ширинах, где эта вкладка и так на экране. Раньше
   здесь стояли две проверки, что кнопке рисуют знак, — они держали настоящий
   баг (пустой квадрат 44×44 в шапке на весь матч). Теперь держать надо
   обратное и более сильное: элемента нет ни в разметке, ни в скрипте, ни в
   стилях. Полуудаление хуже, чем оба состояния: скрытая кнопка с живым
   обработчиком — это код, который читают, но который никогда не работает. */
const chatBtnLeftovers = []
  .concat(/id="btnChat"/.test(onlineHtml) ? ['разметка: id="btnChat"'] : [])
  .concat(/#btnChat\b/.test(noComments(onlineHtml)) ? ['стили: #btnChat'] : [])
  .concat(/\bbtnChat\b/.test(noComments(onlineJs)) ? ['скрипт: btnChat'] : []);
ok(chatBtnLeftovers.length === 0,
  'кнопка чата в шапке убрана целиком, без осиротевших ссылок',
  chatBtnLeftovers.join(' | '));
/* А вкладка «Чат» внизу, наоборот, обязана быть: это единственный вход в чат
   на телефоне. */
ok(/id="tabChat"/.test(onlineHtml), 'вход в чат остался на панели вкладок');
ok(/'tabChat'/.test(onlineJs), 'вкладка чата подписывается и считает непрочитанное');

[].concat(PAGES, CSS).forEach(f => {
  const m = HIDDEN_BREAKER.exec(noComments(read(f)));
  ok(!m, 'нет display:…!important по id, перебивающего [hidden]: ' + f +
    (m ? ' — «' + m[0].slice(0, 60) + '»' : ''));
});

/* Мёртвая правка в медиазапросе. Классический промах каскада: правило для
   сенсорных экранов пишут выше, а ниже в том же файле тот же селектор с той
   же специфичностью объявляет то же свойство — и более позднее объявление
   отменяет правку. В bots.html так восемь месяцев жил крестик 30 пикселей
   шириной, при том что рядом лежал комментарий «делаем 44x44».
   Проверяем ровно это: селектор из медиазапроса не должен повторяться ниже
   с тем же свойством вне медиазапроса. */
function deadMediaRules(css) {
  const clean = noComments(css);
  const dead = [];
  /* Границы медиазапросов: считаем вложенность фигурных скобок. */
  const blocks = [];
  let i = 0;
  while ((i = clean.indexOf('@media', i)) >= 0) {
    const open = clean.indexOf('{', i);
    if (open < 0) break;
    let depth = 0, j = open;
    for (; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') { depth--; if (!depth) break; }
    }
    blocks.push({ start: open, end: j, body: clean.slice(open + 1, j) });
    i = j + 1;
  }
  const inMedia = pos => blocks.some(b => pos > b.start && pos < b.end);
  blocks.forEach(b => {
    const rx = /([.#][\w-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = rx.exec(b.body))) {
      const sel = m[1];
      const props = (m[2].match(/([a-z-]+)\s*:/g) || []).map(x => x.replace(':', '').trim());
      props.forEach(prop => {
        if (/!important/.test(m[2])) return;   // важное правило переспорит и позднее
        /* Ищем то же объявление ниже медиазапроса и вне медиазапросов. */
        const after = new RegExp('\\' + sel + '\\s*\\{[^}]*\\b' + prop + '\\s*:', 'g');
        let k;
        while ((k = after.exec(clean))) {
          if (k.index > b.end && !inMedia(k.index)) {
            dead.push(sel + ' { ' + prop + ' } — перебивается ниже, строка ' +
              (clean.slice(0, k.index).split('\n').length));
            break;
          }
        }
      });
    }
  });
  return dead;
}
[].concat(PAGES, CSS).forEach(f => {
  const dead = deadMediaRules(read(f));
  ok(dead.length === 0, 'ни одна правка в медиазапросе не отменена ниже: ' + f,
    dead.slice(0, 4).join(' | '));
});

/* -------------------------------------------------------------------------
   НЕИЗВЕСТНАЯ ПЕРЕМЕННАЯ НА СТРАНИЦЕ

   Неизвестная переменная в CSS ведёт себя не так, как ждёт человек. Это не
   «цвет по умолчанию» и не ошибка в консоли: var(--нет-такой) без запасного
   значения делает всё объявление недопустимым, и браузер молча выбрасывает
   его целиком. Свойство просто не применяется, и никто об этом не узнаёт.

   Именно так лист «Лучший ход» полпартии стоял без фона. В app.css было
   написано background:var(--panel), а объявлена --panel только внутри
   <style> в bots.html. На online.html, где этот лист и живёт, переменной не
   существовало — и текст читался прямо поверх сцены со фигурами за столом.
   Ни одна проверка этого не видела: геометрия сходилась, консоль молчала,
   фон никто не мерил.

   Проверяем по-страничному, а не по файлам: переменная считается известной,
   если она объявлена в самой странице или в любом подключённом ею файле.
   ------------------------------------------------------------------------- */
function declaredVars(text) {
  const out = new Set();
  const clean = noComments(text);
  /* объявления в CSS и через style.setProperty в скриптах */
  for (const m of clean.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1]);
  for (const m of clean.matchAll(/setProperty\(\s*['"`](--[A-Za-z0-9_-]+)/g)) out.add(m[1]);
  return out;
}
/* Используется ли переменная без запасного значения: var(--x) — да,
   var(--x, 12px) — нет, там есть чем закрыться. */
function usedVarsHard(text) {
  const out = new Map();
  const clean = noComments(text);
  for (const m of clean.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
    if (m[2] === ',') continue;
    if (!out.has(m[1])) out.set(m[1], clean.slice(0, m.index).split('\n').length);
  }
  return out;
}
/* Что страница подключает: свои <link rel=stylesheet> и <script src>. */
function assetsOf(html) {
  const list = [];
  for (const m of html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (href && href[1].charAt(0) === '/') list.push('public' + href[1]);
  }
  for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (m[1].charAt(0) === '/') list.push('public' + m[1]);
  }
  return list.filter(f => fs.existsSync(path.join(root, f)));
}
PAGES.forEach(page => {
  const html = read(page);
  const files = [page].concat(assetsOf(html));
  const known = new Set();
  files.forEach(f => declaredVars(read(f)).forEach(v => known.add(v)));
  const missing = [];
  files.forEach(f => {
    usedVarsHard(read(f)).forEach((line, v) => {
      if (!known.has(v)) missing.push(v + ' (' + f + ':' + line + ')');
    });
  });
  ok(missing.length === 0,
    'на странице нет неизвестных переменных: ' + page + ' (файлов ' + files.length + ')',
    missing.slice(0, 6).join(' | '));
});

/* Слои сцены: плоский стол не имеет права закрывать планшет фазы, док
   действий и занавес финала — иначе на телефоне вкладка «Стол» отбирает у
   игрока таймер и все кнопки. */
const zOf = (css, sel) => {
  const rx = new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{[^}]*?z-index\\s*:\\s*(\\d+)', 's');
  const m = rx.exec(css);
  return m ? Number(m[1]) : null;
};
const zFlat = zOf(onlineHtml, '.flatwrap');
const zBand = zOf(onlineHtml, '.phaseband');
const zDock = zOf(onlineHtml, '.actiondock');
const zRole = zOf(onlineHtml, '.rolepane');
const zEnd = zOf(onlineHtml, '.finale');
ok(zFlat !== null && zBand !== null && zDock !== null && zRole !== null && zEnd !== null,
  'у слоёв сцены объявлен z-index', JSON.stringify({ zFlat, zBand, zDock, zRole, zEnd }));
ok(zFlat < zBand, 'планшет фазы выше плоского стола (' + zFlat + ' < ' + zBand + ')');
ok(zFlat < zDock, 'док действий выше плоского стола (' + zFlat + ' < ' + zDock + ')');
ok(zFlat < zRole, 'панель роли выше плоского стола (' + zFlat + ' < ' + zRole + ')');
ok(zFlat < zEnd, 'финал выше плоского стола (' + zFlat + ' < ' + zEnd + ')');

/* Пришедший по ссылке-приглашению обязан назваться на месте. */
ok(/id="authName"/.test(onlineHtml), 'на экране без имени есть поле имени');
ok(/id="authGo"/.test(onlineHtml), 'на экране без имени есть кнопка «назваться»');
ok(onlineJs.indexOf('function claimName') > 0, 'имя заводится, не покидая приглашения');
ok(onlineJs.indexOf('location.reload()') > 0, 'после имени страница возвращается на тот же адрес');

/* Подсказка выбывшему. */
ok(/you\.alive === false/.test(onlineJs), 'выбывшему пишут своё, а не «выберите, кого выводит город»');

/* Высота шапки пересчитывается: иначе после поворота телефона между шапкой
   и сценой остаётся мёртвая полоса. */
ok(onlineJs.indexOf('function syncBarH') > 0, 'высота шапки пересчитывается');
ok(/ResizeObserver/.test(onlineJs), 'за размером шапки следят, а не мерят один раз');

/* Ровно один h1 на страницу: остальные заголовки той же величины — .as-h1. */
['public/index.html', 'public/online.html', 'public/bots.html', 'public/rules.html', 'public/404.html']
  .forEach(f => {
    /* Заголовок внутри <noscript> не считаем: он и есть единственный
       заголовок страницы, когда скриптов нет, и вместе с остальными
       на экране никогда не оказывается. */
    const body = read(f).replace(/<noscript>[\s\S]*?<\/noscript>/g, ' ');
    const n = (body.match(/<h1[\s>]/g) || []).length;
    ok(n === 1, 'ровно один h1 в ' + f + ' (найдено ' + n + ')');
  });
ok(theatre.indexOf('.as-h1') > 0, 'в дизайн-системе есть заголовок величиной с h1 без тега h1');

/* Абсолютные адреса в og:image и canonical собирает сервер: в файлах домена
   знать неоткуда, а соцсети относительный путь не разворачивают. */
const srv = read('server.js');
ok(srv.indexOf('function absolutizeHtml') > 0, 'сервер разворачивает адреса в разметке до абсолютных');
ok(/og:\(\?:url\|image\)|og:\(\?:image\|url\)/.test(srv) || /og:\(\?:url\|image\)/.test(srv) ||
  srv.indexOf('twitter:image') > 0, 'разворачиваются именно og:* и twitter:image');
ok(srv.indexOf('if-none-match') > 0, 'страницы отдаются с меткой версии: повтор — 304, а не 320 КБ');

console.log(fails === 0 ? '\n✓ ТЕСТ 9 ПРОЙДЕН' : '\n✗ ТЕСТ 9: ошибок ' + fails);
process.exit(fails ? 1 : 0);
