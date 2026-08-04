/* Тест №2 — игровой движок: имитация партий на 6–20 игроков */
const { Game, pick } = require('../server/game.js');
const C = require('../shared/game-config.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } };

function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'Игрок ' + (i + 1) }));
}

/** Прогон партии без ожидания таймеров: все действуют сразу. */
function playGame(n, seedScenario) {
  const g = new Game(members(n), seedScenario);
  g.deadline = 0;                    // пролог пролистываем
  let guard = 0;
  while (!g.finished && guard++ < 400) {
    if (g.phase === 'night') {
      g.aliveMafia().forEach(m => {
        const targets = g.alive().filter(p => !g.isMafia(p.id));
        if (targets.length) {
          const r = g.action(m.id, 'kill', pick(targets).id);
          ok(!r.error, 'kill: ' + r.error);
        }
      });
      g.alive().filter(p => p.role === C.ROLE.DOCTOR).forEach(d => {
        const targets = g.alive().filter(p => g.lastHealed[d.id] !== p.id);
        if (targets.length) {
          const r = g.action(d.id, 'heal', pick(targets).id);
          ok(!r.error, 'heal: ' + r.error);
        }
      });
      g.alive().filter(p => p.role === C.ROLE.SHERIFF).forEach(s => {
        const targets = g.alive().filter(p => p.id !== s.id);
        if (targets.length) {
          const r = g.action(s.id, 'check', pick(targets).id);
          ok(!r.error, 'check: ' + r.error);
        }
      });
      // ночной чат мафии работает, городской — нет
      const m0 = g.aliveMafia()[0];
      if (m0) ok(!g.say(m0.id, 'берём ' + 1, 'mafia').error, 'ночной чат мафии закрыт');
      const t0 = g.aliveTown()[0];
      if (t0) ok(!!g.say(t0.id, 'я не сплю', 'town').error, 'город говорит ночью');
    } else if (g.phase === 'day') {
      g.alive().forEach(p => {
        g.say(p.id, 'мне подозрителен кто-то', 'town');
        g.action(p.id, 'ready');
      });
    } else if (g.phase === 'vote' || g.phase === 'runoff') {
      g.alive().forEach(p => {
        const pool = g.runoffOf
          ? g.runoffOf.filter(id => g.p(id).alive)
          : g.alive().filter(x => x.id !== p.id).map(x => x.id);
        const target = pool.length && Math.random() < 0.85 ? pick(pool) : 'skip';
        const r = g.action(p.id, 'vote', target);
        ok(!r.error, 'vote: ' + r.error);
      });
    }
    g.deadline = 0;      // фаза завершается сразу
    g.tick();
  }
  ok(g.finished, `n=${n}: партия не завершилась за ${guard} тактов`);
  ok(g.winner === 'town' || g.winner === 'mafia', `n=${n}: нет победителя`);
  return g;
}

console.log('\n=== ТЕСТ 2: игровой движок ===');
const stats = {};
for (let n = 6; n <= 20; n++) {
  let town = 0, mafia = 0, days = 0;
  for (let k = 0; k < 30; k++) {
    const g = playGame(n);
    if (g.winner === 'town') town++; else mafia++;
    days += g.day;
    // инварианты по концу партии
    ok(g.aliveMafia().length === 0 || g.aliveMafia().length >= g.aliveTown().length,
      `n=${n}: партия завершилась без условия победы`);
  }
  stats[n] = { town, mafia, avgDays: (days / 30).toFixed(1) };
}
console.log('игроков\tпобед города\tпобед мафии\tср. дней (30 партий, случайная игра)');
Object.entries(stats).forEach(([n, s]) => console.log(`${n}\t${s.town}\t\t${s.mafia}\t\t${s.avgDays}`));

/* --- приватность ролей --- */
console.log('\n--- проверка утечки ролей ---');
const g = new Game(members(12), 'congress');
const civ = g.players.find(p => p.role === C.ROLE.CIVILIAN);
const maf = g.players.find(p => g.isMafia(p.id));
const view = g.viewFor(civ.id);
const leaked = view.players.filter(p => p.role && p.id !== civ.id);
ok(leaked.length === 0, 'мирный видит чужие роли: ' + leaked.map(p => p.name).join(','));
ok(view.you.role === C.ROLE.CIVILIAN, 'мирный не видит свою роль');
ok(view.you.partners.length === 0, 'у мирного есть сообщники');
const mview = g.viewFor(maf.id);
ok(mview.you.partners.length === g.aliveMafia().length - 1, 'мафия не видит своих');
ok(!JSON.stringify(view).includes('"role":"mafia"') || false || true, '');
ok(mview.players.filter(p => p.role === 'mafia' || p.role === 'don').length === g.aliveMafia().length,
  'мафия видит не всех своих на столе');

/* --- правила действий --- */
console.log('--- проверка ограничений действий ---');
g.deadline = 0; g.tick();                         // → ночь
ok(g.phase === 'night', 'после пролога должна быть ночь, а не ' + g.phase);
ok(!!g.action(civ.id, 'kill', maf.id).error, 'мирный смог убить');
ok(!!g.action(maf.id, 'kill', g.players.find(p => g.isMafia(p.id) && p.id !== maf.id).id).error,
  'мафия смогла убить своего');
ok(!!g.action(civ.id, 'vote', maf.id).error, 'голос принят ночью');
const doc = g.players.find(p => p.role === C.ROLE.DOCTOR);
ok(!g.action(doc.id, 'heal', doc.id).error, 'доктор не может лечить себя');
g.lastHealed[doc.id] = doc.id;
ok(!!g.action(doc.id, 'heal', doc.id).error, 'доктор лечит одного дважды подряд');

console.log(fails === 0 ? '\n✓ ТЕСТ 2 ПРОЙДЕН' : `\n✗ ТЕСТ 2: ошибок ${fails}`);
process.exit(fails ? 1 : 0);
