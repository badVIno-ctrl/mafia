/* Тесты сетевого чата: сообщение видно, обращение по имени замечено. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Game } = require('../server/game.js');

function makeGame(n) {
  const users = [];
  for (let i = 0; i < n; i++) users.push({ id: 'u' + i, name: ['Влад', 'Гриша', 'Рита', 'Виктор', 'Аня', 'Олег', 'Марк'][i] || ('Игрок' + i) });
  return new Game(users, null);
}

function run() {
  const g = makeGame(6);
  g.phase = 'day';
  g.players.forEach(p => { p.alive = true; });

  /* --- 1. обычное сообщение доходит до стола --- */
  let r = g.say('u0', 'я хочу домой', 'town');
  assert.ok(r.ok, 'реплика не прошла: ' + JSON.stringify(r));
  assert.strictEqual(g.chat.length, 1);
  assert.strictEqual(g.chat[0].text, 'я хочу домой');

  /* её видят все участники, а не только автор */
  g.players.forEach(p => {
    const view = g.viewFor(p.id);
    assert.ok(view.chat.some(m => m.text === 'я хочу домой'), 'сообщение не видно игроку ' + p.name);
  });

  /* --- 2. обращение по имени в любом падеже --- */
  const vlad = g.players[0];
  r = g.say('u1', 'Влад, подожди ты со своим домом', 'town');
  assert.ok(r.ok, JSON.stringify(r));
  let last = g.chat[g.chat.length - 1];
  assert.deepStrictEqual(last.mentions, [vlad.id], 'обращение к Владу не замечено');
  assert.ok(last.mentionNames.indexOf('Влад') >= 0);

  /* обращение попадает в протокол стола */
  assert.ok(g.log.some(l => /обращается к/.test(l.text)), 'обращение не попало в протокол');

  /* косвенные падежи и номер места */
  g.players.forEach(p => { p.lastSayAt = 0; });
  g.say('u2', 'я не верю Грише', 'town');
  last = g.chat[g.chat.length - 1];
  assert.ok(last.mentions.indexOf('u1') >= 0, 'имя в косвенном падеже не найдено');
  g.players.forEach(p => { p.lastSayAt = 0; });
  g.say('u3', '№' + g.players[4].seat + ', что скажешь?', 'town');
  last = g.chat[g.chat.length - 1];
  assert.ok(last.mentions.indexOf(g.players[4].id) >= 0, 'обращение по номеру места не найдено');

  /* сам себя игрок не упоминает */
  g.players.forEach(p => { p.lastSayAt = 0; });
  g.say('u0', 'Влад здесь ни при чем', 'town');
  last = g.chat[g.chat.length - 1];
  assert.strictEqual(last.mentions.indexOf('u0'), -1, 'игрок упомянул сам себя');

  /* --- 3. защита от флуда --- */
  g.players.forEach(p => { p.lastSayAt = 0; p.lastSayText = ''; });
  assert.ok(g.say('u5', 'первое', 'town').ok);
  assert.ok(g.say('u5', 'второе сразу же', 'town').error, 'флуд не ограничен');
  g.p('u5').lastSayAt = 0;
  assert.ok(g.say('u5', 'первое', 'town').error, 'дубль подряд не отсечён');

  /* --- 4. правила фаз --- */
  g.players.forEach(p => { p.lastSayAt = 0; p.lastSayText = ''; });
  g.phase = 'prologue';
  assert.ok(g.say('u0', 'всем доброго вечера', 'town').ok, 'в прологе нельзя поздороваться');
  g.players.forEach(p => { p.lastSayAt = 0; p.lastSayText = ''; });
  g.phase = 'night';
  assert.ok(g.say('u0', 'эй, кто там', 'town').error, 'ночью город должен молчать');

  /* мафия шепчется ночью, и город этого не видит */
  const mafId = g.players.find(p => g.isMafia(p.id)).id;
  const townId = g.players.find(p => !g.isMafia(p.id) && p.alive).id;
  g.players.forEach(p => { p.lastSayAt = 0; p.lastSayText = ''; });
  assert.ok(g.say(mafId, 'берем первого', 'mafia').ok, 'мафия не может говорить ночью');
  assert.ok(!g.viewFor(townId).chat.some(m => m.text === 'берем первого'), 'живой горожанин видит ночной чат мафии');
  assert.ok(g.viewFor(mafId).chat.some(m => m.text === 'берем первого'), 'мафия не видит свой же чат');

  /* выбывший говорит только за чертой */
  g.players.forEach(p => { p.lastSayAt = 0; p.lastSayText = ''; });
  g.phase = 'day';
  const ghost = g.players[3];
  ghost.alive = false;
  g.say(ghost.id, 'я всё видел', 'town');
  last = g.chat[g.chat.length - 1];
  assert.strictEqual(last.channel, 'ghost', 'реплика выбывшего ушла в город');
  const liveId = g.players.find(p => p.alive).id;
  assert.ok(!g.viewFor(liveId).chat.some(m => m.text === 'я всё видел'), 'живые читают чат мёртвых');

  /* --- 5. клиент показывает обращения --- */
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'online.js'), 'utf8');
  assert.ok(js.indexOf('toyou') >= 0, 'обращение к игроку не выделяется');
  assert.ok(js.indexOf('обращается к вам') >= 0, 'нет уведомления об обращении');
  assert.ok(js.indexOf("'prologue', 'day'") >= 0, 'в прологе поле ввода заблокировано');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'online.html'), 'utf8');
  /* Реплики переехали из «.feed .m» в отдельное окно чата с классом .msg. */
  assert.ok(html.indexOf('.msg.toyou') >= 0, 'нет стиля для обращённых реплик');
  assert.ok(html.indexOf('.msg .men') >= 0, 'нет стиля для названного имени внутри реплики');
  assert.ok(html.indexOf('id="chatDock"') >= 0, 'чат не вынесен в отдельное окно');

  console.log('test-chat: все проверки пройдены');
}

module.exports = run;
if (require.main === module) run();
