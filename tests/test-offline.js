/* =========================================================================
   Тест №7 — устойчивость к обрывам связи.

   Проверяем главное обещание: один закрытый ноутбук не должен держать
   всю партию. До этой правки фаза ждала хода от каждого живого игрока
   и закрывалась только по таймауту — со стороны это выглядело как лаги.
   ========================================================================= */
'use strict';
const { Game } = require('../server/game.js');
const C = require('../shared/game-config.js');

let fails = 0;
function ok(cond, msg) { if (!cond) { fails++; console.log('  FAIL: ' + msg); } else console.log('  ✓ ' + msg); }

console.log('\n=== ТЕСТ 7: обрывы связи не держат фазу ===');

function members(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: 'u' + i, name: 'Игрок' + i });
  return out;
}

/* ---- 1. ночь закрывается, если единственный отставший пропал со связи ---- */
const g = new Game(members(8), 'deck');
g.startNight();
const mafia = g.aliveMafia();
const doc = g.alive().find(p => p.role === C.ROLE.DOCTOR);
const sher = g.alive().find(p => p.role === C.ROLE.SHERIFF);
const victim = g.alive().find(p => p.role === C.ROLE.CIVILIAN);

mafia.forEach(m => g.action(m.id, 'kill', victim.id));
g.action(doc.id, 'heal', doc.id);
ok(g.allNightActionsIn() === false, 'пока шериф не сходил, ночь не закрывается');

g.setOffline([sher.id]);
ok(g.allNightActionsIn() === true, 'шериф без связи — ночь закрывается сразу');
ok(g.log.some(l => l.text.indexOf('потерял связь') >= 0), 'обрыв связи попал в протокол');

g.resolveNight();
ok(g.phase === 'morning', 'после разрешения ночи наступило утро');

/* ---- 2. вернулся на связь — снова его ждём ---- */
const g2 = new Game(members(8), 'deck');
g2.startNight();
g2.setOffline([g2.players[0].id]);
ok(g2.offline.size === 1, 'отключившийся учтён');
const changed = g2.setOffline([]);
ok(changed === true, 'возвращение на связь — тоже изменение состава');
ok(g2.log.some(l => l.text.indexOf('снова на связи') >= 0), 'возвращение видно в протоколе');
ok(g2.setOffline([]) === false, 'повторный вызов с тем же составом ничего не меняет');

/* ---- 3. день не ждёт того, кого нет ---- */
const g3 = new Game(members(6), 'deck');
g3.startDay();
const alive3 = g3.alive();
alive3.slice(1).forEach(p => g3.action(p.id, 'ready', null));
ok(g3.tick() === false, 'один не нажал «готов» — день продолжается');
g3.setOffline([alive3[0].id]);
ok(g3.tick() === true, 'он же без связи — день закрывается');
ok(g3.phase === 'vote', 'после дня началось голосование');

/* ---- 4. голосование не ждёт отключившихся ---- */
const g4 = new Game(members(6), 'deck');
g4.startVote();
const alive4 = g4.alive();
alive4.slice(2).forEach(p => g4.action(p.id, 'vote', 'skip'));
ok(g4.phase === 'vote' && g4.tick() === false, 'двое не голосовали — ждём');
g4.setOffline(alive4.slice(0, 2).map(p => p.id));
ok(g4.tick() === true, 'оба без связи — голосование закрывается');

/* ---- 5. если на связи вообще никого, ночь ждёт таймаут ---- */
const g5 = new Game(members(6), 'deck');
g5.startNight();
g5.setOffline(g5.players.map(p => p.id));
ok(g5.allNightActionsIn() === false, 'пустой стол не «закрывает» ночь мгновенно');

/* ---- 6. признак offline виден в виде игрока ---- */
const g6 = new Game(members(6), 'deck');
g6.setOffline([g6.players[2].id]);
const view = g6.viewFor(g6.players[0].id);
ok(view.players[2].offline === true, 'клиент видит, кто без связи');
ok(view.players[0].offline === false, 'остальные помечены как на связи');

console.log(fails === 0 ? '\n✓ ТЕСТ 7 ПРОЙДЕН' : '\n✗ ТЕСТ 7: ошибок ' + fails);
process.exit(fails ? 1 : 0);
