/* =========================================================================
   Серверный движок сетевой партии.
   Вся секретная информация живёт только здесь: клиент получает
   урезанную картинку через viewFor(userId).
   ========================================================================= */
'use strict';
const C = require('../shared/game-config.js');
const Rng = require('../shared/rng.js');
const Inquest = require('../shared/inquest.js');
const ROLE = C.ROLE;

/* Свободные функции оставлены для совместимости с тем, что их уже
   импортирует, но сама партия ими не пользуется: все её случайные решения
   идут через сеяный генератор, привязанный к партии (см. this.rng). */
function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
const now = () => Date.now();

/* Метки на ночной доске мафии. Их ровно три, и это осознанно: доска нужна,
   чтобы за полминуты договориться, а не чтобы вести протокол. */
const MAFIA_TAGS = ['target', 'watch', 'skip'];
const MAFIA_TAG_RU = { target: 'бьём', watch: 'присмотреть', skip: 'не трогать' };

class Game {
  /**
   * @param {Array<{id:string,name:string}>} members
   * @param {string} scenarioId
   */
  constructor(members, scenarioId, opts) {
    opts = opts || {};
    const n = members.length;
    /* Видят ли выбывшие ночной шёпот мафии. По умолчанию нет: за одним столом
       в одной комнате выбывший, читающий переписку мафии, знает весь расклад,
       а живым остаётся верить, что он промолчит. Хозяин может включить —
       осознанно, для своей компании. */
    this.deadSeeAll = !!opts.deadSeeAll;

    /* Семя партии. Все случайные решения движка — раздача ролей, выбор сюжета,
       разрешение ничьей в ночном выборе, удар вслепую — идут отсюда. Раньше
       это был Math.random(), и партию нельзя было ни повторить, ни разобрать:
       на жалобу «нам третий раз подряд выпала мафия на одних местах» ответить
       было нечем. Семя видно игроку в конце партии, по нему стол собирается
       заново до последней карты. */
    this.seed = String(opts.seed || Rng.freshSeed());
    this.rng = Rng.createRng(this.seed);

    /* Скорость стола. «Блиц» — партия в перерыве, «Клуб» — полные речи.
       Пресеты живут в конфигурации, здесь только выбор. */
    this.speed = C.speedById(opts.speed).id;
    this.timing = C.timing(n, this.speed);
    this.scenario = C.scenarioById(scenarioId) || this.rng.pick(C.scenariosFor(n)) || C.SCENARIOS[0];

    /* Пресет ролей. Классика — по умолчанию и всегда: человек, впервые
       открывший сайт, должен сесть за стол, правила которого он уже знает.
       Расширенный набор выбирается осознанно при создании комнаты, и если
       выбранный пресет на этот стол не садится (полный набор требует
       двенадцати человек), молча падаем в классику вместо того, чтобы
       раздать состав, которого никто не просил. */
    const wanted = C.presetById(opts.rolePreset);
    this.preset = (n >= wanted.min && n <= wanted.max) ? wanted.id : 'classic';
    this.composition = C.composition(n, this.preset);

    const roles = this.rng.shuffle(C.rolePool(n, this.preset));
    this.players = members.map((m, i) => ({
      id: m.id,
      name: m.name,
      seat: i + 1,
      role: roles[i],
      alive: true,
      deathDay: null,
      deathCause: null
    }));

    /* Речи по кругу. В конфигурации на них была отведена своя длительность
       (timing.speech), но фазы для них в движке не существовало вовсе: день был
       общим криком, где на столе из двадцати человек успевали высказаться
       трое. Круг даёт слово каждому по очереди — это и есть мафия. */
    this.speeches = opts.speeches !== false;
    this.speaker = null;            // кому слово прямо сейчас
    this.speechQueue = [];          // кто ещё не говорил в этом круге
    this.spoke = {};                // кто уже высказался — стол это видит
    this.firstSpeakerSeat = 1;      // первое слово каждый день переходит дальше

    /* Режим партии. 'classic' — обычная «Мафия»; 'inquest' — «Следствие»,
       где у каждого есть приметы, ночь оставляет улики, а днём город может
       проверить одного человека по одной примете. Правила режима живут в
       shared/inquest.js, здесь — только их место в ходе партии. */
    this.mode = opts.mode === 'inquest' ? 'inquest' : 'classic';
    if (this.mode === 'inquest') {
      this.traits = Inquest.dealTraits(this.rng, this.players);
      this.clues = [];              // публичные улики: { day, traitId, text, shared }
      this.usedClueTraits = [];     // какие приметы уже назывались
      this.nightMethod = null;      // способ, выбранный мафией на эту ночь
      this.killerId = null;         // кто держал нож этой ночью
      this.expertVotes = {};        // voterId -> { targetId, traitId }
      this.expertDone = {};         // day -> true: одна экспертиза в день
      this.expertLog = [];          // { day, targetId, traitId, has }
      this.publicTraits = {};       // приметы выбывших — общее достояние
    }

    /* ------------------------------------------------------------------
       ПОСЛЕДНЕЕ СЛОВО И ЛУЧШИЙ ХОД

       Две механики живых столов, которых в движке не было, а спрашивают о
       них чаще всего.

       Последнее слово: того, кого только что вывели, стол выслушивает перед
       уходом. Это не украшение — это информация. Половина разборов после
       партии строится на том, что сказал выбывший, и без последнего слова
       игра теряет самый драматичный свой момент: человек уже знает, что
       проиграл эту роль, и говорит то, что думает.

       Лучший ход: убитый первой ночью называет трёх подозреваемых. Мафия
       ходит первой и знает друг друга, город не знает ничего — лучший ход
       и есть та компенсация, которая даёт городу стартовый капитал. В
       спортивной мафии это стандарт.
       ------------------------------------------------------------------ */
    this.lastWordOn = opts.lastWord !== false;
    this.bestMoveOn = opts.bestMove !== false;
    this.lastWordId = null;        // кто говорит последнее слово
    this.lastWordNext = null;      // куда идём после него: 'speech' | 'night'
    /* Очередь на последнее слово. Раньше здесь стоял один игрок, и этого
       хватало: за ночь погибал максимум один. С маньяком за ночь погибают
       двое, а стол решением «поднять всех» выводит и трёх сразу — говорить
       им надо по очереди, иначе стол не услышит никого. */
    this.lastWordQueue = [];
    this.bestMoveOpen = false;     // ждём ли трёх имён от него
    this.bestMove = null;          // { by, byName, picks:[{id,name,seat}], hits }

    /* ------------------------------------------------------------------
       ПРАВИЛА СТОЛА

       Три настройки, каждая из которых делает из одного движка другую игру.

       voteOpen — открытое или закрытое голосование. При открытом стол видит
       в реальном времени, кто куда поднял руку, и это меняет всё: голос
       становится высказыванием, за которым следят, а поздний голос — самым
       ценным. При закрытом видно только «проголосовал», а расклад
       открывается вместе с итогом. Фактически это две разные игры на одном
       движке, поэтому и настройка, а не жёсткое правило.

       onTie — что делать при ничьей в переголосовке. 'none' — прежнее
       поведение: никого не выводим. 'table' — стол решает сам, поднимать
       всех или оставить всех. Второе и есть классика живых столов: случайный
       тай-брейк — самая частая причина фразы «да ну, ерунда какая-то».

       fouls — дисциплина. За перебивание чужой речи предупреждение, за
       четыре — пропуск своей речи. На столе от пятнадцати человек без этого
       круг речей превращается в общий крик, ради отмены которого он и нужен.
       ------------------------------------------------------------------ */
    this.voteOpen = opts.voteOpen !== false;
    this.onTie = opts.onTie === 'table' ? 'table' : 'none';
    this.foulsOn = opts.fouls === undefined ? (n >= 15) : !!opts.fouls;
    this.fouls = {};                // playerId -> сколько раз перебил
    this.foulSkip = {};             // playerId -> пропускает следующую речь
    this.tieOf = null;              // кого поднимаем на голосовании стола

    this.day = 0;
    this.phase = 'prologue';        // prologue | night | morning | lastword | speech | day | vote | runoff | tievote | over
    this.deadline = now() + 12000;
    this.finished = false;
    this.winner = null;
    this.log = [];                  // публичный протокол
    this.chat = [];                 // { channel:'town'|'mafia'|'ghost', from, name, text, ts }
    this.nightActions = { kill: {}, heal: {}, check: {} };
    this.lastHealed = {};           // doctorId -> targetId прошлой ночи
    this.checkResults = {};         // sheriffId -> [{targetId, name, isMafia, day}]
    this.votes = {};                // voterId -> targetId | 'skip'
    this.runoffOf = null;           // список id для переголосовки

    /* ------------------------------------------------------------------
       РАСШИРЕННЫЙ НАБОР РОЛЕЙ

       Пять карт — пять исключений из общих правил, и каждое хранит своё.
       Заводим всё всегда, а не только когда роль на столе: проверка
       «а есть ли у нас журналист» в двадцати местах кода дороже пяти
       пустых объектов.
       ------------------------------------------------------------------ */
    this.nightActions.slay = {};    // маньяк -> кого
    this.nightActions.block = {};   // любовница -> кого
    this.nightActions.shield = {};  // адвокат -> кого прикрывает от изгнания
    this.nightActions.press = {};   // журналист -> 'idA,idB'
    this.lastBlocked = {};          // любовница -> кого блокировала прошлой ночью
    this.blockedLast = [];          // кого заблокировали этой ночью (для протокола)
    this.pressResults = {};         // журналист -> [{aId,bId,aName,bName,sameTeam,day}]
    this.lawyerSpent = {};          // адвокат -> право уже сработало
    this.shieldSkip = {};           // адвокат -> «этой ночью берегу право»
    this.lawyerSaved = [];          // кого адвокат уже вытащил — это публично
    /* Ночная доска мафии. Общий приватный холст: метка на месте, которую
       видят и ставят все свои. До этого ночь мафии была одним кликом — и
       на большом столе трое чёрных не могли даже договориться, кого
       обсуждать днём, не выдав себя в общем чате. */
    this.mafiaBoard = {};           // targetId -> { tag, byName, ts }
    this.omenStep = 0;
    /* Кто сейчас без связи. Такие игроки не должны держать фазу: раньше
       один закрытый ноутбук растягивал ночь на полный таймаут, и это
       читалось как «лаги». */
    this.offline = new Set();
    /* Кто встал и ушёл. Место за столом остаётся (движок не умеет убирать
       игрока посреди партии, и это правильно: состав ролей уже роздан), но
       ходов от него никто не ждёт, а вернуться он может в любой момент. */
    this.left = new Set();

    /* Когда слово идёт по кругу, общее обсуждение после него короче: иначе
       день на двадцать человек растягивается на двадцать пять минут.
       Насколько короче — решает пресет скорости. */
    if (this.speeches) this.timing.day = this.timing.afterCircle;

    this.pushLog('story', this.scenario.prologue);
    this.pushLog('sys', 'Состав стола: ' + C.compositionLabel(n, this.preset) + '.');
    /* Про третью силу стол узнаёт до раздачи, а не в финале. Иначе город
       весь вечер считает чёрных по головам и не понимает, почему счёт не
       сходится: это не загадка, а поломанная арифметика. */
    if (this.composition.sides === 3) {
      this.pushLog('sys', 'За столом три силы, а не две: кроме мафии есть маньяк. ' +
        'Он ходит ночью один и побеждает один.');
    }
    if (this.preset !== 'classic') {
      this.pushLog('sys', 'Пресет стола: «' + C.presetById(this.preset).ru + '». ' +
        C.presetById(this.preset).hint + '.');
    }
    if (!this.voteOpen) {
      this.pushLog('sys', 'Голосование закрытое: видно, кто уже проголосовал, но не за кого.');
    }
    if (this.onTie === 'table') {
      this.pushLog('sys', 'При ничьей стол решает сам: поднять всех или оставить всех.');
    }
    if (this.foulsOn) {
      this.pushLog('sys', 'Фолы включены: перебил чужое слово — предупреждение, ' +
        'четыре предупреждения — пропуск своей речи.');
    }
    if (this.mode === 'inquest') {
      this.pushLog('sys', 'Следствие. У каждого за столом три приметы — свои вы знаете, чужие нет. ' +
        'Каждое утро город получает улики: улика всегда говорит правду о том, кто убивал. ' +
        'Днём можно сложиться и проверить одного человека по одной примете. ' +
        'Приметы выбывшего становятся известны всем.');
    }
    if (this.speeches) {
      this.pushLog('sys', 'Слово идёт по кругу: у каждого ' + this.timing.speech +
        ' секунд, можно передать слово раньше.');
    }
    if (this.lastWordOn) {
      this.pushLog('sys', 'Последнее слово: выбывший получает ' + this.timing.lastWord +
        ' секунд высказаться перед уходом.' +
        (this.bestMoveOn ? ' Убитый первой ночью назовёт трёх подозреваемых — это «лучший ход».' : ''));
    }
  }

  /* ------------------------------ утилиты ------------------------------ */
  pushLog(kind, text) {
    this.log.push({ kind, text, day: this.day, ts: now() });
    if (this.log.length > 400) this.log.shift();
  }
  p(id) { return this.players.find(x => x.id === id) || null; }
  alive() { return this.players.filter(x => x.alive); }
  aliveMafia() { return this.alive().filter(x => this.isMafia(x.id)); }
  /* «Город» — это все, кто не мафия. Осторожно: маньяк тоже сюда попадает,
     и потому эта функция больше не годится для условия победы (см. checkWin).
     Оставлена там, где смысл именно «не мафия»: право говорить, право быть
     целью, счёт живых для игрока. */
  aliveTown() { return this.alive().filter(x => !this.isMafia(x.id)); }
  isMafia(id) { const p = this.p(id); return !!p && (p.role === ROLE.MAFIA || p.role === ROLE.DON); }
  isManiac(id) { const p = this.p(id); return !!p && p.role === ROLE.MANIAC; }
  /** Команда игрока: 'mafia' | 'town' | 'maniac'. Команд три, а не две. */
  teamOf(id) { const p = this.p(id); return p ? C.teamOf(p.role) : 'town'; }
  /** Есть ли на столе хоть одна карта этой роли (жива или нет). */
  hasRole(role) { return this.players.some(p => p.role === role); }
  /** Живые с этой ролью. */
  aliveWith(role) { return this.alive().filter(p => p.role === role); }
  /** Счёт по командам среди живых: { mafia, town, maniac }. */
  headcount() {
    const out = { mafia: 0, town: 0, maniac: 0 };
    this.alive().forEach(p => { out[C.teamOf(p.role)]++; });
    return out;
  }
  nameOf(id) { const p = this.p(id); return p ? p.name : '?'; }
  secondsLeft() { return Math.max(0, Math.ceil((this.deadline - now()) / 1000)); }

  /* ------------------------------ чат ------------------------------ */
  /* Кого назвали в реплике: имя в любом падеже или номер места («№3», «3-й»). */
  mentionsIn(text) {
    const low = ' ' + String(text || '').toLowerCase().replace(/\u0451/g, '\u0435')
      .replace(/[^0-9a-z\u0430-\u044f\s\u2116#-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const out = [];
    for (const pl of this.players) {
      const nm = String(pl.name || '').toLowerCase().replace(/\u0451/g, '\u0435');
      if (!nm) continue;
      /* Имя надо узнать в любом падеже. В русском склоняется конец слова, и
         правило простое: у имён на гласную последнюю букву отбрасываем
         («Вера» → «вер», и тогда находятся «Веру», «Вере», «Верой»), у имён
         на согласную оставляем как есть — падежные окончания к ним
         дописываются («Борис» → «Бориса», и совпадение находится по началу).

         Две границы. Короткие имена не режем: от «Ани» останется «ан», и
         обращением станет любое «Антон». И не режем имена, кончающиеся
         цифрой: «Игрок1» и «Игрок2» свелись бы к одному «игрок», после чего
         каждая фраза считалась бы обращением ко всему столу сразу. */
      const cutTail = nm.length >= 4 && !/\d$/.test(nm) && /[аяоеиыуюё]$/.test(nm);
      const stem = cutTail ? nm.slice(0, nm.length - 1) : nm;
      const bySeat = new RegExp('(^|[\\s\\u2116#])' + pl.seat + '(-\u0439|-\u0433\u043e|[\\s,.!?:;]|$)').test(low);
      if (low.indexOf(' ' + stem) >= 0 || bySeat) out.push({ id: pl.id, seat: pl.seat, name: pl.name });
    }
    return out;
  }

  say(userId, text, channel) {
    const p = this.p(userId);
    if (!p) return { error: 'Вы не за столом' };
    text = String(text || '').slice(0, 400).trim();
    if (!text) return { error: 'Пустое сообщение' };

    const t = now();

    let ch = channel || 'town';
    /* Последнее слово — единственный случай, когда выбывший говорит со
       столом. Без этого исключения его реплики уходили бы в чат выбывших,
       то есть в пустоту: живые их не видят. */
    if (!p.alive && !(this.phase === 'lastword' && this.lastWordId === userId)) ch = 'ghost';
    else if (ch === 'mafia' && !(this.isMafia(userId) && this.phase === 'night')) return { error: 'Ночной чат сейчас недоступен' };
    else if (ch === 'town' && this.phase === 'speech') {
      /* В этом и весь смысл круга: пока говорит один, остальные слушают.
         Раньше «речь по кругу» была невозможна в принципе — стол писал в
         общий чат всегда, и на двадцати человеках высказывались трое. */
      if (this.speaker !== userId) {
        return Object.assign(
          { error: 'Слово у ' + this.nameOf(this.speaker) + ' — дождитесь своей очереди' },
          this.foul(userId, t));
      }
    }
    else if (ch === 'town' && this.phase === 'lastword') {
      if (this.lastWordId !== userId) {
        return Object.assign(
          { error: 'Последнее слово у ' + this.nameOf(this.lastWordId) },
          this.foul(userId, t));
      }
    }
    else if (ch === 'town' && !(this.phase === 'prologue' || this.phase === 'day' || this.phase === 'vote' || this.phase === 'runoff' || this.phase === 'tievote' || this.phase === 'morning' || this.phase === 'over')) {
      return { error: 'Город спит — говорить нельзя' };
    }

    /* антифлуд общего стола: шёпот мафии, голоса за чертой и последнее
       слово не ограничены — там говорит один, и перебить его нельзя */
    if (ch === 'town' && this.phase !== 'speech' && this.phase !== 'lastword') {
      if (p.lastSayAt && t - p.lastSayAt < 900) return { error: 'Не так быстро — дайте столу вставить слово' };
      if (p.lastSayText === text && t - (p.lastSayTextAt || 0) < 15000) return { error: 'Вы уже это сказали' };
      p.lastSayAt = t;
      p.lastSayText = text;
      p.lastSayTextAt = t;
    }

    const mentions = this.mentionsIn(text).filter(m => m.id !== userId);
    this.chat.push({
      channel: ch, from: userId, name: p.name, seat: p.seat, text, ts: t, day: this.day,
      mentions: mentions.map(m => m.id),
      mentionNames: mentions.map(m => m.name)
    });
    if (this.chat.length > 500) this.chat.shift();

    /* обращение по имени попадает в протокол — его видят все, кто читает канал */
    if (ch === 'town' && mentions.length) {
      this.pushLog('talk', p.name + ' обращается к: ' + mentions.map(m => m.name).join(', '));
    }
    return { ok: true, mentions: mentions.map(m => m.id) };
  }

  /* ------------------------------ фолы ------------------------------
     Перебил чужое слово — фол. Механика скучная и совершенно необходимая:
     на столе от пятнадцати человек круг речей без неё превращается в общий
     крик, ради отмены которого он и заведён.

     Считаем попытки говорить не в свою очередь, а не сами слова: сказанного
     всё равно никто не увидит — движок реплику отклоняет. Два фола —
     предупреждение вслух, четыре — пропуск своей речи в следующем круге.
     Дальше счётчик не растёт: смысл наказания в том, чтобы человек услышал
     себя, а не в том, чтобы выкинуть его из партии.

     Одна попытка в две секунды: двойной клик по «Отправить» — это один
     перебив, а не два. */
  foul(userId, t) {
    if (!this.foulsOn) return {};
    const p = this.p(userId);
    if (!p || !p.alive) return {};
    if (p.lastFoulAt && t - p.lastFoulAt < 2000) return {};
    p.lastFoulAt = t;
    const n = this.fouls[userId] = (this.fouls[userId] || 0) + 1;
    if (n % 4 === 0) {
      this.foulSkip[userId] = true;
      this.pushLog('foul', 'Фол ' + n + ': ' + p.name + ' пропускает свою следующую речь.');
      return { foul: n, skip: true };
    }
    if (n % 2 === 0) {
      this.pushLog('foul', 'Фол ' + n + ': ' + p.name + ' перебивает. Ещё два — и речь пропускается.');
      return { foul: n, warned: true };
    }
    return { foul: n };
  }

  /* ------------------------------ действия ------------------------------ */
  action(userId, type, targetId) {
    const me = this.p(userId);
    if (!me) return { error: 'Действие недоступно' };
    /* Выбывший обычно ничего не делает — кроме последнего слова и лучшего
       хода: и то и другое он подаёт уже мёртвым, и именно в этом их смысл. */
    const lastWordMine = this.phase === 'lastword' && this.lastWordId === userId;
    if (!me.alive && !lastWordMine) return { error: 'Действие недоступно' };
    const t = targetId ? this.p(targetId) : null;

    /* Лучший ход: три имени от убитого первой ночью. Подаётся одной
       строкой «id,id,id» — стол видит результат целиком, а не по одному
       имени, иначе первое же названное имя решило бы день. */
    if (type === 'bestmove') {
      if (!this.bestMoveOpen || !lastWordMine) return { error: 'Лучший ход сейчас не ваш' };
      const ids = String(targetId || '').split(',').map(x => x.trim()).filter(Boolean);
      const picks = [];
      for (const id of ids) {
        const q = this.p(id);
        if (!q || q.id === userId) continue;
        if (picks.some(x => x.id === q.id)) continue;
        picks.push({ id: q.id, name: q.name, seat: q.seat });
      }
      if (picks.length !== 3) return { error: 'Нужно назвать ровно трёх разных игроков' };
      this.bestMoveOpen = false;
      this.bestMove = {
        by: userId, byName: me.name, bySeat: me.seat, picks,
        /* Сколько из названных оказались чёрными. Считаем сразу, но
           показываем только после занавеса: до него это раскрытие ролей. */
        hits: picks.filter(x => this.isMafia(x.id)).length
      };
      this.pushLog('bestmove', 'Лучший ход ' + me.name + ': ' +
        picks.map(x => x.name + ' (' + x.seat + ')').join(', ') + '.');
      return { ok: true };
    }

    if (type === 'kill') {
      if (this.phase !== 'night' || !this.isMafia(userId)) return { error: 'Не сейчас' };
      if (!t || !t.alive || this.isMafia(targetId)) return { error: 'Неверная цель' };
      this.nightActions.kill[userId] = targetId;
      return { ok: true };
    }
    if (type === 'heal') {
      if (this.phase !== 'night' || me.role !== ROLE.DOCTOR) return { error: 'Не сейчас' };
      if (!t || !t.alive) return { error: 'Неверная цель' };
      if (this.lastHealed[userId] === targetId) return { error: 'Этого же человека две ночи подряд лечить нельзя' };
      this.nightActions.heal[userId] = targetId;
      return { ok: true };
    }
    if (type === 'check') {
      if (this.phase !== 'night' || me.role !== ROLE.SHERIFF) return { error: 'Не сейчас' };
      if (!t || !t.alive || targetId === userId) return { error: 'Неверная цель' };
      this.nightActions.check[userId] = targetId;
      return { ok: true };
    }

    /* ---------------- расширенный набор: ночные дела ---------------- */

    /* Маньяк. Отдельный тип действия, а не 'kill': у мафии ход общий и
       считается голосованием, у маньяка он свой и ни с кем не складывается.
       Своих у него нет, поэтому и запрета «не бей своего» тоже нет. */
    if (type === 'slay') {
      if (this.phase !== 'night' || me.role !== ROLE.MANIAC) return { error: 'Не сейчас' };
      if (!t || !t.alive || targetId === userId) return { error: 'Неверная цель' };
      this.nightActions.slay[userId] = targetId;
      return { ok: true };
    }
    /* Любовница. Ограничение «не два раза подряд» ровно то же, что у врача,
       и по той же причине: иначе один игрок оказывается вычеркнут из ночи
       на всю партию, а это не игра, а приговор. */
    if (type === 'block') {
      if (this.phase !== 'night' || me.role !== ROLE.LOVER) return { error: 'Не сейчас' };
      if (!t || !t.alive || targetId === userId) return { error: 'Неверная цель' };
      if (this.lastBlocked[userId] === targetId) return { error: 'Этого же человека две ночи подряд нельзя' };
      this.nightActions.block[userId] = targetId;
      return { ok: true };
    }
    /* Адвокат. Право одно на партию, но тратится только когда сработало:
       иначе роль сводилась бы к угадыванию, кого выведут завтра, — то есть
       к одному шансу из десяти быть полезным за весь вечер.

       Пустая цель — это «берегу право», и это полноценный ход, а не отказ
       отвечать. Без него получалась дыра, которую видно только в живой
       партии: ночь не ждёт адвоката (иначе он был бы обязан прикрывать
       кого-то каждую ночь), а закрывается она, как только отходили все
       прочие. На столе с ботами это происходит за десять секунд — и адвокат
       физически не успевал нажать ни на что. Решение простое: ночь ждёт от
       него решения, а «не тратить» и есть решение. */
    if (type === 'shield') {
      if (this.phase !== 'night' || me.role !== ROLE.LAWYER) return { error: 'Не сейчас' };
      if (this.lawyerSpent[userId]) return { error: 'Право защиты уже сработало' };
      if (!targetId) {
        this.shieldSkip[userId] = true;
        delete this.nightActions.shield[userId];
        return { ok: true, kept: true };
      }
      if (!t || !t.alive) return { error: 'Неверная цель' };
      delete this.shieldSkip[userId];
      this.nightActions.shield[userId] = targetId;
      return { ok: true };
    }
    /* Журналист. Пара подаётся одной строкой «id,id»: два отдельных
       нажатия дали бы половину факта, а половина этого факта бессмысленна. */
    if (type === 'press') {
      if (this.phase !== 'night' || me.role !== ROLE.JOURNALIST) return { error: 'Не сейчас' };
      const ids = String(targetId || '').split(',').map(x => x.trim()).filter(Boolean);
      const pair = [];
      for (const id of ids) {
        const q = this.p(id);
        if (!q || !q.alive || q.id === userId) continue;
        if (pair.indexOf(q.id) >= 0) continue;
        pair.push(q.id);
      }
      if (pair.length !== 2) return { error: 'Нужно назвать двух разных живых игроков' };
      this.nightActions.press[userId] = pair.join(',');
      return { ok: true };
    }
    /* Ночная доска мафии. Метка на месте, общая для своих: до этого ночь
       мафии была одним кликом, и договориться, кого топить днём, было
       негде — кроме общего чата, то есть при всём городе. */
    if (type === 'mark') {
      if (!this.isMafia(userId)) return { error: 'Доска только для своих' };
      if (this.phase !== 'night') return { error: 'Доска открыта ночью' };
      const parts = String(targetId || '').split(':');
      const who = this.p(parts[0]);
      const tag = parts[1] || '';
      if (!who) return { error: 'Неверная цель' };
      if (!tag) delete this.mafiaBoard[who.id];
      else if (MAFIA_TAGS.indexOf(tag) < 0) return { error: 'Неизвестная метка' };
      else this.mafiaBoard[who.id] = { tag, byName: me.name, ts: now() };
      return { ok: true };
    }

    if (type === 'vote') {
      /* Голосование стола при ничьей: «поднять всех» или «оставить всех».
         Здесь голос — да или нет, а не имя, поэтому и цели у него две. */
      if (this.phase === 'tievote') {
        if (targetId !== 'yes' && targetId !== 'no') return { error: 'Только «поднять всех» или «оставить всех»' };
        this.votes[userId] = targetId;
        return { ok: true };
      }
      if (this.phase !== 'vote' && this.phase !== 'runoff') return { error: 'Голосование ещё не идёт' };
      if (targetId !== 'skip') {
        if (!t || !t.alive) return { error: 'Неверная цель' };
        if (this.runoffOf && this.runoffOf.indexOf(targetId) < 0) return { error: 'Этого игрока нет в переголосовке' };
      }
      this.votes[userId] = targetId;
      return { ok: true };
    }
    /* Способ убийства. Решение мафии, и оно не бесплатное: за две улики
       городу мафия получает ночь, в которую врач не успевает. */
    if (type === 'method') {
      if (this.mode !== 'inquest') return { error: 'Не в этом режиме' };
      if (this.phase !== 'night' || !this.isMafia(userId)) return { error: 'Не сейчас' };
      if (!Inquest.METHOD_BY_ID[targetId]) return { error: 'Неизвестный способ' };
      this.nightMethod = targetId;
      return { ok: true };
    }
    /* Экспертиза: город складывается и проверяет одну примету одного
       человека. Голос подаётся парой «кого» и «по какой примете». */
    if (type === 'expert') {
      if (this.mode !== 'inquest') return { error: 'Не в этом режиме' };
      if (this.phase !== 'day') return { error: 'Экспертизу заказывают днём' };
      if (this.expertDone[this.day]) return { error: 'Одна экспертиза в день — сегодняшняя уже сделана' };
      const parts = String(targetId || '').split(':');
      const who = this.p(parts[0]);
      const traitId = parts[1];
      if (!who || !who.alive) return { error: 'Неверная цель' };
      if (!Inquest.TRAIT_BY_ID[traitId]) return { error: 'Такой приметы нет' };
      if (!this.clues.some(c => c.traitId === traitId)) return { error: 'Эта примета не всплывала в уликах' };
      this.expertVotes[userId] = { targetId: who.id, traitId };
      this.resolveExpert();
      return { ok: true };
    }
    if (type === 'pass') {            // «я всё сказал» — передать слово по кругу
      if (this.phase === 'lastword') {
        if (this.lastWordId !== userId) return { error: 'Слово не у вас' };
        this.endLastWord();
        return { ok: true };
      }
      if (this.phase !== 'speech') return { error: 'Слово сейчас не по кругу' };
      if (this.speaker !== userId) return { error: 'Слово не у вас' };
      this.nextSpeaker();
      return { ok: true };
    }
    if (type === 'ready') {           // «я готов дальше» в дневной фазе
      /* В круге речей та же кнопка означает «передаю слово»: игроку не надо
         помнить, что она называется по-разному в двух фазах. */
      if (this.phase === 'speech') return this.action(userId, 'pass', null);
      if (this.phase !== 'day') return { error: 'Не сейчас' };
      this.ready = this.ready || {};
      this.ready[userId] = true;
      return { ok: true };
    }
    return { error: 'Неизвестное действие' };
  }

  /* ------------------------------ такт ------------------------------ */
  /** Вызывается сервером раз в секунду. Возвращает true, если состояние изменилось. */
  tick() {
    if (this.finished) return false;
    const expired = now() >= this.deadline;
    let changed = false;

    if (this.phase === 'prologue') {
      if (expired) { this.startNight(); changed = true; }
    } else if (this.phase === 'night') {
      if (expired || this.allNightActionsIn()) { this.resolveNight(); changed = true; }
    } else if (this.phase === 'morning') {
      if (expired) { this.afterMorning(); changed = true; }
    } else if (this.phase === 'lastword') {
      /* Последнее слово кончается по времени, по кнопке «я всё сказал» или
         сразу, если говорить некому: человек закрыл вкладку или встал из-за
         стола. Стол не должен смотреть в тишину полминуты. */
      const gone = this.offline.has(this.lastWordId) || this.left.has(this.lastWordId);
      if (expired || gone) { this.endLastWord(); changed = true; }
    } else if (this.phase === 'speech') {
      /* Слово кончилось само или говорящий выбыл из партии по ходу дела. */
      const sp = this.speaker ? this.p(this.speaker) : null;
      if (expired || !sp || !sp.alive || this.offline.has(this.speaker) || this.left.has(this.speaker)) {
        this.nextSpeaker();
        changed = true;
      }
    } else if (this.phase === 'day') {
      const waiting = this.waiting();
      const ready = this.ready || {};
      const allReady = waiting.length > 0 && waiting.every(p => ready[p.id]);
      if (expired || allReady) { this.startVote(); changed = true; }
    } else if (this.phase === 'vote' || this.phase === 'runoff' || this.phase === 'tievote') {
      const waiting = this.waiting();
      const allVoted = waiting.length > 0 && waiting.every(p => this.votes[p.id] !== undefined);
      if (expired || allVoted) { this.resolveVote(); changed = true; }
    }
    return changed;
  }

  /** Обновить список отключившихся. Возвращает true, если состав изменился. */
  setOffline(ids) {
    const next = new Set(ids || []);
    let changed = next.size !== this.offline.size;
    if (!changed) for (const id of next) if (!this.offline.has(id)) { changed = true; break; }
    if (!changed) return false;
    /* пишем в протокол только про живых: выбывшим связь уже не нужна */
    for (const id of next) {
      if (!this.offline.has(id)) {
        const p = this.p(id);
        if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' потерял связь — его хода ждать не будем.');
      }
    }
    for (const id of this.offline) {
      if (!next.has(id)) {
        const p = this.p(id);
        if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' снова на связи.');
      }
    }
    this.offline = next;
    return true;
  }

  /** Живые, от которых имеет смысл ждать хода. */
  waiting() { return this.alive().filter(p => !this.offline.has(p.id)); }

  /** Игрок встал из-за стола. Возвращает true, если состав ожидающих изменился. */
  markLeft(id) {
    const p = this.p(id);
    if (!p || this.left.has(id)) return false;
    this.left.add(id);
    if (p.alive && !this.finished) this.pushLog('sys', p.name + ' вышел из-за стола. Место остаётся за ним.');
    return true;
  }

  /** Игрок вернулся на своё место. */
  markBack(id) {
    if (!this.left.has(id)) return false;
    this.left.delete(id);
    const p = this.p(id);
    if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' вернулся за стол.');
    return true;
  }

  allNightActionsIn() {
    const on = p => !this.offline.has(p.id);
    const with_ = role => this.alive().filter(p => p.role === role && on(p));
    const mafiaAlive = this.aliveMafia().filter(on);
    const docs = with_(ROLE.DOCTOR);
    const shs = with_(ROLE.SHERIFF);
    const mans = with_(ROLE.MANIAC);
    const lovers = with_(ROLE.LOVER);
    const press = with_(ROLE.JOURNALIST);
    /* Адвокат ждётся не по цели, а по решению: «берегу право» — такой же ход,
       как и «прикрываю такого-то». Пока его здесь не было, ночь закрывалась,
       как только отходили все прочие, и на столе с ботами это происходило за
       десять секунд — адвокат не успевал нажать ни на что. */
    const laws = with_(ROLE.LAWYER).filter(p => !this.lawyerSpent[p.id]);
    const actors = mafiaAlive.length + docs.length + shs.length +
      mans.length + lovers.length + press.length + laws.length;
    /* Если у стола вообще никого нет на связи, ночь всё равно закроется
       по таймауту — здесь мы только не даём ей закрыться раньше времени. */
    if (!actors) return false;
    return mafiaAlive.every(p => this.nightActions.kill[p.id])
      && docs.every(p => this.nightActions.heal[p.id])
      && shs.every(p => this.nightActions.check[p.id])
      && mans.every(p => this.nightActions.slay[p.id])
      && lovers.every(p => this.nightActions.block[p.id])
      && press.every(p => this.nightActions.press[p.id])
      && laws.every(p => this.nightActions.shield[p.id] || this.shieldSkip[p.id]);
  }

  /* ------------------------------ фазы ------------------------------ */
  startNight() {
    this.day += 1;
    this.phase = 'night';
    this.nightActions = { kill: {}, heal: {}, check: {}, slay: {}, block: {}, shield: {}, press: {} };
    this.shieldSkip = {};
    this.blockedLast = [];
    this.mafiaBoard = {};
    this.ready = {};
    if (this.mode === 'inquest') { this.nightMethod = null; this.killerId = null; }
    this.deadline = now() + this.timing.night * 1000;
    this.pushLog('night', 'Ночь ' + this.day + '. ' + this.scenario.nightFlavor);
  }

  /* ------------------------------------------------------------------------
     РАЗБОР НОЧИ

     Порядок здесь и есть правила игры, поэтому он выписан явно, а не
     складывается из того, в каком месте кода что оказалось:

       0. Любовница. Блокировка решается ПЕРВОЙ, потому что она отменяет
          чужие ходы: если считать её после мафии, заблокированный уже
          успел ударить.
       1. Мафия. Голоса заблокированных не считаются вовсе; при ничьей
          решает дон, если он сам не заблокирован.
       2. Маньяк. Его нож ни с чьим не складывается: две жертвы за ночь —
          это две жертвы, а не спор о цели.
       3. Врач. Спасает от любого ночного ножа — и от мафии, и от маньяка:
          для врача это одинаковая рана.
       4. Шериф. Проверка отвечает на вопрос «состоит ли в мафии». Оборотень
          отвечает «да», хотя он мирный: в этом весь смысл его карты.
       5. Журналист. Сравнивает команды, а не роли.
       6. Адвокат. Прикрытие от дневного изгнания, а не от ножа: работает
          днём и записывается на день вперёд.
     ------------------------------------------------------------------------ */
  resolveNight() {
    // 0. любовница: чьи ночные дела этой ночью не состоятся
    const blocked = new Set();
    Object.entries(this.nightActions.block).forEach(([lid, tid]) => {
      const lover = this.p(lid);
      const target = this.p(tid);
      if (!lover || !lover.alive || !target || !target.alive) return;
      /* Заблокировать саму любовницу другой любовницей можно, и тогда её
         блокировка не действует. Считаем по исходному списку, а не по
         накопленному: иначе исход зависел бы от порядка перебора. */
      blocked.add(tid);
    });
    /* Если любовницу заблокировали, её собственная блокировка отменяется. */
    Object.entries(this.nightActions.block).forEach(([lid, tid]) => {
      if (blocked.has(lid)) blocked.delete(tid);
    });
    this.lastBlocked = Object.assign({}, this.nightActions.block);
    this.blockedLast = [...blocked];

    // 1. жертва мафии: большинство голосов, при ничье решает голос дона
    const tally = {};
    Object.entries(this.nightActions.kill).forEach(([mid, tid]) => {
      if (blocked.has(mid)) return;         // заблокированный не бьёт и не голосует
      if (this.p(tid) && this.p(tid).alive) tally[tid] = (tally[tid] || 0) + 1;
    });
    let victim = null;
    const entries = Object.entries(tally);
    if (entries.length) {
      const max = Math.max(...entries.map(e => e[1]));
      const top = entries.filter(e => e[1] === max).map(e => e[0]);
      if (top.length === 1) victim = top[0];
      else {
        const don = this.aliveMafia().find(p => p.role === ROLE.DON);
        const donPick = don ? this.nightActions.kill[don.id] : null;
        victim = (donPick && top.indexOf(donPick) >= 0) ? donPick : this.rng.pick(top);
      }
    } else if (this.aliveMafia().filter(p => !blocked.has(p.id)).length) {
      const targets = this.alive().filter(p => !this.isMafia(p.id));
      if (targets.length) victim = this.rng.pick(targets).id;   // мафия промолчала — удар вслепую
    }

    /* 2. маньяк. Отдельный нож, отдельная жертва. Промолчавший маньяк не
       бьёт вслепую — в отличие от мафии: у мафии молчание означает «мы не
       договорились», а у маньяка оно означает «он не пришёл». */
    let slain = null;
    Object.entries(this.nightActions.slay).forEach(([mid, tid]) => {
      const man = this.p(mid);
      if (!man || !man.alive || blocked.has(mid)) return;
      const t2 = this.p(tid);
      if (t2 && t2.alive) slain = tid;
    });

    /* Кто держал нож. В «Следствии» это важно: улики говорят о его
       приметах. Убийцей считаем того из мафии, чей голос совпал с итогом, —
       иначе дона, иначе любого живого мафиози. */
    if (this.mode === 'inquest' && victim) {
      const voted = Object.entries(this.nightActions.kill)
        .find(([mid, tid]) => tid === victim && !blocked.has(mid));
      const don = this.aliveMafia().find(p => p.role === ROLE.DON);
      this.killerId = (voted && voted[0]) || (don && don.id) ||
        (this.aliveMafia()[0] && this.aliveMafia()[0].id) || null;
    }

    // 3. лечение
    const method = this.mode === 'inquest'
      ? (Inquest.METHOD_BY_ID[this.nightMethod] || Inquest.METHOD_BY_ID[Inquest.DEFAULT_METHOD])
      : null;
    /* «Грубо и быстро»: врач не успевает. Это и есть плата за две улики. */
    const healed = (method && method.noHeal) ? new Set()
      : new Set(Object.entries(this.nightActions.heal)
        .filter(([did]) => !blocked.has(did))       // заблокированный врач не лечит
        .map(([, tid]) => tid));
    this.lastHealed = Object.assign({}, this.nightActions.heal);

    // 4. проверки шерифа
    Object.entries(this.nightActions.check).forEach(([sid, tid]) => {
      if (blocked.has(sid)) return;                 // заблокированный шериф не узнаёт ничего
      const t = this.p(tid);
      if (!t) return;
      (this.checkResults[sid] = this.checkResults[sid] || []).push({
        /* Ответ на вопрос «состоит ли в мафии», а не «какая у него карта».
           Оборотень отвечает «да»: он мирный, но проверка на нём ошибается —
           в этом вся его роль и весь риск города, слепо верящего шерифу. */
        targetId: tid, name: t.name, seat: t.seat, day: this.day,
        isMafia: this.isMafia(tid) || t.role === ROLE.WEREWOLF
      });
    });

    // 5. журналист: в одной команде или в разных
    Object.entries(this.nightActions.press).forEach(([jid, pairStr]) => {
      if (blocked.has(jid)) return;
      const [aId, bId] = String(pairStr).split(',');
      const a = this.p(aId), b = this.p(bId);
      if (!a || !b) return;
      (this.pressResults[jid] = this.pressResults[jid] || []).push({
        aId, bId, aName: a.name, bName: b.name, aSeat: a.seat, bSeat: b.seat,
        /* Сравниваем команды, а не роли: «вместе» про дона и мафию — правда,
           про доктора и мирного — тоже правда. Маньяк не вместе ни с кем. */
        sameTeam: this.teamOf(aId) === this.teamOf(bId) && this.teamOf(aId) !== 'maniac',
        day: this.day
      });
    });

    // 6. адвокат: кого он прикрывает от сегодняшнего изгнания
    this.shieldToday = {};
    Object.entries(this.nightActions.shield).forEach(([lid, tid]) => {
      const lw = this.p(lid);
      if (!lw || !lw.alive || blocked.has(lid) || this.lawyerSpent[lid]) return;
      if (this.p(tid)) this.shieldToday[tid] = lid;
    });

    // 7. итог
    this.phase = 'morning';
    this.deadline = now() + this.timing.reveal * 1000;
    this.votes = {};
    this.runoffOf = null;
    this.tieOf = null;

    /* Двое ножей — до двух погибших, и врач спасает от любого из них.
       Если мафия и маньяк выбрали одного, ночь всё равно уносит одного:
       умереть дважды нельзя. */
    const fallen = [];
    [victim, slain].forEach(id => {
      if (!id || healed.has(id)) return;
      if (fallen.indexOf(id) < 0) fallen.push(id);
    });
    const saved = [victim, slain].filter(id => id && healed.has(id));

    if (!victim && !slain) {
      this.pushLog('morning', 'Утро ' + this.day + '. Ночь прошла тихо.');
    } else if (!fallen.length) {
      this.pushLog('morning', 'Утро ' + this.day + '. Этой ночью все выжили — врач успел вовремя.');
    } else {
      fallen.forEach(id => this.kill(id, 'night'));
      /* Последнее слово получают оба, по очереди. Очередь важнее, чем
         кажется: одновременно говорящих выбывших стол не слышит вовсе. */
      this.lastWordQueue = this.lastWordQueue.concat(fallen);
      const who = fallen.map(id => this.nameOf(id) + ' (' + C.ROLE_INFO[this.p(id).role].ru + ')').join(' и ');
      this.pushLog('morning', 'Утро ' + this.day + '. ' +
        (fallen.length > 1 ? 'До рассвета не дожили двое: ' : 'Не дожил(а) до рассвета: ') + who + '. ' +
        this.scenario.deathFlavor);
      if (fallen.length > 1) {
        this.pushLog('sys', 'Две смерти за одну ночь — значит, за столом не одна сила, а две.');
      }
      if (saved.length) this.pushLog('sys', 'Ещё одного этой ночью успел вытащить врач.');
    }
    /* Про сработавшую блокировку стол знает только то, что она была: имени
       любовницы не видно, иначе роль сгорала бы в первое же утро. */
    if (this.blockedLast.length) {
      const stopped = this.blockedLast.filter(id =>
        this.nightActions.kill[id] || this.nightActions.heal[id] ||
        this.nightActions.check[id] || this.nightActions.slay[id] ||
        this.nightActions.press[id] || this.nightActions.shield[id]);
      if (stopped.length) this.pushLog('sys', 'Кому-то этой ночью было не до дела: ход не состоялся.');
    }

    /* Улики оставляет само покушение, а не его исход: если врач успел, следы
       у двери всё равно остались, и город получает их. Иначе спасённая ночь
       была бы для следствия пустой — а это самая интересная ночь. */
    if (this.mode === 'inquest' && victim && this.killerId) {
      const fresh = Inquest.cluesFor(this.rng, this.killerId, this.traits,
        method.id, this.alive(), this.usedClueTraits);
      fresh.forEach(c => {
        this.clues.push({ day: this.day, traitId: c.traitId, text: c.text, shared: c.shared });
        this.usedClueTraits.push(c.traitId);
        this.pushLog('clue', 'Улика: тот, кто это сделал, ' + c.text + '.');
      });
      if (!fresh.length) this.pushLog('clue', 'Следов не осталось: этой ночью работали чисто.');
    }

    if (!this.checkWin()) {
      this.omenStep++;
      if (this.scenario.dayFlavor && this.omenStep % 2 === 0) this.pushLog('story', this.scenario.dayFlavor);
    }
  }

  /* ------------------------------ следствие ------------------------------ */
  /** Заказана ли экспертиза большинством живых. Считаем по паре «кого и что». */
  resolveExpert() {
    if (this.mode !== 'inquest' || this.expertDone[this.day]) return false;
    const aliveN = this.alive().length;
    const need = Math.floor(aliveN / 2) + 1;
    const tally = {};
    Object.entries(this.expertVotes).forEach(([voter, v]) => {
      const p = this.p(voter);
      if (!p || !p.alive) return;
      const key = v.targetId + ':' + v.traitId;
      tally[key] = (tally[key] || 0) + 1;
    });
    const win = Object.entries(tally).find(([, n]) => n >= need);
    if (!win) return false;

    const [targetId, traitId] = win[0].split(':');
    const has = (this.traits[targetId] || []).indexOf(traitId) >= 0;
    this.expertDone[this.day] = true;
    this.expertVotes = {};
    this.expertLog.push({ day: this.day, targetId, traitId, has });
    this.pushLog('expert', 'Экспертиза: у ' + this.nameOf(targetId) + ' приметы «' +
      Inquest.traitShort(traitId) + '» ' + (has ? 'есть' : 'нет') + '.');
    return true;
  }

  /* --------------------------- последнее слово --------------------------- */

  /**
   * Дать последнее слово выбывшему.
   * @param {string} id кто говорит
   * @param {'speech'|'night'} next куда идти после
   * @returns {boolean} началось ли слово (иначе идём дальше сразу)
   */
  startLastWord(id, next) {
    if (this.finished || !this.lastWordOn) return false;
    const p = this.p(id);
    /* Ушедшему и потерявшему связь слова не даём: ждать нечего. */
    if (!p || this.offline.has(id) || this.left.has(id)) return false;

    this.lastWordId = id;
    this.lastWordNext = next;
    this.phase = 'lastword';
    this.speaker = id;
    this.deadline = now() + this.timing.lastWord * 1000;

    /* Лучший ход достаётся только убитому первой ночью — и только если он
       вообще был: если первую ночь никто не потерял, права на три имени ни
       у кого нет. Днём казнённый лучшего хода не получает: он говорил весь
       день, город его уже слышал. */
    this.bestMoveOpen = this.bestMoveOn && !this.bestMove &&
      this.day === 1 && p.deathCause === 'night';

    this.pushLog('lastword', 'Последнее слово: ' + p.name + ' (место ' + p.seat + ').' +
      (this.bestMoveOpen ? ' Он же называет трёх подозреваемых — лучший ход.' : ''));
    return true;
  }

  /** Слово кончилось. Идём туда, откуда пришли. */
  endLastWord() {
    const next = this.lastWordNext;
    if (this.bestMoveOpen) {
      this.pushLog('sys', 'Лучший ход не назван: ' + this.nameOf(this.lastWordId) + ' промолчал.');
    }
    this.lastWordId = null;
    this.lastWordNext = null;
    this.bestMoveOpen = false;
    this.speaker = null;
    if (this.checkWin()) return;
    /* В очереди может стоять второй выбывший: за ночь с маньяком погибают
       двое, а стол решением «поднять всех» выводит и трёх. Слово переходит
       к следующему, и только когда очередь пуста — идём дальше по фазам. */
    while (this.lastWordQueue.length) {
      const id = this.lastWordQueue.shift();
      if (this.startLastWord(id, next)) return;
    }
    if (next === 'night') return this.startNight();
    return this.startSpeech();
  }

  /** После утра: либо последнее слово убитого, либо сразу круг речей. */
  afterMorning() {
    while (this.lastWordQueue.length) {
      const id = this.lastWordQueue.shift();
      if (this.startLastWord(id, 'speech')) return true;
    }
    return this.startSpeech();
  }

  /* ------------------------------ круг речей ------------------------------ */
  /* Порядок мест, начиная с того, чьё слово первое сегодня. Первое слово
     каждый день переходит к следующему месту: иначе один и тот же человек
     всегда говорит в пустоту, а последний всегда решает исход дня. */
  startSpeech() {
    if (this.finished) return;
    if (!this.speeches || this.alive().length < 3) return this.startDay();

    const order = this.alive().slice().sort((a, b) => a.seat - b.seat);
    const from = order.findIndex(p => p.seat >= this.firstSpeakerSeat);
    const start = from < 0 ? 0 : from;
    this.speechQueue = order.slice(start).concat(order.slice(0, start)).map(p => p.id);
    this.spoke = {};
    this.speaker = null;
    /* С какого места круг начался на самом деле. Считать «следующее место»
       от намеченного нельзя: намеченный мог не дожить до утра, и тогда два дня
       подряд первым говорил один и тот же человек. */
    this.circleFirstSeat = null;
    this.phase = 'speech';
    this.pushLog('sys', 'День ' + this.day + '. Слово по кругу.');
    this.nextSpeaker();
  }

  /** Передать слово следующему. Пустая очередь — переходим к общему обсуждению. */
  nextSpeaker() {
    if (this.speaker) this.spoke[this.speaker] = true;
    /* Мёртвых, ушедших и потерявших связь пропускаем: ждать их слова нечего,
       а стол не должен сидеть в тишине по сорок пять секунд за каждого. */
    let next = null;
    while (this.speechQueue.length) {
      const id = this.speechQueue.shift();
      const p = this.p(id);
      if (!p) continue;
      /* Пропуск за фолы. Наказание срабатывает один раз: пропустив речь,
         игрок возвращается в круг с чистого листа — иначе один вспыльчивый
         вечер вычёркивал бы человека из партии до занавеса. */
      if (this.foulSkip[id]) {
        delete this.foulSkip[id];
        this.spoke[id] = true;
        this.pushLog('foul', p.name + ' пропускает речь за фолы.');
        continue;
      }
      if (p.alive && !this.offline.has(id) && !this.left.has(id)) { next = id; break; }
      this.spoke[id] = true;
    }
    if (!next) {
      this.speaker = null;
      /* Следующий день начинает место за тем, кто говорил первым сегодня. */
      const order = this.players.slice().sort((a, b) => a.seat - b.seat);
      const base = this.circleFirstSeat || this.firstSpeakerSeat;
      const cur = order.findIndex(p => p.seat === base);
      const nextFirst = order[((cur < 0 ? 0 : cur) + 1) % order.length];
      this.firstSpeakerSeat = nextFirst ? nextFirst.seat : 1;
      return this.startDay();
    }
    this.speaker = next;
    if (this.circleFirstSeat === null) this.circleFirstSeat = this.p(next).seat;
    this.deadline = now() + this.timing.speech * 1000;
    this.pushLog('talk', 'Слово: ' + this.nameOf(next) + ' (место ' + this.p(next).seat + ').');
    return true;
  }

  startDay() {
    if (this.finished) return;
    this.speaker = null;
    this.phase = 'day';
    this.ready = {};
    if (this.mode === 'inquest') this.expertVotes = {};
    this.deadline = now() + this.timing.day * 1000;
    this.pushLog('sys', 'День ' + this.day + '. Обсуждение: ' + Math.round(this.timing.day / 60 * 10) / 10 + ' мин.');
  }

  startVote(candidates) {
    if (this.finished) return;
    this.votes = {};
    if (candidates && candidates.length) {
      this.phase = 'runoff';
      this.runoffOf = candidates;
      this.pushLog('vote', 'Переголосовка между: ' + candidates.map(id => this.nameOf(id)).join(', ') + '.');
    } else {
      this.phase = 'vote';
      this.runoffOf = null;
      this.pushLog('vote', 'Город голосует.');
    }
    this.deadline = now() + this.timing.vote * 1000;
  }

  resolveVote() {
    /* Голосование стола при ничьей — отдельный разбор: там голоса «да» и
       «нет», а не имена. */
    if (this.phase === 'tievote') return this.resolveTieVote();

    const tally = {};
    Object.entries(this.votes).forEach(([voter, target]) => {
      const v = this.p(voter);
      if (!v || !v.alive || target === 'skip') return;
      tally[target] = (tally[target] || 0) + 1;
    });
    const entries = Object.entries(tally);
    const wasRunoff = this.phase === 'runoff';

    if (!entries.length) {
      this.pushLog('vote', 'Город никого не выбрал. Казни не будет.');
      return this.afterVote();
    }
    const max = Math.max(...entries.map(e => e[1]));
    const top = entries.filter(e => e[1] === max).map(e => e[0]);

    this.pushLog('vote', 'Итог голосования: ' +
      entries.sort((a, b) => b[1] - a[1]).map(e => this.nameOf(e[0]) + ' — ' + e[1]).join(', ') + '.');
    /* Кто за кого — только на открытом голосовании. При закрытом расклад
       остаётся тайной навсегда: иначе «закрытое» означало бы всего лишь
       «объявим на минуту позже», и второй игры из настройки не получилось бы. */
    if (this.voteOpen) {
      const byTarget = {};
      Object.entries(this.votes).forEach(([voter, target]) => {
        const v = this.p(voter);
        if (!v || !v.alive || target === 'skip') return;
        (byTarget[target] = byTarget[target] || []).push(v.name);
      });
      Object.keys(byTarget).forEach(tid => {
        this.pushLog('vote', 'За ' + this.nameOf(tid) + ': ' + byTarget[tid].join(', ') + '.');
      });
    }

    if (top.length > 1) {
      if (wasRunoff) {
        /* Ничья второй раз. Прежде здесь партия просто теряла день, и это
           самая частая причина фразы «да ну, ерунда какая-то»: стол дважды
           договорился до одного и того же и остался ни с чем. Теперь стол
           может решить сам — но только если хозяин включил это правило. */
        if (this.onTie === 'table' && this.alive().length > top.length + 1) {
          return this.startTieVote(top);
        }
        this.pushLog('vote', 'Снова ничья. Сегодня никого не казнят.');
        return this.afterVote();
      }
      return this.startVote(top);
    }

    return this.execute([top[0]]);
  }

  /* --------------------------- «поднять всех» ---------------------------
     Второй тур кончился ничьей. Стол голосует не за человека, а за правило:
     вывести всех, кто набрал равное число голосов, или не выводить никого.
     Тай-брейк броском монеты убирается ровно этим — решение остаётся за
     столом, и проигравшая сторона знает, кто его принял. */
  startTieVote(candidates) {
    this.phase = 'tievote';
    this.tieOf = candidates;
    this.votes = {};
    /* Вдвое короче обычного голосования: вопрос здесь один и он закрытый. */
    this.deadline = now() + Math.max(12, Math.round(this.timing.vote / 2)) * 1000;
    this.pushLog('vote', 'Снова ничья: ' + candidates.map(id => this.nameOf(id)).join(', ') +
      '. Стол решает: поднять всех или оставить всех.');
  }

  resolveTieVote() {
    const cands = this.tieOf || [];
    let yes = 0, no = 0;
    Object.entries(this.votes).forEach(([voter, v]) => {
      const p = this.p(voter);
      if (!p || !p.alive) return;
      /* Свой голос кандидаты подают наравне со всеми: они ещё за столом. */
      if (v === 'yes') yes++; else if (v === 'no') no++;
    });
    this.tieOf = null;
    /* Равенство здесь трактуется в пользу жизни: чтобы вывести трёх сразу,
       нужно большинство, а не отсутствие возражений. */
    if (yes > no) {
      this.pushLog('vote', 'Стол решил поднять всех: ' + yes + ' за, ' + no + ' против.');
      return this.execute(cands);
    }
    this.pushLog('vote', 'Стол решил оставить всех: ' + yes + ' за, ' + no + ' против. ' +
      'Сегодня город никого не выводит.');
    return this.afterVote();
  }

  /* ------------------------------ изгнание ------------------------------
     Одно место, через которое проходят все дневные казни — и одиночная, и
     «поднять всех». Здесь же живёт адвокат: его право отменяет изгнание, но
     не отменяет самого голосования, и стол видит результат, не видя автора. */
  execute(ids) {
    const shield = this.shieldToday || {};
    const kept = [];
    const gone = [];
    ids.forEach(id => {
      const lid = shield[id];
      if (lid && !this.lawyerSpent[lid]) {
        this.lawyerSpent[lid] = true;
        this.lawyerSaved.push({ day: this.day, id, name: this.nameOf(id) });
        kept.push(id);
        return;
      }
      gone.push(id);
    });

    kept.forEach(id => {
      this.pushLog('execution', 'Изгнание отменено: за ' + this.nameOf(id) +
        ' вступился адвокат. Кто именно — стол не узнает.');
    });
    gone.forEach(id => {
      this.kill(id, 'vote');
      this.pushLog('execution', 'Город казнил ' + this.nameOf(id) +
        '. Роль: ' + C.ROLE_INFO[this.p(id).role].ru + '.');
    });
    this.lastWordQueue = this.lastWordQueue.concat(gone);
    this.afterVote();
  }

  afterVote() {
    if (this.checkWin()) return;
    while (this.lastWordQueue.length) {
      const id = this.lastWordQueue.shift();
      if (this.startLastWord(id, 'night')) return;
    }
    this.startNight();
  }

  kill(id, cause) {
    const p = this.p(id);
    if (!p || !p.alive) return;
    p.alive = false;
    p.deathDay = this.day;
    p.deathCause = cause;
    /* В «Следствии» приметы выбывшего становятся общим достоянием: именно
       так у стола к третьему дню собирается доска проверяемых фактов. */
    if (this.mode === 'inquest') {
      this.publicTraits[id] = (this.traits[id] || []).slice();
      const list = this.publicTraits[id].map(t => Inquest.traitShort(t)).join(', ');
      if (list) this.pushLog('clue', 'Приметы ' + p.name + ': ' + list + '.');
    }
  }

  /* ------------------------------ конец партии ------------------------------
     С появлением маньяка условие победы перестаёт быть арифметикой из двух
     чисел. Раньше было так: мафии ноль — победил город; мафии столько же,
     сколько мирных, — победила мафия. Теперь сил три, и правила читаются
     в таком порядке:

       1. Мафии нет и маньяка нет — победил город. Это единственный случай,
          когда город побеждает: пока за столом ходит кто-то с ножом, партия
          не кончена, даже если чёрных больше не осталось.
       2. Мафии столько же, сколько всех остальных вместе, — победила мафия.
          «Все остальные» здесь включает маньяка: он мафии не союзник, но и
          переголосовать её в одиночку не может.
       3. Мафии нет, а из мирных остался один — победил маньяк. Добивать его
          ночью не нужно: исход уже определён, и растягивать партию на
          формальную ночь незачем.

     Порядок важен. При «мафия 1, маньяк 1, мирных 0» срабатывает второе
     правило: двое с ножами друг против друга — это тот же случай, что и
     «мафия против последнего мирного», и решается он так же.
     ------------------------------------------------------------------------ */
  checkWin() {
    const h = this.headcount();
    if (h.mafia === 0 && h.maniac === 0) return this.finish('town');
    if (h.mafia > 0 && h.mafia >= h.town + h.maniac) return this.finish('mafia');
    if (h.maniac > 0 && h.mafia === 0 && h.town <= 1) return this.finish('maniac');
    return false;
  }

  finish(winner) {
    this.finished = true;
    this.winner = winner;
    this.phase = 'over';
    this.deadline = now();
    /* В протокол пишем причину числами: игрок должен понять, почему
       партия закончилась именно сейчас, а не разгадывать метафору. */
    const h = this.headcount();
    const mafiaTotal = this.players.filter(p => this.isMafia(p.id)).length;
    const maniac = this.players.find(p => p.role === ROLE.MANIAC);
    if (winner === 'town') {
      this.pushLog('end', 'Город победил: вся мафия (' + mafiaTotal + ') выбыла из игры' +
        (maniac ? ', и маньяк вместе с ней' : '') + '.');
    } else if (winner === 'maniac') {
      this.pushLog('end', 'Маньяк победил: мафии больше нет, а из мирных остался один — ' +
        'до утра он не дожил бы всё равно. Это был ' + maniac.name + ' (место ' + maniac.seat + ').');
    } else {
      this.pushLog('end', 'Мафия победила: её осталось ' + h.mafia + ', остальных — ' +
        (h.town + h.maniac) + '. Город больше не может её переголосовать.');
    }
    if (this.bestMove) {
      this.pushLog('bestmove', 'Лучший ход ' + this.bestMove.byName + ': угадано ' +
        this.bestMove.hits + ' из 3.');
    }
    this.pushLog('story', winner === 'town' ? this.scenario.finaleTown : this.scenario.finaleMafia);
    return true;
  }

  /* ------------------------------ голос ------------------------------ */
  /* С кем игрок может говорить голосом прямо сейчас.

     Голосовой чат до этого ничего не знал ни о фазах, ни о смерти: стол
     соединялся «каждый с каждым» один раз и так и оставался. Ночью это
     значило, что мафия договаривается вслух при всём городе, а выбывший
     продолжает подсказывать живым.

     Правила те же, что у текстовых каналов:
       ночь    — только мафия между собой, остальные молчат: город спит;
       выбывшие — между собой;
       день и конец партии — весь живой стол.

     Список собеседников отдавать безопасно: в нём нет ничего, чего игрок и
     так не знает. Мафия знает своих, выбывший знает выбывших, город знает
     живых. Чужие каналы игроку не видны вовсе. */
  voiceFor(userId) {
    const me = this.p(userId);
    const none = { channel: null, peers: [], why: 'Вы не за столом' };
    if (!me) return none;

    const ids = list => list.filter(p => p.id !== userId).map(p => p.id);

    if (this.finished) {
      return { channel: 'town', peers: ids(this.players), why: '' };
    }
    /* Последнее слово слышит весь стол. Это единственная минута партии,
       когда выбывший говорит с живыми — и она же самая важная для разбора:
       без неё половина драмы живого стола пропадает. */
    if (this.phase === 'lastword') {
      const mine = this.lastWordId === userId;
      const peers = ids(this.alive().concat(
        this.lastWordId && this.p(this.lastWordId) ? [this.p(this.lastWordId)] : []));
      return {
        channel: 'town', peers, mute: !mine,
        why: mine ? 'Последнее слово у вас' : 'Последнее слово у ' + this.nameOf(this.lastWordId)
      };
    }
    if (!me.alive) {
      return {
        channel: 'ghost',
        peers: ids(this.players.filter(p => !p.alive)),
        why: 'Вас слышат только выбывшие'
      };
    }
    if (this.phase === 'night') {
      if (!this.isMafia(userId)) {
        return { channel: null, peers: [], why: 'Город спит — микрофон выключен' };
      }
      return {
        channel: 'mafia',
        peers: ids(this.aliveMafia()),
        why: 'Вас слышат только свои'
      };
    }
    if (this.phase === 'speech') {
      /* Слушают все живые — линии не рвём, иначе стол терял бы связь на каждой
         передаче слова. Закрыт только микрофон: говорит тот, чья очередь. */
      const mine = this.speaker === userId;
      return {
        channel: 'town',
        peers: ids(this.alive()),
        mute: !mine,
        why: mine ? 'Слово у вас' : 'Слово у ' + this.nameOf(this.speaker)
      };
    }
    return { channel: 'town', peers: ids(this.alive()), why: '' };
  }

  /** Можно ли этим двоим связаться голосом. Решает сервер, не клиент. */
  voiceAllowed(fromId, toId) {
    const v = this.voiceFor(fromId);
    return !!v.channel && v.peers.indexOf(toId) >= 0;
  }

  /* ------------------------------ вид для игрока ------------------------------ */
  viewFor(userId) {
    const me = this.p(userId);
    const isSpectator = !me;
    const revealAll = this.finished;
    const iAmMafia = me ? this.isMafia(userId) : false;

    const voting = this.phase === 'vote' || this.phase === 'runoff' || this.phase === 'tievote';
    const players = this.players.map(p => {
      const showRole = revealAll || !p.alive || (iAmMafia && this.isMafia(p.id)) || (me && p.id === me.id);
      return {
        id: p.id, name: p.name, seat: p.seat, alive: p.alive,
        deathDay: p.deathDay, deathCause: p.deathCause,
        role: showRole ? p.role : null,
        roleRu: showRole ? C.ROLE_INFO[p.role].ru : null,
        roleGlyph: showRole ? C.ROLE_INFO[p.role].glyph : null,
        /* Команда приезжает вместе с картой, а не считается на клиенте:
           с третьей силой «мафия или город» больше не выводится из имени
           роли, и два места, где это считалось бы, разошлись бы в первый же
           вечер. */
        team: showRole ? C.teamOf(p.role) : null,
        voted: voting && this.votes[p.id] !== undefined,
        /* За кого поднял руку — только на открытом голосовании и только пока
           оно идёт: в этом и вся разница между двумя правилами. */
        voteFor: (this.voteOpen && this.phase !== 'tievote' && voting) ? (this.votes[p.id] || null) : null,
        ready: this.phase === 'day' && !!(this.ready && this.ready[p.id]),
        spoke: this.phase === 'speech' && !!this.spoke[p.id],
        /* Фолы публичны: наказание, о котором знает только наказанный, не
           работает как дисциплина. */
        fouls: this.foulsOn ? (this.fouls[p.id] || 0) : 0,
        foulSkip: !!this.foulSkip[p.id],
        offline: this.offline.has(p.id),
        left: this.left.has(p.id)
      };
    });

    const channels = ['town'];
    if (me && !me.alive) channels.push('ghost');
    if (me && me.alive && iAmMafia) channels.push('mafia');
    if (me && !me.alive && this.deadSeeAll) channels.push('mafia');

    /* Кто что читает. Три правила, и каждое из них — про то, чтобы знание не
       утекало из партии:
         общий чат  — всем, включая наблюдателя;
         шёпот мафии — живой мафии, а выбывшим только если хозяин разрешил;
         чат выбывших — самим выбывшим. Наблюдателю он не положен: там роли
           уже раскрыты, и один зритель за спиной ломает партию целиком. */
    const chat = this.chat.filter(m => {
      if (m.channel === 'town') return true;
      if (m.channel === 'mafia') {
        return revealAll || (me && iAmMafia && me.alive) || (me && !me.alive && this.deadSeeAll);
      }
      if (m.channel === 'ghost') return revealAll || (me && !me.alive);
      return false;
    });

    const view = {
      phase: this.phase,
      day: this.day,
      secondsLeft: this.secondsLeft(),
      phaseSeconds: this.phaseSeconds(),
      finished: this.finished,
      winner: this.winner,
      scenario: {
        id: this.scenario.id, title: this.scenario.title, place: this.scenario.place,
        rule: this.scenario.rule, prologue: this.scenario.prologue,
        /* Чем закончилась история. Отдаём только после конца партии:
           до этого оба текста — спойлер. */
        finaleTown: revealAll ? this.scenario.finaleTown : null,
        finaleMafia: revealAll ? this.scenario.finaleMafia : null
      },
      composition: this.composition,
      compositionLabel: C.compositionLabel(this.players.length, this.preset),
      /* Правила стола едут к клиенту целиком: игрок должен видеть, во что
         он играет, не спрашивая хозяина комнаты. */
      preset: this.preset,
      presetRu: C.presetById(this.preset).ru,
      sides: this.composition.sides,
      voteOpen: this.voteOpen,
      onTie: this.onTie,
      foulsOn: this.foulsOn,
      /* Семя отдаём только после занавеса: до него по нему можно было бы
         пересчитать раздачу и узнать все роли. */
      seed: revealAll ? this.seed : null,
      players,
      log: this.log.slice(-120),
      chat: chat.slice(-120),
      channels,
      aliveCount: this.alive().length,
      you: null
    };

    if (me) {
      const info = C.ROLE_INFO[me.role];
      view.you = {
        id: me.id, name: me.name, seat: me.seat, alive: me.alive,
        role: me.role, roleRu: info.ru, roleGlyph: info.glyph, roleDesc: info.desc,
        team: info.team,
        partners: iAmMafia ? this.players.filter(p => this.isMafia(p.id) && p.id !== me.id)
          .map(p => ({ id: p.id, name: p.name, seat: p.seat, role: p.role, alive: p.alive })) : [],
        checks: me.role === ROLE.SHERIFF ? (this.checkResults[me.id] || []) : [],
        myKill: this.nightActions.kill[me.id] || null,
        myHeal: this.nightActions.heal[me.id] || null,
        myCheck: this.nightActions.check[me.id] || null,
        healBlocked: this.lastHealed[me.id] || null,
        myVote: this.votes[me.id] !== undefined ? this.votes[me.id] : null,
        ready: !!(this.ready && this.ready[me.id]),
        canAct: this.canAct(me),
        voice: this.voiceFor(userId),
        /* ---- расширенный набор: своё и только своё ---- */
        mySlay: this.nightActions.slay[me.id] || null,
        myBlock: this.nightActions.block[me.id] || null,
        myShield: this.nightActions.shield[me.id] || null,
        myPress: this.nightActions.press[me.id] || null,
        blockBlocked: this.lastBlocked[me.id] || null,
        press: me.role === ROLE.JOURNALIST ? (this.pressResults[me.id] || []) : [],
        shieldSpent: me.role === ROLE.LAWYER ? !!this.lawyerSpent[me.id] : false,
        shieldKept: me.role === ROLE.LAWYER ? !!this.shieldSkip[me.id] : false,
        fouls: this.foulsOn ? (this.fouls[me.id] || 0) : 0,
        foulSkip: !!this.foulSkip[me.id]
      };
      if (this.phase === 'night' && iAmMafia) {
        view.mafiaVotes = Object.entries(this.nightActions.kill)
          .map(([mid, tid]) => ({ from: this.nameOf(mid), to: this.nameOf(tid) }));
        /* Ночная доска. Уезжает только своим и только ночью — это и есть
           весь её смысл: договориться, не выходя в общий чат. */
        view.mafiaBoard = Object.entries(this.mafiaBoard).map(([id, m]) => ({
          id, tag: m.tag, tagRu: MAFIA_TAG_RU[m.tag], byName: m.byName
        }));
        view.mafiaTags = MAFIA_TAGS.map(t => ({ id: t, ru: MAFIA_TAG_RU[t] }));
      }
    }
    /* Отменённые изгнания публичны, автор — нет. Стол должен понимать, почему
       казнь не состоялась, но не должен знать, кого за это благодарить. */
    if (this.lawyerSaved.length) view.lawyerSaved = this.lawyerSaved.slice();
    if (this.phase === 'tievote') {
      view.tieOf = this.tieOf || [];
      view.tieNames = (this.tieOf || []).map(id => this.nameOf(id));
    }
    /* Доска следствия. Публичного здесь только то, что публично: улики,
       результаты экспертиз и приметы выбывших. Свои приметы человек видит
       свои, чужие живые — никогда. */
    if (this.mode === 'inquest') {
      view.mode = 'inquest';
      view.inquest = {
        clues: this.clues.map(c => ({ day: c.day, traitId: c.traitId, text: c.text, shared: c.shared })),
        expert: this.expertLog.slice(),
        expertDone: !!this.expertDone[this.day],
        expertNeed: Math.floor(this.alive().length / 2) + 1,
        expertVotes: Object.keys(this.expertVotes).length,
        publicTraits: this.publicTraits,
        methods: Inquest.METHODS
      };
      if (me) {
        view.inquest.myTraits = (revealAll || true) ? (this.traits[me.id] || []).slice() : [];
        view.inquest.myTraitsRu = view.inquest.myTraits.map(t => Inquest.traitRu(t));
        view.inquest.myExpert = this.expertVotes[me.id] || null;
        if (iAmMafia && this.phase === 'night') view.inquest.method = this.nightMethod;
      }
      if (revealAll) {
        view.inquest.allTraits = this.traits;
        view.inquest.killerId = this.killerId;
      }
    } else {
      view.mode = 'classic';
    }

    view.speed = this.speed;
    view.timing = {
      night: this.timing.night, day: this.timing.day, speech: this.timing.speech,
      vote: this.timing.vote, lastWord: this.timing.lastWord
    };
    if (this.phase === 'lastword') {
      view.lastWordId = this.lastWordId;
      view.lastWordName = this.nameOf(this.lastWordId);
      /* Право на три имени видно только тому, у кого оно есть: остальным
         это подсказка, кого сейчас будут называть. */
      if (me && me.id === this.lastWordId) view.bestMoveOpen = this.bestMoveOpen;
    }
    /* Лучший ход публичен с момента, как он назван: в этом и весь смысл —
       город получает три имени от того, кто уже не играет. Сколько из них
       чёрные, показываем только после занавеса. */
    if (this.bestMove) {
      view.bestMove = {
        by: this.bestMove.by, byName: this.bestMove.byName, bySeat: this.bestMove.bySeat,
        picks: this.bestMove.picks,
        hits: revealAll ? this.bestMove.hits : null
      };
    }
    if (this.runoffOf) view.runoffOf = this.runoffOf;
    if (this.phase === 'speech') {
      view.speakerId = this.speaker;
      view.speakerName = this.nameOf(this.speaker);
      view.speechLeft = this.speechQueue.length;
    }
    return view;
  }

  phaseSeconds() {
    if (this.phase === 'lastword') return this.timing.lastWord;
    if (this.phase === 'speech') return this.timing.speech;
    if (this.phase === 'night') return this.timing.night;
    if (this.phase === 'day') return this.timing.day;
    if (this.phase === 'vote' || this.phase === 'runoff') return this.timing.vote;
    if (this.phase === 'tievote') return Math.max(12, Math.round(this.timing.vote / 2));
    if (this.phase === 'morning') return this.timing.reveal;
    return 12;
  }

  canAct(me) {
    if (this.finished) return null;
    if (this.phase === 'lastword') {
      if (this.lastWordId !== me.id) return 'listen';
      return this.bestMoveOpen ? 'bestmove' : 'lastword';
    }
    if (!me.alive) return null;
    if (this.phase === 'night') {
      if (this.isMafia(me.id)) return 'kill';
      if (me.role === ROLE.DOCTOR) return 'heal';
      if (me.role === ROLE.SHERIFF) return 'check';
      if (me.role === ROLE.MANIAC) return 'slay';
      if (me.role === ROLE.LOVER) return 'block';
      if (me.role === ROLE.JOURNALIST) return 'press';
      /* Адвокат с потраченным правом ночью ничего не делает: показывать ему
         живую кнопку, которая ничего не даст, — хуже, чем не показывать. */
      if (me.role === ROLE.LAWYER) return this.lawyerSpent[me.id] ? null : 'shield';
      return null;
    }
    if (this.phase === 'tievote') return 'tievote';
    if (this.phase === 'vote' || this.phase === 'runoff') return 'vote';
    if (this.phase === 'speech') return this.speaker === me.id ? 'speak' : 'listen';
    if (this.phase === 'day') return 'talk';
    return null;
  }
}

module.exports = { Game, shuffle, pick };
