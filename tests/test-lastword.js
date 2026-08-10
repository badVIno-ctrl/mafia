/* =========================================================================
   Тест 16 — последнее слово, лучший ход и пресеты темпа.

   Три механики, которых в движке не было, и все три — классика живых столов.
   Проверяем не только «работает», а именно то, из-за чего их легко сломать:

     1. Между смертью и следующей фазой появляется ровно одна пауза, и она
        кончается сама. Фаза, которая не кончается сама, — это зависший стол.
     2. Выбывший говорит со всем столом. Если его реплика уйдёт в канал
        выбывших, механика становится невидимой, то есть отсутствует.
     3. Он же — и только он — может назвать три имени, и ровно три.
     4. Голос: последнее слово слышат живые, но микрофон открыт только у
        говорящего.
     5. Темп меняет длительности и ничего кроме них.
     6. Выключенное последнее слово возвращает прежний ход партии.
   ========================================================================= */
'use strict';
const C = require('../shared/game-config.js');
const { Game } = require('../server/game.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };

function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'Игрок' + (i + 1) }));
}

/** Ночь с полным набором ходов: мафия бьёт мирного, врач лечит себя. */
function nightWithKill(g) {
  const victim = g.aliveTown().find(p => p.role === C.ROLE.CIVILIAN) || g.aliveTown()[0];
  g.aliveMafia().forEach(m => g.action(m.id, 'kill', victim.id));
  g.alive().filter(p => p.role === C.ROLE.DOCTOR).forEach(d => g.action(d.id, 'heal', d.id));
  g.alive().filter(p => p.role === C.ROLE.SHERIFF).forEach(sh => {
    const t = g.alive().find(p => p.id !== sh.id);
    if (t) g.action(sh.id, 'check', t.id);
  });
  return victim;
}

console.log('\n=== ТЕСТ 16: последнее слово, лучший ход, темп ===');

/* ---- 1. фаза появляется, принадлежит убитому и кончается сама ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'lw-1' });
  g.deadline = 0; g.tick();                     // пролог → ночь
  const victim = nightWithKill(g);
  g.deadline = 0; g.tick();                     // ночь → утро
  ok(g.phase === 'morning', 'после ночи утро (' + g.phase + ')');

  g.deadline = 0; g.tick();                     // утро → последнее слово
  ok(g.phase === 'lastword', 'убитому дают последнее слово (' + g.phase + ')');
  ok(g.lastWordId === victim.id, 'слово именно у убитого: ' + g.nameOf(g.lastWordId));
  ok(g.phaseSeconds() === g.timing.lastWord,
    'длительность фазы — та самая timing.lastWord (' + g.phaseSeconds() + ')');
  ok(g.canAct(g.p(victim.id)) === 'bestmove',
    'первой ночью у него ещё и лучший ход (' + g.canAct(g.p(victim.id)) + ')');
  ok(g.canAct(g.alive()[0]) === 'listen', 'остальные слушают');

  /* Кончается сама, а не висит до конца времён. */
  g.deadline = 0; g.tick();
  ok(g.phase === 'speech', 'после последнего слова идёт круг речей (' + g.phase + ')');
  ok(g.lastWordId === null, 'слово снято');
}

/* ---- 2. выбывший говорит со столом, а не в пустоту ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'lw-2' });
  g.deadline = 0; g.tick();
  const victim = nightWithKill(g);
  g.deadline = 0; g.tick();
  g.deadline = 0; g.tick();
  ok(g.phase === 'lastword', 'дошли до последнего слова');

  const r = g.say(victim.id, 'Я мирный, ищите среди тех, кто меня топил.', 'town');
  ok(!r.error, 'выбывший может сказать последнее слово: ' + (r.error || 'ok'));
  const last = g.chat[g.chat.length - 1];
  ok(last.channel === 'town', 'реплика ушла в общий чат, а не в чат выбывших (' + last.channel + ')');

  /* Живой видит её. Раньше выбывший писал в 'ghost', и стол не видел ничего. */
  const liveView = g.viewFor(g.alive()[0].id);
  ok(liveView.chat.some(m => m.from === victim.id && m.channel === 'town'),
    'живые видят последнее слово');

  /* А перебить его нельзя. */
  const other = g.alive()[0];
  const r2 = g.say(other.id, 'Да ты чёрный!', 'town');
  ok(!!r2.error, 'перебить последнее слово нельзя: ' + (r2.error || 'перебил'));

  /* Голос: слышат все живые, микрофон открыт у одного. */
  const vMine = g.voiceFor(victim.id);
  const vOther = g.voiceFor(other.id);
  ok(vMine.channel === 'town' && !vMine.mute, 'у говорящего микрофон открыт');
  ok(vOther.channel === 'town' && vOther.mute === true, 'остальные слушают с закрытым микрофоном');
  ok(vOther.peers.indexOf(victim.id) >= 0, 'выбывший есть в списке собеседников живого');

  /* И он может закончить раньше срока. */
  const r3 = g.action(victim.id, 'pass', null);
  ok(!r3.error && g.phase === 'speech', 'кнопкой «я всё сказал» слово закрывается (' + g.phase + ')');
}

/* ---- 3. лучший ход: ровно три разных имени и только от убитого ---- */
{
  const g = new Game(members(10), 'ferry', { seed: 'lw-3' });
  g.deadline = 0; g.tick();
  const victim = nightWithKill(g);
  g.deadline = 0; g.tick();
  g.deadline = 0; g.tick();
  ok(g.phase === 'lastword' && g.bestMoveOpen, 'лучший ход открыт');

  const others = g.alive();
  ok(!!g.action(others[0].id, 'bestmove', others.slice(1, 4).map(p => p.id).join(',')).error,
    'чужой лучший ход подать нельзя');
  ok(!!g.action(victim.id, 'bestmove', others.slice(0, 2).map(p => p.id).join(',')).error,
    'двух имён недостаточно');
  ok(!!g.action(victim.id, 'bestmove', [others[0].id, others[0].id, others[1].id].join(',')).error,
    'одно имя дважды не считается');

  const picks = others.slice(0, 3).map(p => p.id);
  const r = g.action(victim.id, 'bestmove', picks.join(','));
  ok(!r.error, 'три разных имени принимаются: ' + (r.error || 'ok'));
  ok(!g.bestMoveOpen, 'второй раз назвать нельзя');
  ok(!!g.action(victim.id, 'bestmove', others.slice(3, 6).map(p => p.id).join(',')).error,
    'и попытка переиграть отклоняется');

  /* Три имени публичны сразу — в этом весь смысл. А попадания — нет. */
  const view = g.viewFor(g.alive()[0].id);
  ok(view.bestMove && view.bestMove.picks.length === 3, 'стол видит три имени');
  ok(view.bestMove.hits === null, 'сколько из них чёрные — до занавеса тайна');
  ok(g.log.some(l => l.kind === 'bestmove'), 'лучший ход попал в протокол');

  /* После занавеса счёт открывается. */
  g.finish('town');
  const done = g.viewFor(g.alive()[0].id);
  ok(typeof done.bestMove.hits === 'number', 'после занавеса видно, сколько угадано (' + done.bestMove.hits + ')');
}

/* ---- 4. казнённому днём слово дают, лучший ход — нет ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'lw-4', speeches: false });
  g.deadline = 0; g.tick();
  nightWithKill(g);
  g.deadline = 0; g.tick();                 // утро
  g.deadline = 0; g.tick();                 // последнее слово ночной жертвы
  if (g.phase === 'lastword') { g.deadline = 0; g.tick(); }
  ok(g.phase === 'day', 'без круга речей после слова сразу день (' + g.phase + ')');

  g.startVote(null);
  const alive = g.alive();
  const target = alive[alive.length - 1];
  alive.forEach(p => g.action(p.id, 'vote', p.id === target.id ? 'skip' : target.id));
  g.resolveVote();
  ok(g.phase === 'lastword', 'казнённый тоже получает последнее слово (' + g.phase + ')');
  ok(g.lastWordId === target.id, 'и слово именно у него');
  ok(g.bestMoveOpen === false, 'лучшего хода у казнённого нет: он говорил весь день');
  g.deadline = 0; g.tick();
  ok(g.phase === 'night', 'после слова казнённого наступает ночь (' + g.phase + ')');
}

/* ---- 5. ушедшему слова не дают: стол не смотрит в тишину ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'lw-5' });
  g.deadline = 0; g.tick();
  const victim = nightWithKill(g);
  g.markLeft(victim.id);
  g.deadline = 0; g.tick();                 // утро
  g.deadline = 0; g.tick();                 // должно проскочить мимо слова
  ok(g.phase === 'speech', 'вышедшему из-за стола слова не дают (' + g.phase + ')');
}

/* ---- 6. выключенное последнее слово возвращает прежний ход партии ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'lw-6', lastWord: false });
  g.deadline = 0; g.tick();
  nightWithKill(g);
  g.deadline = 0; g.tick();
  g.deadline = 0; g.tick();
  ok(g.phase === 'speech', 'без последнего слова после утра сразу круг (' + g.phase + ')');
}

/* ---- 7. пресеты темпа ---- */
{
  const sizes = [6, 10, 20];
  for (const n of sizes) {
    const blitz = C.timing(n, 'blitz');
    const normal = C.timing(n, 'normal');
    const club = C.timing(n, 'club');
    ok(blitz.speech < normal.speech && normal.speech < club.speech,
      'n=' + n + ': речь растёт от блица к клубу (' + [blitz.speech, normal.speech, club.speech].join(' < ') + ')');
    ok(blitz.day < normal.day && normal.day < club.day,
      'n=' + n + ': день растёт от блица к клубу');
    ok(blitz.vote < normal.vote && normal.vote < club.vote, 'n=' + n + ': голосование тоже');
  }

  /* Обратная совместимость: без пресета всё ровно как было до правки. */
  const t = C.timing(10);
  ok(t.night === 40 && t.speech === 45 && t.day === 120 && t.vote === 50 && t.reveal === 10,
    'по умолчанию длительности не изменились: ' + JSON.stringify(t));

  /* Круг речей укорачивает день, и укорачивает по пресету. */
  const gb = new Game(members(20), 'shift', { seed: 't', speed: 'blitz' });
  const gc = new Game(members(20), 'shift', { seed: 't', speed: 'club' });
  ok(gb.timing.day < gc.timing.day,
    'после круга обсуждение короче у блица (' + gb.timing.day + ' против ' + gc.timing.day + ')');
  ok(gb.speed === 'blitz' && gc.speed === 'club', 'партия помнит свой темп');
  ok(gb.viewFor('u0').speed === 'blitz', 'клиент видит темп стола');

  /* Двадцать человек в «Клубе» получают больше четырёх минут на день —
     та самая жалоба, из которой пресеты и выросли. */
  ok(gc.timing.speech === 60, 'в «Клубе» речь шестьдесят секунд');
  ok(C.timing(20, 'club').day > 240, 'в «Клубе» день на двадцать человек длиннее прежнего потолка');
}

/* ---- 8. неизвестный темп не ломает стол ---- */
{
  const g = new Game(members(8), 'deck', { seed: 'x', speed: 'сверхзвуковой' });
  ok(g.speed === 'normal', 'непонятный темп сводится к стандартному (' + g.speed + ')');
}

console.log(fails === 0 ? '\n✓ ТЕСТ 16 ПРОЙДЕН' : '\n✗ ТЕСТ 16: ошибок ' + fails);
process.exit(fails ? 1 : 0);
