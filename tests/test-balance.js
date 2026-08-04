/* Тест №1 — баланс ролей и сюжеты */
const C = require('../shared/game-config.js');

let fails = 0;
function ok(cond, msg) {
  if (!cond) { fails++; console.log('  FAIL: ' + msg); }
}

console.log('\n=== ТЕСТ 1: состав и баланс (6–20 игроков) ===');
const rows = [];
for (let n = C.MIN_PLAYERS; n <= C.MAX_PLAYERS; n++) {
  const c = C.composition(n);
  const pool = C.rolePool(n);
  const town = c.doctors + c.sheriffs + c.civilians;

  ok(pool.length === n, `n=${n}: в колоде ролей ${pool.length}, ожидалось ${n}`);
  ok(c.mafiaTotal + town === n, `n=${n}: сумма ролей не сходится`);
  ok(c.mafiaTotal >= 1, `n=${n}: нет мафии`);
  ok(town > c.mafiaTotal, `n=${n}: город не больше мафии (игра началась бы победой мафии)`);
  ok(c.mafiaTotal / n <= 0.3, `n=${n}: мафии больше 30 %`);
  ok(c.mafiaTotal / n >= 0.16, `n=${n}: мафии меньше 16 %`);
  ok((c.doctors + c.sheriffs) / town <= 0.4, `n=${n}: слишком много сильных ролей города`);
  ok(c.civilians >= 3, `n=${n}: мало мирных`);
  ok(C.scenariosFor(n).length >= 1, `n=${n}: нет ни одного сюжета`);

  rows.push([n, c.mafiaTotal + (c.dons ? ' (в т.ч. дон)' : ''), c.doctors, c.sheriffs, c.civilians,
    (100 * c.mafiaTotal / n).toFixed(0) + '%', C.scenariosFor(n).length].join('\t'));
}
console.log('игроков\tмафия\tдокт\tшериф\tмирн\tдоля\tсюжетов');
rows.forEach(r => console.log(r));

console.log('\nСюжеты на 20 игроков: ' + C.scenariosFor(20).map(s => s.title).join(', '));
console.log('Подпись состава 20: ' + C.compositionLabel(20));
console.log('Подпись состава 6: ' + C.compositionLabel(6));

// границы
ok(C.composition(3).players === 6, 'кламп снизу не работает');
ok(C.composition(50).players === 20, 'кламп сверху не работает');
ok(C.SCENARIOS.every(s => s.min >= 6 && s.max <= 20 && s.min <= s.max), 'некорректные границы сюжета');
ok(new Set(C.SCENARIOS.map(s => s.id)).size === C.SCENARIOS.length, 'дублируются id сюжетов');

console.log(fails === 0 ? '\n✓ ТЕСТ 1 ПРОЙДЕН' : `\n✗ ТЕСТ 1: ошибок ${fails}`);
process.exit(fails ? 1 : 0);
