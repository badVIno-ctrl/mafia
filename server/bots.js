/* =========================================================================
   Боты для сетевой комнаты.

   Зачем. Собрать двадцать живых людей к восьми вечера получается редко, а
   вшестером за столом уже можно играть. Раньше сетевая комната просто
   ждала: пока не наберётся шесть человек, партия не начиналась. Теперь
   хозяин нажимает «Играть с ботами», пустые места занимают соседи с
   именами и характерами, и партия идёт — а друг всё равно может прийти по
   ссылке-приглашению и сесть на место одного из ботов.

   Как это устроено. Бот — обычный игрок движка: у него есть id, имя, роль
   и место за столом. Движок про ботов ничего не знает, поэтому правила для
   них те же, что для людей: мафия-бот не может «убить» своего, доктор-бот
   не лечит одного и того же две ночи подряд, шериф-бот получает результат
   проверки ровно так же и ровно так же им распоряжается.

   Что бот знает. Только то, что положено его роли: свою роль, своих
   сообщников (если он мафия), свои проверки (если шериф) и всё, что
   прозвучало в общем чате. Скрытые роли остальных бот не подсматривает —
   иначе играть с ним было бы бессмысленно.

   Ход времени. Боты не отвечают мгновенно: у каждого хода свой срок в
   пределах фазы, поэтому ночь не закрывается через полсекунды после
   начала, а день не превращается в стену текста.
   ========================================================================= */
'use strict';
const C = require('../shared/game-config.js');
const ROLE = C.ROLE;

const PREFIX = 'bot_';

const NAMES = [
  'Аня', 'Борис', 'Вера', 'Гриша', 'Дина', 'Егор', 'Жанна', 'Зоя',
  'Игорь', 'Кира', 'Лёва', 'Марта', 'Никита', 'Оля', 'Павел', 'Рита',
  'Семён', 'Тоня', 'Ульяна', 'Фёдор', 'Хома', 'Юля', 'Яков', 'Клим'
];

/* Характер меняет только манеру: как часто бот говорит и насколько резко.
   На силу игры он не влияет — иначе «характер» превратился бы в фору. */
const TRAITS = [
  { id: 'talker', talk: 2, sharp: 0.6 },
  { id: 'quiet', talk: 1, sharp: 0.3 },
  { id: 'hot', talk: 2, sharp: 0.9 },
  { id: 'calm', talk: 1, sharp: 0.45 },
  { id: 'lawyer', talk: 2, sharp: 0.35 }
];

/* Случайность ботов идёт от партии, если та её предоставила: тогда стол
   повторяем при том же семени, и симулятор баланса даёт устойчивые числа.
   Вне партии (создание бота, выбор имени) остаётся обычный Math.random. */
let RNG = null;
const rnd = (n) => Math.floor((RNG ? RNG.next() : Math.random()) * n);
const pick = (a) => a[rnd(a.length)];
const chance = (p) => (RNG ? RNG.next() : Math.random()) < p;

function isBotId(id) { return typeof id === 'string' && id.slice(0, PREFIX.length) === PREFIX; }

/** Новый бот с именем, которого ещё нет за столом. */
function makeBot(takenNames) {
  const free = NAMES.filter(n => takenNames.indexOf(n) < 0);
  const name = free.length ? pick(free) : ('Сосед ' + (rnd(89) + 10));
  return {
    id: PREFIX + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3),
    name,
    bot: true,
    trait: pick(TRAITS)
  };
}

/* =========================================================================
   РЕПЛИКИ
   Банки собраны по позициям, а не по ролям: одну и ту же фразу может
   сказать и мирный, и мафия — на этом и держится игра.
   ========================================================================= */
const LINES = {
  /* Последнее слово. Говорит человек, который уже вне игры, и потому
     говорит прямо — это главное, чем последнее слово ценно столу. */
  lastWordTown: [
    'Я мирный(ая), и вы это узнаете через минуту. Смотрите на тех, кто громче всех меня выводил.',
    'Меня убрали не случайно. Ищите среди тех, кто вчера меня и не защищал, и не топил — просто молчал.',
    'Ухожу с чистой картой. Верьте тем, кто говорил по делу, а не громко.',
    'Проверьте {T}. Больше мне сказать нечего.',
    'Я всё сказал(а) днём. Если вы меня вывели — вы уже проиграли один ход.'
  ],
  lastWordMafia: [
    'Ну что вы. Я такой же мирный, как и вы. Ошиблись — бывает.',
    'Ладно, ваша взяла. Но {T} вы зря не слушали.',
    'Ухожу молча. Подумайте о {T}.',
    'Поздравляю, вывели своего. Дальше сами.',
    'Я бы на вашем месте посмотрел(а) на {T}. Просто совет напоследок.'
  ],
  open: [
    'Ну что, с кого начнём? Молчать всё равно не получится.',
    'Давайте по кругу: кто что видел, кто где сидел.',
    'Я бы послушал(а) сначала тех, кто вчера отмалчивался.',
    'Начнём с простого: у кого есть хоть одна догадка?'
  ],
  accuse: [
    '{T} слишком спокоен(на) для такого вечера. Я смотрю на {T}.',
    'Мне не нравится, как {T} обходит вопросы. Голос мой пока туда.',
    '{T}, объяснись. Со стороны это выглядит плохо.',
    'Ставлю на {T}. Слишком удобно у {T} всё складывается.',
    'Я против {T}. Кто со мной?'
  ],
  defend: [
    '{T} я бы не трогал(а) — на {T} давят от растерянности.',
    'Против {T} нет ничего, кроме чужого раздражения.',
    'Если сегодня выведем {T}, завтра будем извиняться.',
    'Я за {T} ручаюсь. Ошибаюсь — значит ошибаюсь громко.'
  ],
  question: [
    '{T}, а ты кого подозреваешь? Только без «я подумаю».',
    '{T}, где ты был(а), когда всё началось?',
    '{T}, назови имя. Одно. Прямо сейчас.',
    '{T}, ты слишком быстро согласился(лась). Почему?'
  ],
  defendSelf: [
    'На меня показывают, потому что я говорю больше всех. Это не довод.',
    'Я мирный(ая). Скучно, но так и есть.',
    'Выведете меня — потеряете вечер. Я вам ещё пригожусь.',
    'Меня удобно вывести: я никому не нужен(на). Это и подозрительно.'
  ],
  claimSheriff: [
    'Хорошо. Я шериф. {T} — чёрный, проверял(а) этой ночью.',
    'Раскрываюсь: шериф. По {T} у меня плохая новость.',
    'Я проверял(а) {T}. Это мафия. Дальше решайте сами.'
  ],
  mourn: [
    'Ну вот. Одним человеком меньше, а понятнее не стало.',
    'Значит, ночью работали. Кто-то из нас улыбается зря.',
    'Считаем: кто громче всех защищал того, кто сегодня не встал?',
    'Мне это не нравится. Совсем.'
  ],
  vote: [
    'Голосую и не жалею.',
    'Пусть будет так. Ошибусь — признаю.',
    'Решено. Дальше посмотрим, кто останется.'
  ]
};

function fill(tpl, vars) {
  return String(tpl).replace(/\{T\}/g, vars.T || 'ты');
}

/* =========================================================================
   ПАМЯТЬ СТОЛА
   Кого сегодня называли — тот и под подозрением. Считаем по общему чату:
   бот видит ровно то же, что видит человек.
   ========================================================================= */
/* Заготовки не должны повторяться подряд у разных ботов: три соседа с одной и
   той же фразой мгновенно выдают механику, и стол перестаёт читаться живым.
   Партия помнит последние сказанные заготовки и выбирает из оставшихся. */
function pickFresh(list, game) {
  if (!list || !list.length) return undefined;
  /* Случайность берём у партии, если она есть.

     Раньше выбор заготовки шёл через общий pick, а тот пользуется семенем
     партии только внутри такта — RNG выставляется в tick(). Всё, что зовёт
     pickFresh снаружи такта (симулятор, тесты, разбор партии по семени),
     получало Math.random, и результат от прогона к прогону менялся. Тест на
     повторы заготовок из-за этого падал примерно раз из пяти: не потому,
     что боты повторялись, а потому, что «одна и та же партия» каждый раз
     была разной. Реплики — часть партии, и по семени они обязаны
     воспроизводиться так же, как раздача ролей. */
  const r = game && game.rng ? game.rng : null;
  const pickOne = (l) => (r ? l[Math.floor(r.next() * l.length)] : pick(l));
  const used = game._botSaid = game._botSaid || [];
  const free = list.filter(x => used.indexOf(x) < 0);
  const chosen = pickOne(free.length ? free : list);
  used.push(chosen);
  const keep = Math.max(6, Math.min(28, list.length * 2));
  while (used.length > keep) used.shift();
  return chosen;
}

function suspicionMap(game) {
  const sus = {};
  game.players.forEach(p => { sus[p.id] = 0; });
  game.chat.forEach(m => {
    if (m.channel !== 'town') return;
    (m.mentions || []).forEach(id => { if (sus[id] !== undefined) sus[id] += 1; });
  });
  game.log.forEach(l => {
    if (l.kind !== 'vote') return;
    game.players.forEach(p => { if (l.text.indexOf(p.name) >= 0) sus[p.id] += 0.5; });
  });
  return sus;
}

/** Кто кого называл в общем чате: {кого: [кто]}. */
function accusationsIn(game) {
  const out = {};
  game.chat.forEach(m => {
    if (m.channel !== 'town') return;
    (m.mentions || []).forEach(id => {
      (out[id] = out[id] || []).push(m.from);
    });
  });
  return out;
}

/* Заявки «я шериф, такой-то чёрный».

   Раньше здесь стояло простое правило: сообщение со словом «шериф» плюс любое
   упомянутое имя — заявка. Из этого получалась дыра, которой ломался весь
   стол: мафия-человек писала «шериф проверил Веру, она чёрная» и одним
   сообщением направляла всех ботов на Веру, а следующей ночью боты-мафия шли
   за «объявившимся шерифом».

   Теперь заявкой считается только та фраза, в которой автор называет шерифом
   себя. Заявок от одного игрока учитывается ограниченное число, повторы про
   одного и того же человека не складываются, а два игрока, объявившие себя
   шерифом, ослабляют друг друга — ровно так же, как это работает за настоящим
   столом. */
const CLAIM_SELF = /(^|[\s,.;:!?—-])(я\s+шериф|шериф\s+(?:—|-|это)?\s*я|раскрываюсь[\s,:—-]*шериф|моя\s+карта\s*[—:-]?\s*шериф)/i;
const CLAIMS_PER_PLAYER = 3;

function sheriffClaims(game) {
  const out = [];
  const perAuthor = {};
  const seen = {};
  game.chat.forEach(m => {
    if (m.channel !== 'town') return;
    if (!CLAIM_SELF.test(String(m.text || ''))) return;
    const who = game.p(m.from);
    if (!who || !who.alive) return;
    const named = (m.mentions || []).map(id => game.p(id)).filter(p => p && p.alive && p.id !== m.from);
    if (!named.length) return;
    /* Больше трёх чёрных от одного шерифа за партию — уже не проверки, а
       поток имён: дальше его слово ничего не добавляет. */
    perAuthor[m.from] = (perAuthor[m.from] || 0) + 1;
    if (perAuthor[m.from] > CLAIMS_PER_PLAYER) return;
    const key = m.from + '→' + named[0].id;
    if (seen[key]) return;                    // повтор той же заявки не усиливает её
    seen[key] = true;
    out.push({ from: m.from, target: named[0].id });
  });
  return out;
}

/** Сколько человек объявили себя шерифом. Двое и больше — верить некому. */
function claimants(game) {
  const set = {};
  sheriffClaims(game).forEach(c => { set[c.from] = true; });
  return Object.keys(set);
}
function sheriffClaim(game) {
  const all = sheriffClaims(game);
  return all.length ? all[all.length - 1] : null;
}

/* Свой взгляд на стол. Городской бот знает про себя, что он не мафия,
   поэтому давящий на него — первый подозреваемый; а ещё он помнит, кто
   травил тех, у кого потом открылась мирная карта. Это единственное, чем
   бот «думает», и всё это — открытая информация, доступная и человеку. */
function personalSus(game, me, sus) {
  const out = Object.assign({}, sus);
  const acc = accusationsIn(game);
  (acc[me.id] || []).forEach(id => { out[id] = (out[id] || 0) + 1.4; });
  game.players.filter(p => !p.alive).forEach(dead => {
    const wasTown = !game.isMafia(dead.id);
    (acc[dead.id] || []).forEach(id => { out[id] = (out[id] || 0) + (wasTown ? 1.1 : -1.7); });
  });
  /* Открытая проверка шерифа весит больше любого шума за столом: город,
     который не слушает шерифа, обречён. Но вес не безграничен, и когда
     шерифом называют себя двое, обе заявки стоят вдвое меньше: одна из них
     точно ложная, и бот это понимает так же, как понял бы человек. */
  const who = claimants(game).filter(id => id !== me.id);
  const trust = who.length <= 1 ? 1 : 1 / who.length;
  const claims = sheriffClaims(game).filter(c => c.from !== me.id);
  const added = {};
  claims.forEach(c => {
    /* Одному человеку от одного заявителя — один раз. Иначе повторами одна
       фраза складывалась в непробиваемое подозрение. */
    const key = c.from + '→' + c.target;
    if (added[key]) return;
    added[key] = true;
    out[c.target] = (out[c.target] || 0) + 3.2 * trust;
    /* Заявившему верим ровно настолько, насколько верим заявке. */
    out[c.from] = (out[c.from] || 0) - 1.4 * trust;
  });
  out[me.id] = -99;
  return out;
}

/** Самый подозрительный из списка. При равенстве — случайный из лидеров. */
function mostSuspected(ids, sus, exclude) {
  const list = ids.filter(id => (exclude || []).indexOf(id) < 0);
  if (!list.length) return null;
  const max = Math.max(...list.map(id => sus[id] || 0));
  return pick(list.filter(id => (sus[id] || 0) === max));
}

/* =========================================================================
   ХОД БОТА
   ========================================================================= */
function nightAction(game, me, sus) {
  const alive = game.alive();
  if (game.isMafia(me.id)) {
    const mates = alive.filter(p => game.isMafia(p.id)).map(p => p.id);
    /* Первым делом — тот, кто объявил себя шерифом: он опаснее всех. */
    const claimed = claimedSheriff(game, mates);
    const targets = alive.filter(p => mates.indexOf(p.id) < 0).map(p => p.id);
    if (!targets.length) return null;
    const trusted = invert(personalSus(game, me, sus), targets);
    const t = (claimed && targets.indexOf(claimed) >= 0) ? claimed
      : (chance(0.7) ? mostSuspected(targets, trusted) : pick(targets));
    return { type: 'kill', target: t };
  }
  if (me.role === ROLE.DOCTOR) {
    /* Себя лечим не каждую ночь: иначе доктор бессмертен и партия глохнет. */
    const blocked = game.lastHealed[me.id] || null;
    const cands = alive.map(p => p.id).filter(id => id !== blocked);
    if (!cands.length) return null;
    const self = cands.indexOf(me.id) >= 0 && chance(0.35) ? me.id : null;
    const claimed = claimedSheriff(game, []);
    const t = self || ((claimed && cands.indexOf(claimed) >= 0) ? claimed : pick(cands));
    return { type: 'heal', target: t };
  }
  if (me.role === ROLE.SHERIFF) {
    const done = (game.checkResults[me.id] || []).map(c => c.targetId);
    const claimed = sheriffClaims(game).map(c => c.target);
    const cands = alive.map(p => p.id)
      .filter(id => id !== me.id && done.indexOf(id) < 0 && claimed.indexOf(id) < 0);
    if (!cands.length) return null;
    return { type: 'check', target: mostSuspected(cands, personalSus(game, me, sus)) };
  }
  return null;
}

/* Кто вслух назвал шерифом себя — по общему чату, тем же строгим правилом,
   что и заявки. Мафия идёт за таким человеком первой ночью после раскрытия:
   так играют и живые. Важно, что раскрытием считается только «я шериф», а не
   любое упоминание слова: иначе фразой «где наш шериф?» можно было заказать
   любого, и один человек управлял всеми ботами-мафией. */
function claimedSheriff(game, skip) {
  for (let i = game.chat.length - 1; i >= 0; i--) {
    const m = game.chat[i];
    if (m.channel !== 'town') continue;
    if (!CLAIM_SELF.test(String(m.text || ''))) continue;
    if ((skip || []).indexOf(m.from) >= 0) continue;
    const p = game.p(m.from);
    if (p && p.alive) return p.id;
  }
  return null;
}

/* Мафии удобно бить того, кого город защищает, а не того, кого травит. */
function invert(sus, ids) {
  const out = {};
  const max = Math.max(1, ...ids.map(id => sus[id] || 0));
  ids.forEach(id => { out[id] = max - (sus[id] || 0); });
  return out;
}

function voteChoice(game, me, sus) {
  const alive = game.alive();
  let pool = alive.filter(p => p.id !== me.id).map(p => p.id);
  if (game.runoffOf && game.runoffOf.length) pool = game.runoffOf.filter(id => pool.indexOf(id) >= 0);
  if (!pool.length) return 'skip';

  if (game.isMafia(me.id)) {
    const mates = alive.filter(p => game.isMafia(p.id)).map(p => p.id);
    const clean = pool.filter(id => mates.indexOf(id) < 0);
    if (clean.length) return mostSuspected(clean, sus);
    return 'skip';                       // своих не сдаём
  }
  if (me.role === ROLE.SHERIFF) {
    const black = (game.checkResults[me.id] || []).filter(c => c.isMafia).map(c => c.targetId);
    const known = pool.filter(id => black.indexOf(id) >= 0);
    if (known.length) return known[0];
  }
  /* Мирный голосует не за самого громкого, а за самого подозрительного по
     своему счёту: кто давил на него самого и кто травил уже раскрывшихся
     мирных. Иначе стол превращался в стадо, и мафия водила его за руку. */
  if (chance(0.1)) return 'skip';
  return mostSuspected(pool, personalSus(game, me, sus));
}

/* Реплика бота днём.

   Обёртка нужна ровно для одного: любая функция, которой передали партию,
   должна брать случайность у этой партии. Внутри такта RNG выставляет tick(),
   но реплики просят и снаружи — симулятор баланса, разбор партии по семени,
   тесты. Пока этого не было, «та же партия» каждый раз говорила по-другому. */
function dayLine(game, me, sus, said) {
  const prev = RNG;
  RNG = (game && game.rng) || RNG;
  try { return dayLineInner(game, me, sus, said); }
  finally { RNG = prev; }
}

function dayLineInner(game, me, sus, said) {
  const alive = game.alive().filter(p => p.id !== me.id);
  if (!alive.length) return null;
  const mates = game.isMafia(me.id) ? game.alive().filter(p => game.isMafia(p.id)).map(p => p.id) : [];
  const others = alive.filter(p => mates.indexOf(p.id) < 0);
  const heat = sus[me.id] || 0;
  const sharp = me._trait ? me._trait.sharp : 0.5;

  if (!said && !game.chat.filter(m => m.channel === 'town' && m.day === game.day).length && chance(0.5)) {
    return { text: pickFresh(LINES.open, game) };
  }
  if (game.day > 1 && !said && chance(0.25)) return { text: pickFresh(LINES.mourn, game) };
  if (heat >= 2 && chance(0.7)) return { text: pickFresh(LINES.defendSelf, game) };

  /* Шериф-бот раскрывается, когда нашёл чёрного и уже опасно молчать. */
  if (me.role === ROLE.SHERIFF) {
    /* Каждого нового чёрного шериф объявляет отдельно: одна заявка на всю
       партию — это выброшенная половина работы. */
    me._told = me._told || [];
    const black = (game.checkResults[me.id] || [])
      .filter(c => c.isMafia && game.p(c.targetId) && game.p(c.targetId).alive)
      .filter(c => me._told.indexOf(c.targetId) < 0);
    if (black.length) {
      me._told.push(black[0].targetId);
      return { text: fill(pickFresh(LINES.claimSheriff, game), { T: game.nameOf(black[0].targetId) }) };
    }
  }
  const mine = personalSus(game, me, sus);
  const target = others.length ? mostSuspected(others.map(p => p.id), mine) : pick(alive).id;
  const name = game.nameOf(target);
  if (chance(sharp)) return { text: fill(pickFresh(LINES.accuse, game), { T: name }) };
  if (chance(0.45)) return { text: fill(pickFresh(LINES.question, game), { T: name }) };
  return { text: fill(pickFresh(LINES.defend, game), { T: name }) };
}

/* =========================================================================
   РАСПИСАНИЕ
   На каждую фазу боты получают сроки ходов. Пересобирается при смене фазы.
   ========================================================================= */
function planFor(room, game, now) {
  const jobs = [];
  /* Сроки ходов тоже часть партии. Пока они брались из Math.random, стол по
     одному сиду каждый раз говорил в другом порядке — а порядок речей меняет
     то, кого стол успевает заподозрить. Здесь та же случайность, что у
     раздачи ролей. */
  const R = game.rng ? () => game.rng.next() : Math.random;
  const bots = game.players.filter(p => p.alive && isBotId(p.id));
  const phaseMs = Math.max(6, game.phaseSeconds()) * 1000;

  bots.forEach(b => {
    if (game.phase === 'night') {
      jobs.push({ id: b.id, at: now + 2000 + R() * Math.min(9000, phaseMs * 0.5), kind: 'night' });
    } else if (game.phase === 'day') {
      const trait = b._trait || TRAITS[0];
      const lines = trait.talk === 2 ? (chance(0.5) ? 2 : 1) : (chance(0.35) ? 1 : 0);
      const window = Math.min(phaseMs * 0.6, 16000);
      for (let i = 0; i < lines; i++) {
        jobs.push({ id: b.id, at: now + 2500 + R() * window + i * 5000, kind: 'say' });
      }
      /* «Я высказался» боты нажимают, поговорив, — и дальше день держит только
         человек. День всё равно не закроется, пока не готовы все живые, так
         что раннее «готов» у ботов не отбирает у игрока ни секунды. */
      jobs.push({ id: b.id, at: now + Math.min(phaseMs * 0.6, 17000 + R() * 9000), kind: 'ready' });
    } else if (game.phase === 'vote' || game.phase === 'runoff') {
      jobs.push({ id: b.id, at: now + 1500 + R() * Math.min(8000, phaseMs * 0.6), kind: 'vote' });
    } else if (game.phase === 'morning') {
      if (chance(0.5)) jobs.push({ id: b.id, at: now + 1200 + R() * 3000, kind: 'mourn' });
    }
  });
  /* Последнее слово выбывшего-бота. Стол не должен сидеть в тишине двадцать
     секунд из-за того, что вывели соседа: бот говорит одну фразу и уходит.
     Первой ночью он вместе с фразой называет три имени — лучший ход. */
  if (game.phase === 'lastword' && game.lastWordId && isBotId(game.lastWordId)) {
    jobs.push({ id: game.lastWordId, at: now + 1200 + R() * 1800, kind: 'lastword' });
    jobs.push({ id: game.lastWordId, at: now + 4200 + R() * 2200, kind: 'lastpass' });
  }

  /* В круге речей говорящий меняется по нескольку раз за фазу, поэтому в
     ключ плана входит и он: иначе бот, получивший слово, ждал бы следующей
     фазы, чтобы что-нибудь сказать. */
  if (game.phase === 'speech' && game.speaker && isBotId(game.speaker)) {
    const me = game.p(game.speaker);
    if (me && me.alive) {
      const trait = me._trait || TRAITS[0];
      /* Молчаливый бот высказывается коротко, говорливый — двумя фразами.
         Слово он передаёт сам: стол не должен ждать сорок пять секунд, пока
         сосед-бот додумает мысль. */
      const lines = trait.talk === 2 ? 2 : 1;
      for (let i = 0; i < lines; i++) {
        jobs.push({ id: me.id, at: now + 1400 + R() * 2200 + i * 2600, kind: 'speak' });
      }
      jobs.push({
        id: me.id,
        at: now + 1400 + lines * 2600 + R() * 2000,
        kind: 'pass'
      });
    }
  }

  jobs.sort((a, b) => a.at - b.at);
  return { key: game.phase + ':' + game.day + ':' + (game.speaker || '') +
    ':' + (game.lastWordId || ''), jobs: jobs };
}

/**
 * Ход всех ботов комнаты. Вызывается из такта сервера раз в секунду.
 * @returns {boolean} изменилось ли что-нибудь (нужен ли пуш клиентам)
 */
function tick(room, now) {
  const game = room.game;
  if (!game || game.finished) return false;
  now = now || Date.now();

  /* Случайность берём у партии: при том же семени стол ведёт себя так же,
     и симулятор баланса перестаёт шуметь от прогона к прогону.

     Порядок здесь важен. Раньше эта строка стояла ПОСЛЕ раздачи характеров,
     и характер выбирался ещё через Math.random. Характер решает, сколько бот
     говорит и насколько резко голосует, — то есть от него зависит исход
     партии. Симулятор это и поймал: один и тот же сид давал то победу
     города, то победу мафии. Семя обязано быть первым. */
  RNG = game.rng || null;

  /* Характер держим на игроке движка: он живёт ровно столько, сколько партия. */
  game.players.forEach(p => {
    if (isBotId(p.id) && !p._trait) {
      const b = (room.bots || []).find(x => x.id === p.id);
      p._trait = (b && b.trait) || pick(TRAITS);
    }
  });

  const key = game.phase + ':' + game.day + ':' + (game.speaker || '') +
    ':' + (game.lastWordId || '');
  if (!room.botPlan || room.botPlan.key !== key) room.botPlan = planFor(room, game, now);

  let changed = false;
  const sus = suspicionMap(game);
  const rest = [];
  room.botPlan.jobs.forEach(job => {
    if (job.at > now) { rest.push(job); return; }
    const me = game.p(job.id);
    if (!me) return;
    /* Мёртвый бот молчит — кроме своего последнего слова: в этом весь его
       смысл. Проверка «только живые» отменяла бы механику целиком. */
    const lastWordMine = game.phase === 'lastword' && game.lastWordId === me.id;
    if (!me.alive && !lastWordMine) return;
    try {
      if (job.kind === 'night') {
        const a = nightAction(game, me, sus);
        if (a && a.target) { game.action(me.id, a.type, a.target); changed = true; }
        /* «Следствие»: способ выбирает мафия, и бот выбирает его как игрок —
           обычно тихо, но если город уже поджимает, идёт грубо и быстро,
           чтобы врач не успел. Без этого выбора ночь всегда была бы «тихой»
           и режим потерял бы половину смысла. */
        if (game.mode === 'inquest' && game.isMafia(me.id) && !game.nightMethod) {
          const pressed = game.aliveMafia().length * 2 >= game.alive().length;
          const method = pressed ? 'rough' : (chance(0.35) ? 'clean' : 'quiet');
          game.action(me.id, 'method', method);
          changed = true;
        }
      } else if (job.kind === 'vote') {
        const t = voteChoice(game, me, sus);
        if (t) {
          game.action(me.id, 'vote', t);
          if (chance(0.25)) game.say(me.id, pickFresh(LINES.vote, game), 'town');
          changed = true;
        }
      } else if (job.kind === 'say') {
        const line = dayLine(game, me, sus, me._saidToday === game.day);
        if (line) {
          me._saidToday = game.day;
          const r = game.say(me.id, line.text, 'town');
          if (!r.error) changed = true;
        }
      } else if (job.kind === 'mourn') {
        const r = game.say(me.id, pickFresh(LINES.mourn, game), 'town');
        if (!r.error) changed = true;
      } else if (job.kind === 'speak') {
        /* Речь по кругу: та же реплика, что и в общем обсуждении, но она
           точно прозвучит — слово принадлежит боту, и его никто не перебьёт. */
        if (game.phase === 'speech' && game.speaker === me.id) {
          const line = dayLine(game, me, sus, me._spokeAt === game.day + ':' + me.id);
          if (line) {
            me._spokeAt = game.day + ':' + me.id;
            const r = game.say(me.id, line.text, 'town');
            if (!r.error) changed = true;
          }
        }
      } else if (job.kind === 'lastword') {
        if (game.phase === 'lastword' && game.lastWordId === me.id) {
          /* Лучший ход: три самых подозрительных для города. Бот-мафия
             называет своих последними — то есть подставляет мирных, и это
             честная игра за свою команду, а не поддавки. */
          if (game.bestMoveOpen) {
            const mine = game.isMafia(me.id);
            const cand = game.alive().filter(p => p.id !== me.id);
            cand.sort((a, b) => {
              const ka = (mine ? (game.isMafia(a.id) ? -3 : 1) : 0) + (sus[a.id] || 0);
              const kb = (mine ? (game.isMafia(b.id) ? -3 : 1) : 0) + (sus[b.id] || 0);
              return kb - ka;
            });
            const picks = cand.slice(0, 3).map(p => p.id);
            if (picks.length === 3) game.action(me.id, 'bestmove', picks.join(','));
          }
          const bank = game.isMafia(me.id) ? LINES.lastWordMafia : LINES.lastWordTown;
          const target = game.alive().filter(p => p.id !== me.id)
            .sort((a, b) => (sus[b.id] || 0) - (sus[a.id] || 0))[0];
          const text = pickFresh(bank, game).replace(/\{T\}/g, target ? target.name : 'того, кто громче всех');
          const r = game.say(me.id, text, 'town');
          if (!r.error) changed = true;
        }
      } else if (job.kind === 'lastpass') {
        if (game.phase === 'lastword' && game.lastWordId === me.id) {
          game.action(me.id, 'pass', null);
          changed = true;
        }
      } else if (job.kind === 'pass') {
        if (game.phase === 'speech' && game.speaker === me.id) {
          game.action(me.id, 'pass', null);
          changed = true;
        }
      } else if (job.kind === 'ready') {
        game.action(me.id, 'ready', null);
        changed = true;
      }
    } catch (e) {
      /* Сбой одного бота не должен ронять такт всей комнаты. */
      console.warn('Бот ' + me.name + ' сбился: ' + e.message);
    }
  });
  room.botPlan.jobs = rest;
  return changed;
}

/* Внутренности, открытые тестам. В игре они не нужны: наружу бот показывает
   только ходы и реплики. Но проверить, что фразой «шериф проверил такого-то»
   больше нельзя заказать человека, можно только заглянув в эти функции. */
const __test = { sheriffClaims, claimants, personalSus, suspicionMap, dayLine, claimedSheriff, pickFresh };

module.exports = { isBotId, makeBot, tick, NAMES, PREFIX, __test };
