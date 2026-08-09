/* =========================================================================
   Тест 14 — семя партии и устойчивость ботов к словам.

   Две вещи, которые нельзя проверить глазами.

   1. Семя. Все случайные решения движка шли через Math.random(), и партию
      нельзя было ни повторить, ни разобрать: на жалобу «нам третий раз
      подряд выпала мафия на одних и тех же местах» ответить было нечем, а
      симулятор баланса шумел от прогона к прогону. Теперь у партии есть
      семя, и при одинаковом семени стол собирается заново до последней карты.

   2. Слова-триггеры. Боты считали заявкой шерифа любое сообщение, где есть
      слово «шериф» и чьё-то имя. Мафия-человек писала «шериф проверил Веру,
      она чёрная» — и одним сообщением направляла на Веру весь стол, а
      следующей ночью боты-мафия шли за «объявившимся шерифом». Проверяем,
      что теперь заявкой считается только настоящее раскрытие, что вклад
      заявки ограничен, а два самозванца ослабляют друг друга.
   ========================================================================= */
'use strict';
const { Game } = require('../server/game.js');
const Rng = require('../shared/rng.js');
const C = require('../shared/game-config.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };

/* Имена нарочно непохожие: разбор обращений в чате сводит имя к основе, и на
   именах вида «Игрок1»/«Игрок2» тест проверял бы не заявки шерифа, а слабость
   этого разбора. */
const NAMES = ['Клим', 'Марта', 'Борис', 'Устинья', 'Фёдор', 'Гриша', 'Тоня', 'Яков',
  'Зоя', 'Лёва', 'Кира', 'Павел', 'Рита', 'Семён', 'Юля', 'Егор', 'Дина', 'Хома', 'Ульяна', 'Аркадий'];
function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: NAMES[i % NAMES.length] }));
}
const roles = g => g.players.map(p => p.role).join(',');

console.log('\n=== ТЕСТ 14: семя партии и устойчивость ботов ===');

/* ---- 1. генератор ---- */
{
  const a = Rng.createRng('одно');
  const b = Rng.createRng('одно');
  const c = Rng.createRng('другое');
  const seq = r => Array.from({ length: 8 }, () => r.next().toFixed(6)).join(' ');
  const sa = seq(a), sb = seq(b), sc = seq(c);
  ok(sa === sb, 'одно семя — одна последовательность');
  ok(sa !== sc, 'другое семя — другая');

  const r = Rng.createRng('шкала');
  let min = 1, max = 0, sum = 0;
  for (let i = 0; i < 20000; i++) { const v = r.next(); min = Math.min(min, v); max = Math.max(max, v); sum += v; }
  ok(min >= 0 && max < 1, 'числа лежат в [0,1): ' + min.toFixed(5) + '…' + max.toFixed(5));
  ok(Math.abs(sum / 20000 - 0.5) < 0.01, 'среднее около половины: ' + (sum / 20000).toFixed(4));

  const buckets = new Array(10).fill(0);
  const r2 = Rng.createRng('корзины');
  for (let i = 0; i < 20000; i++) buckets[Math.floor(r2.next() * 10)]++;
  ok(buckets.every(n => n > 1500 && n < 2500), 'по десяти корзинам распределение ровное: ' + buckets.join('/'));

  const r3 = Rng.createRng('перемешать');
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const mixed = r3.shuffle(src);
  ok(src.join() === '1,2,3,4,5,6,7,8', 'shuffle не портит исходный массив');
  ok(mixed.slice().sort((x, y) => x - y).join() === '1,2,3,4,5,6,7,8', 'и не теряет элементов');
  ok(Rng.createRng('перемешать').shuffle(src).join() === mixed.join(), 'перемешивание повторяемо');
}

/* ---- 2. партия по семени ---- */
{
  const a = new Game(members(12), null, { seed: 'вечер' });
  const b = new Game(members(12), null, { seed: 'вечер' });
  const c = new Game(members(12), null, { seed: 'утро' });
  ok(roles(a) === roles(b), 'одно семя — одна раздача ролей');
  ok(a.scenario.id === b.scenario.id, 'и один сюжет');
  ok(roles(a) !== roles(c) || a.scenario.id !== c.scenario.id, 'другое семя — другой стол');
  ok(!!a.seed && a.seed.length > 0, 'семя записано в партии: ' + a.seed);

  const fresh = new Game(members(8), null);
  ok(!!fresh.seed, 'без указания семя придумывается само: ' + fresh.seed);
  const again = new Game(members(8), null, { seed: fresh.seed });
  ok(roles(again) === roles(fresh), 'по записанному семени стол собирается заново');
}

/* ---- 3. семя не утекает до конца партии ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'секрет' });
  const mid = g.viewFor(g.players[0].id);
  ok(mid.seed === null, 'до занавеса семя игроку не отдают: по нему пересчитали бы все роли');
  g.finish('town');
  const end = g.viewFor(g.players[0].id);
  ok(end.seed === 'секрет', 'после занавеса семя видно — партию можно разобрать');
}

/* ---- 4. одинаковое семя — одинаковый ход всей партии ---- */
{
  /* Ведём две партии одинаковыми действиями и сверяем протокол. Раньше даже
     при одинаковых ходах ничьи и удары вслепую расходились. */
  function play(seed) {
    const g = new Game(members(9), 'deck', { seed });
    g.deadline = 0;
    let guard = 0;
    while (!g.finished && guard++ < 800) {
      if (g.phase === 'night') {
        /* Все мафии бьют в разные цели: ничью разрешает генератор партии. */
        const targets = g.alive().filter(p => !g.isMafia(p.id));
        g.aliveMafia().forEach((m, i) => {
          const t = targets[i % targets.length];
          if (t) g.action(m.id, 'kill', t.id);
        });
      } else if (g.phase === 'speech') {
        g.action(g.speaker, 'pass', null);
      } else if (g.phase === 'day') {
        g.alive().forEach(p => g.action(p.id, 'ready'));
      } else if (g.phase === 'vote' || g.phase === 'runoff') {
        /* Ровно ничья: половина за одного, половина за другого. */
        const pool = g.runoffOf ? g.runoffOf.filter(id => g.p(id).alive)
          : g.alive().map(p => p.id);
        g.alive().forEach((p, i) => {
          const t = pool.filter(id => id !== p.id)[i % Math.max(1, pool.length - 1)];
          g.action(p.id, 'vote', t || 'skip');
        });
      }
      g.deadline = 0;
      g.tick();
    }
    return { winner: g.winner, log: g.log.map(l => l.kind + ':' + l.text).join('|'), roles: roles(g) };
  }
  const one = play('повтор');
  const two = play('повтор');
  const other = play('иначе');
  ok(one.roles === two.roles, 'при одном семени роли те же');
  ok(one.log === two.log, 'и весь протокол партии совпадает до буквы');
  ok(one.winner === two.winner, 'и победитель тот же: ' + one.winner);
  ok(one.log !== other.log, 'при другом семени партия идёт иначе');
}

/* ---- 5. заявку шерифа не подделать словом ---- */
{
  /* Ставим партию руками, чтобы роли были известны наверняка. */
  function table() {
    const g = new Game(members(8), 'deck', { seed: 'заявки' });
    g.players.forEach((p, i) => { p.role = i === 0 ? C.ROLE.MAFIA : (i === 1 ? C.ROLE.SHERIFF : C.ROLE.CIVILIAN); });
    g.phase = 'day';
    return g;
  }
  const bots = require('../server/bots.js');
  /* Карта подозрений — внутренняя, поэтому смотрим на её последствие:
     на кого бот-мафия пойдёт ночью и за кого проголосует город. Для этого
     достаточно открытого поведения, которое видит и человек. */
  const g = table();
  const mafia = g.players[0], sheriff = g.players[1];
  const victim = g.players[4], innocent = g.players[5];

  /* Мафия пытается заказать словом «шериф». */
  g.say(mafia.id, 'шериф проверил ' + victim.name + ', он чёрный', 'town');
  const fake = g.viewFor(sheriff.id);
  ok(fake.chat.length > 0, 'сообщение в чате есть — его никто не цензурирует');

  /* Заявок в понимании ботов быть не должно. */
  const claimsAfterFake = bots.__test.sheriffClaims(g);
  ok(claimsAfterFake.length === 0, 'фраза «шериф проверил такого-то» заявкой не считается');

  /* А настоящее раскрытие — считается. */
  g.say(sheriff.id, 'Я шериф. ' + victim.name + ' — чёрный, проверял этой ночью.', 'town');
  const real = bots.__test.sheriffClaims(g);
  ok(real.length === 1, 'настоящее раскрытие учитывается (' + real.length + ')');
  ok(real[0].from === sheriff.id && real[0].target === victim.id, 'и в нём верны и автор, и цель');

  /* Повтор той же заявки её не усиливает. */
  g.say(sheriff.id, 'Повторю: я шериф, ' + victim.name + ' чёрный.', 'town');
  ok(bots.__test.sheriffClaims(g).length === 1, 'повтор той же заявки не удваивает её');

  /* Больше трёх чёрных от одного «шерифа» — уже поток имён. */
  const g2 = table();
  const sh2 = g2.players[1];
  [4, 5, 6, 7].forEach(i => {
    /* Антифлуд движка не даёт писать чаще раза в секунду — это верно для
       живого стола, но здесь мешает проверке. Отматываем его руками. */
    sh2.lastSayAt = 0; sh2.lastSayText = null;
    g2.say(sh2.id, 'Я шериф. ' + g2.players[i].name + ' — чёрный.', 'town');
  });
  ok(bots.__test.sheriffClaims(g2).length === 3, 'от одного заявителя учитываются первые три заявки');

  /* Двое самозванцев ослабляют друг друга. */
  const g3 = table();
  const one = g3.players[2], two = g3.players[3];
  g3.say(one.id, 'Я шериф. ' + innocent.name + ' — чёрный.', 'town');
  two.lastSayAt = 0;
  g3.say(two.id, 'Я шериф. ' + victim.name + ' — чёрный.', 'town');
  ok(bots.__test.claimants(g3).length === 2, 'шерифом объявились двое');
  const susOne = bots.__test.personalSus(g3, g3.players[6], bots.__test.suspicionMap(g3));
  const g4 = table();
  g4.say(one.id, 'Я шериф. ' + innocent.name + ' — чёрный.', 'town');
  const susSolo = bots.__test.personalSus(g4, g4.players[6], bots.__test.suspicionMap(g4));
  ok(susSolo[innocent.id] > susOne[innocent.id],
    'одинокая заявка весит больше спорной: ' + susSolo[innocent.id].toFixed(2) +
    ' против ' + susOne[innocent.id].toFixed(2));

  /* И самое главное: одна фраза не должна перевешивать весь стол. */
  const g5 = table();
  const shx = g5.players[1];
  g5.say(shx.id, 'Я шериф. ' + innocent.name + ' — чёрный.', 'town');
  const s5 = bots.__test.personalSus(g5, g5.players[6], bots.__test.suspicionMap(g5));
  /* Было: безусловные +5 за заявку, плюс единица за упоминание — шесть, и
     это перевешивало любые наблюдения стола. Стало: 3,2 плюс упоминание. */
  ok(s5[innocent.id] < 5,
    'вклад заявки ограничен: ' + s5[innocent.id].toFixed(2) + ' вместо прежних 6');
}

/* ---- 6. боты не повторяют одну заготовку подряд ---- */
{
  const g = new Game(members(10), 'deck', { seed: 'реплики' });
  const bots = require('../server/bots.js');
  g.phase = 'day';
  const sus = bots.__test.suspicionMap(g);
  const said = [];
  g.alive().slice(0, 6).forEach(p => {
    p._trait = { id: 'talker', talk: 2, sharp: 0.6 };
    const line = bots.__test.dayLine(g, p, sus, false);
    if (line) said.push(line.text);
  });
  const uniq = new Set(said);
  ok(said.length >= 4, 'боты сказали достаточно, чтобы судить о повторах (' + said.length + ')');
  ok(uniq.size === said.length,
    'шесть соседей подряд не повторили ни одной заготовки (' + uniq.size + ' из ' + said.length + ')');
}

console.log(fails === 0 ? '\n✓ ТЕСТ 14 ПРОЙДЕН' : '\n✗ ТЕСТ 14: ошибок ' + fails);
process.exit(fails ? 1 : 0);
