/* Тесты живой речи: каждая реплика игрока должна быть понята и получить ответ. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../public/js/speech.js');

const people = [
  { idx: 1, name: 'Гриша', alive: true },
  { idx: 2, name: 'Рита', alive: true },
  { idx: 3, name: 'Виктор', alive: true }
];
const ctx = (history) => ({ people, selfIdx: 0, history: history || [] });

function run(){
  /* --- 1. распознавание смысла --- */
  const cases = [
    ['я хочу домой', 'home'],
    ['Надоело всё, я ухожу', 'home'],
    ['Гриша мафия, голосую за него', 'accuse'],
    ['Рита, ты где была ночью?', 'question'],
    ['а где вы все были ночью?', 'question_table'],
    ['я шериф, проверял Гришу', 'claim_sheriff'],
    ['я доктор и я лечил Риту', 'claim_doctor'],
    ['ладно, я мафия', 'claim_mafia'],
    ['это не я, меня зря обвиняют', 'defend'],
    ['верю Рите, она мирная', 'vouch'],
    ['мне страшно', 'fear'],
    ['всем привет', 'greeting'],
    ['заткнись уже', 'insult'],
    ['пас, нечего сказать', 'pass'],
    ['', 'silence'],
    ['погода сегодня отличная в горо', 'offtop']
  ];
  cases.forEach(([text, kind]) => {
    const a = S.classify(text, ctx());
    assert.strictEqual(a.kind, kind, 'реплика "' + text + '" опознана как ' + a.kind + ', а ждали ' + kind);
  });

  /* --- 2. адресат находится в любом падеже --- */
  assert.strictEqual(S.classify('Рита, ты где была?', ctx()).target, 2);
  assert.strictEqual(S.classify('я подозреваю Гришу', ctx()).target, 1);
  assert.strictEqual(S.classify('Виктору не верю', ctx()).target, 3);

  /* --- 3. у каждого вида реплики есть ответ на любой характер --- */
  const tones = ['hot', 'cold', 'warm', 'sly', 'short', 'plain'];
  const kinds = S.KINDS.concat(['reply_question', 'reply_accuse', 'reply_vouch']);
  kinds.forEach(k => {
    tones.forEach(t => {
      const bank = S.replyBank(k, t, false);
      assert.ok(Array.isArray(bank) && bank.length > 0, 'нет ответов для ' + k + '/' + t);
      bank.forEach(tpl => assert.ok(tpl.indexOf('{P}') >= 0 || tpl.indexOf('{PA}') >= 0 ||
        tpl.indexOf('{PG}') >= 0 || tpl.indexOf('{PD}') >= 0 || tpl.indexOf('{T}') >= 0,
        'ответ без обращения к игроку: ' + tpl));
    });
  });
  ['support', 'against', 'hook'].forEach(m => {
    assert.ok(S.secondBank(m).length > 0, 'пустой банк второго голоса: ' + m);
  });

  /* --- 4. требование из задачи: «Влад, подожди ты со своим домом» --- */
  const homeBank = S.replyBank('home', 'hot', false);
  const line = S.fill(homeBank[0], { P: 'Влад', PA: 'Влада', PD: 'Владу', PG: 'Влада' });
  assert.ok(/^Влад, подожди ты со своим домом/.test(line), 'нет обещанного ответа про дом: ' + line);

  /* --- 5. подстановка не оставляет дырок --- */
  const filled = S.fill('{P} спросил {TA}, а {S} поддержал.',
    { P: 'Влад', TA: 'Гришу', S: 'Рита' });
  assert.strictEqual(filled, 'Влад спросил Гришу, а Рита поддержал.');
  assert.ok(S.fill('{P} и {T}', { P: 'Влад' }).indexOf('{') < 0, 'осталась незаполненная метка');

  /* --- 6. повтор одного и того же замечают --- */
  const first = S.classify('хочу домой', ctx([]));
  const again = S.classify('ну я же хочу домой', ctx(['home']));
  assert.strictEqual(first.repeat, false);
  assert.strictEqual(again.repeat, true, 'повтор не замечен');
  assert.ok(again.suspicionDelta > first.suspicionDelta, 'повтор должен усиливать подозрение');
  assert.ok(S.replyBank('home', 'hot', true)[0].indexOf('второй раз') >= 0, 'нет ответа на повтор');

  /* --- 7. каждая реплика получает хотя бы один ответ --- */
  S.KINDS.forEach(k => {
    const prof = S.PROFILE[k];
    assert.ok(prof && prof.attention >= 1, 'вид реплики без внимания стола: ' + k);
  });
  ['хочу домой', '', 'привет', 'ааа', 'Гриша мафия'].forEach(t => {
    const a = S.classify(t, ctx());
    assert.ok(a.attention >= 1, 'реплика осталась без внимания: ' + t);
  });

  /* --- 8. крик притягивает больше внимания --- */
  assert.strictEqual(S.classify('Я ХОЧУ ДОМОЙ!!', ctx()).attention, 2);

  /* --- 9. игра с ботами подключает модуль и вызывает реакцию --- */
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'bots.html'), 'utf8');
  assert.ok(html.indexOf('/js/speech.js') >= 0, 'speech.js не подключён к игре с ботами');
  assert.ok(html.indexOf('async function reactToHuman') >= 0, 'нет реакции стола');
  assert.ok(html.indexOf('await humanSpeak(token') >= 0, 'реакция не подключена к дню');
  assert.ok(html.indexOf('armInterject') >= 0, 'нет реплики вне очереди');

  /* --- 10. имя спрашивают только один раз --- */
  assert.ok(html.indexOf('ACCOUNT_KEY') >= 0, 'игра с ботами не читает имя аккаунта');
  assert.ok(html.indexOf('syncNameFromAccount') >= 0, 'имя не синхронизируется при запуске');
  assert.ok(html.indexOf('id="profileBox"') >= 0, 'нет карточки игрока вместо повторного вопроса');

  console.log('test-speech: все проверки пройдены');
}

module.exports = run;
if (require.main === module) run();
