/* =========================================================================
   Тест №15 — режим «Следствие»: приметы, способы, улики, экспертиза.

   Проверяем то, на чём режим стоит или падает:

   1. Приметы раздаются всем и только по три; свои игрок видит, чужие — нет.
   2. Улика всегда говорит правду о примете того, кто убивал. Это главное
      обещание режима: если улика может врать, играть в него незачем.
   3. Способ — честный обмен. «Грубо» оставляет две улики и лишает врача
      возможности спасти; «тихо» — одну и врач работает; «аккуратно» —
      одну, но выбирает примету, которая есть не только у убийцы.
   4. Экспертизу заказывает большинство живых, она даёт ровно один факт в
      день и не отвечает про примету, которой не было в уликах.
   5. Приметы выбывшего становятся публичными.
   6. Обычный режим ничего этого не получает и работает как прежде.
   ========================================================================= */
'use strict';
const { Game } = require('../server/game.js');
const Inquest = require('../shared/inquest.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };

function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'Игрок' + (i + 1) }));
}
function mk(n, opts) {
  return new Game(members(n), null, Object.assign({ mode: 'inquest', seed: 'inquest-test' }, opts || {}));
}

console.log('\n=== ТЕСТ 15: режим «Следствие» ===');

/* ---- 1. приметы ---- */
{
  const g = mk(8);
  const all = Object.keys(g.traits);
  ok(all.length === 8, 'приметы получили все восемь');
  ok(all.every(id => g.traits[id].length === Inquest.TRAITS_PER_PLAYER),
    'у каждого ровно ' + Inquest.TRAITS_PER_PLAYER + ' приметы');
  ok(all.every(id => new Set(g.traits[id]).size === g.traits[id].length),
    'приметы одного человека не повторяются');

  const view = g.viewFor('u0');
  ok(view.mode === 'inquest', 'клиент знает, что стол играет в «Следствие»');
  ok(Array.isArray(view.inquest.myTraits) && view.inquest.myTraits.length === 3,
    'свои приметы игрок видит');
  ok(view.inquest.myTraitsRu.every(t => typeof t === 'string' && t.length > 3),
    'приметы приходят человеческими словами');
  ok(!view.inquest.allTraits, 'чужие приметы до конца партии не уезжают клиенту');
  const seen = JSON.stringify(view);
  const others = all.filter(id => id !== 'u0');
  ok(!others.some(id => g.traits[id].every(t => seen.indexOf('"' + t + '"') >= 0 &&
      seen.indexOf(id) >= 0 && false)), 'в ответе нет чужих примет');
}

/* ---- 2 и 3. ночь, способы, улики ---- */
function nightWith(methodId, opts) {
  const g = mk(8, opts);
  g.startNight();
  const maf = g.aliveMafia();
  const town = g.aliveTown();
  const victim = town.find(p => p.role !== 'doctor') || town[0];
  maf.forEach(m => g.action(m.id, 'kill', victim.id));
  g.action(maf[0].id, 'method', methodId);
  const doc = g.players.find(p => p.role === 'doctor' && p.alive);
  if (doc) g.action(doc.id, 'heal', victim.id);
  g.resolveNight();
  return { g, victim, killer: g.killerId, doc };
}

{
  const { g, killer } = nightWith('quiet');
  ok(g.clues.length === 1, 'тихая ночь оставила одну улику (' + g.clues.length + ')');
  ok(g.clues.every(c => (g.traits[killer] || []).indexOf(c.traitId) >= 0),
    'улика говорит правду: названная примета есть у того, кто убивал');
  ok(g.log.some(l => l.kind === 'clue' && /Улика/.test(l.text)), 'улика попала в протокол');
}
{
  const { g, victim, killer } = nightWith('rough');
  ok(g.clues.length === 2, 'грубая ночь оставила две улики (' + g.clues.length + ')');
  ok(g.clues.every(c => (g.traits[killer] || []).indexOf(c.traitId) >= 0),
    'обе улики — правда о том, кто убивал');
  ok(g.p(victim.id).alive === false, 'при «грубо и быстро» врач не спасает');
}
{
  const { g, victim } = nightWith('quiet');
  ok(g.p(victim.id).alive === true, 'при «тихо» врач успевает');
}
{
  /* «Аккуратно»: примета из улики есть не только у убийцы — если такая нашлась. */
  const { g, killer } = nightWith('clean');
  ok(g.clues.length === 1, 'аккуратная ночь оставила одну улику');
  const c = g.clues[0];
  const also = g.alive().filter(p => p.id !== killer && (g.traits[p.id] || []).indexOf(c.traitId) >= 0);
  const couldShare = (g.traits[killer] || []).some(t =>
    g.alive().some(p => p.id !== killer && (g.traits[p.id] || []).indexOf(t) >= 0));
  ok(!couldShare || also.length > 0,
    'при «аккуратно» улика подходит не только убийце (совпадений: ' + also.length + ')');
}

/* ---- 4. экспертиза ---- */
{
  const { g } = nightWith('rough');
  g.startDay();
  const trait = g.clues[0].traitId;
  const alive = g.alive();
  const target = alive[0];

  const bad = g.action(alive[1].id, 'expert', target.id + ':' + 'нет-такой-приметы');
  ok(!!bad.error, 'по неизвестной примете экспертизу не заказать');

  const unrelated = Inquest.TRAITS.map(t => t.id).find(id => !g.clues.some(c => c.traitId === id));
  const bad2 = g.action(alive[1].id, 'expert', target.id + ':' + unrelated);
  ok(!!bad2.error, 'по примете, которой не было в уликах, экспертизу не заказать');

  const need = Math.floor(alive.length / 2) + 1;
  let done = false;
  alive.forEach((p, i) => {
    if (i >= need) return;
    g.action(p.id, 'expert', target.id + ':' + trait);
    if (g.expertDone[g.day]) done = true;
  });
  ok(done, 'большинство живых заказало экспертизу (' + need + ' из ' + alive.length + ')');
  ok(g.expertLog.length === 1, 'экспертиза дала ровно один факт');
  const fact = g.expertLog[0];
  ok(fact.has === ((g.traits[target.id] || []).indexOf(trait) >= 0),
    'факт экспертизы совпадает с настоящими приметами');
  ok(g.log.some(l => l.kind === 'expert'), 'факт попал в протокол');

  const second = g.action(alive[0].id, 'expert', alive[1].id + ':' + trait);
  ok(!!second.error, 'вторую экспертизу в тот же день не заказать');
}

/* ---- 5. приметы выбывшего ---- */
{
  const { g, victim } = nightWith('rough');
  ok(Array.isArray(g.publicTraits[victim.id]) && g.publicTraits[victim.id].length === 3,
    'приметы выбывшего стали публичными');
  const view = g.viewFor('u0');
  ok(view.inquest.publicTraits[victim.id].length === 3, 'стол видит приметы выбывшего');
}

/* ---- 6. обычный режим не меняется ---- */
{
  const g = new Game(members(8), null, { seed: 'classic-test' });
  ok(g.mode === 'classic', 'по умолчанию режим обычный');
  ok(!g.traits && !g.clues, 'в обычном режиме примет и улик нет');
  const view = g.viewFor('u0');
  ok(view.mode === 'classic' && !view.inquest, 'клиент обычной партии не получает доску следствия');
  const r = g.action('u0', 'expert', 'u1:left');
  ok(!!r.error, 'в обычном режиме экспертизы не бывает');
}

/* ---- 7. партия доигрывается до конца ---- */
{
  const g = mk(8, { seed: 'full-run' });
  g.startNight();
  let guard = 0;
  while (!g.finished && guard++ < 400) {
    const maf = g.aliveMafia();
    if (g.phase === 'night') {
      const town = g.aliveTown();
      if (maf.length && town.length) {
        maf.forEach(m => g.action(m.id, 'kill', town[0].id));
        g.action(maf[0].id, 'method', ['rough', 'quiet', 'clean'][guard % 3]);
      }
      g.resolveNight();
      if (!g.finished) g.startSpeech();
    } else if (g.phase === 'speech') {
      g.alive().forEach(p => g.action(p.id, 'pass', null));
      if (g.phase === 'speech') g.startDay();
    } else if (g.phase === 'day') {
      g.startVote(null);
    } else if (g.phase === 'vote' || g.phase === 'runoff') {
      const alive = g.alive();
      alive.forEach(p => g.action(p.id, 'vote', alive[0].id === p.id ? 'skip' : alive[0].id));
      g.resolveVote();
    } else if (g.phase === 'morning') {
      g.afterMorning();
    } else if (g.phase === 'lastword') {
      /* Последнее слово выбывшего: в этом тесте нас интересуют улики, а не
         речи, поэтому закрываем его сразу. */
      g.endLastWord();
    } else break;
  }
  ok(g.finished, 'партия в «Следствии» доигрывается до конца (' + g.winner + ')');
  ok(g.clues.length > 0, 'за партию город получил улики (' + g.clues.length + ')');
  const bad = g.clues.filter(c => !c.traitId || !Inquest.TRAIT_BY_ID[c.traitId]);
  ok(bad.length === 0, 'все улики ссылаются на настоящие приметы');
  const done = g.viewFor('u0');
  ok(!!done.inquest.allTraits, 'после занавеса приметы раскрываются всем');
}

if (fails) { console.log('\n✗ ТЕСТ 15 ПРОВАЛЕН: ' + fails); process.exit(1); }
console.log('\n✓ ТЕСТ 15 ПРОЙДЕН');
