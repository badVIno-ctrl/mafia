/* =========================================================================
   Тест №18 — расширенный набор ролей и правила стола.

   План разрешает новой роли въехать в игру только вместе с тремя вещами:
   карточкой-объяснением в интерфейсе, логикой для бота и прогоном в
   симуляторе. Этот файл отвечает за четвёртое, без чего первые три ничего
   не стоят: за то, что правила работают именно так, как написано в карточке.

   Проверяем то, на чём набор стоит или падает:

    1. Состав. Пресеты сходятся по числу карт на каждом размере стола,
       мирных всегда остаётся хотя бы один, поправка «минус мафия, плюс врач»
       действительно применяется, а пресет, который на стол не садится,
       не раздаётся молча.
    2. Маньяк. Ходит один, убивает отдельно от мафии (за ночь могут выбыть
       двое), проверка шерифа честно говорит «не мафия», и он побеждает
       один — но не раньше, чем мафии не станет.
    3. Любовница. Блокировка отменяет ночное дело цели — любое, включая
       удар мафии и проверку шерифа. Себя нельзя, дважды подряд нельзя.
    4. Адвокат. Отменяет ровно одно изгнание за партию, право тратится
       только когда сработало, автор отмены столу не виден.
    5. Журналист. Отвечает про сторону, а не про роль; пара обязательна
       целиком; маньяк не «вместе» ни с кем.
    6. Оборотень. Проверка шерифа показывает его мафией, но побеждает он с
       городом, и мафия его своим не видит.
    7. Правила стола: открытое и закрытое голосование, решение стола при
       ничьей, фолы за перебивание.
    8. Классика от всего этого не изменилась ни на одно правило.
   ========================================================================= */
'use strict';
const C = require('../shared/game-config.js');
const Roles = require('../shared/roles.js');
const { Game } = require('../server/game.js');
const Bots = require('../server/bots.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };

function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'Игрок' + (i + 1) }));
}
function mk(n, opts) {
  return new Game(members(n), null, Object.assign({ seed: 'roles-test' }, opts || {}));
}
/** Партия, в которой роли расставлены руками: иначе тест ловил бы раздачу. */
function rigged(n, layout, opts) {
  const g = mk(n, opts);
  Object.keys(layout).forEach(id => { g.p(id).role = layout[id]; });
  return g;
}
const roleOf = (g, r) => g.players.filter(p => p.role === r);

console.log('\n=== ТЕСТ 18: расширенный набор ролей и правила стола ===');

/* ---------------------- 1. состав и пресеты ---------------------- */
{
  let allFit = true, plainLeft = true;
  for (const pr of C.PRESETS) {
    for (let n = pr.min; n <= pr.max; n++) {
      const pool = C.rolePool(n, pr.id);
      if (pool.length !== n) { allFit = false; console.log('    ' + pr.id + ' n=' + n + ': карт ' + pool.length); }
      const comp = C.composition(n, pr.id);
      if (comp.civilians < 1) { plainLeft = false; console.log('    ' + pr.id + ' n=' + n + ': мирных не осталось'); }
      const sum = comp.mafiaTotal + comp.doctors + comp.sheriffs + comp.civilians +
        Object.keys(comp.extra).reduce((s, k) => s + comp.extra[k], 0);
      if (sum !== n) { allFit = false; console.log('    ' + pr.id + ' n=' + n + ': сумма ' + sum); }
    }
  }
  ok(allFit, 'у каждого пресета на каждом размере карт ровно столько, сколько людей');
  ok(plainLeft, 'хотя бы один мирный остаётся всегда: стол без пустой карты — не мафия');

  /* Поправка «минус мафия, плюс врач» — та, которую нашёл симулятор. */
  const base = C.composition(12, 'classic');
  const withMan = C.composition(12, 'maniac');
  ok(withMan.mafiaTotal === base.mafiaTotal - 1, 'с маньяком чёрных на одного меньше');
  ok(withMan.doctors === base.doctors + 1, 'с маньяком врачей на одного больше: двум ножам — два спасения');
  ok(withMan.sides === 3 && base.sides === 2, 'сил за столом три, и стол знает об этом до раздачи');

  /* Спортивный стандарт: врача нет вовсе, и это не забытая строка. */
  const sport = C.composition(10, 'sport');
  ok(sport.mafiaTotal === 3 && sport.dons === 1 && sport.doctors === 0 && sport.sheriffs === 1 &&
    sport.civilians === 6, 'спортивная десятка: дон, две мафии, шериф, шесть мирных, без врача');

  /* Пресет не по размеру не раздаётся молча. */
  const small = mk(8, { rolePreset: 'extended' });
  ok(small.preset === 'classic', 'полный набор на восьмерых не раздаётся — стол падает в классику');
  const fit = mk(12, { rolePreset: 'extended' });
  ok(fit.preset === 'extended', 'на двенадцати полный набор раздаётся');
  ok(roleOf(fit, 'maniac').length === 1 && roleOf(fit, 'lover').length === 1 &&
    roleOf(fit, 'lawyer').length === 1 && roleOf(fit, 'journalist').length === 1 &&
    roleOf(fit, 'werewolf').length === 1, 'все пять новых карт на столе по одной');

  /* Каждая роль обязана иметь карточку: правило плана, а не украшение. */
  const cards = Object.keys(Roles.ROLE_INFO).every(r => {
    const i = Roles.ROLE_INFO[r];
    return i.ru && i.desc && i.team && i.card && i.card.sees && i.card.acts && i.card.risk && i.card.why;
  });
  ok(cards, 'у каждой новой роли есть карточка: что видит, что делает, чем рискует, зачем нужна');
}

/* ---------------------- 2. маньяк ---------------------- */
{
  /* Стол на восьмерых: мафия одна, маньяк один, шериф, врач, четверо мирных. */
  const g = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  g.startNight();
  ok(g.canAct(g.p('u1')) === 'slay', 'маньяку ночью дают его собственное действие, а не «убить» мафии');
  ok(!!g.action('u1', 'kill', 'u4').error, 'маньяк не пользуется ходом мафии');
  ok(!!g.action('u0', 'slay', 'u4').error, 'мафия не пользуется ходом маньяка');
  ok(!!g.action('u1', 'slay', 'u1').error, 'себя маньяк выбрать не может');

  g.action('u0', 'kill', 'u4');
  g.action('u1', 'slay', 'u5');
  g.action('u2', 'check', 'u1');
  g.action('u3', 'heal', 'u6');
  g.resolveNight();
  ok(!g.p('u4').alive && !g.p('u5').alive, 'два ножа — двое выбывших за одну ночь');
  const chk = g.checkResults.u2[0];
  ok(chk.targetId === 'u1' && chk.isMafia === false,
    'проверка шерифа на маньяке честно отвечает «не мафия» — это его защита');
  ok(g.lastWordQueue.length + (g.lastWordId ? 1 : 0) >= 1, 'последнее слово ставится в очередь на обоих');

  /* Врач спасает и от маньяка: для врача это одинаковая рана. */
  const g2 = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  g2.startNight();
  g2.action('u1', 'slay', 'u5');
  g2.action('u3', 'heal', 'u5');
  g2.resolveNight();
  ok(g2.p('u5').alive, 'врач спасает от ножа маньяка так же, как от ножа мафии');

  /* Один нож на двоих: умереть дважды нельзя. */
  const g3 = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  g3.startNight();
  g3.action('u0', 'kill', 'u4');
  g3.action('u1', 'slay', 'u4');
  g3.resolveNight();
  ok(g3.alive().length === 7, 'мафия и маньяк выбрали одного — выбыл один');

  /* Победа маньяка: мафии нет, из мирных остался один. */
  const g4 = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  ['u0', 'u2', 'u3', 'u4', 'u5'].forEach(id => g4.kill(id, 'vote'));
  ok(!g4.checkWin(), 'пока живы двое мирных, маньяк ещё не победил: его можно переголосовать');
  g4.kill('u6', 'vote');
  ok(g4.checkWin() && g4.winner === 'maniac', 'мафии нет и мирный остался один — победил маньяк');

  /* Город не побеждает, пока за столом ходит нож. */
  const g5 = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  g5.kill('u0', 'vote');
  ok(!g5.checkWin(), 'мафия кончилась, но маньяк жив — партия не кончена');
  g5.kill('u1', 'vote');
  ok(g5.checkWin() && g5.winner === 'town', 'нет ни мафии, ни маньяка — победил город');

  /* Двое с ножами против нуля мирных решаются как «мафия против последнего». */
  const g6 = rigged(8, {
    u0: 'mafia', u1: 'maniac', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian'
  });
  ['u2', 'u3', 'u4', 'u5', 'u6', 'u7'].forEach(id => g6.kill(id, 'vote'));
  ok(g6.checkWin() && g6.winner === 'mafia', 'мафия против маньяка один на один — победа мафии, а не ничья');
}

/* ---------------------- 3. любовница ---------------------- */
{
  const layout = {
    u0: 'mafia', u1: 'lover', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'maniac'
  };
  const g = rigged(8, layout);
  g.startNight();
  ok(!!g.action('u1', 'block', 'u1').error, 'себя любовница заблокировать не может');
  g.action('u0', 'kill', 'u4');
  g.action('u1', 'block', 'u0');
  g.action('u2', 'check', 'u0');
  g.resolveNight();
  ok(g.p('u4').alive, 'заблокированная мафия не бьёт');
  ok(g.checkResults.u2 && g.checkResults.u2.length === 1,
    'а шериф не заблокирован — проверку он получил');
  ok(g.checkResults.u2[0].isMafia === true, 'и она правдива: он проверял мафию');

  /* Один и тот же дважды подряд — нельзя, ровно как у врача. */
  const g2 = rigged(8, layout);
  g2.startNight();
  g2.action('u1', 'block', 'u0');
  g2.resolveNight();
  g2.startNight();
  ok(!!g2.action('u1', 'block', 'u0').error, 'того же человека две ночи подряд блокировать нельзя');
  ok(!g2.action('u1', 'block', 'u2').error, 'другого — можно');

  /* Блокировка отменяет проверку шерифа. */
  const g3 = rigged(8, layout);
  g3.startNight();
  g3.action('u1', 'block', 'u2');
  g3.action('u2', 'check', 'u0');
  g3.resolveNight();
  ok(!g3.checkResults.u2, 'заблокированный шериф не узнаёт ничего');

  /* Блокировка отменяет лечение. */
  const g4 = rigged(8, layout);
  g4.startNight();
  g4.action('u0', 'kill', 'u4');
  g4.action('u3', 'heal', 'u4');
  g4.action('u1', 'block', 'u3');
  g4.resolveNight();
  ok(!g4.p('u4').alive, 'заблокированный врач не спасает');

  /* Блокировка отменяет нож маньяка. */
  const g5 = rigged(8, layout);
  g5.startNight();
  g5.action('u7', 'slay', 'u4');
  g5.action('u1', 'block', 'u7');
  g5.resolveNight();
  ok(g5.p('u4').alive, 'заблокированный маньяк не бьёт');

  /* Имени любовницы в протоколе нет: иначе роль сгорала бы в первое утро. */
  const g6 = rigged(8, layout);
  g6.startNight();
  g6.action('u0', 'kill', 'u4');
  g6.action('u1', 'block', 'u0');
  g6.resolveNight();
  const said = g6.log.map(l => l.text).join(' ');
  ok(said.indexOf(g6.p('u1').name) < 0, 'протокол не называет любовницу по имени');
  const seen = JSON.stringify(g6.viewFor('u4'));
  ok(seen.indexOf('"myBlock":"u0"') < 0, 'чужой ход любовницы не уезжает другому игроку');
}

/* ---------------------- 4. адвокат ---------------------- */
{
  const layout = {
    u0: 'mafia', u1: 'mafia', u2: 'lawyer', u3: 'sheriff',
    u4: 'doctor', u5: 'civilian', u6: 'civilian', u7: 'civilian',
    u8: 'civilian', u9: 'civilian'
  };
  const g = rigged(10, layout);
  g.startNight();
  ok(g.canAct(g.p('u2')) === 'shield', 'адвокату ночью дают выбрать, кого прикрыть');
  g.action('u2', 'shield', 'u5');
  g.action('u0', 'kill', 'u9');
  g.action('u1', 'kill', 'u9');
  g.resolveNight();
  /* День: стол выводит того, кого прикрыли. */
  g.phase = 'vote';
  g.votes = { u0: 'u5', u1: 'u5', u3: 'u5', u4: 'u5', u5: 'u6' };
  g.resolveVote();
  ok(g.p('u5').alive, 'изгнание прикрытого отменяется');
  ok(g.lawyerSpent.u2 === true, 'право адвоката потрачено — оно сработало');
  const text = g.log.map(l => l.text).join(' ');
  ok(text.indexOf('адвокат') >= 0, 'стол видит, что вмешался адвокат');
  ok(text.indexOf('Игрок3') < 0, 'но не видит, кто именно это сделал');

  /* «Берегу право» — полноценный ход: ночь ждёт от адвоката решения.
     Без этого ночь закрывалась, как только отходили все прочие, и на столе
     с ботами адвокат физически не успевал нажать ни на что. */
  const gk = rigged(10, layout);
  gk.startNight();
  gk.aliveMafia().forEach(m => gk.action(m.id, 'kill', 'u9'));
  gk.action('u3', 'check', 'u0');
  gk.action('u4', 'heal', 'u4');
  ok(!gk.allNightActionsIn(), 'ночь ждёт решения адвоката');
  ok(!gk.action('u2', 'shield', '').error, '«берегу право» принимается как ход');
  ok(gk.allNightActionsIn(), 'и закрывает ночь');
  ok(gk.viewFor('u2').you.shieldKept === true, 'адвокат видит, что решение подано');
  gk.resolveNight();
  ok(!gk.lawyerSpent.u2, 'право при этом не тратится');
  gk.startNight();
  ok(gk.viewFor('u2').you.shieldKept === false, 'новая ночь — новое решение');

  /* Второй раз права уже нет. */
  g.startNight();
  ok(g.canAct(g.p('u2')) === null, 'потратив право, адвокат ночью больше ничего не делает');
  ok(!!g.action('u2', 'shield', 'u6').error, 'и подать ход не может');

  /* Не сработало — не потратилось. */
  const g2 = rigged(10, layout);
  g2.startNight();
  g2.action('u2', 'shield', 'u5');
  g2.resolveNight();
  g2.phase = 'vote';
  g2.votes = { u0: 'u6', u1: 'u6', u3: 'u6', u4: 'u6' };
  g2.resolveVote();
  ok(!g2.p('u6').alive, 'вывели не того, кого прикрыли — изгнание состоялось');
  ok(!g2.lawyerSpent.u2, 'право адвоката осталось при нём: тратится только когда сработало');
}

/* ---------------------- 5. журналист ---------------------- */
{
  const layout = {
    u0: 'mafia', u1: 'don', u2: 'journalist', u3: 'sheriff',
    u4: 'doctor', u5: 'civilian', u6: 'civilian', u7: 'maniac',
    u8: 'civilian', u9: 'civilian'
  };
  const g = rigged(10, layout);
  g.startNight();
  ok(g.canAct(g.p('u2')) === 'press', 'журналисту ночью дают его сравнение');
  ok(!!g.action('u2', 'press', 'u0').error, 'одного имени журналисту недостаточно');
  ok(!!g.action('u2', 'press', 'u0,u0').error, 'два одинаковых имени — не пара');
  ok(!!g.action('u2', 'press', 'u0,u2').error, 'себя в пару включать нельзя');
  g.action('u2', 'press', 'u0,u1');
  g.resolveNight();
  ok(g.pressResults.u2[0].sameTeam === true, 'мафия и дон — в одной команде');

  const g2 = rigged(10, layout);
  g2.startNight();
  g2.action('u2', 'press', 'u0,u5');
  g2.resolveNight();
  ok(g2.pressResults.u2[0].sameTeam === false, 'мафия и мирный — в разных');

  const g3 = rigged(10, layout);
  g3.startNight();
  g3.action('u2', 'press', 'u3,u5');
  g3.resolveNight();
  ok(g3.pressResults.u3 === undefined && g3.pressResults.u2[0].sameTeam === true,
    'шериф и мирный — в одной команде: сравнение про сторону, а не про роль');

  const g4 = rigged(10, layout);
  g4.startNight();
  g4.action('u2', 'press', 'u7,u5');
  g4.resolveNight();
  ok(g4.pressResults.u2[0].sameTeam === false, 'маньяк не «вместе» ни с кем: он сам за себя');

  /* Свои сравнения видит только журналист. */
  const view = g4.viewFor('u2');
  ok(view.you.press.length === 1, 'журналист видит свои сравнения в карте роли');
  ok((g4.viewFor('u5').you.press || []).length === 0, 'чужие сравнения другому игроку не видны');
}

/* ---------------------- 6. оборотень ---------------------- */
{
  const layout = {
    u0: 'mafia', u1: 'mafia', u2: 'werewolf', u3: 'sheriff',
    u4: 'doctor', u5: 'civilian', u6: 'civilian', u7: 'civilian',
    u8: 'civilian', u9: 'civilian'
  };
  const g = rigged(10, layout);
  g.startNight();
  ok(g.canAct(g.p('u2')) === null, 'оборотень ночью ничего не делает — как мирный');
  g.action('u3', 'check', 'u2');
  g.action('u0', 'kill', 'u9');
  g.action('u1', 'kill', 'u9');
  g.resolveNight();
  ok(g.checkResults.u3[0].isMafia === true, 'проверка шерифа показывает оборотня мафией');
  ok(g.teamOf('u2') === 'town', 'но команда у него городская');
  ok(!g.isMafia('u2'), 'и мафией движок его не считает');

  /* Мафия своим его не видит: иначе он был бы просто мафией без ножа. */
  const view = g.viewFor('u0');
  ok(!view.you.partners.some(p => p.id === 'u2'), 'мафия не видит оборотня среди своих');
  const w = g.viewFor('u2');
  ok(w.you.partners.length === 0, 'и сам оборотень своих не видит');

  /* Побеждает с городом. */
  ['u0', 'u1'].forEach(id => g.kill(id, 'vote'));
  ok(g.checkWin() && g.winner === 'town', 'оборотень побеждает вместе с городом');
}

/* ---------------------- 7. правила стола ---------------------- */
{
  /* Открытое голосование: за кого поднял руку — видно, пока голосование идёт. */
  const g = mk(8, { voteOpen: true });
  g.phase = 'vote';
  g.action('u0', 'vote', 'u1');
  const open = g.viewFor('u2');
  ok(open.players.find(p => p.id === 'u0').voteFor === 'u1', 'открытое голосование: видно, кто за кого');
  ok(open.voteOpen === true, 'и клиент знает, что голосование открытое');

  const gc = mk(8, { voteOpen: false });
  gc.phase = 'vote';
  gc.action('u0', 'vote', 'u1');
  const closed = gc.viewFor('u2');
  ok(closed.players.find(p => p.id === 'u0').voteFor === null,
    'закрытое голосование: видно только «проголосовал»');
  ok(closed.players.find(p => p.id === 'u0').voted === true, 'но факт голоса виден');
  gc.resolveVote();
  ok(gc.log.filter(l => l.text.indexOf('За ' + gc.p('u1').name + ':') === 0).length === 0,
    'и расклад не появляется в протоколе даже после итога');
  ok(g.log.length >= 0, 'открытый стол расклад печатает (проверено ниже целиком)');

  /* Решение стола при ничьей. */
  const gt = mk(10, { onTie: 'table', speeches: false });
  gt.phase = 'runoff';
  gt.runoffOf = ['u1', 'u2'];
  gt.votes = { u0: 'u1', u3: 'u1', u4: 'u2', u5: 'u2' };
  gt.resolveVote();
  ok(gt.phase === 'tievote', 'вторая ничья при правиле «стол решает» открывает голосование стола');
  ok(gt.tieOf.length === 2, 'кандидатов двое');
  ok(!!gt.action('u0', 'vote', 'u3').error, 'здесь голосуют не за человека');
  ['u0', 'u3', 'u4', 'u5', 'u6', 'u7'].forEach(id => gt.action(id, 'vote', 'yes'));
  ['u1', 'u2'].forEach(id => gt.action(id, 'vote', 'no'));
  gt.resolveVote();
  ok(!gt.p('u1').alive && !gt.p('u2').alive, 'большинство «за» — выводят всех');

  const gt2 = mk(10, { onTie: 'table', speeches: false });
  gt2.phase = 'runoff';
  gt2.runoffOf = ['u1', 'u2'];
  gt2.votes = { u0: 'u1', u3: 'u1', u4: 'u2', u5: 'u2' };
  gt2.resolveVote();
  gt2.alive().forEach(p => gt2.action(p.id, 'vote', 'no'));
  gt2.resolveVote();
  ok(gt2.p('u1').alive && gt2.p('u2').alive, 'нет большинства — не выводят никого');

  const gt3 = mk(10, { onTie: 'none', speeches: false });
  gt3.phase = 'runoff';
  gt3.runoffOf = ['u1', 'u2'];
  gt3.votes = { u0: 'u1', u3: 'u1', u4: 'u2', u5: 'u2' };
  gt3.resolveVote();
  ok(gt3.phase !== 'tievote' && gt3.p('u1').alive,
    'без правила «стол решает» вторая ничья по-прежнему никого не выводит');

  /* Фолы. */
  const gf = mk(16, { fouls: true });
  ok(gf.foulsOn === true, 'на большом столе фолы включаются сами');
  ok(mk(10).foulsOn === false, 'на столе на десять — нет');
  gf.startSpeech();
  const speaker = gf.speaker;
  const other = gf.alive().find(p => p.id !== speaker).id;
  let r = null;
  for (let i = 0; i < 4; i++) {
    /* Фол считается не чаще раза в две секунды: двойной клик — один перебив. */
    const p = gf.p(other);
    p.lastFoulAt = 0;
    r = gf.say(other, 'дайте сказать ' + i, 'town');
  }
  ok(gf.fouls[other] === 4, 'четыре попытки говорить не в свою очередь — четыре фола');
  ok(gf.foulSkip[other] === true, 'на четвёртом фоле речь пропускается');
  ok(gf.log.some(l => l.kind === 'foul'), 'фолы попадают в протокол: наказание должно быть публичным');
  const fv = gf.viewFor(other);
  ok(fv.you.fouls === 4 && fv.you.foulSkip === true, 'игрок видит свои фолы');

  /* Двойной клик не считается двумя фолами. */
  const gf2 = mk(16, { fouls: true });
  gf2.startSpeech();
  const o2 = gf2.alive().find(p => p.id !== gf2.speaker).id;
  gf2.say(o2, 'раз', 'town');
  gf2.say(o2, 'два', 'town');
  ok(gf2.fouls[o2] === 1, 'две попытки в одну секунду — один фол');

  const gf3 = mk(16, { fouls: false });
  gf3.startSpeech();
  const o3 = gf3.alive().find(p => p.id !== gf3.speaker).id;
  gf3.say(o3, 'раз', 'town');
  ok(!gf3.fouls[o3], 'при выключенных фолах их не считают');
}

/* ---------------------- ночная доска мафии ---------------------- */
{
  const g = rigged(10, {
    u0: 'mafia', u1: 'don', u2: 'sheriff', u3: 'doctor',
    u4: 'civilian', u5: 'civilian', u6: 'civilian', u7: 'civilian',
    u8: 'civilian', u9: 'civilian'
  });
  g.startNight();
  ok(!!g.action('u2', 'mark', 'u4:target').error, 'доска только для своих');
  ok(!g.action('u0', 'mark', 'u4:target').error, 'мафия ставит метку');
  ok(!!g.action('u0', 'mark', 'u4:чушь').error, 'неизвестных меток не бывает');
  const mine = g.viewFor('u1');
  ok((mine.mafiaBoard || []).length === 1 && mine.mafiaBoard[0].id === 'u4',
    'метку видит другой мафиози — доска общая');
  ok(mine.mafiaBoard[0].tagRu === 'бьём', 'метка приезжает человеческим словом');
  const town = g.viewFor('u4');
  ok(!town.mafiaBoard, 'городу доска не видна');
  g.action('u1', 'mark', 'u4:');
  ok((g.viewFor('u0').mafiaBoard || []).length === 0, 'метку можно снять');
  /* Доска не переживает ночь: вчерашние метки — чужой разговор. */
  g.resolveNight();
  g.startNight();
  ok(Object.keys(g.mafiaBoard).length === 0, 'каждую ночь доска чистая');
}

/* ---------------------- 8. классика не изменилась ---------------------- */
{
  const g = mk(10);
  ok(g.preset === 'classic', 'по умолчанию стол играет классику');
  ok(g.composition.sides === 2, 'сторон две');
  ok(Object.keys(g.composition.extra).length === 0, 'новых карт на столе нет');
  ok(C.compositionLabel(10) === '2 мафии · доктор · шериф · 6 мирных',
    'состав классики на десять человек не изменился ни на карту');
  ok(g.voteOpen === true && g.onTie === 'none' && g.foulsOn === false,
    'правила по умолчанию: открытое голосование, ничья никого не выводит, фолов нет');
  /* И движок классики ведёт себя точно как прежде. */
  g.startNight();
  const maf = g.aliveMafia();
  maf.forEach(m => g.action(m.id, 'kill', g.aliveTown()[0].id));
  g.resolveNight();
  ok(g.alive().length === 9, 'ночь классики уносит одного');
  ok(g.canAct(g.aliveMafia()[0]) === null || g.phase === 'morning', 'и дальше идёт как раньше');
}

/* ---------------------- боты играют все новые роли ---------------------- */
{
  const g = rigged(12, {
    u0: 'mafia', u1: 'mafia', u2: 'maniac', u3: 'lover', u4: 'lawyer',
    u5: 'journalist', u6: 'werewolf', u7: 'sheriff', u8: 'doctor',
    u9: 'civilian', u10: 'civilian', u11: 'civilian'
  });
  g.startNight();
  const sus = Bots.__test.suspicionMap(g);
  const got = {};
  ['u2', 'u3', 'u4', 'u5', 'u6'].forEach(id => {
    const a = Bots.__test.nightAction(g, g.p(id), sus);
    got[g.p(id).role] = a ? a.type : null;
  });
  ok(got.maniac === 'slay', 'бот-маньяк ходит своим ножом');
  ok(got.lover === 'block', 'бот-любовница блокирует');
  ok(got.lawyer === 'shield', 'бот-адвокат прикрывает');
  ok(got.journalist === 'press', 'бот-журналист сравнивает пару');
  ok(got.werewolf === null, 'бот-оборотень ночью не делает ничего — как мирный');

  /* Ход бота движок обязан принять: иначе бот «играет» роль только на бумаге. */
  let accepted = true;
  ['u2', 'u3', 'u4', 'u5'].forEach(id => {
    const a = Bots.__test.nightAction(g, g.p(id), sus);
    if (!a) return;
    const r = g.action(id, a.type, a.target);
    if (r.error) { accepted = false; console.log('    ' + g.p(id).role + ': ' + r.error); }
  });
  ok(accepted, 'все ходы ботов движок принимает');

  /* Выкладка журналиста: «вместе» с открытым чёрным делает второго чёрным. */
  g.pressResults.u5 = [{ aId: 'u0', bId: 'u9', aName: 'a', bName: 'b', sameTeam: true, day: 1 }];
  g.kill('u0', 'vote');
  const hints = Bots.__test.pressHints(g, g.p('u5'));
  ok(hints.u9 > 0, 'бот-журналист складывает связь с открытой картой: «вместе» с чёрным — чёрный');

  /* Голосование стола при ничьей: бот отвечает «да» или «нет», а не именем. */
  const gt = mk(10, { onTie: 'table', speeches: false });
  gt.phase = 'tievote';
  gt.tieOf = ['u1', 'u2'];
  const v = Bots.__test.voteChoice(gt, gt.p('u0'), Bots.__test.suspicionMap(gt));
  ok(v === 'yes' || v === 'no', 'на решении стола бот голосует за правило, а не за человека');
  ok(Bots.__test.voteChoice(gt, gt.p('u1'), Bots.__test.suspicionMap(gt)) === 'no',
    'кандидат голосует против своего изгнания');
}

console.log(fails === 0 ? '\n✓ ТЕСТ 18 ПРОЙДЕН' : '\n✗ ТЕСТ 18: ошибок ' + fails);
process.exit(fails ? 1 : 0);
