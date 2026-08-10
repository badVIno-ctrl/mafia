/* =========================================================================
   Клиент сетевой партии.

   Три вещи, которые здесь важнее остального:

   1. Точечные обновления DOM. Раньше на каждый пуш от сервера (а он
      приходит раз в секунду) страница целиком переписывала innerHTML чата,
      стола и протокола. Из-за этого пропадал фокус в поле ввода, скакал
      скролл и терялось выделение — именно это игроки называли «лагами».
      Теперь узлы создаются один раз и потом только правятся.

   2. Одна сцена с бот-режимом. Стол, комната и фигуры приходят из
      stage3d.js; подписи мест рисует HTML поверх canvas, поэтому текст
      резкий и его можно нажать пальцем.

   3. Голос. Микрофон соединяет игроков напрямую (rtc.js), сервер только
      передаёт записки о знакомстве. Кто говорит — видно по уровню звука.
   ========================================================================= */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ico = function (name, size) { return window.Icons ? Icons.svg(name, { size: size || 18 }) : ''; };

  /* Названия фаз. Общее правило для всех подписей: сначала обычные
     слова, образ — потом. Игрок не должен расшифровывать «занавес». */
  var PHASE_RU = {
    prologue: 'Знакомство', night: 'Ночь', morning: 'Утро',
    lastword: 'Последнее слово',
    speech: 'День — слово по кругу',
    day: 'День — обсуждение', vote: 'Голосование', runoff: 'Повторное голосование',
    tievote: 'Решение стола', over: 'Игра окончена'
  };
  var CH_RU = { town: 'Общий чат', mafia: 'Чат мафии', ghost: 'Выбывшие' };
  var ACT_RU = {
    kill: 'Выберите жертву', heal: 'Кого спасаете этой ночью',
    check: 'Кого проверяете', vote: 'За кого голосуете',
    speak: 'Слово у вас', listen: 'Слушайте',
    lastword: 'Последнее слово ваше', bestmove: 'Назовите трёх подозреваемых',
    /* Расширенный набор. Формулировка здесь — это единственное, что игрок
       читает в момент хода, поэтому она говорит не «примените способность», а
       что именно случится. */
    slay: 'Кого вы заберёте этой ночью', block: 'Кому этой ночью будет не до дела',
    shield: 'Кого прикрываете от изгнания', press: 'Выберите двоих — узнаете, вместе они или врозь',
    tievote: 'Поднять всех или оставить всех'
  };
  /* Что ведущий говорит вслух при смене фазы. */
  var NARRATE = {
    night: 'Город засыпает.',
    morning: 'Город просыпается.',
    lastword: 'Последнее слово выбывшего.',
    speech: 'Слово идёт по кругу.',
    day: 'День. Обсуждайте, кто вам кажется подозрительным.',
    vote: 'Голосуем.',
    runoff: 'Повторное голосование.',
    tievote: 'Снова ничья. Стол решает: поднять всех или оставить всех.',
    over: 'Игра окончена.'
  };

  var state = {
    lobby: null, room: null, game: null,
    tab: 'town', friendsOpen: false,
    lastPhase: null, lastMentionTs: null,
    /* Первый из пары журналиста. Живёт только на клиенте: сервер получает
       пару целиком, потому что половина этого факта бессмысленна. */
    pressA: null,
    stage: null, stageBroken: false, seatsKey: '',
    marks: new Map(), chatSeen: new Set(), chatPrimed: false,
    actionsKey: '', roleKey: '',
    rtc: null, levels: new Map(), micOn: false,
    speaker: null, speakerUntil: 0,
    panel: 'stage', unread: 0, curtain: null
  };

  /* =======================================================================
     мелкая механика DOM
     ======================================================================= */

  /** Список с ключами: узлы переиспользуются, а не перерисовываются. */
  function syncKeyed(box, items, keyOf, create, update) {
    var have = new Map();
    for (var i = 0; i < box.children.length; i++) {
      var c = box.children[i];
      have.set(c.dataset.k, c);
    }
    var order = [];
    items.forEach(function (it, idx) {
      var k = String(keyOf(it, idx));
      var el = have.get(k);
      if (!el) { el = create(it); el.dataset.k = k; }
      else have.delete(k);
      update(el, it);
      order.push(el);
    });
    have.forEach(function (el) { el.remove(); });
    /* переставляем только то, что действительно стоит не на месте */
    order.forEach(function (el, idx) {
      if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    });
  }

  /** Записать текст, только если он изменился: иначе браузер сбрасывает выделение. */
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
  function setHTML(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
  function setCls(el, cls, on) { if (el) el.classList.toggle(cls, !!on); }

  function nearBottom(box) { return box.scrollHeight - box.scrollTop - box.clientHeight < 60; }

  /* Полный адрес приглашения: его и показываем, и копируем. */
  function inviteUrl(room) {
    if (!room) return '';
    return location.origin + (room.inviteLink || ('/online.html?join=' + room.invite));
  }

  /* Сцена поднимается асинхронно, и всё это время в state.stage лежит метка
     'loading'. Один геттер вместо проверок в каждой точке вызова. */
  function stg() { return (state.stage && state.stage !== 'loading') ? state.stage : null; }

  /* =======================================================================
     виды
     ======================================================================= */
  function show(which) {
    $('needAuth').hidden = which !== 'auth';
    $('lobbyView').hidden = which !== 'lobby';
    $('gameView').hidden = which !== 'game';
    $('logSheet').hidden = which !== 'game';
    $('mobTabs').hidden = which !== 'game';
    $('btnChat').hidden = which !== 'game';
    $('roomTag').hidden = which !== 'game';
    document.body.classList.toggle('playing', which === 'game');
  }

  /* =======================================================================
     ВХОД НА МЕСТЕ

     Самый дорогой отказ на сайте выглядел так: друг присылает ссылку
     ?join=…, у пришедшего имени ещё нет, и вместо стола он получает экран
     «вернитесь на главную и назовитесь». Возвращается, называется — а
     приглашения уже нет: адрес потерян вместе со страницей.

     Назваться можно здесь же. Приглашение при этом не трогаем: оно лежит в
     адресной строке, и после имени страница просто перезагружается тем же
     адресом — со всеми ?join=, ?solo=, ?quick=.
     ======================================================================= */
  function showAuthGate() {
    show('auth');
    var q = new URLSearchParams(location.search);
    var lede = $('authLede');
    if (lede && (q.get('join') || q.get('room'))) {
      setText(lede, 'Вас позвали за стол. Назовитесь — и вы сразу окажетесь в комнате: ' +
        'приглашение никуда не денется, почта и пароль не нужны.');
    }
    setTimeout(function () { if ($('authName')) $('authName').focus(); }, 60);
  }

  /** Завести имя и вернуться на этот же адрес — вместе с приглашением. */
  function claimName(name, btn) {
    name = String(name || '').trim();
    if (name.length < 2) { API.toast('Имя от 2 до 16 символов', 'bad'); return; }
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    API.call('/api/register', { name: name })
      .then(function (r) { API.save(r.user); location.reload(); })
      .catch(function (e) {
        API.fail(e);
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      });
  }

  /* =======================================================================
     ЛОББИ
     ======================================================================= */
  /* Раньше здесь были только адресные приглашения: человек, пришедший на сайт
     впервые, не мог найти соперников вообще никак. Теперь лобби отвечает на три
     вопроса сразу: есть ли тут люди, куда можно сесть и кто меня звал. */
  function renderLobby(lobby) {
    state.lobby = lobby;
    renderOnlineCount(lobby);
    renderOpenTables(lobby);
    renderInvites(lobby);
  }

  /* Самый важный ответ на вопрос «а есть вообще с кем играть?» */
  function renderOnlineCount(lobby) {
    var el = $('onlineCount'); if (!el) return;
    var online = (lobby.users || []).filter(function (u) { return u.online; }).length + 1;
    var tables = (lobby.rooms || []).length;
    setText(el, online + ' ' + API.plural(online, 'игрок', 'игрока', 'игроков') + ' на сайте' +
      (tables ? ' · ' + tables + ' ' + API.plural(tables, 'стол ждёт', 'стола ждут', 'столов ждут') : ''));
    setCls(el, 'good', tables > 0 || online > 1);
  }

  /* «Ждёт 4 минуты» понятнее, чем штамп времени создания. */
  function waitLabel(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 45) return 'собрался только что';
    var m = Math.round(sec / 60);
    if (m < 60) return 'ждёт ' + m + ' ' + API.plural(m, 'минуту', 'минуты', 'минут');
    var h = Math.round(m / 60);
    return 'ждёт ' + h + ' ' + API.plural(h, 'час', 'часа', 'часов');
  }

  /* Открытые столы общего зала. Порядок задаёт сервер: сначала те,
     где почти собрались — так ждать приходится меньше всего. */
  function renderOpenTables(lobby) {
    var box = $('openTables'); if (!box) return;
    var rooms = lobby.rooms || [];
    if (!rooms.length) {
      setHTML(box, '<div class="empty">Открытых столов сейчас нет. Нажмите «Быстрая игра» — ' +
        'стол откроется, и остальные увидят его в этом списке.</div>');
      return;
    }
    box._html = null;
    syncKeyed(box, rooms, function (r) { return r.roomId; },
      function () { var d = document.createElement('div'); d.className = 'item'; return d; },
      function (el, r) {
        var pct = Math.round(100 * (r.players || 0) / Math.max(1, r.size));
        var людей = r.humans || 0;
        setHTML(el, '<div class="tblrow">' +
          '<span class="avatar">' + API.esc(API.initial(r.host)) + '</span>' +
          '<span class="who2">' +
            '<b class="ttl">' + API.esc(r.title || 'Стол') + '</b>' +
            '<span class="sub2">' + людей + ' ' + API.plural(людей, 'человек', 'человека', 'человек') +
              (r.bots ? ' и ' + r.bots + ' ' + API.plural(r.bots, 'бот', 'бота', 'ботов') : '') +
              ' из ' + r.size + ' · ' + API.esc(r.scenario) + ' · ' + waitLabel(r.waitingSec) + '</span>' +
            '<span class="seatbar"><i style="--fill:' + (pct / 100).toFixed(3) + '"></i></span>' +
          '</span>' +
          '<button class="btn primary sm" data-sit="' + r.roomId + '">Сесть</button>' +
          '</div>');
      });
  }

  function renderInvites(lobby) {
    var box = $('roomList'); if (!box) return;
    var items = lobby.invites || [];
    if (!items.length) {
      setHTML(box, '<div class="empty">Личных приглашений нет — но за любой открытый стол ' +
        'можно сесть и без них.</div>');
      return;
    }
    box._html = null;
    syncKeyed(box, items, function (i) { return 'invite:' + i.roomId; },
      function () { var d = document.createElement('div'); d.className = 'item'; return d; },
      function (el, i) {
        el.style.borderColor = 'rgba(226,180,120,.45)';
        setHTML(el, '<span class="avatar">' + ico('envelope', 18) + '</span>' +
          '<span class="nm">' + API.esc(i.from) + ' зовёт в «' + API.esc(i.title) + '» ' +
          '<span class="muted">' + i.players + '/' + i.size + '</span></span>' +
          '<button class="btn primary sm" data-join="' + i.roomId + '">Принять</button>');
      });
  }

  function renderFriends() {
    var box = $('friends');
    if (!box || !state.lobby || !state.room) return;
    var q = ($('friendSearch').value || '').trim().toLowerCase();
    var inRoom = {}, invited = {};
    state.room.members.forEach(function (m) { inRoom[m.id] = true; });
    state.room.invites.forEach(function (i) { invited[i.id] = true; });
    var isHost = state.room.hostId === API.user.id;

    var list = (state.lobby.users || []).filter(function (u) {
      return !q || u.name.toLowerCase().indexOf(q) >= 0;
    }).slice(0, 60);

    if (!list.length) {
      /* Список показывает только тех, кто сейчас на сайте, поэтому пустота
         здесь — обычное дело, и объяснить её надо по-разному: «никого нет»
         и «по вашему запросу никого нет» — это две разные новости. */
      setHTML(box, '<div class="empty">' + (q
        ? 'По запросу «' + API.esc(q) + '» на сайте никого нет.'
        : 'Кроме вас на сайте сейчас никого. Пришлите друзьям ссылку на стол — ' +
          'они откроют её, назовутся и сразу появятся здесь.') + '</div>');
      return;
    }
    box._html = null;
    syncKeyed(box, list, function (u) { return u.id; },
      function () { var d = document.createElement('div'); d.className = 'item'; return d; },
      function (el, u) {
        var right = inRoom[u.id] ? '<span class="pill good">за столом</span>'
          : invited[u.id] ? '<span class="pill">позван</span>'
            : !isHost ? '<span class="pill">зовёт хозяин</span>'
              : '<button class="btn sm" data-invite="' + u.id + '">Позвать</button>';
        setHTML(el, '<span class="avatar">' + API.esc(API.initial(u.name)) + '</span>' +
          '<span class="nm">' + API.esc(u.name) + '</span>' +
          '<span class="dot ' + (u.online ? '' : 'off') + '"></span>' + right);
      });
  }

  function renderRoom(room) {
    var wasStarted = state.room && state.room.started;
    state.room = room;
    if (room && room.started) {
      /* Новая партия начинается в 2D: плоский стол встаёт сразу и одинаково
         у всех. Кто хочет объём — нажмёт кнопку «3D». */
      if (!wasStarted) ViewMode.resetForNewGame();
      show('game'); renderGame(room.game); return;
    }
    var st = stg();
    if (st) { st.dispose(); state.marks.clear(); }
    if (st || !state.stage) { state.stage = null; state.seatsKey = ''; }
    if (state.rtc && state.rtc.running) toggleMic(false);

    show('lobby');
    $('noRoom').hidden = !!room;
    $('roomPane').hidden = !room;
    if (!room) { if (state.lobby) renderLobby(state.lobby); return; }

    var isHost = room.hostId === API.user.id;
    setHTML($('lobbyTitle'), API.esc(room.title) +
      (room.solo ? '<em>стол на одного — соседи уже сидят</em>'
        : '<em>хозяин — ' + API.esc(room.hostName) + '</em>'));
    setText($('inviteLink'), inviteUrl(room));
    /* Стол на одного объявлять в общем зале нечего: человек сел играть один.
       Ссылка при этом остаётся — передумает, позовёт живого, и тот сядет на
       место соседа. */
    /* Переключатель «показывать стол в общем зале» и его объяснение прячутся
       вместе. Спрятать только галочку недостаточно: подпись про ссылку
       уезжала под соседнюю галочку и объясняла не то, что рядом стоит. */
    if ($('openTable')) $('openTable').closest('.check').hidden = !!room.solo;
    if ($('openTableNote')) $('openTableNote').hidden = !!room.solo;
    if ($('inviteNote')) {
      setText($('inviteNote'), room.solo
        ? 'Стол закрыт: вы играете с соседями. Захотите позвать живого человека — дайте ему эту ссылку, он сядет на место одного из соседей.'
        : 'Одна ссылка — одна дверь. Кто пришёл по ней, садится за стол; если все места заняты соседями-ботами, один из них уступит место.');
    }
    setText($('cntNow'), room.members.length + ' из ' + room.size);
    setText($('cntBots'), room.bots ? String(room.bots) : 'ни одного');
    setText($('cntGoal'), room.autoStart ? (room.size + ' игроках — сами') : 'ручном старте');
    setText($('compo'), room.compositionLabel);

    $('hostBox').hidden = !isHost;
    if (isHost) {
      if (document.activeElement !== $('sizeRange')) $('sizeRange').value = room.size;
      setText($('sizeVal'), String(room.size));
      $('autoStart').checked = room.autoStart;
      $('openTable').checked = room.visibility !== 'invite';
      if ($('modeInquest')) $('modeInquest').checked = room.mode === 'inquest';
      if ($('lastWordOn')) $('lastWordOn').checked = room.lastWord !== false;
      /* Темп: три кнопки, у каждой видно, сколько секунд даётся на речь.
         Число здесь важнее названия — именно оно отвечает на вопрос «а это
         долго?». */
      if ($('speedPick')) {
        setHTML($('speedPick'), (room.speedList || []).map(function (sp) {
          return '<button class="btn sm' + (room.speed === sp.id ? ' on' : '') +
            '" data-speed="' + sp.id + '" title="' + API.esc(sp.hint) + '">' +
            API.esc(sp.ru) + ' <span class="muted">' + sp.speech + ' с</span></button>';
        }).join(''));
      }
      /* Набор ролей. Пресет, а не пять галочек: восемнадцать сочетаний, из
         которых половина не сходится по составу, — это не выбор, а ловушка.
         Пресет, который на текущий стол не садится, показываем погашенным и
         подписываем, сколько человек ему нужно: иначе хозяин жмёт кнопку и
         получает отказ без объяснения. */
      if ($('presetPick')) {
        setHTML($('presetPick'), (room.presetList || []).map(function (pr) {
          var need = pr.min === pr.max ? ('ровно ' + pr.min) : (pr.min + '–' + pr.max);
          return '<button class="btn sm' + (room.rolePreset === pr.id ? ' on' : '') +
            (pr.fits ? '' : ' off') + '" data-preset="' + pr.id + '"' +
            (pr.fits ? '' : ' disabled') +
            ' title="' + API.esc(pr.hint) + '">' + API.esc(pr.ru) +
            (pr.fits ? '' : ' <span class="muted">' + need + '</span>') + '</button>';
        }).join(''));
        var cur = (room.presetList || []).filter(function (x) { return x.id === room.rolePreset; })[0];
        /* Сначала зачем, потом что: «Маньяк убивает сам за себя. Состав:
           классика плюс третья сила.» Обратный порядок читался как обрывок
           фразы с маленькой буквы посередине. */
        setText($('presetNote'), cur ? (cur.hint + '. Состав: ' + cur.short + '.') : '');
      }
      if ($('voteOpenOn')) $('voteOpenOn').checked = room.voteOpen !== false;
      if ($('onTieTable')) $('onTieTable').checked = room.onTie === 'table';
      if ($('foulsOn')) $('foulsOn').checked = !!room.fouls;
      $('btnStart').disabled = !room.canStart;
      setText($('btnStart'), room.canStart ? 'Начать партию (' + room.members.length + ')' : 'Нужно хотя бы шесть человек');
      /* Добор ботами: сколько мест осталось — столько и предлагаем занять. */
      $('btnBots').hidden = !room.freeSeats;
      setText($('btnBots'), 'Добрать ботами (' + room.freeSeats + ')');
      $('btnBotsOff').hidden = !room.bots;
    }

    var mem = room.members.map(function (m) { return { kind: 'm', m: m }; })
      .concat(room.invites.map(function (i) { return { kind: 'i', i: i }; }));
    syncKeyed($('members'), mem,
      function (it) { return it.kind + (it.m ? it.m.id : it.i.id); },
      function () { var d = document.createElement('div'); d.className = 'item'; return d; },
      function (el, it) {
        if (it.kind === 'm') {
          el.style.opacity = '';
          setHTML(el, '<span class="avatar">' + API.esc(API.initial(it.m.name)) + '</span>' +
            '<span class="nm">' + API.esc(it.m.name) + (it.m.id === API.user.id ? ' <span class="muted">— это вы</span>' : '') + '</span>' +
            (it.m.voice ? '<span class="pill good">' + ico('mic', 14) + '</span>' : '') +
            (it.m.bot ? '<span class="pill">сосед-бот</span>' : '') +
            (it.m.host ? '<span class="pill">хозяин</span>' : '') +
            '<span class="dot ' + (it.m.online ? '' : 'off') + '"></span>' +
            (isHost && !it.m.host ? '<button class="iconbtn" data-kick="' + it.m.id + '" aria-label="Убрать из комнаты">' + ico('close', 16) + '</button>' : ''));
        } else {
          el.style.opacity = '.6';
          setHTML(el, '<span class="avatar">' + ico('envelope', 18) + '</span>' +
            '<span class="nm">' + API.esc(it.i.name) + '</span><span class="pill">ждём ответа</span>');
        }
      });

    syncKeyed($('scenarios'), room.scenarios, function (s) { return s.id; },
      function () { return document.createElement('button'); },
      function (el, s) {
        el.className = s.id === room.scenarioId ? 'on' : '';
        el.disabled = !isHost;
        el.dataset.scen = s.id;
        setHTML(el, '<div class="t">' + API.esc(s.title) + '</div>' +
          '<div class="d">' + API.esc(s.place) + ' · ' + s.min + '–' + s.max + ' человек</div>');
      });

    var feed = $('lobbyFeed');
    var stick = nearBottom(feed);
    syncKeyed(feed, room.chat || [], function (m) { return m.ts + ':' + (m.from || 'sys'); },
      function () { var d = document.createElement('div'); d.className = 'msg'; return d; },
      function (el, m) {
        el.className = 'msg' + (m.system ? ' sys' : (m.from === API.user.id ? ' mine' : ''));
        setHTML(el, m.system ? API.esc(m.text)
          : '<span class="who">' + API.esc(m.name) + ':</span> ' + API.esc(m.text));
      });
    if (stick) feed.scrollTop = feed.scrollHeight;

    $('friendsBox').hidden = !state.friendsOpen;
    renderFriends();
  }

  /* =======================================================================
     ПАРТИЯ
     ======================================================================= */
  function renderGame(g) {
    if (!g) return;
    state.game = g;
    var you = g.you || {};
    var room = state.room;

    setText($('roomTag'), room ? room.title : '');

    /* --- смена фазы: тост, объявление ведущего, свет на сцене --- */
    if (state.lastPhase && state.lastPhase !== g.phase) {
      API.toast(PHASE_RU[g.phase] + (g.day ? ' · день ' + g.day : ''));
      if (NARRATE[g.phase]) Voice.say(NARRATE[g.phase] + ' ' + hintFor(g, you), { narrator: true, urgent: true });
      /* Недобранная пара журналиста не должна пережить ночь: утром первый
         выбранный уже ничего не значит, а кнопка «выберите второго» осталась
         бы висеть до конца партии. */
      state.pressA = null;
    }
    state.lastPhase = g.phase;

    /* Своя очередь в круге речей. Молча передать слово тому, кто отвернулся от
       экрана, — верный способ потерять его речь: слово надо объявить. */
    if (g.phase === 'speech' && g.speakerId !== state.lastSpeaker) {
      state.lastSpeaker = g.speakerId;
      if (g.speakerId && you.id === g.speakerId) {
        API.toast('Слово у вас — говорите', 'good');
        Voice.say('Ваше слово.', { narrator: true, urgent: true });
        var box = $('gMsg');
        if (box && !box.disabled) box.focus();
      } else if (g.speakerName) {
        Voice.say('Слово: ' + g.speakerName + '.', { narrator: true });
      }
    }
    if (g.phase !== 'speech') state.lastSpeaker = null;

    setHTML($('phaseIcon'), ico(Icons.phase(g.phase), 22));
    setText($('gPhase'), PHASE_RU[g.phase] + (g.day ? ' · день ' + g.day : ''));
    setText($('gScenario'), g.scenario.title + ' · ' + g.scenario.place);
    setText($('gAlive'), 'в игре ' + g.aliveCount + ' из ' + g.players.length);
    paintTimer(g.secondsLeft, g.phaseSeconds);
    setText($('gHint'), hintFor(g, you));

    /* Блокнот привязан к столу: метки одной партии не должны всплывать
       в другой. Открываем его на идентификаторе комнаты. */
    if (window.Notes) Notes.open(room && room.id ? room.id : 'net');

    /* Состав стола сменился — раздаём голоса и пересобираем сцену. */
    var key = g.players.map(function (p) { return p.id; }).join(',');
    if (state.seatsKey !== key) {
      Voice.assign(g.players);
      state.chatPrimed = false;
    }
    ensureStage(g, key);
    renderRole(g, you);
    renderMarks(g, you);
    renderFlatSeats(g, you);
    renderActions(g, you, room);
    renderChat(g, you);
    renderLog(g);
    renderFinale(g);

    syncVoice();

    if (stg()) {
      stg().sync({
        phase: g.phase,
        players: g.players,
        targets: g.players.filter(function (p) { return canTarget(g, you, p); }).map(function (p) { return p.id; }),
        /* В круге речей говорящего называет сервер, а не уровень микрофона:
           так фигура поворачивается к нему даже у тех, кто играет без звука. */
        speakerId: g.phase === 'speech' ? (g.speakerId || null) : (state.speaker || null),
        /* Ночью мафия видит комнату в кирпичном отсвете — своим об этом
           говорить не надо, а мирный этого отсвета не увидит никогда. */
        mafiaGlow: g.phase === 'night' && !!you && you.alive && (you.role === 'mafia' || you.role === 'don')
      });
    }
  }

  /* ---------------------------- сцена ---------------------------- */
  /* Декораций две, контракт один: mount(container, {onPick}) отдаёт объект
     с setSeats / sync / project / dispose. Клиент не знает, стоит перед ним
     выгородка в глубину или писаный задник, — и это единственная причина,
     по которой кнопку вида удалось сделать без перезапуска партии. */
  function sceneMount(mode) {
    return mode === ViewMode.FLAT
      ? import('/js/stage2d.js').then(function (m) { return m.mountFlatStage; })
      : import('/js/stage3d.js').then(function (m) { return m.mountStage; });
  }

  function mountScene() {
    var mode = ViewMode.get();
    state.stage = 'loading';
    state.stageMode = mode;
    sceneMount(mode).then(function (mount) {
      return mount($('stage'), { onPick: function (id) { pickTarget(id); } });
    }).then(function (stage) {
      /* Пока сцена вставала, игрок мог передумать: тогда её сразу убираем. */
      if (mode !== ViewMode.get()) { try { stage.dispose(); } catch (e) { } return; }
      state.stage = stage;
      state.stageBroken = false;
      state.seatsKey = '';
      $('flatWrap').hidden = true;
      $('flatWrap').classList.remove('plain');
      paintViewBtn();
      if (state.game) renderGame(state.game);
    }).catch(function (e) {
      state.stage = null;
      console.warn('Сцена не встала (' + mode + '):', e && e.message);
      /* Глубокая сцена может не подняться на слабом железе. Это не повод
         показывать таблицу: плоский задник не требует ни WebGL, ни three.js. */
      if (mode !== ViewMode.FLAT) {
        API.toast('Глубокая сцена не встала — вешаем плоский задник');
        ViewMode.set(ViewMode.FLAT);
        return;
      }
      state.stageBroken = true;
      $('flatWrap').hidden = false;
      $('flatWrap').classList.add('plain');
      API.toast('Сцена не поднялась — играем на плоском столе');
    });
  }

  /* Смена вида посреди партии: старую декорацию разбираем, новую ставим и
     сразу отдаём ей текущее состояние. Партия живёт на сервере, поэтому для
     игрока это просто перемена декораций, а не перезаход. */
  function remountScene() {
    if (state.stage && state.stage !== 'loading' && state.stage.dispose) {
      try { state.stage.dispose(); } catch (e) { /* разбирать нечего */ }
    }
    state.stage = null;
    state.seatsKey = '';
    state.marks.clear();
    $('marks').innerHTML = '';
    $('stage').innerHTML = '';
    mountScene();
  }

  function ensureStage(g, key) {
    if (state.stageBroken) { state.seatsKey = key; return; }
    if (stg() && state.seatsKey === key) return;

    if (!state.stage) { mountScene(); return; }
    if (!stg()) return;

    state.seatsKey = key;
    state.stage.setSeats(g.players.map(function (p) {
      return { id: p.id, name: p.name, seat: p.seat, you: g.you && p.id === g.you.id };
    }));
    state.marks.clear();
    $('marks').innerHTML = '';
  }

  /* Жетон вместо таблички: только номер места. Иначе на телефоне двадцать
     подписей перекрывают друг друга и не читается ни одна.

     Важное следствие, из которого растёт всё дальнейшее: в режиме жетонов
     подпись места — кружок 30 px с одним номером внутри. Замер по живой
     сцене на телефоне 390 px: центры соседних жетонов расходятся на 61 px при
     восьми игроках, на 39 при двенадцати и на 24 при двадцати — то есть при
     полном столе жетоны уже перекрываются. Пальцем в такой жетон попадать
     нельзя, и увеличение этого не исправит: места на дуге ровно столько,
     сколько есть, а промах здесь означает проверку не того человека.

     Значит выбирать надо в списке — он давно есть во вкладке «Стол», просто
     игроку об этом никто не говорил. */
  function chipMode(g) {
    return g.players.length > 14 || window.innerWidth < 620;
  }

  /* Подписи мест: создаются один раз, дальше только правятся и двигаются. */
  function renderMarks(g, you) {
    if (!stg()) return;
    var box = $('marks');
    var chip = chipMode(g);
    setCls(box, 'chips', chip);
    syncKeyed(box, g.players, function (p) { return p.id; },
      function () {
        var d = document.createElement('button');
        d.className = 'mark';
        d.innerHTML = '<span class="seatno"></span><span class="nm"></span><span class="sub"></span>' +
          '<span class="note-chip" hidden></span><span class="lvl"></span>';
        return d;
      },
      function (el, p) {
        var pickable = canTarget(g, you, p);
        var picked = isPicked(you, p);
        el.className = 'mark' +
          (p.id === you.id ? ' you' : '') +
          (!p.alive ? ' dead' : '') +
          (pickable ? ' pickable' : '') +
          (picked ? ' picked' : '') +
          (p.team === 'mafia' ? ' mafia' : '') + (p.team === 'maniac' ? ' maniac' : '') +
          (state.speaker === p.id ? ' talking' : '');
        el.dataset.target = pickable ? p.id : '';
        el.disabled = !pickable;
        setText(el.querySelector('.seatno'), String(p.seat));
        setText(el.querySelector('.nm'), p.name + (p.id === you.id ? ' · вы' : ''));
        setText(el.querySelector('.sub'), subFor(g, p));
        paintNote(el.querySelector('.note-chip'), p.id);
        el.dataset.note = p.id;
        var lvl = state.levels.get(p.id) || 0;
        el.querySelector('.lvl').style.setProperty('--lvl', Math.min(1, lvl).toFixed(3));
      });
    state.marks.clear();
    for (var i = 0; i < box.children.length; i++) state.marks.set(box.children[i].dataset.k, box.children[i]);
    placeMarks();
  }

  /* Позиции подписей пересчитываются в кадре: камеру можно вращать. */
  function placeMarks() {
    var st = stg();
    if (!st) return;
    var box = $('marks');
    /* Подписи спрятаны — считать их место незачем. На телефоне это ровно
       четыре вкладки из пяти: пока открыт стол, чат, роль или протокол,
       жетоны не видны, а раньше их положение всё равно пересчитывалось
       шестьдесят раз в секунду. На столе из двадцати человек это тысяча
       двести проекций и записей в стиль в секунду вхолостую. */
    if (box.hidden) return;
    var W = box.clientWidth, H = box.clientHeight;
    state.marks.forEach(function (el, id) {
      /* Своя подпись поднята выше: камера стоит почти за спиной игрока,
         и на уровне головы табличка легла бы прямо на сукно. */
      var mine = state.game && state.game.you && state.game.you.id === id;
      var p = st.project(id, mine ? 1.95 : 1.66);
      if (!p || !p.visible) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; return; }
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
      /* Держим подпись в кадре: у дальних мест она иначе уезжает за край. */
      var w2 = el.offsetWidth / 2 + 4;
      el.style.left = Math.round(Math.max(w2, Math.min(W - w2, p.x))) + 'px';
      el.style.top = Math.round(Math.max(el.offsetHeight + 4, Math.min(H - 8, p.y))) + 'px';
      /* дальние подписи чуть мельче — глубина читается без лишних линий */
      var k = Math.max(0.78, Math.min(1, 1.25 - p.depth * 0.28));
      el.style.transform = 'translate(-50%,-100%) scale(' + k.toFixed(2) + ')';
      /* Слой подписей держим низким: выше них должны оказываться шторки. */
      el.style.zIndex = String(30 - Math.round(p.depth * 20));
    });
  }

  function subFor(g, p) {
    if (!p.alive) return (p.roleRu || '—') + ' · ' + (p.deathCause === 'vote' ? 'город вывел' : 'ночь забрала');
    /* Вышедший из-за стола и потерявший связь — разные вещи: первый ушёл сам,
       и стол вправе знать, что ждать его хода бессмысленно. */
    if (p.left) return 'вышел из-за стола';
    if (p.offline) return 'нет связи';
    if (p.role) return p.roleRu;
    /* Открытое голосование: за кого поднял руку — прямо на месте. Ради этого
       правило и включают: голос становится высказыванием, за которым следят. */
    if (p.voteFor) {
      if (p.voteFor === 'skip') return 'воздержался';
      var to = g.players.filter(function (x) { return x.id === p.voteFor; })[0];
      return to ? ('голос → ' + to.name) : 'голос подан';
    }
    if (g.phase === 'tievote' && p.voted) return 'решение принял';
    if ((g.phase === 'vote' || g.phase === 'runoff') && p.voted) return 'голос подан';
    if (g.phase === 'day' && p.ready) return 'готов голосовать';
    if (p.foulSkip) return 'пропускает речь за фолы';
    if (p.fouls >= 2) return p.fouls + ' фола';
    return 'за столом';
  }

  function isPicked(you, p) {
    var act = you.canAct;
    /* Выбранное место должно быть видно на самом месте, а не только в доке:
       иначе после клика игрок не уверен, что ход подан. */
    var pressed = (you.myPress || '').split(',').indexOf(p.id) >= 0 || state.pressA === p.id;
    return (act === 'kill' && you.myKill === p.id) || (act === 'heal' && you.myHeal === p.id) ||
      (act === 'check' && you.myCheck === p.id) || (act === 'vote' && you.myVote === p.id) ||
      (act === 'slay' && you.mySlay === p.id) || (act === 'block' && you.myBlock === p.id) ||
      (act === 'shield' && you.myShield === p.id) || (act === 'press' && pressed);
  }

  /* ---------------------------- запасной стол ---------------------------- */
  /* Плоский стол нужен в двух случаях: когда 3D не поднялась и когда экран
     узкий. На телефоне двадцать подписей поверх сцены превращаются в кашу,
     поэтому выбирать игрока удобнее в списке с нормальными именами. */
  function renderFlatSeats(g, you) {
    syncKeyed($('seats'), g.players, function (p) { return p.id; },
      function () {
        var b = document.createElement('button');
        b.className = 'seat';
        b.innerHTML = '<span class="no"></span><span class="avatar"></span><span class="nm"></span>' +
          '<span class="sub"></span><span class="note-chip" hidden></span>';
        return b;
      },
      function (el, p) {
        var pickable = canTarget(g, you, p);
        el.className = 'seat' + (!p.alive ? ' dead' : '') + (p.id === you.id ? ' you' : '') +
          (isPicked(you, p) ? ' picked' : '') + (pickable ? ' pickable' : '');
        el.dataset.target = pickable ? p.id : '';
        el.disabled = !pickable;
        setText(el.querySelector('.no'), '№' + p.seat);
        setText(el.querySelector('.avatar'), API.initial(p.name));
        setText(el.querySelector('.nm'), p.name + (p.id === you.id ? ' · вы' : ''));
        setText(el.querySelector('.sub'), subFor(g, p));
        paintNote(el.querySelector('.note-chip'), p.id);
        el.dataset.note = p.id;
      });
  }

  /* ------------------------------ блокнот ------------------------------
     Пометки на местах: «чёрный», «шериф», «врёт». Живут только у своего
     хозяина (см. notes.js) и появляются на месте маленьким цветным ярлыком.
     Ставятся долгим нажатием или правой кнопкой — тот же жест, которым
     на живом столе двигают к себе бумажку. */
  function paintNote(el, id) {
    if (!el || !window.Notes) return;
    var t = Notes.get(id);
    el.hidden = !t;
    if (!t) return;
    el.textContent = t.ru;
    el.style.setProperty('--tag', t.color);
  }

  /** Меню меток для одного места. */
  function openNotes(id) {
    var g = state.game;
    if (!g || !window.Notes) return;
    var p = g.players.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var cur = Notes.get(id);
    var h = '<div class="expert">';
    /* Ночью у мафии тот же жест открывает ещё и общую доску: метка на месте,
       которую видят свои. Отдельного жеста заводить нельзя — второй способ
       трогать место игрок просто не найдёт. */
    var you = g.you || {};
    if (g.phase === 'night' && you.canAct === 'kill' && g.mafiaTags) {
      var mine = (g.mafiaBoard || []).filter(function (m) { return m.id === id; })[0];
      h += '<h3>Доска мафии · место ' + p.seat + '</h3>' +
        '<p class="note">Эту метку видят только свои — она для того, чтобы договориться ' +
        'ночью, а не в общем чате при всём городе.</p><div class="grid2">' +
        g.mafiaTags.map(function (t) {
          return '<button class="btn sm btag ' + t.id + (mine && mine.tag === t.id ? ' on' : '') +
            '" data-mark="' + id + ':' + t.id + '">' + API.esc(t.ru) + '</button>';
        }).join('') + '</div>' +
        (mine ? '<button class="btn ghost sm" data-mark="' + id + ':">Снять метку мафии</button>' : '') +
        '<hr class="rule">';
    }
    h += '<h3>Блокнот · место ' + p.seat + '</h3>' +
      '<p class="note">Пометка видна только вам и остаётся на этом устройстве. ' +
      'Ни сервер, ни другие игроки её не получают.</p><div class="grid2">';
    Notes.tags().forEach(function (t) {
      h += '<button class="btn sm noteopt' + (cur && cur.id === t.id ? ' on' : '') +
        '" data-note-set="' + id + ':' + t.id + '" style="--tag:' + t.color + '">' +
        API.esc(t.ru) + ' <em>' + API.esc(t.hint) + '</em></button>';
    });
    h += '</div>' +
      (cur ? '<button class="btn ghost sm" data-note-set="' + id + ':">Снять пометку</button>' : '') +
      '<button class="btn ghost sm" id="expertClose">Закрыть</button></div>';
    var box = $('expertBox');
    setHTML(box, h);
    box.hidden = false;
  }

  /* ---------------------------- карта роли ---------------------------- */
  function renderRole(g, you) {
    var iq = g.inquest || null;
    var key = JSON.stringify([you.role, you.alive, (you.partners || []).length, (you.checks || []).length,
      (you.press || []).length, you.shieldSpent, you.myShield, you.fouls,
      iq ? (iq.myTraitsRu || []).join(',') : '']);
    if (state.roleKey === key) return;
    state.roleKey = key;
    var h = '<div class="role">' + ico(Icons.role(you.role), 22) +
      '<h3>' + API.esc(you.roleRu || 'Наблюдатель') + '</h3></div>' +
      '<p>' + API.esc(you.roleDesc || 'Вы смотрите со стороны.') + '</p>';
    /* Подсказка про блокнот. Механику, которую не видно, считай что её нет:
       про долгое нажатие на месте игрок сам не догадается никогда. */
    h += '<p class="hintline">Долгое нажатие на месте — <b>пометка в блокноте</b>: ' +
      'чёрный, красный, шериф, «врёт». Видно только вам.</p>';
    if (you.partners && you.partners.length) {
      h += '<div class="known">Свои: ' + you.partners.map(function (p) {
        return '<b>' + API.esc(p.name) + '</b> (№' + p.seat + (p.alive ? '' : ', выбыл') + ')';
      }).join(', ') + '</div>';
    }
    if (you.checks && you.checks.length) {
      h += '<div class="known">Проверки: ' + you.checks.map(function (c) {
        return API.esc(c.name) + ' — <b style="color:' + (c.isMafia ? 'var(--ember-soft)' : 'var(--verdigris)') + '">' +
          (c.isMafia ? 'мафия' : 'мирный') + '</b>';
      }).join('; ') + '</div>';
    }
    /* «Следствие»: свои приметы — половина игры. Их надо держать на виду
       рядом с ролью, а не искать в правилах: именно про них придётся
       врать, и именно по ним вас будут ловить. */
    if (iq && iq.myTraitsRu && iq.myTraitsRu.length) {
      h += '<div class="known"><b>Ваши приметы:</b> ' +
        iq.myTraitsRu.map(function (t) { return API.esc(t); }).join(', ') +
        '<span class="muted"> — их знаете только вы. Улики называют приметы того, кто убивал.</span></div>';
    }
    /* Журналист. Его знание — это связи, а не имена, и держать их надо
       списком: «вместе» про пару, один из которой уже раскрыт, стоит целой
       проверки шерифа, но заметить это можно только глядя на все связи разом. */
    if (you.press && you.press.length) {
      h += '<div class="known"><b>Ваши сравнения:</b> ' + you.press.map(function (r) {
        return API.esc(r.aName) + ' и ' + API.esc(r.bName) + ' — <b style="color:' +
          (r.sameTeam ? 'var(--ember-soft)' : 'var(--verdigris)') + '">' +
          (r.sameTeam ? 'вместе' : 'врозь') + '</b>';
      }).join('; ') + '<span class="muted"> — это про сторону, а не про роль.</span></div>';
    }
    /* Адвокат. Одно право на партию — и он обязан видеть, цело ли оно. */
    if (you.role === 'lawyer') {
      h += '<div class="known">' + (you.shieldSpent
        ? 'Право защиты <b>потрачено</b>: изгнание вы уже отменили один раз.'
        : 'Право защиты <b>при вас</b>. Тратится только когда сработает — ' +
          'прикрывать можно каждую ночь.') + '</div>';
    }
    /* Оборотень. Главное про свою карту он должен читать со своей карты, а не
       узнавать в тот день, когда шериф объявит его чёрным. */
    if (you.role === 'werewolf') {
      h += '<div class="known">Проверка шерифа покажет вас <b>мафией</b>. Это не ошибка движка — ' +
        'это ваша роль. Побеждаете вы вместе с городом.</div>';
    }
    if (you.fouls) {
      h += '<div class="known">Фолы: <b>' + you.fouls + '</b>' +
        (you.foulSkip ? ' — следующую речь вы пропускаете' : ' из 4') + '.</div>';
    }
    if (you.alive === false && !g.finished) h += '<div class="known muted">Вы выбыли, но видите всё.</div>';
    setHTML($('rolePane'), h);
  }

  /* ---------------------------- кнопки действий ---------------------------- */
  function renderActions(g, you, room) {
    var act = you.canAct;
    var iq = g.inquest || null;
    /* Режим жетонов и открытая панель входят в ключ: от них зависит, нужна ли
       кнопка «Выбрать в списке». Режим жетонов меняется при повороте
       телефона, панель — по нажатию на вкладку. */
    var chip = chipMode(g);
    var key = [g.finished, act, you.ready, you.myVote, you.healBlocked, you.alive, g.speakerId,
      g.lastWordId, g.bestMoveOpen, you.myPress, state.pressA, you.shieldSpent, chip, state.panel,
      (g.mafiaBoard || []).map(function (m) { return m.id + m.tag; }).join(','),
      (g.tieNames || []).join(','),
      iq ? [iq.method, iq.expertDone, iq.expertVotes, iq.clues.length].join(',') : ''].join('|');
    if (state.actionsKey === key) return;
    state.actionsKey = key;

    var a = '';
    if (g.finished) {
      if (room && room.hostId === API.user.id) a += '<button class="btn primary sm" id="btnRestart">Собрать новую партию</button>';
      a += '<a class="btn ghost sm" href="/">На главную</a>';
    } else if (act === 'vote') {
      a = '<button class="btn sm" data-target="skip">Воздержаться</button>';
    } else if (act === 'tievote') {
      /* Голос за правило, а не за человека. Имена кандидатов стоят прямо в
         подписи кнопки: «поднять всех» без списка — это голосование вслепую. */
      var who = (g.tieNames || []).join(', ');
      a = '<button class="btn danger sm' + (you.myVote === 'yes' ? ' on' : '') +
        '" data-tie="yes">Поднять всех' + (who ? ' (' + API.esc(who) + ')' : '') + '</button>' +
        '<button class="btn sm' + (you.myVote === 'no' ? ' on' : '') +
        '" data-tie="no">Оставить всех</button>';
    } else if (act === 'press') {
      /* Журналисту нужны двое, и подавать их надо парой: половина факта
         бесполезна. Первый выбранный держится на клиенте и виден в доке. */
      if (you.myPress) {
        a = '<span class="pill">Пара названа — ждём утра</span>';
      } else if (state.pressA) {
        var pa = g.players.filter(function (x) { return x.id === state.pressA; })[0];
        a = '<span class="pill">Первый: ' + API.esc(pa ? pa.name : '—') +
          '</span><span class="sep"></span>Выберите второго' +
          '<button class="btn ghost sm" id="btnPressReset">Сбросить</button>';
      } else {
        a = '<span class="pill">Выберите двоих: узнаете, в одной они команде или в разных</span>';
      }
    } else if (act === 'shield') {
      /* «Берегу право» — полноценный ход, а не отсутствие хода: ночь ждёт от
         адвоката решения, и без этой кнопки решение подать было бы нечем. */
      a = you.shieldKept
        ? '<span class="pill">Решение подано: этой ночью вы не вмешиваетесь</span>'
        : '<span class="pill">Право одно на партию — тратится только когда сработает</span>' +
          '<button class="btn sm" id="btnKeepShield">Берегу право</button>';
    } else if (act === 'speak') {
      a = '<button class="btn primary sm" id="btnPass">Передать слово</button>';
    } else if (act === 'lastword') {
      a = '<button class="btn primary sm" id="btnPass">Я всё сказал</button>';
    } else if (act === 'bestmove') {
      a = '<button class="btn primary sm" id="btnBestMove">Назвать трёх</button>' +
        '<button class="btn sm" id="btnPass">Уйти молча</button>';
    } else if (act === 'listen') {
      a = '<span class="pill">Слово у ' +
        API.esc(g.phase === 'lastword' ? (g.lastWordName || '—') : (g.speakerName || '—')) + '</span>';
    } else if (act === 'talk') {
      a = '<button class="btn sm ' + (you.ready ? 'on' : '') + '" id="btnReady">' +
        (you.ready ? 'Готов' : 'Я высказался') + '</button>';
    }

    /* Ночная доска мафии. До неё ночь мафии была одним кликом: трое чёрных
       не могли даже договориться, кого топить днём, — кроме общего чата, то
       есть при всём городе. Метки видят и ставят только свои. */
    if (act === 'kill' && g.mafiaBoard) {
      var board = g.mafiaBoard.filter(function (m) { return m.tag; });
      a += '<span class="sep"></span><span class="pill">Доска:</span>';
      a += board.length
        ? board.map(function (m) {
          var pp = g.players.filter(function (x) { return x.id === m.id; })[0];
          return '<button class="btn sm btag ' + m.tag + '" data-mark="' + m.id + ':"' +
            ' title="Снять метку · поставил ' + API.esc(m.byName) + '">' +
            API.esc(pp ? pp.name : '—') + ' — ' + API.esc(m.tagRu) + '</button>';
        }).join('')
        : '<span class="muted">пусто — долгое нажатие или правая кнопка на месте</span>';
    }

    /* Способ убийства: решение мафии, и оно стоит рядом с выбором жертвы. */
    if (iq && act === 'kill') {
      a += '<span class="sep"></span><span class="pill">Способ:</span>' +
        (iq.methods || []).map(function (m) {
          return '<button class="btn sm ' + (iq.method === m.id ? 'on' : '') +
            '" data-method="' + m.id + '" title="' + API.esc(m.note) + '">' + API.esc(m.ru) + '</button>';
        }).join('');
    }

    /* Экспертиза: одна в день и только вместе со всем столом. Кнопка
       появляется днём и только когда есть что проверять. */
    if (iq && act === 'talk' && you.alive && iq.clues.length) {
      a += '<span class="sep"></span>' + (iq.expertDone
        ? '<span class="pill">Экспертиза на сегодня сделана</span>'
        : '<button class="btn sm" id="btnExpert">Заказать экспертизу' +
          (iq.expertVotes ? ' (' + iq.expertVotes + ' из ' + iq.expertNeed + ')' : '') + '</button>');
    }
    /* Ход, которого не было видно.

       Когда от игрока ждут выбора человека — жертву, проверку, лечение,
       голос, — выбор подаётся нажатием на место. На широком экране это
       очевидно: у места есть табличка с именем и её видно. На телефоне
       остаётся жетон с номером, и весь ход выглядит так: подсказка говорит
       «за кого голосуете», а нажимать вроде бы некуда. Список с настоящими
       именами всё это время лежал во вкладке «Стол», но ни одна надпись на
       него не указывала — узнать о нём можно было только случайно.

       Кнопка не добавляет нового способа играть, она показывает уже
       существующий: одно нажатие открывает список, где у каждого места имя,
       номер и высота 92 px. */
    if (chip && needsPick(g, you) && state.panel !== 'table') {
      a += '<button class="btn primary sm" id="btnPickList">Выбрать в списке</button>';
    }
    setHTML($('actions'), a);
  }

  /* Ждёт ли партия от игрока выбора человека и есть ли кого выбирать. */
  function needsPick(g, you) {
    if (!you.canAct || g.finished || you.alive === false) return false;
    if (PICKLESS[you.canAct]) return false;
    return g.players.some(function (p) { return canTarget(g, you, p); });
  }
  /* Ходы, у которых цель — не человек: они целиком живут в кнопках дока. */
  var PICKLESS = { talk: 1, speak: 1, listen: 1, lastword: 1, tievote: 1 };

  /* ---------------------------- чат ---------------------------- */
  function renderChat(g, you) {
    if (g.channels.indexOf(state.tab) < 0) state.tab = g.channels[0];

    syncKeyed($('chatTabs'), g.channels, function (c) { return c; },
      function () { return document.createElement('button'); },
      function (el, c) {
        el.className = c === state.tab ? 'on' : '';
        el.dataset.tab = c;
        setText(el, CH_RU[c]);
      });

    var feed = $('gFeed');
    var msgs = g.chat.filter(function (m) { return m.channel === state.tab; });
    var stick = nearBottom(feed);

    if (!msgs.length) {
      setHTML(feed, '<div class="empty">Сообщений пока нет. Напишите первым — остальные ответят.</div>');
    } else {
      feed._html = null;
      syncKeyed(feed, msgs, function (m) { return m.ts + ':' + m.from; },
        function () { var d = document.createElement('div'); d.className = 'msg'; return d; },
        function (el, m) {
          var toMe = (m.mentions || []).indexOf(you.id) >= 0;
          var body = API.esc(m.text);
          (m.mentionNames || []).forEach(function (nm) {
            var stem = API.esc(nm).slice(0, Math.max(2, nm.length - 1));
            body = body.replace(new RegExp('(' + stem + '[\\u0430-\\u044f]*)', 'gi'), '<u class="men">$1</u>');
          });
          el.className = 'msg ' + m.channel + (toMe ? ' toyou' : '') + (m.from === you.id ? ' mine' : '');
          setHTML(el, (toMe ? '<span class="flag">вам</span>' : '') +
            '<span class="no">№' + m.seat + '</span><span class="who">' + API.esc(m.name) + ':</span> ' + body +
            '<button class="iconbtn say" data-say="' + m.ts + ':' + m.from + '" ' +
            'aria-label="Прочитать вслух" title="Прочитать вслух">' + ico('sound', 14) + '</button>');
          el._msg = m;
        });
    }
    if (stick) feed.scrollTop = feed.scrollHeight;

    /* Новые реплики: озвучиваем и подсвечиваем говорящего на сцене.
       При первом показе история помечается прочитанной молча — иначе
       вошедший в партию услышал бы весь день сразу. */
    var priming = !state.chatPrimed;
    state.chatPrimed = true;
    if (state.chatSeen.size > 400) state.chatSeen.clear();
    msgs.forEach(function (m) {
      var k = m.ts + ':' + m.from;
      if (state.chatSeen.has(k)) return;
      state.chatSeen.add(k);
      if (priming || m.from === you.id) return;
      Voice.say(m.text, { from: m.from });
      markSpeaking(m.from, 2600);
      if ((m.mentions || []).indexOf(you.id) >= 0 && state.lastMentionTs !== m.ts) {
        state.lastMentionTs = m.ts;
        API.toast(m.name + ' обращается к вам');
      }
      if (state.panel !== 'chat' && window.matchMedia('(max-width:900px)').matches) {
        state.unread++;
        paintTabs();
      }
    });

    /* В круге речей общий чат открыт только тому, у кого слово: иначе круг
       ничем не отличается от общего крика, ради отмены которого он и нужен. */
    var mySpeech = g.phase === 'speech' && g.speakerId === you.id;
    var canSay = (state.tab === 'town' && you.alive &&
        (['prologue', 'day', 'vote', 'runoff', 'tievote', 'morning', 'over'].indexOf(g.phase) >= 0 || mySpeech)) ||
      (state.tab === 'mafia' && g.phase === 'night' && you.alive) ||
      (state.tab === 'ghost' && you.alive === false);
    $('gMsg').disabled = !canSay;
    $('gSend').disabled = !canSay;
    $('gMsg').placeholder = canSay
      ? 'Назовите имя — человек увидит, что вы к нему'
      : (state.tab === 'town'
        ? (g.phase === 'night' ? 'Город спит — слово вернётся утром'
          : g.phase === 'speech' ? 'Слово у ' + (g.speakerName || '—') + ' — дождитесь очереди'
            : 'Сейчас говорить нельзя')
        : (state.tab === 'mafia' ? 'Мафия шепчется только ночью' : 'Этот канал для выбывших'));
  }

  /* ---------------------------- протокол ---------------------------- */
  function renderLog(g) {
    var box = $('gLog');
    var stick = nearBottom(box);
    syncKeyed(box, g.log, function (l) { return l.ts + ':' + l.kind + ':' + l.text; },
      function () { var d = document.createElement('div'); return d; },
      function (el, l) { el.className = 'l ' + l.kind; setText(el, l.text); });
    setText($('logCount'), String(g.log.length));
    if (stick) box.scrollTop = box.scrollHeight;
  }

  /* ---------------------------- итог партии ----------------------------
     Раньше здесь было «Занавес» и «Тишина осталась за чёрными» — красиво,
     но игрок не понимал, почему партия закончилась именно сейчас. Теперь
     сначала счёт и причина обычными словами, а атмосферная фраза сюжета
     остаётся, но явно помечена как концовка истории. */
  function isMafiaRole(r) { return r === 'mafia' || r === 'don'; }
  /* Команда приезжает с сервера вместе с картой: с третьей силой её больше
     нельзя вывести из имени роли, а два места, где это считалось бы,
     разошлись бы в первый же вечер. */
  function teamOf(p) { return p.team || (isMafiaRole(p.role) ? 'mafia' : 'town'); }
  var WIN_RU = { town: 'Победил город', mafia: 'Победила мафия', maniac: 'Победил маньяк' };

  /* Склонение числительных. Локально: shared/game-config.js к этой странице
     не подключён, и обращение к MafiaConfig отсюда упало бы. */
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /** Почему партия закончилась — в числах, а не в метафорах. */
  function winReason(g) {
    var mafiaAlive = 0, townAlive = 0, mafiaTotal = 0, maniacAlive = 0, maniac = null;
    g.players.forEach(function (p) {
      var t = teamOf(p);
      if (t === 'mafia') { mafiaTotal++; if (p.alive) mafiaAlive++; }
      else if (t === 'maniac') { maniac = p; if (p.alive) maniacAlive++; }
      else if (p.alive) townAlive++;
    });
    if (g.winner === 'maniac') {
      return 'Маньяк выиграл: мафии больше нет, а из мирных остался один — ' +
        'до утра он всё равно не дожил бы. Третья сила побеждает в одиночку, ' +
        'и считать её вместе с мафией было нельзя с самого начала.';
    }
    if (g.winner === 'town') {
      return 'Город выиграл: ' + plural(mafiaTotal,
        'единственный игрок из мафии выбыл',
        'все ' + mafiaTotal + ' игрока из мафии выбыли',
        'все ' + mafiaTotal + ' игроков из мафии выбыли') +
        ' из игры' + (maniac ? ', и маньяк вместе с ней' : '') +
        '. В живых остались только мирные жители.';
    }
    return 'Мафия выиграла: её осталось ' + mafiaAlive + ', а остальных — ' +
      (townAlive + maniacAlive) +
      '. Когда мафии становится столько же, сколько всех прочих вместе, ' +
      'переголосовать её больше нельзя.';
  }

  function renderFinale(g) {
    if (!g.finished) { $('finale').hidden = true; return; }
    $('finale').hidden = false;
    var key = 'fin' + g.winner + g.players.length;
    if ($('finale')._k === key) return;
    $('finale')._k = key;

    var you = g.you || {};
    /* «Ваша сторона выиграла» с третьей силой считается по команде, а не по
       «мафия или не мафия»: маньяк не выигрывает вместе с городом, даже когда
       мафия проиграла. */
    var youWon = null;
    if (you.role) {
      var myTeam = you.team || (isMafiaRole(you.role) ? 'mafia' : 'town');
      youWon = g.winner === myTeam;
    }
    var story = g.winner === 'mafia' ? g.scenario.finaleMafia : g.scenario.finaleTown;

    $('finale').innerHTML =
      '<div class="box">' +
      '<span class="label">Итог партии</span>' +
      '<div class="win ' + g.winner + '">' + (WIN_RU[g.winner] || 'Занавес') + '</div>' +
      (youWon === null ? '' :
        '<div class="youres ' + (youWon ? 'won' : 'lost') + '">' +
        (youWon ? 'Вы в числе победителей' : 'В этот раз не ваша партия') +
        ' · ваша роль: ' + API.esc(you.roleRu || '—') + '</div>') +
      '<p class="why">' + API.esc(winReason(g)) + '</p>' +
      (story ? '<p class="epilogue"><span>Концовка истории</span>' + API.esc(story) + '</p>' : '') +
      '<div class="seats">' + g.players.map(function (p) {
        var team = teamOf(p);
        return '<div class="seat ' + (p.alive ? '' : 'dead') + ' ' + team + '">' +
          '<span class="no">№' + p.seat + '</span>' +
          '<span class="avatar' + (p.alive ? '' : ' dead') + '">' + API.esc(API.initial(p.name)) + '</span>' +
          '<span class="nm">' + API.esc(p.name) + (p.id === you.id ? ' · вы' : '') + '</span>' +
          '<span class="sub">' + API.esc(p.roleRu || '') +
          (p.alive ? '' : ' · выбыл' + (p.deathDay ? ' на ' + p.deathDay + '-й день' : '')) +
          '</span></div>';
      }).join('') + '</div>' +
      /* Семя партии. По нему стол собирается заново до последней карты —
         этим можно разобрать спорную раздачу и этим же воспроизводится
         жалоба «нам третий раз подряд выпало одно и то же». */
      (g.seed ? '<p class="seed">Семя партии: <code>' + API.esc(g.seed) +
        '</code> — по нему этот стол собирается заново</p>' : '') +
      '</div>';

    Voice.say('Игра окончена. ' + (WIN_RU[g.winner] || 'Занавес') + '. ' + winReason(g),
      { narrator: true, urgent: true });
  }

  /* =======================================================================
     подсказки и правила выбора
     ======================================================================= */
  /* Куда нажимать. Подсказка описывала, что решить, но не говорила, чем это
     решение подаётся, — а на телефоне не догадаешься: место превращается в
     жетон с номером, и «выберите того, кого город выводит» повисает в
     воздухе. Дописываем одно предложение и только когда от игрока
     действительно ждут выбора человека.

     Предложение держим коротким: название кнопки в нём не повторяем — кнопка
     стоит рядом и подписана сама, а каждая лишняя строка растит док действий,
     который на телефоне и без того занимает низ кадра. */
  function whereToTap(g, you) {
    if (!needsPick(g, you)) return '';
    return chipMode(g)
      ? ' Нажмите на жетон места или откройте список.'
      : ' Нажмите на имя игрока за столом.';
  }

  function hintFor(g, you) {
    return baseHint(g, you) + whereToTap(g, you);
  }

  function baseHint(g, you) {
    if (g.finished) return 'Партия окончена — роли раскрыты.';
    if (g.phase === 'prologue') return g.scenario.prologue;
    /* Выбывший читал те же подсказки, что и живые: «Голосование: выберите
       того, кого город выводит» — при том что выбрать он ничего не может, и
       ни одной кнопки на экране у него нет. Человек в этот момент решает,
       что игра сломалась. Своя строка для выбывшего: сказано, что он вне
       игры, и сказано, где ему теперь можно говорить.

       Последнее слово — исключение: там выбывший как раз и говорит. */
    if (you.alive === false && g.phase !== 'lastword') {
      return 'Вы вне игры и уже всё знаете. Стол вас не слышит — говорить можно ' +
        'в канале выбывших. Смотрите, чем кончится.';
    }
    if (g.phase === 'night') {
      var extra = '';
      if (you.canAct === 'block' && you.blockBlocked) extra = ' Того же, что прошлой ночью, выбрать нельзя.';
      if (you.canAct === 'shield') extra = ' Право одно на партию и тратится только когда сработает.';
      if (you.canAct === 'slay') extra = ' Своих у вас нет — вы играете один.';
      return 'Город засыпает. ' + (you.canAct ? ACT_RU[you.canAct] + '.' : 'Ждите утра.') + extra;
    }
    if (g.phase === 'morning') return 'Утро. Город считает потери.';
    if (g.phase === 'lastword') {
      if (you.canAct === 'bestmove') {
        return 'Последнее слово ваше. И лучший ход: назовите трёх, на кого показываете. ' +
          'Город услышит все три имени сразу.';
      }
      if (you.canAct === 'lastword') return 'Последнее слово ваше: скажите столу то, что считаете нужным.';
      return 'Последнее слово у ' + API.esc(g.lastWordName || '—') + '. Слушайте: он уже вне игры и говорит прямо.';
    }
    if (g.phase === 'speech') {
      var left = g.speechLeft ? ', после вас ещё ' + g.speechLeft : '';
      return you.canAct === 'speak'
        ? 'Слово у вас: скажите, что думаете' + left + '. Закончили — передайте слово.'
        : 'Слово у ' + (g.speakerName || '—') + '. Остальные слушают' +
          (g.speechLeft ? ' — в очереди ещё ' + g.speechLeft : '') + '.';
    }
    if (g.phase === 'day') {
      return (you.ready
        ? 'Вы высказались — ждём остальных. Передумали? Скажите ещё раз в чате. '
        : 'День: спорьте, оправдывайтесь, сопоставляйте. ') + g.scenario.rule;
    }
    if (g.phase === 'vote') {
      /* Поданный голос надо подтвердить словами. Иначе экран после нажатия
         выглядит точно так же, как до него, и игрок жмёт второй раз. */
      if (you.myVote) {
        return (you.myVote === 'skip' ? 'Вы воздержались.' : 'Ваш голос подан.') +
          ' Передумать можно до конца отсчёта — выберите другого.';
      }
      return 'Голосование: выберите того, кого город выводит.' +
        (g.voteOpen === false ? ' Голосование закрытое: расклад не откроется.' : '');
    }
    if (g.phase === 'runoff') {
      return 'Переголосовка между лидерами — при новой ничьей ' +
        (g.onTie === 'table' ? 'решать будет стол.' : 'не выйдет никто.');
    }
    if (g.phase === 'tievote') {
      return 'Снова ничья: ' + API.esc((g.tieNames || []).join(', ')) +
        '. Стол решает одним голосом — поднять всех сразу или не выводить никого. ' +
        'Большинство «за» выводит всех.';
    }
    return '';
  }

  function canTarget(g, you, p) {
    var act = you.canAct;
    if (!act || g.finished) return false;
    if (act === 'talk') return false;
    if (!p.alive) return false;
    if (act === 'kill') return !(you.partners || []).some(function (x) { return x.id === p.id; }) && p.id !== you.id;
    if (act === 'check') return p.id !== you.id;
    if (act === 'heal') return p.id !== you.healBlocked;
    if (act === 'vote') return !g.runoffOf || g.runoffOf.indexOf(p.id) >= 0;
    /* Маньяк своих не имеет — ограничение одно: не себя. */
    if (act === 'slay') return p.id !== you.id;
    /* Любовница: не себя и не того же, что прошлой ночью. */
    if (act === 'block') return p.id !== you.id && p.id !== you.blockBlocked;
    /* Адвокат прикрывает кого угодно, включая себя: право одно, и распорядиться
       им он должен сам. */
    if (act === 'shield') return !you.shieldSpent;
    /* Журналисту нужны двое, и второй не может быть первым. */
    if (act === 'press') return !you.myPress && p.id !== you.id && p.id !== state.pressA;
    return false;
  }

  function paintTimer(left, total) {
    var t = $('gTimer');
    setText(t, API.mmss(left));
    setCls(t, 'warn', left <= 10);
    $('gBar').style.setProperty('--left', total ? Math.max(0, Math.min(1, left / total)).toFixed(3) : '0');
  }

  /* =======================================================================
     действия игрока
     ======================================================================= */
  function call(path, body) { return API.call(path, body || {}).catch(API.fail); }
  function act(type, target) { return API.call('/api/rooms/action', { type: type, target: target }).catch(API.fail); }

  function pickTarget(id) {
    var g = state.game;
    if (!g || !g.you || !g.you.canAct) return;
    var p = g.players.find(function (x) { return x.id === id; });
    if (!p || !canTarget(g, g.you, p)) return;
    /* Пара журналиста собирается на клиенте и уезжает одним действием: два
       отдельных хода дали бы половину факта, а половина этого факта — ничто. */
    if (g.you.canAct === 'press') {
      if (!state.pressA) {
        state.pressA = id;
        state.actionsKey = null;
        renderActions(g, g.you, state.room);
        renderMarks(g, g.you);
        renderFlatSeats(g, g.you);
        API.toast('Первый выбран: ' + p.name + '. Теперь второй.');
        return;
      }
      var pair = state.pressA + ',' + id;
      state.pressA = null;
      act('press', pair);
      return;
    }
    act(g.you.canAct, id);
    if (stg()) stg().shake(0.03);
    /* Выбрали в списке — показываем результат на сцене. */
    if (state.panel === 'table' && !state.stageBroken) openPanel('stage');
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-join],[data-sit],[data-invite],[data-kick],[data-scen],[data-target],' +
      '[data-tab],[data-say],[data-panel],[data-method],[data-expert],[data-note-set],[data-speed],' +
      '[data-preset],[data-mark],[data-tie]');
    if (el) {
      if (el.dataset.join) return call('/api/rooms/join', { roomId: el.dataset.join });
      /* Сесть за открытый стол — без ссылки и без приглашения. */
      if (el.dataset.sit) {
        el.disabled = true;
        return call('/api/rooms/join', { roomId: el.dataset.sit }).then(function (r) {
          el.disabled = false;
          if (r && r.room) { renderRoom(r.room); API.toast('Вы за столом «' + r.room.title + '»'); }
        });
      }
      if (el.dataset.invite) return call('/api/rooms/invite', { userId: el.dataset.invite })
        .then(function () { API.toast('Приглашение отправлено'); });
      if (el.dataset.kick) return call('/api/rooms/kick', { userId: el.dataset.kick });
      if (el.dataset.scen) return call('/api/rooms/config', { scenarioId: el.dataset.scen });
      if (el.dataset.speed) return call('/api/rooms/config', { speed: el.dataset.speed });
      if (el.dataset.preset) return call('/api/rooms/config', { rolePreset: el.dataset.preset });
      /* Ночная доска мафии: метка на месте, которую видят все свои. */
      if (el.dataset.mark) {
        $('expertBox').hidden = true;
        return act('mark', el.dataset.mark);
      }
      /* Голосование стола при ничьей: «да» или «нет», а не имя. */
      if (el.dataset.tie) return act('vote', el.dataset.tie);
      if (el.dataset.tab) { state.tab = el.dataset.tab; if (state.game) renderChat(state.game, state.game.you || {}); return; }
      if (el.dataset.say) {
        var box = el.closest('.msg');
        if (box && box._msg) Voice.say(box._msg.text, { from: box._msg.from, urgent: true });
        return;
      }
      if (el.dataset.panel) return openPanel(el.dataset.panel);
      if (el.dataset.method) return act('method', el.dataset.method);
      if (el.dataset.expert) return act('expert', el.dataset.expert);
      if (el.dataset.noteSet) {
        var parts = el.dataset.noteSet.split(':');
        Notes.set(parts[0], parts[1] || null);
        $('expertBox').hidden = true;
        return;
      }
      if (el.dataset.target) return el.dataset.target === 'skip' ? act('vote', 'skip') : pickTarget(el.dataset.target);
    }
    /* Экспертиза заказывается парой «кого» и «по какой примете»: город
       складывается, и один факт становится общим. Спрашиваем в два шага,
       чтобы не строить отдельного окна. */
    /* «Берегу право» — это ход, а не отказ от хода: ночь ждёт от адвоката
       решения, и подать его иначе было бы нечем. Ночь после этого обычно
       закрывается сразу, поэтому кнопки «передумать» здесь нет: она обещала
       бы возможность, которой уже не будет. */
    if (e.target.closest('#btnKeepShield')) return act('shield', '');
    if (e.target.closest('#btnPressReset')) {
      state.pressA = null;
      state.actionsKey = null;
      if (state.game) {
        renderActions(state.game, state.game.you || {}, state.room);
        renderMarks(state.game, state.game.you || {});
        renderFlatSeats(state.game, state.game.you || {});
      }
      return;
    }
    if (e.target.closest('#btnPickList')) return openPanel('table');
    if (e.target.closest('#btnExpert')) return askExpert();
    if (e.target.closest('#btnBestMove')) return askBestMove();
    if (e.target.closest('#btnReady')) return act('ready', null);
    if (e.target.closest('#btnPass')) return act('pass', null);
    if (e.target.closest('#btnRestart')) return call('/api/rooms/restart');
  });

  /* Метку поставили — перекрашиваем ярлыки, не дожидаясь пуша с сервера.
     Полная перерисовка тут не нужна: меняется только цветной ярлык. */
  if (window.Notes) {
    Notes.onChange(function () {
      var g = state.game;
      if (!g) return;
      document.querySelectorAll('[data-note]').forEach(function (el) {
        var chip = el.querySelector('.note-chip');
        if (chip) paintNote(chip, el.dataset.note);
      });
      var b = $('btnNotes');
      if (b) setText(b.querySelector('.n'), Notes.count() ? String(Notes.count()) : '');
    });
  }

  /* Жест для блокнота: правая кнопка на настольном компьютере, долгое
     нажатие на телефоне. Обычное короткое касание оставляем игре — им
     выбирают цель, и перехватывать его нельзя.

     Порог 480 мс подобран по тому же правилу, что у системного «долгого
     нажатия»: короче — и метки будут ставиться случайно при попытке
     выбрать жертву, дольше — и жест перестаёт находиться сам. */
  (function () {
    var timer = null, startedOn = null, moved = 0;

    function target(e) {
      var el = e.target.closest ? e.target.closest('[data-note]') : null;
      return el ? el.dataset.note : null;
    }

    document.addEventListener('contextmenu', function (e) {
      var id = target(e);
      if (!id) return;
      e.preventDefault();
      openNotes(id);
    });

    document.addEventListener('pointerdown', function (e) {
      var id = target(e);
      if (!id) return;
      startedOn = id; moved = 0;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (startedOn === id && moved < 12) {
          startedOn = null;
          openNotes(id);
        }
      }, 480);
    });
    document.addEventListener('pointermove', function (e) {
      if (startedOn) moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
    });
    ['pointerup', 'pointercancel', 'scroll'].forEach(function (ev) {
      document.addEventListener(ev, function () { clearTimeout(timer); startedOn = null; }, true);
    });
  })();

  /* Лучший ход: три имени от убитого первой ночью.

     Почему одним окном, а не тремя нажатиями по столу. Три имени должны
     прозвучать одновременно: если город услышит первое имя раньше двух
     остальных, он начнёт обсуждать его, не дослушав, и весь смысл лучшего
     хода — «вот моя картина целиком» — пропадёт. */
  function askBestMove() {
    var g = state.game;
    if (!g) return;
    var picked = [];
    function draw() {
      var h = '<div class="expert"><h3>Лучший ход</h3>' +
        '<p class="note">Вас убили первой ночью — значит вы видели день, которого ' +
        'остальные ещё не поняли. Назовите трёх, на кого показываете. ' +
        'Все три имени стол увидит сразу, и они останутся в протоколе.</p>' +
        '<div class="grid2">';
      g.players.forEach(function (p) {
        if (!p.alive || p.id === g.you.id) return;
        var on = picked.indexOf(p.id) >= 0;
        h += '<button class="btn sm' + (on ? ' on' : '') + '" data-bm="' + p.id + '">' +
          '№' + p.seat + ' · ' + API.esc(p.name) + '</button>';
      });
      h += '</div><div class="row tight" style="margin-top:var(--s3)">' +
        '<button class="btn primary sm" id="bmSend"' + (picked.length === 3 ? '' : ' disabled') + '>' +
        'Назвать (' + picked.length + ' из 3)</button>' +
        '<button class="btn ghost sm" id="expertClose">Отмена</button></div></div>';
      setHTML($('expertBox'), h);
      $('expertBox').hidden = false;
    }
    $('expertBox').onclick = function (e) {
      var b = e.target.closest('[data-bm]');
      if (b) {
        var id = b.dataset.bm;
        var i = picked.indexOf(id);
        if (i >= 0) picked.splice(i, 1);
        else if (picked.length < 3) picked.push(id);
        return draw();
      }
      if (e.target.closest('#bmSend')) {
        act('bestmove', picked.join(','));
        $('expertBox').hidden = true;
        $('expertBox').onclick = null;
      }
    };
    draw();
  }

  /* Экспертиза: выбираем, кого и по какой примете проверить. Список примет
     — только те, что уже всплывали в уликах: проверять то, о чём улик не
     было, режим не позволяет, и это правило игры, а не ограничение окна. */
  function askExpert() {
    var g = state.game;
    if (!g || !g.inquest) return;
    var iq = g.inquest;
    var alive = g.players.filter(function (p) { return p.alive; });
    var traits = [];
    iq.clues.forEach(function (c) {
      if (!traits.some(function (t) { return t.id === c.traitId; })) {
        traits.push({ id: c.traitId, text: c.text });
      }
    });
    if (!traits.length || !alive.length) return API.toast('Проверять пока нечего', 'bad');

    var h = '<div class="expert"><h3>Экспертиза</h3>' +
      '<p class="note">Один факт в день, и заказать его должен весь стол: ' +
      'нужно ' + iq.expertNeed + ' голоса из ' + alive.length + '. ' +
      'Выберите, кого проверить и по какой примете из улик.</p>' +
      '<div class="grid2">';
    alive.forEach(function (p) {
      traits.forEach(function (t) {
        h += '<button class="btn sm" data-expert="' + p.id + ':' + t.id + '">' +
          API.esc(p.name) + ' · ' + API.esc(t.text) + '</button>';
      });
    });
    h += '</div><button class="btn ghost sm" id="expertClose">Закрыть</button></div>';
    var box = $('expertBox');
    setHTML(box, h);
    box.hidden = false;
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('#expertClose') || e.target.id === 'expertBox') $('expertBox').hidden = true;
    if (e.target.closest('[data-expert]')) $('expertBox').hidden = true;
  });

  /* Быстрая игра: одна кнопка вместо переписки со знакомыми. Сервер сам
     выбирает самый полный открытый стол, а если таких нет — открывает новый. */
  var quickBusy = false;
  $('btnQuick').addEventListener('click', function () {
    if (quickBusy) return;
    var b = this, was = b.textContent;
    quickBusy = true; b.disabled = true; setText(b, 'Ищем стол…');
    API.call('/api/rooms/quick', { size: 8, fill: true })
      .then(function (r) {
        if (r && r.room) renderRoom(r.room);
        API.toast(r && r.joined ? 'Вас посадили за стол — ждём остальных'
          : r && r.filled ? 'Людей на сайте нет — начали с соседями, стол открыт для всех'
            : 'Свободных столов не нашлось — открыли ваш');
      })
      .catch(API.fail)
      .then(function () { quickBusy = false; b.disabled = false; setText(b, was); });
  });

  $('btnRefreshTables').addEventListener('click', function () {
    var b = this; b.disabled = true;
    API.call('/api/lobby').then(function (r) {
      if (r && r.lobby) renderLobby(r.lobby); else if (r) renderLobby(r);
      API.toast('Список обновлён');
    }).catch(API.fail).then(function () { b.disabled = false; });
  });

  $('btnCreate').addEventListener('click', function () {
    /* Режим выбирают до партии: адрес ?mode=inquest приводит человека сразу
       к столу «Следствия» — по такой ссылке зовут в этот режим с главной. */
    var wantInquest = false;
    try { wantInquest = new URLSearchParams(location.search).get('mode') === 'inquest'; } catch (e) { }
    call('/api/rooms/create', {
      size: 8, autoStart: true, visibility: 'public',
      mode: wantInquest ? 'inquest' : 'classic'
    }).then(function (r) {
      if (!r) return;
      renderRoom(r.room);
      API.toast(r.room.mode === 'inquest'
        ? 'Стол «Следствия» открыт — его видно в общем зале'
        : 'Стол открыт — его видно в общем зале');
    });
  });
  if ($('modeInquest')) {
    $('modeInquest').addEventListener('change', function () {
      call('/api/rooms/config', { mode: this.checked ? 'inquest' : 'classic' })
        .then(function (r) { if (r) renderRoom(r.room); });
    });
  }
  $('btnBots').addEventListener('click', function () {
    call('/api/rooms/bots', { on: true }).then(function (r) {
      if (r) { renderRoom(r.room); API.toast('Соседи сели за стол'); }
    });
  });
  $('btnBotsOff').addEventListener('click', function () {
    call('/api/rooms/bots', { on: false }).then(function (r) { if (r) renderRoom(r.room); });
  });
  $('btnLeave').addEventListener('click', function () {
    call('/api/rooms/leave').then(function () { state.room = null; renderRoom(null); });
  });
  $('btnCopy').addEventListener('click', function () {
    var link = inviteUrl(state.room);
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(function () { API.toast('Ссылка скопирована'); })
      .catch(function () { prompt('Скопируйте ссылку:', link); });
  });
  $('btnFriends').addEventListener('click', function () {
    state.friendsOpen = true; $('friendsBox').hidden = false; renderFriends(); $('friendSearch').focus();
  });
  $('btnFriendsClose').addEventListener('click', function () { state.friendsOpen = false; $('friendsBox').hidden = true; });
  $('friendSearch').addEventListener('input', renderFriends);
  $('sizeRange').addEventListener('input', function () { setText($('sizeVal'), this.value); });
  $('sizeRange').addEventListener('change', function () { call('/api/rooms/config', { size: Number(this.value) }); });
  $('autoStart').addEventListener('change', function () { call('/api/rooms/config', { autoStart: this.checked }); });
  if ($('lastWordOn')) {
    $('lastWordOn').addEventListener('change', function () {
      call('/api/rooms/config', { lastWord: this.checked });
    });
  }
  /* Правила стола: три переключателя, каждый из которых меняет игру, а не
     оформление. Подтверждение всплывашкой обязательно — иначе хозяин не
     уверен, доехала ли настройка до сервера. */
  if ($('voteOpenOn')) {
    $('voteOpenOn').addEventListener('change', function () {
      var on = this.checked;
      call('/api/rooms/config', { voteOpen: on })
        .then(function () { API.toast(on ? 'Голосование открытое' : 'Голосование закрытое'); });
    });
  }
  if ($('onTieTable')) {
    $('onTieTable').addEventListener('change', function () {
      call('/api/rooms/config', { onTie: this.checked ? 'table' : 'none' });
    });
  }
  if ($('foulsOn')) {
    $('foulsOn').addEventListener('change', function () {
      call('/api/rooms/config', { fouls: this.checked });
    });
  }
  $('openTable').addEventListener('change', function () {
    var on = this.checked;
    call('/api/rooms/config', { visibility: on ? 'public' : 'invite' })
      .then(function () { API.toast(on ? 'Стол виден в общем зале' : 'Стол теперь только по ссылке'); });
  });
  $('btnStart').addEventListener('click', function () { call('/api/rooms/start'); });

  function sendLobby() {
    var v = $('lobbyMsg').value.trim(); if (!v) return;
    $('lobbyMsg').value = '';
    call('/api/rooms/chat', { text: v });
  }
  $('lobbySend').addEventListener('click', sendLobby);
  $('lobbyMsg').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendLobby(); });

  function sendGame() {
    var v = $('gMsg').value.trim(); if (!v) return;
    $('gMsg').value = '';
    call('/api/rooms/chat', { text: v, channel: state.tab });
    markSpeaking(API.user.id, 1800);
  }
  $('gSend').addEventListener('click', sendGame);
  $('gMsg').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendGame(); });

  /* =======================================================================
     вид сцены: выгородка в глубину или писаный задник
     ======================================================================= */
  function paintViewBtn() {
    var btn = $('btnView');
    if (!btn) return;
    var flat = ViewMode.isFlat();
    /* На кнопке написан тот вид, который она включит: стоишь в 2D — читаешь
       «3D». Подсказка говорит то же словами. Никаких театральных названий:
       «2D» и «3D» понимает любой игрок без объяснений. */
    setHTML(btn, ico(ViewMode.icon(ViewMode.next()), 18) +
      '<b class="vlabel">' + ViewMode.short() + '</b>');
    btn.className = 'iconbtn viewbtn';
    btn.title = ViewMode.action();
    btn.setAttribute('aria-label', ViewMode.action());
    btn.setAttribute('aria-pressed', ViewMode.isDeep() ? 'true' : 'false');
    btn.disabled = ViewMode.locked();
    btn.hidden = false;
  }

  if ($('btnView')) {
    $('btnView').addEventListener('click', function () {
      if (ViewMode.locked()) return API.toast(ViewMode.action(), 'bad');
      var mode = ViewMode.toggle();
      API.toast(mode === ViewMode.FLAT ? '2D-вид: плоский стол' : '3D-вид: объёмная сцена');
    });
  }
  ViewMode.onChange(function () {
    paintViewBtn();
    if (!$('gameView').hidden || state.game) remountScene();
  });

  /* =======================================================================
     голос: микрофон и озвучка
     ======================================================================= */
  /* Кто вас сейчас слышит. Голос подчиняется фазам, и кнопка обязана это
     показывать: ночью мирный молчит, мафия говорит своим, выбывший — своим.
     Иначе человек говорит в пустоту либо, что хуже, думает, что говорит
     своим, а его слышит весь стол. */
  function voiceState() {
    var you = state.game && state.game.you;
    if (!you || !you.voice) return { channel: 'town', peers: [], why: '' };
    return you.voice;
  }

  var VOICE_RU = { town: 'Слышит весь стол', mafia: 'Слышат только свои', ghost: 'Слышат только выбывшие' };

  function paintMic() {
    var v = voiceState();
    var open = !!v.channel;
    /* Канал может быть открыт, а микрофон закрыт: так устроен круг речей —
       слушать можно всем, говорить только тому, у кого слово. */
    var canTalk = open && !v.mute;
    var on = state.micOn && canTalk;
    /* Иконка меняется, подпись остаётся: setHTML вычистил бы её вместе со
       старым знаком, и кнопка снова стала бы немой. */
    setHTML($('btnMic'), ico(on ? 'mic' : 'micoff', 20) + '<span class="lbl">Микрофон</span>');
    $('btnMic').style.color = on
      ? (v.channel === 'mafia' ? 'var(--ember)' : v.channel === 'ghost' ? 'var(--bruise)' : 'var(--verdigris)')
      : '';
    $('btnMic').title = !open ? (v.why || 'Сейчас говорить нельзя')
      : v.mute ? (state.micOn
        ? 'Микрофон включён и ждёт вашей очереди · ' + (v.why || '')
        : (v.why || 'Слово сейчас не у вас'))
        : (state.micOn ? 'Микрофон включён · ' + (VOICE_RU[v.channel] || '') : 'Включить микрофон');
    $('btnMic').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* Привести голосовые соединения к тому кругу, который разрешил сервер.
     Вызывается на каждом обновлении партии: смена фазы рвёт лишние линии. */
  function syncVoice() {
    var v = voiceState();
    /* Кнопку красим всегда, даже если микрофоном ещё не пользовались: игрок
       должен видеть, слышат ли его, до того как включит звук. */
    paintMic();
    if (!state.rtc) return;
    /* Глушим и когда канала нет вовсе, и когда слово у другого: иначе игрок,
       включивший микрофон в общем обсуждении, продолжал бы говорить в круге
       поверх того, чья сейчас очередь. */
    state.rtc.setMuted(!v.channel || !!v.mute);
    state.rtc.reconcile(v.peers || []);
  }
  function paintTts() {
    setHTML($('btnTts'), ico(Voice.enabled ? 'sound' : 'mute', 20) +
      '<span class="lbl">' + (Voice.enabled ? 'Озвучка' : 'Без звука') + '</span>');
    $('btnTts').style.color = Voice.enabled ? 'var(--tallow)' : '';
    $('btnTts').title = Voice.enabled ? 'Реплики читаются вслух' : 'Читать реплики вслух';
    $('btnTts').setAttribute('aria-pressed', Voice.enabled ? 'true' : 'false');
  }

  /* Сервера ICE площадки спрашиваем один раз: без них голос через интернет
     не соединится, а в локальной сети список пуст и ничего не меняет. */
  var iceAsked = false;
  function ensureIce() {
    if (iceAsked) return Promise.resolve();
    iceAsked = true;
    return API.call('/api/ice').then(function (r) {
      if (r && r.iceServers && r.iceServers.length && state.rtc) state.rtc.useIce(r.iceServers);
    }).catch(function () { /* нет ответа — остаёмся на прямых адресах */ });
  }

  function ensureRtc() {
    if (state.rtc) return state.rtc;
    state.rtc = createVoiceChat({
      selfId: API.user.id,
      getPeers: function () {
        /* В партии круг собеседников определяет сервер по фазе и по тому, жив
           ли игрок. До начала партии в комнате говорят все — это сбор за
           столом, а не игра. */
        var v = voiceState();
        if (state.game) return v.peers || [];
        return state.room ? state.room.members.map(function (m) { return m.id; }) : [];
      },
      signal: function (to, kind, data) {
        return API.call('/api/rooms/signal', { to: to, kind: kind, data: data }).catch(function () { });
      },
      onLevel: function (id, lvl) {
        state.levels.set(id, lvl);
        var el = state.marks.get(id);
        if (el) el.querySelector('.lvl').style.setProperty('--lvl', Math.min(1, lvl).toFixed(3));
        if (lvl > 0.14) markSpeaking(id, 700);
      },
      onError: function (e) { API.toast('Голос: ' + (e && e.message ? e.message : 'сбой соединения'), 'bad'); }
    });
    return state.rtc;
  }

  async function toggleMic(want) {
    var on = want === undefined ? !state.micOn : !!want;
    var v = voiceState();
    if (on && !v.channel) {
      API.toast(v.why || 'Сейчас говорить нельзя', 'bad');
      return;
    }
    try {
      if (on) {
        ensureRtc();
        await ensureIce();
        await state.rtc.start();
        API.toast('Микрофон включён · ' + (VOICE_RU[v.channel] || 'вас слышат за столом'));
      }
      else if (state.rtc) { state.rtc.stop(); }
      state.micOn = on;
    } catch (e) {
      state.micOn = false;
      API.toast('Микрофон недоступен: ' + (e && e.message ? e.message : 'нет разрешения'), 'bad');
    }
    paintMic();
    API.call('/api/rooms/voice', { on: state.micOn }).catch(function () { });
  }

  $('btnMic').addEventListener('click', function () { toggleMic(); });
  $('btnTts').addEventListener('click', function () {
    if (!Voice.available()) return API.toast('Этот браузер не умеет читать текст вслух', 'bad');
    Voice.setEnabled(!Voice.enabled);
    paintTts();
    if (Voice.enabled) Voice.say('Голос включён. Я буду читать реплики за столом.', { narrator: true, urgent: true });
  });

  /* Рот на сцене открывается и от синтезатора, и от живого микрофона. */
  Voice.onSpeak(function (id) { if (id) markSpeaking(id, 1200); });

  function markSpeaking(id, ms) {
    state.speaker = id;
    state.speakerUntil = performance.now() + (ms || 1200);
    if (stg()) stg().setSpeaker(id);
    var el = state.marks.get(id);
    if (el) el.classList.add('talking');
  }

  /* =======================================================================
     панели на телефоне
     ======================================================================= */
  function openPanel(which) {
    state.panel = which;
    setCls($('chatDock'), 'open', which === 'chat');
    setCls($('rolePane'), 'open', which === 'role');
    setCls($('logSheet'), 'open', which === 'log');
    /* Плоский стол: на телефоне это панель выбора, а без WebGL — основной вид. */
    if (!state.stageBroken) $('flatWrap').hidden = which !== 'table';
    /* Пока поверх сцены открыта шторка, жетоны мест убираем: иначе номера
       просвечивают сквозь чат и накладываются на реплики. На большом экране
       чат стоит рядом со сценой, и прятать ничего не нужно. */
    var narrow = window.matchMedia('(max-width:900px)').matches;
    $('marks').hidden = narrow ? which !== 'stage' : which === 'table';
    if (which === 'chat') { state.unread = 0; $('gFeed').scrollTop = $('gFeed').scrollHeight; }
    paintTabs();
    /* Кнопка «Выбрать в списке» нужна только пока список закрыт — значит при
       смене панели док надо пересобрать, не дожидаясь сообщения от сервера. */
    if (state.game && state.room && state.room.started) {
      renderActions(state.game, state.game.you || {}, state.room);
    }
  }
  /* Кнопка чата в шапке. Знак ей никто не рисовал: в разметке лежит только
     подпись «Чат», а на телефоне подписи у кнопок-знаков спрятаны — и всю
     партию в шапке висел пустой квадрат 44×44, в который никто не жал.
     Заодно кнопка показывает состояние: открыта шторка чата или нет —
     непрочитанные считает панель вкладок, дублировать счётчик незачем. */
  function paintChatBtn() {
    var b = $('btnChat');
    if (!b) return;
    var open = state.panel === 'chat';
    setHTML(b, ico('chat', 20) + '<span class="lbl">Чат</span>');
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
    b.title = open ? 'Закрыть чат стола' : 'Открыть чат стола';
  }

  function paintTabs() {
    paintChatBtn();
    [['tabStage', 'mask', 'Сцена', 'stage'], ['tabTable', 'people', 'Стол', 'table'],
     ['tabRole', 'scroll', 'Роль', 'role'],
     ['tabChat', 'chat', 'Чат', 'chat'], ['tabLog', 'hourglass', 'Протокол', 'log']]
      .forEach(function (t) {
        var el = $(t[0]);
        if (!el) return;
        setHTML(el, ico(t[1], 20) + '<span>' + t[2] + '</span>' +
          (t[3] === 'chat' && state.unread ? '<span class="badge">' + state.unread + '</span>' : ''));
        setCls(el, 'on', state.panel === t[3]);
      });
  }
  $('btnChat').addEventListener('click', function () { openPanel(state.panel === 'chat' ? 'stage' : 'chat'); });

  /* Вход на месте: имя, гость и Enter в поле. */
  if ($('authGo')) {
    $('authGo').addEventListener('click', function () { claimName($('authName').value, this); });
  }
  if ($('authName')) {
    $('authName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') claimName(this.value, $('authGo'));
    });
  }
  if ($('authGuest')) {
    $('authGuest').addEventListener('click', function () {
      /* Терять из-за одного поля того, кто пришёл по ссылке, нельзя: имя
         придумываем сами, переименоваться он сможет с главной. */
      claimName('Гость ' + (10 + Math.floor(Math.random() * 89)), this);
    });
  }
  $('btnChatClose').addEventListener('click', function () { openPanel('stage'); });
  $('logGrip').addEventListener('click', function () { $('logSheet').classList.toggle('open'); });
  setHTML($('btnChatClose'), ico('close', 18));
  setHTML($('logIcon'), ico('scroll', 16));

  /* =======================================================================
     кадр: таймер, подписи, гашение говорящего
     ======================================================================= */
  var lastSec = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    placeMarks();
    if (state.speaker && now > state.speakerUntil) {
      var el = state.marks.get(state.speaker);
      if (el) el.classList.remove('talking');
      state.speaker = null;
      if (stg()) stg().setSpeaker(null);
    }
    /* таймер тикает локально между пушами — цифры не «прыгают» */
    if (now - lastSec >= 1000) {
      lastSec = now;
      var g = state.game;
      if (g && !g.finished && state.room && state.room.started) {
        g.secondsLeft = Math.max(0, g.secondsLeft - 1);
        paintTimer(g.secondsLeft, g.phaseSeconds);
      }
    }
  }
  requestAnimationFrame(frame);

  /* =======================================================================
     СТАРТ
     ======================================================================= */
  var curtain = Curtain.show({ title: 'Мафия', note: 'Собираем стол' });
  curtain.progress(0.2);

  paintMic(); paintTts(); paintTabs(); paintViewBtn();

  /* Высота шапки едет в CSS: экран партии стоит фиксированно и начинается
     ровно под ней. Мерилось это один раз при загрузке — и стоило повернуть
     телефон, как шапка из двух строк становилась одной, а между ней и сценой
     оставалась мёртвая чёрная полоса на пятьдесят пикселей. Меряем на каждое
     изменение размеров самой шапки. */
  function syncBarH() {
    document.documentElement.style.setProperty('--barH', ($('topbar').offsetHeight || 58) + 'px');
  }
  syncBarH();
  if (window.ResizeObserver) new ResizeObserver(syncBarH).observe($('topbar'));
  else window.addEventListener('resize', syncBarH);

  /* Поворот телефона меняет ширину, а от ширины зависит и вид подписей
     (табличка или жетон), и подсказка «куда нажимать», и нужна ли кнопка
     «Выбрать в списке». Раньше пересчёт случался только со следующим
     сообщением от сервера, и до него игрок держал в руках интерфейс от
     прошлой ориентации. Ждать сообщения незачем: перерисовка стоит копейки.
     Считаем один раз после того, как поворот закончился, — иначе за один
     жест сюда прилетает несколько десятков событий. */
  var reflowWait = 0;
  window.addEventListener('resize', function () {
    clearTimeout(reflowWait);
    reflowWait = setTimeout(function () {
      var g = state.game;
      if (!g || !state.room || !state.room.started) return;
      var you = g.you || {};
      state.actionsKey = null;
      renderMarks(g, you);
      renderActions(g, you, state.room);
      setText($('gHint'), hintFor(g, you));
    }, 160);
  }, { passive: true });
  /* Шрифты приезжают после первого кадра и меняют высоту строки. */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncBarH);

  API.load();
  if (!API.user) {
    showAuthGate();
    curtain.close();
    return;
  }
  setText($('whoName'), API.user.name);
  curtain.progress(0.4);

  API.call('/api/me').then(function (r) {
    API.save(r.user);
    setText($('whoName'), r.user.name);
    renderLobby(r.lobby);
    curtain.progress(0.7);
    curtain.note('Ищем ваш стол');

    var q = new URLSearchParams(location.search);
    var token = q.get('join');
    if (token) {
      return API.call('/api/rooms/join', { invite: token }).then(function (x) { renderRoom(x.room); });
    }
    var wanted = q.get('room');
    if (wanted) return API.call('/api/rooms/join', { roomId: wanted }).then(function (x) { renderRoom(x.room); });

    /* Воронка с главной приходит сюда адресом, а не пересказом. Три пути, и
       каждый должен сработать без единого лишнего нажатия — в этом вся идея
       «одна страница, одно очевидное действие».

         ?solo    — вечер с соседями: закрытый стол, боты уже сидят;
                    ?solo=setup оставляет выбор состава и сюжета за игроком;
         ?quick   — быстрая игра: подберём стол, а если людей нет — начнём с
                    соседями, но стол оставим объявленным;
         ?create  — своя комната со ссылкой для друзей. */
    var solo = q.get('solo');
    if (solo) {
      curtain.note('Соседи занимают места');
      return API.call('/api/rooms/solo', {
        size: Math.max(6, Math.min(20, Number(q.get('size')) || 8)),
        rolePreset: q.get('preset') || 'classic',
        mode: q.get('mode') === 'inquest' ? 'inquest' : 'classic',
        speed: q.get('speed') || undefined,
        start: solo !== 'setup'
      }).then(function (x) { renderRoom(x.room); });
    }
    if (q.get('quick')) {
      curtain.note('Ищем стол');
      return API.call('/api/rooms/quick', { size: 8, fill: true })
        .then(function (x) { renderRoom(x.room); });
    }
    if (q.get('create')) {
      curtain.note('Открываем комнату');
      return API.call('/api/rooms/create', {
        size: 8, autoStart: true, visibility: 'public',
        mode: q.get('mode') === 'inquest' ? 'inquest' : 'classic'
      }).then(function (x) { renderRoom(x.room); });
    }
    return API.call('/api/rooms/state').then(function (x) { renderRoom(x.room); })
      .catch(function () { renderRoom(null); });
  }).catch(function (e) {
    /* Раньше здесь любая ошибка отрисовки трактовалась как «нет аккаунта»:
       сессия стиралась, SSE не подключался, и партия замирала на экране
       регистрации. Теперь выход из аккаунта только по 401. */
    if (e && e.status === 401) { API.clear(); showAuthGate(); return; }
    console.error('Не удалось показать стол:', e);
    API.toast('Сбой отрисовки: ' + ((e && e.message) || 'неизвестно'), 'bad');
  }).then(function () {
    curtain.progress(1);
    curtain.close();
    API.events({
      lobby: renderLobby,
      room: function (room) {
        /* Ушедших из комнаты отключаем от голоса, иначе висит мёртвый peer. */
        if (state.rtc && state.room) {
          var now = {};
          room.members.forEach(function (m) { now[m.id] = true; });
          state.room.members.forEach(function (m) { if (!now[m.id]) state.rtc.forget(m.id); });
        }
        renderRoom(room);
      },
      signal: function (pkt) { if (state.rtc) state.rtc.handleSignal(pkt); },
      /* Сверка часов. Полное состояние стола сервер присылает только когда за
         столом что-то произошло; секунды приходят отдельным коротким событием,
         и его достаточно, чтобы отсчёт не расходился. */
      tick: function (t) {
        if (!t || !state.game || !state.room || t.roomId !== state.room.id) return;
        state.game.secondsLeft = t.secondsLeft;
        state.game.phaseSeconds = t.phaseSeconds;
        paintTimer(t.secondsLeft, t.phaseSeconds);
      }
    });
    $('netDot').classList.remove('off');
  });

  window.addEventListener('beforeunload', function () {
    if (state.rtc && state.rtc.running) state.rtc.stop();
  });
})();
