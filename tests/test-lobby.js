/* =========================================================================
   Тест №11 — общий зал, быстрая игра и SEO-обвязка.

   Самая больная точка любой сетевой игры — первые тридцать секунд новичка.
   Если ему не видно ни одного стола и нет кнопки «сыграть сейчас», он уйдёт,
   и никакое качество сцены его не вернёт. Поэтому здесь проверяем именно
   встречу игроков:

   1. Первый нажавший «Быструю игру» открывает стол, второй — садится к нему,
      а не плодит второй пустой стол. Именно так люди находят друг друга.
   2. Открытый стол виден в общем зале со всем, что нужно для решения:
      кто хозяин, сколько людей, сколько мест и давно ли ждут.
   3. Сесть за открытый стол можно прямо из списка, без ссылки.
   4. Ключ внешнего помощника живёт только на сервере, доступен лишь тем, кто
      за столом, а без ключа игра честно говорит 503, а не ломается.
   5. Страницы готовы к индексации: robots, sitemap, canonical, OG-картинка,
      манифест, человеческая 404 и адреса без .html.
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 8211;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Маленький клиент на http: без зависимостей и без fetch, чтобы тест
   шёл на любой версии Node, где запускается сам сервер. */
function req(pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (opts.token) headers['x-token'] = opts.token;
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: opts.method || (data ? 'POST' : 'GET'), headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* не JSON — так и задумано */ }
          resolve({ status: res.statusCode, headers: res.headers, text, bytes: buf.length, json });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  /* Ключ специально не передаём: проверяем именно поведение без ключа. */
  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  delete env.MISTRAL_API_KEY;

  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => console.log('  [server stderr] ' + d));
  await sleep(900);

  try {
    const stamp = Date.now().toString(36).slice(-4);
    const mk = async name => (await req('/api/register', { body: { name: name + stamp } })).json.user;
    const first = await mk('Первый');
    const second = await mk('Второй');
    const third = await mk('Третий');
    const looker = await mk('Зритель');

    /* ---- 1. быстрая игра сводит людей за один стол ---- */
    const noAuth = await req('/api/rooms/quick', { body: {} });
    ok(noAuth.status === 401, 'без имени быстрая игра не работает (' + noAuth.status + ')');

    const q1 = await req('/api/rooms/quick', { token: first.token, body: {} });
    ok(q1.status === 200 && q1.json.joined === false, 'первый игрок открыл стол сам');
    const table = q1.json.room;
    ok(table.visibility === 'public', 'стол из быстрой игры сразу открыт для всех');
    ok(table.autoStart === true, 'стол сам начнёт партию, когда соберётся');

    const q2 = await req('/api/rooms/quick', { token: second.token, body: {} });
    ok(q2.status === 200 && q2.json.joined === true, 'второй игрок подсел, а не открыл второй пустой стол');
    ok(q2.status === 200 && q2.json.room.id === table.id, 'двое оказались за одним столом');
    ok(q2.status === 200 && q2.json.room.members.length === 2, 'за столом двое живых');
    ok(q2.status === 200 && (q2.json.room.chat || []).some(m => m.system && /подсел/.test(m.text)),
      'стол видит, что к нему пришёл человек');

    /* ---- 2. общий зал показывает всё, что нужно для решения ---- */
    const zal = await req('/api/lobby', { token: looker.token });
    const row = (zal.json.rooms || []).find(r => r.roomId === table.id);
    ok(!!row, 'стол виден в общем зале со стороны');
    ok(!!row && row.humans === 2 && row.players === 2, 'видно, что там уже двое людей');
    ok(!!row && row.free > 0, 'видно, что есть свободные места (' + (row && row.free) + ')');
    ok(!!row && !!row.host && !!row.title && !!row.scenario, 'видно хозяина, название и сюжет');
    ok(!!row && typeof row.waitingSec === 'number' && row.waitingSec >= 0, 'видно, сколько стол ждёт');
    ok(!(zal.json.users || []).some(u => u.id === looker.id), 'себя самого в списке игроков нет');

    /* ---- 3. сесть из списка — без ссылки и без приглашения ---- */
    const sit = await req('/api/rooms/join', { token: third.token, body: { roomId: table.id } });
    ok(sit.status === 200, 'за открытый стол садятся прямо из списка (' + sit.status + ')');
    ok(sit.status === 200 && sit.json.room.members.length === 3, 'теперь за столом трое');
    ok(sit.status === 200 && !!sit.json.room.inviteLink, 'хозяину всё равно есть что разослать друзьям');

    const zal2 = await req('/api/lobby', { token: looker.token });
    const row2 = (zal2.json.rooms || []).find(r => r.roomId === table.id);
    ok(!!row2 && row2.humans === 3, 'строка в зале обновилась сама');

    /* ---- 4. помощник: чужой ключ не бесплатное API для интернета ---- */
    /* Обработчик стоял выше проверки авторизации, и ключом хозяина площадки
       мог пользоваться любой, кто знал адрес. Проверяем оба конца: без имени
       не пускают вовсе, с именем и без ключа отвечают честным 503. */
    const helperAnon = await req('/api/helper', { body: { messages: [{ role: 'user', content: 'привет' }] } });
    ok(helperAnon.status === 401, 'без авторизации помощник не отвечает (' + helperAnon.status + ')');

    const helper = await req('/api/helper', {
      token: looker.token, body: { messages: [{ role: 'user', content: 'привет' }] }
    });
    ok(helper.status === 503 && helper.json && helper.json.error === 'helper-off',
      'без ключа помощник честно отвечает 503 (' + helper.status + ')');
    const helperBad = await req('/api/helper', { token: looker.token, body: {} });
    ok(helperBad.status === 503 || helperBad.status === 400, 'пустой запрос к помощнику не роняет сервер');

    const botsHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'bots.html'), 'utf8');
    ok(!/api\.mistral\.ai/.test(botsHtml), 'адреса внешнего сервиса больше нет в коде страницы');
    ok(!/Bearer\s*'?\s*\+?\s*HELPER\.key/.test(botsHtml) && !/[A-Za-z0-9]{32,}/.test(botsHtml.split('\n').filter(l => /HELPER/.test(l)).join('\n')),
      'ключа в странице нет — он только на сервере');

    /* ---- 5. SEO и честные коды ответов ---- */
    const robots = await req('/robots.txt');
    ok(robots.status === 200 && /Sitemap:/i.test(robots.text), 'robots.txt отдаётся и ведёт на карту сайта');
    ok(/Disallow: \/api\//.test(robots.text), 'служебные адреса закрыты от поисковиков');

    const sitemap = await req('/sitemap.xml');
    ok(sitemap.status === 200 && /<urlset/.test(sitemap.text), 'sitemap.xml — валидный список адресов');
    ['/bots.html', '/online.html', '/rules.html'].forEach(u => {
      ok(sitemap.text.indexOf(u) > 0, 'в карте сайта есть ' + u);
    });
    ok(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap.text), 'в карте сайта есть дата обновления');

    const ghost = await req('/net-takogo-adresa-xyz');
    ok(ghost.status === 404, 'несуществующий адрес отвечает 404, а не подсунутым главным экраном (' + ghost.status + ')');

    for (const [url, mark] of [['/online', 'online'], ['/bots', 'bots'], ['/rules', 'rules']]) {
      const r = await req(url);
      ok(r.status === 200, 'адрес без .html работает: ' + url + ' (' + r.status + ')');
      ok(r.status === 200 && /rel="canonical"/.test(r.text), 'у ' + mark + ' есть canonical');
    }

    for (const url of ['/', '/online.html', '/bots.html', '/rules.html']) {
      const r = await req(url);
      const t = r.text;
      ok(r.status === 200, 'страница отдаётся: ' + url);
      ok(/<title>[^<]{20,}<\/title>/.test(t), url + ' — заголовок осмысленный, а не одно слово');
      ok(/<meta name="description" content="[^"]{80,}"/.test(t), url + ' — описание для выдачи на месте');
      ok(/property="og:image"/.test(t) && /property="og:title"/.test(t), url + ' — карточка для соцсетей собрана');
      ok(/application\/ld\+json/.test(t), url + ' — разметка Schema.org на месте');
      ok(/<html lang="ru"/.test(t), url + ' — язык страницы объявлен');
      ok(/rel="canonical"/.test(t), url + ' — canonical указан');
      ok(/rel="manifest"/.test(t), url + ' — манифест подключён');
    }

    const og = await req('/img/og-image.png');
    ok(og.status === 200 && og.bytes > 20000, 'OG-картинка на месте и не пустая (' + og.bytes + ' байт)');
    const man = await req('/manifest.webmanifest');
    ok(man.status === 200 && man.json && man.json.icons && man.json.icons.length >= 2,
      'манифест отдаётся со значками');
    for (const ic of ['/img/icon-192.png', '/img/icon-512.png', '/img/mask.svg']) {
      const r = await req(ic);
      ok(r.status === 200 && r.bytes > 500, 'значок на месте: ' + ic + ' (' + r.bytes + ' байт)');
    }

    const p404 = await req('/404.html');
    ok(p404.status === 200 && /noindex/.test(p404.text), 'своя страница 404 есть и закрыта от индексации');

    /* Каждая страница обязана давать дорогу назад — иначе это тупик. */
    for (const [url, name] of [['/online.html', 'сетевая'], ['/bots.html', 'с ботами'], ['/rules.html', 'правила'], ['/404.html', '404']]) {
      const r = await req(url);
      ok(/href="\/"/.test(r.text), 'со страницы «' + name + '» есть ссылка на главную');
    }

    /* Стол за собой прибираем. */
    for (const u of [third, second, first]) await req('/api/rooms/leave', { token: u.token, body: {} });
    const after = await req('/api/lobby', { token: looker.token });
    ok(!(after.json.rooms || []).some(r => r.roomId === table.id), 'пустой стол не висит в зале после ухода людей');
  } catch (e) {
    fails++;
    console.log('  ИСКЛЮЧЕНИЕ: ' + e.stack);
  } finally {
    srv.kill();
  }

  console.log(fails === 0 ? '\n✓ ТЕСТ 11 ПРОЙДЕН' : '\n✗ ТЕСТ 11: ошибок ' + fails);
  process.exit(fails ? 1 : 0);
})();
