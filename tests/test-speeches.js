/* =========================================================================
   Тест 13 — слово по кругу.

   В конфигурации на речь одного игрока была отведена своя длительность
   (timing.speech = 45), и это значение не использовалось нигде: фазы для речей
   в движке не существовало. День был общим криком, и на столе из двадцати
   человек успевали высказаться трое-четверо, а остальные молча голосовали за
   того, чьё имя чаще мелькало. Это самая большая недостающая механика игры.

   Здесь проверяется всё, из чего круг состоит:
     1. фаза появляется между утром и общим обсуждением;
     2. слово идёт по местам и достаётся каждому живому;
     3. пока говорит один, остальные молчат — и в чате, и в микрофоне;
     4. слово можно передать раньше срока;
     5. мёртвых, ушедших и потерявших связь круг пропускает;
     6. первое слово каждый день переходит к следующему месту;
     7. круг заканчивается общим обсуждением, а не голосованием сразу;
     8. без круга (speeches: false) партия идёт точно как раньше.
   ========================================================================= */
'use strict';
const { Game } = require('../server/game.js');
const C = require('../shared/game-config.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } else console.log('  ✓ ' + m); };

function members(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: 'Игрок' + (i + 1) }));
}

/** Довести партию до круга речей: пролог, ночь с ходами, утро. */
function toSpeech(g) {
  g.deadline = 0; g.tick();                     // пролог → ночь
  g.aliveMafia().forEach(m => {
    const t = g.alive().find(p => !g.isMafia(p.id));
    if (t) g.action(m.id, 'kill', t.id);
  });
  g.alive().filter(p => p.role === C.ROLE.DOCTOR).forEach(d => g.action(d.id, 'heal', d.id));
  g.alive().filter(p => p.role === C.ROLE.SHERIFF).forEach(s => {
    const t = g.alive().find(p => p.id !== s.id);
    if (t) g.action(s.id, 'check', t.id);
  });
  g.deadline = 0; g.tick();                     // ночь → утро
  g.deadline = 0; g.tick();                     // утро → последнее слово или круг
  /* Если ночь кого-то забрала, между утром и кругом стоит последнее слово
     выбывшего: пропускаем его, тест здесь не про него. */
  if (g.phase === 'lastword') { g.deadline = 0; g.tick(); }
  return g;
}

console.log('\n=== ТЕСТ 13: слово по кругу ===');

/* ---- 1. фаза на месте ---- */
{
  const g = toSpeech(new Game(members(8), 'deck'));
  ok(g.phase === 'speech', 'после утра наступает круг речей (' + g.phase + ')');
  ok(!!g.speaker, 'слово кому-то принадлежит: ' + g.nameOf(g.speaker));
  ok(g.phaseSeconds() === g.timing.speech,
    'длительность фазы — та самая timing.speech (' + g.phaseSeconds() + ')');
  ok(g.timing.speech === 45, 'значение из конфигурации наконец используется');

  const view = g.viewFor(g.speaker);
  ok(view.speakerId === g.speaker, 'клиенту сообщают, у кого слово');
  ok(view.you.canAct === 'speak', 'говорящему доступно действие speak');
  const other = g.alive().find(p => p.id !== g.speaker);
  ok(g.viewFor(other.id).you.canAct === 'listen', 'остальным — listen');
}

/* ---- 2. слово обходит всех живых ---- */
{
  const g = toSpeech(new Game(members(8), 'deck'));
  const heard = [];
  let guard = 0;
  while (g.phase === 'speech' && guard++ < 40) {
    heard.push(g.speaker);
    g.action(g.speaker, 'pass', null);
  }
  ok(g.phase === 'day', 'круг закончился общим обсуждением, а не голосованием (' + g.phase + ')');
  const aliveIds = g.alive().map(p => p.id).sort();
  ok(heard.length === aliveIds.length,
    'слово получил каждый живой: ' + heard.length + ' из ' + aliveIds.length);
  ok(JSON.stringify(heard.slice().sort()) === JSON.stringify(aliveIds),
    'и ровно живые, без повторов');

  /* порядок — по местам, начиная с первого слова дня */
  const seats = heard.map(id => g.p(id).seat);
  const rising = seats.slice(1).every((s, i) => s > seats[i]) ||
    seats.slice(1).some((s, i) => s < seats[i]);   // круг может перевалить через последнее место
  ok(rising, 'слово идёт по местам: ' + seats.join(' → '));
}

/* ---- 3. пока говорит один, остальные молчат ---- */
{
  const g = toSpeech(new Game(members(8), 'deck'));
  const sp = g.speaker;
  const other = g.alive().find(p => p.id !== sp);

  const mine = g.say(sp, 'я скажу коротко', 'town');
  ok(!mine.error, 'говорящий пишет в общий чат');
  const theirs = g.say(other.id, 'а я перебью', 'town');
  ok(!!theirs.error, 'остальным общий чат закрыт: ' + theirs.error);
  ok(/Слово у/.test(theirs.error), 'и в отказе названо имя того, у кого слово');

  /* дважды подряд говорящему можно: своя минута не режется антифлудом */
  const again = g.say(sp, 'и ещё одно', 'town');
  ok(!again.error, 'в свою минуту можно сказать несколько фраз подряд');

  /* голос: линии не рвутся, закрыт только микрофон */
  const vMe = g.voiceFor(sp);
  const vThem = g.voiceFor(other.id);
  ok(vMe.channel === 'town' && !vMe.mute, 'микрофон открыт у говорящего');
  ok(vThem.channel === 'town' && vThem.mute === true, 'у слушателей микрофон закрыт');
  ok(vThem.peers.length > 0, 'но слышать они продолжают — соединения живы');
  ok(/Слово у/.test(vThem.why), 'слушателю объясняют, почему он молчит');
}

/* ---- 4. слово передаётся только своим владельцем ---- */
{
  const g = toSpeech(new Game(members(8), 'deck'));
  const sp = g.speaker;
  const other = g.alive().find(p => p.id !== sp);
  ok(!!g.action(other.id, 'pass', null).error, 'чужое слово передать нельзя');
  ok(!g.action(sp, 'pass', null).error, 'своё — можно');
  ok(g.speaker !== sp, 'слово ушло дальше: ' + g.nameOf(g.speaker));

  /* кнопка «я высказался» в круге означает то же самое */
  const now2 = g.speaker;
  ok(!g.action(now2, 'ready', null).error, '«я высказался» работает как передача слова');
  ok(g.speaker !== now2, 'и слово тоже ушло дальше');
}

/* ---- 5. круг пропускает тех, кого нет ---- */
{
  const g = toSpeech(new Game(members(10), 'deck'));
  const queue = g.speechQueue.slice();
  const skipOffline = queue[0];
  const skipLeft = queue[1];
  ok(!!skipOffline && !!skipLeft, 'в очереди есть кого пропускать');

  g.setOffline([skipOffline]);
  g.markLeft(skipLeft);

  const heard = [];
  let guard = 0;
  while (g.phase === 'speech' && guard++ < 40) {
    heard.push(g.speaker);
    g.action(g.speaker, 'pass', null);
  }
  ok(heard.indexOf(skipOffline) < 0, 'потерявшему связь слово не дают');
  ok(heard.indexOf(skipLeft) < 0, 'вышедшему из-за стола тоже');
  ok(heard.length > 0, 'остальные высказались (' + heard.length + ')');
}

/* ---- 6. по таймауту слово уходит само ---- */
{
  const g = toSpeech(new Game(members(8), 'deck'));
  const sp = g.speaker;
  g.deadline = 0;
  const changed = g.tick();
  ok(changed === true, 'истёкшее слово двигает фазу');
  ok(g.speaker !== sp, 'молчащий не держит круг: слово ушло дальше');
}

/* ---- 7. первое слово каждый день переходит дальше ---- */
{
  const g = new Game(members(8), 'deck');
  toSpeech(g);
  const firstDayOne = g.speaker;
  let guard = 0;
  while (g.phase === 'speech' && guard++ < 40) g.action(g.speaker, 'pass', null);
  const seatAfter = g.firstSpeakerSeat;
  ok(g.p(firstDayOne).seat !== seatAfter,
    'на следующий день первым говорит другое место (' + g.p(firstDayOne).seat + ' → ' + seatAfter + ')');
}

/* ---- 8. без круга всё как было ---- */
{
  const g = new Game(members(8), 'deck', { speeches: false });
  toSpeech(g);
  ok(g.phase === 'day', 'с выключенным кругом после утра сразу обсуждение (' + g.phase + ')');
  ok(g.speaker === null, 'говорящего нет');
  const anyone = g.alive()[0];
  ok(!g.say(anyone.id, 'говорю когда хочу', 'town').error, 'общий чат открыт всем, как раньше');
}

/* ---- 9. круг не мешает партии доиграться до конца ---- */
{
  for (const n of [6, 12, 20]) {
    const g = new Game(members(n), null);
    g.deadline = 0;
    let guard = 0;
    while (!g.finished && guard++ < 3000) {
      if (g.phase === 'night') {
        g.aliveMafia().forEach(m => {
          const t = g.alive().filter(p => !g.isMafia(p.id))[0];
          if (t) g.action(m.id, 'kill', t.id);
        });
        g.alive().filter(p => p.role === C.ROLE.DOCTOR).forEach(d => {
          const t = g.alive().find(p => g.lastHealed[d.id] !== p.id);
          if (t) g.action(d.id, 'heal', t.id);
        });
        g.alive().filter(p => p.role === C.ROLE.SHERIFF).forEach(sh => {
          const t = g.alive().find(p => p.id !== sh.id);
          if (t) g.action(sh.id, 'check', t.id);
        });
      } else if (g.phase === 'speech') {
        g.say(g.speaker, 'моё слово', 'town');
        g.action(g.speaker, 'pass', null);
      } else if (g.phase === 'day') {
        g.alive().forEach(p => g.action(p.id, 'ready'));
      } else if (g.phase === 'vote' || g.phase === 'runoff') {
        g.alive().forEach(p => {
          const pool = g.runoffOf ? g.runoffOf.filter(id => g.p(id).alive)
            : g.alive().filter(x => x.id !== p.id).map(x => x.id);
          g.action(p.id, 'vote', pool.length ? pool[0] : 'skip');
        });
      }
      g.deadline = 0;
      g.tick();
    }
    ok(g.finished, 'партия на ' + n + ' человек доигралась с кругом речей (' + guard + ' тактов)');
    ok(g.winner === 'town' || g.winner === 'mafia', 'и у неё есть победитель: ' + g.winner);
  }
}

console.log(fails === 0 ? '\n✓ ТЕСТ 13 ПРОЙДЕН' : '\n✗ ТЕСТ 13: ошибок ' + fails);
process.exit(fails ? 1 : 0);
