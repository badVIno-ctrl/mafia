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

  var PHASE_RU = {
    prologue: 'Пролог', night: 'Ночь', morning: 'Утро',
    day: 'День — обсуждение', vote: 'Голосование', runoff: 'Переголосовка', over: 'Занавес'
  };
  var CH_RU = { town: 'Город', mafia: 'Мафия', ghost: 'За чертой' };
  var ACT_RU = {
    kill: 'Выберите жертву', heal: 'Кого спасаете этой ночью',
    check: 'Кого проверяете', vote: 'За кого голосуете'
  };
  /* Что ведущий говорит вслух при смене фазы. */
  var NARRATE = {
    night: 'Город засыпает.',
    morning: 'Город просыпается.',
    day: 'День. Слово столу.',
    vote: 'Голосуем.',
    runoff: 'Переголосовка.',
    over: 'Занавес.'
  };

  var state = {
    lobby: null, room: null, game: null,
    tab: 'town', friendsOpen: false,
    lastPhase: null, lastMentionTs: null,
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
     ЛОББИ
     ======================================================================= */
  function renderLobby(lobby) {
    state.lobby = lobby;
    var items = []
      .concat((lobby.invites || []).map(function (i) { return { kind: 'invite', i: i }; }))
      .concat((lobby.rooms || []).filter(function (r) { return !r.mine; }).map(function (r) { return { kind: 'room', r: r }; }));

    var box = $('roomList');
    if (!items.length) {
      setHTML(box, '<div class="empty">Открытых столов пока нет. Соберите свой и позовите людей — они появятся в списке.</div>');
      return;
    }
    box._html = null;
    syncKeyed(box, items,
      function (it) { return it.kind + ':' + (it.i ? it.i.roomId : it.r.id); },
      function () { var d = document.createElement('div'); d.className = 'item'; return d; },
      function (el, it) {
        if (it.kind === 'invite') {
          el.style.borderColor = 'rgba(226,180,120,.45)';
          setHTML(el, '<span class="avatar">' + ico('envelope', 18) + '</span>' +
            '<span class="nm">' + API.esc(it.i.from) + ' зовёт в «' + API.esc(it.i.title) + '» ' +
            '<span class="muted">' + it.i.players + '/' + it.i.size + '</span></span>' +
            '<button class="btn primary sm" data-join="' + it.i.roomId + '">Принять</button>');
        } else {
          setHTML(el, '<span class="avatar">' + API.esc(API.initial(it.r.hostName)) + '</span>' +
            '<span class="nm">' + API.esc(it.r.title) + ' <span class="muted">· ' + API.esc(it.r.scenario) +
            ' · ' + it.r.players + '/' + it.r.size + '</span></span>' +
            (it.r.started ? '<span class="pill bad">идёт партия</span>'
              : '<button class="btn sm" data-join="' + it.r.id + '">Сесть</button>'));
        }
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
      setHTML(box, '<div class="empty">Никого не нашлось. Пришлите друзьям ссылку — они назовутся и появятся здесь.</div>');
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
    state.room = room;
    if (room && room.started) { show('game'); renderGame(room.game); return; }
    var st = stg();
    if (st) { st.dispose(); state.marks.clear(); }
    if (st || !state.stage) { state.stage = null; state.seatsKey = ''; }
    if (state.rtc && state.rtc.running) toggleMic(false);

    show('lobby');
    $('noRoom').hidden = !!room;
    $('roomPane').hidden = !room;
    if (!room) { if (state.lobby) renderLobby(state.lobby); return; }

    var isHost = room.hostId === API.user.id;
    setHTML($('lobbyTitle'), API.esc(room.title) + '<em>хозяин — ' + API.esc(room.hostName) + '</em>');
    setText($('roomCode'), room.code);
    setText($('cntNow'), room.members.length + ' из ' + room.size);
    setText($('cntGoal'), room.autoStart ? (room.size + ' игроках — сами') : 'ручном старте');
    setText($('compo'), room.compositionLabel);

    $('hostBox').hidden = !isHost;
    if (isHost) {
      if (document.activeElement !== $('sizeRange')) $('sizeRange').value = room.size;
      setText($('sizeVal'), String(room.size));
      $('autoStart').checked = room.autoStart;
      $('btnStart').disabled = !room.canStart;
      setText($('btnStart'), room.canStart ? 'Начать партию (' + room.members.length + ')' : 'Нужно хотя бы шесть человек');
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
    }
    state.lastPhase = g.phase;

    setHTML($('phaseIcon'), ico(Icons.phase(g.phase), 22));
    setText($('gPhase'), PHASE_RU[g.phase] + (g.day ? ' · день ' + g.day : ''));
    setText($('gScenario'), g.scenario.title + ' · ' + g.scenario.place);
    setText($('gAlive'), 'в игре ' + g.aliveCount + ' из ' + g.players.length);
    paintTimer(g.secondsLeft, g.phaseSeconds);
    setText($('gHint'), hintFor(g, you));

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

    if (stg()) {
      stg().sync({
        phase: g.phase,
        players: g.players,
        targets: g.players.filter(function (p) { return canTarget(g, you, p); }).map(function (p) { return p.id; })
      });
    }
  }

  /* ---------------------------- сцена ---------------------------- */
  function ensureStage(g, key) {
    if (state.stageBroken) { state.seatsKey = key; return; }
    if (stg() && state.seatsKey === key) return;

    if (!state.stage) {
      state.stage = 'loading';
      import('/js/stage3d.js').then(function (mod) {
        return mod.mountStage($('stage'), {
          onPick: function (id) { pickTarget(id); }
        });
      }).then(function (stage) {
        state.stage = stage;
        state.seatsKey = '';
        if (state.game) renderGame(state.game);
      }).catch(function (e) {
        state.stage = null;
        state.stageBroken = true;
        $('flatWrap').hidden = false;
        $('flatWrap').classList.add('plain');
        console.warn('3D-сцена недоступна:', e && e.message);
        API.toast('Сцена не поднялась — играем на плоском столе');
      });
      return;
    }
    if (!stg()) return;

    state.seatsKey = key;
    state.stage.setSeats(g.players.map(function (p) {
      return { id: p.id, name: p.name, seat: p.seat, you: g.you && p.id === g.you.id };
    }));
    state.marks.clear();
    $('marks').innerHTML = '';
  }

  /* Подписи мест: создаются один раз, дальше только правятся и двигаются. */
  function renderMarks(g, you) {
    if (!stg()) return;
    var box = $('marks');
    /* Жетон вместо таблички: только номер места. Иначе на телефоне двадцать
       подписей перекрывают друг друга и не читается ни одна. */
    var chip = g.players.length > 14 || window.innerWidth < 620;
    setCls(box, 'chips', chip);
    syncKeyed(box, g.players, function (p) { return p.id; },
      function () {
        var d = document.createElement('button');
        d.className = 'mark';
        d.innerHTML = '<span class="seatno"></span><span class="nm"></span><span class="sub"></span><span class="lvl"></span>';
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
          ((p.role === 'mafia' || p.role === 'don') ? ' mafia' : '') +
          (state.speaker === p.id ? ' talking' : '');
        el.dataset.target = pickable ? p.id : '';
        el.disabled = !pickable;
        setText(el.querySelector('.seatno'), String(p.seat));
        setText(el.querySelector('.nm'), p.name + (p.id === you.id ? ' · вы' : ''));
        setText(el.querySelector('.sub'), subFor(g, p));
        var lvl = state.levels.get(p.id) || 0;
        el.querySelector('.lvl').style.width = Math.round(Math.min(1, lvl) * 100) + '%';
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
    var W = box.clientWidth, H = box.clientHeight;
    state.marks.forEach(function (el, id) {
      /* Своя подпись поднята выше: камера стоит почти за спиной игрока,
         и на уровне головы табличка легла бы прямо на сукно. */
      var mine = state.game && state.game.you && state.game.you.id === id;
      var p = st.project(id, mine ? 2.5 : 2.05);
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
    if (p.offline) return 'нет связи';
    if (p.role) return p.roleRu;
    if ((g.phase === 'vote' || g.phase === 'runoff') && p.voted) return 'голос подан';
    if (g.phase === 'day' && p.ready) return 'готов голосовать';
    return 'за столом';
  }

  function isPicked(you, p) {
    var act = you.canAct;
    return (act === 'kill' && you.myKill === p.id) || (act === 'heal' && you.myHeal === p.id) ||
      (act === 'check' && you.myCheck === p.id) || (act === 'vote' && you.myVote === p.id);
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
        b.innerHTML = '<span class="no"></span><span class="avatar"></span><span class="nm"></span><span class="sub"></span>';
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
      });
  }

  /* ---------------------------- карта роли ---------------------------- */
  function renderRole(g, you) {
    var key = JSON.stringify([you.role, you.alive, (you.partners || []).length, (you.checks || []).length]);
    if (state.roleKey === key) return;
    state.roleKey = key;
    var h = '<div class="role">' + ico(Icons.role(you.role), 22) +
      '<h3>' + API.esc(you.roleRu || 'Наблюдатель') + '</h3></div>' +
      '<p>' + API.esc(you.roleDesc || 'Вы смотрите со стороны.') + '</p>';
    if (you.partners && you.partners.length) {
      h += '<div class="known">Свои: ' + you.partners.map(function (p) {
        return '<b>' + API.esc(p.name) + '</b> (№' + p.seat + (p.alive ? '' : ', выбыл') + ')';
      }).join(', ') + '</div>';
    }
    if (you.checks && you.checks.length) {
      h += '<div class="known">Проверки: ' + you.checks.map(function (c) {
        return API.esc(c.name) + ' — <b style="color:' + (c.isMafia ? 'var(--ember-soft)' : 'var(--verdigris)') + '">' +
          (c.isMafia ? 'чёрный' : 'мирный') + '</b>';
      }).join('; ') + '</div>';
    }
    if (you.alive === false && !g.finished) h += '<div class="known muted">Вы выбыли, но видите всё.</div>';
    setHTML($('rolePane'), h);
  }

  /* ---------------------------- кнопки действий ---------------------------- */
  function renderActions(g, you, room) {
    var act = you.canAct;
    var key = [g.finished, act, you.ready, you.myVote, you.healBlocked, you.alive].join('|');
    if (state.actionsKey === key) return;
    state.actionsKey = key;

    var a = '';
    if (g.finished) {
      if (room && room.hostId === API.user.id) a += '<button class="btn primary sm" id="btnRestart">Собрать новую партию</button>';
      a += '<a class="btn ghost sm" href="/">На главную</a>';
    } else if (act === 'vote') {
      a = '<button class="btn sm" data-target="skip">Воздержаться</button>';
    } else if (act === 'talk') {
      a = '<button class="btn sm ' + (you.ready ? 'on' : '') + '" id="btnReady">' +
        (you.ready ? 'Готов' : 'Я высказался') + '</button>';
    }
    setHTML($('actions'), a);
  }

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
      setHTML(feed, '<div class="empty">Пока тишина. Начните разговор — к вам прислушаются.</div>');
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
            '<button class="iconbtn say" data-say="' + m.ts + ':' + m.from + '" aria-label="Прочитать вслух" ' +
            'style="width:24px;height:24px">' + ico('sound', 14) + '</button>');
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

    var canSay = (state.tab === 'town' && you.alive && ['prologue', 'day', 'vote', 'runoff', 'morning', 'over'].indexOf(g.phase) >= 0) ||
      (state.tab === 'mafia' && g.phase === 'night' && you.alive) ||
      (state.tab === 'ghost' && you.alive === false);
    $('gMsg').disabled = !canSay;
    $('gSend').disabled = !canSay;
    $('gMsg').placeholder = canSay
      ? 'Назовите имя — человек увидит, что вы к нему'
      : (state.tab === 'town'
        ? (g.phase === 'night' ? 'Город спит — слово вернётся утром' : 'Сейчас говорить нельзя')
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

  /* ---------------------------- финал ---------------------------- */
  function renderFinale(g) {
    if (!g.finished) { $('finale').hidden = true; return; }
    $('finale').hidden = false;
    var key = 'fin' + g.winner + g.players.length;
    if ($('finale')._k === key) return;
    $('finale')._k = key;
    $('finale').innerHTML =
      '<div class="box">' +
      '<span class="label">Занавес</span>' +
      '<div class="win ' + g.winner + '">' + (g.winner === 'town' ? 'Победил город' : 'Победила мафия') + '</div>' +
      '<p class="lede" style="margin:var(--s4) auto var(--s5)">' +
      API.esc(g.winner === 'town' ? (g.scenario.finaleTown || 'Город вычистил себя сам.')
        : (g.scenario.finaleMafia || 'Тишина осталась за чёрными.')) + '</p>' +
      '<div class="seats">' + g.players.map(function (p) {
        return '<div class="seat ' + (p.alive ? '' : 'dead') + '">' +
          '<span class="no">№' + p.seat + '</span>' +
          '<span class="avatar' + (p.alive ? '' : ' dead') + '">' + API.esc(API.initial(p.name)) + '</span>' +
          '<span class="nm">' + API.esc(p.name) + '</span>' +
          '<span class="sub">' + API.esc(p.roleRu || '') + '</span></div>';
      }).join('') + '</div></div>';
    Voice.say('Занавес. ' + (g.winner === 'town' ? 'Победил город.' : 'Победила мафия.'), { narrator: true, urgent: true });
  }

  /* =======================================================================
     подсказки и правила выбора
     ======================================================================= */
  function hintFor(g, you) {
    if (g.finished) return 'Партия окончена — роли раскрыты.';
    if (g.phase === 'prologue') return g.scenario.prologue;
    if (g.phase === 'night') return 'Город засыпает. ' + (you.canAct ? ACT_RU[you.canAct] + '.' : 'Ждите утра.');
    if (g.phase === 'morning') return 'Утро. Город считает потери.';
    if (g.phase === 'day') return 'День: спорьте, оправдывайтесь, сопоставляйте. ' + g.scenario.rule;
    if (g.phase === 'vote') return 'Голосование: выберите того, кого город выводит.';
    if (g.phase === 'runoff') return 'Переголосовка между лидерами — при новой ничьей не выйдет никто.';
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
    return false;
  }

  function paintTimer(left, total) {
    var t = $('gTimer');
    setText(t, API.mmss(left));
    setCls(t, 'warn', left <= 10);
    $('gBar').style.width = total ? Math.max(0, Math.min(100, left / total * 100)) + '%' : '0%';
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
    act(g.you.canAct, id);
    if (stg()) stg().shake(0.03);
    /* Выбрали в списке — показываем результат на сцене. */
    if (state.panel === 'table' && !state.stageBroken) openPanel('stage');
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-join],[data-invite],[data-kick],[data-scen],[data-target],[data-tab],[data-say],[data-panel]');
    if (el) {
      if (el.dataset.join) return call('/api/rooms/join', { roomId: el.dataset.join });
      if (el.dataset.invite) return call('/api/rooms/invite', { userId: el.dataset.invite })
        .then(function () { API.toast('Приглашение отправлено'); });
      if (el.dataset.kick) return call('/api/rooms/kick', { userId: el.dataset.kick });
      if (el.dataset.scen) return call('/api/rooms/config', { scenarioId: el.dataset.scen });
      if (el.dataset.tab) { state.tab = el.dataset.tab; if (state.game) renderChat(state.game, state.game.you || {}); return; }
      if (el.dataset.say) {
        var box = el.closest('.msg');
        if (box && box._msg) Voice.say(box._msg.text, { from: box._msg.from, urgent: true });
        return;
      }
      if (el.dataset.panel) return openPanel(el.dataset.panel);
      if (el.dataset.target) return el.dataset.target === 'skip' ? act('vote', 'skip') : pickTarget(el.dataset.target);
    }
    if (e.target.closest('#btnReady')) return act('ready', null);
    if (e.target.closest('#btnRestart')) return call('/api/rooms/restart');
  });

  $('btnCreate').addEventListener('click', function () {
    call('/api/rooms/create', { size: 8, autoStart: true }).then(function (r) { if (r) renderRoom(r.room); });
  });
  $('btnJoinCode').addEventListener('click', function () {
    var code = $('joinCode').value.trim();
    if (!code) return API.toast('Введите код стола', 'bad');
    call('/api/rooms/join', { code: code }).then(function (r) { if (r) renderRoom(r.room); });
  });
  $('btnLeave').addEventListener('click', function () {
    call('/api/rooms/leave').then(function () { state.room = null; renderRoom(null); });
  });
  $('btnCopy').addEventListener('click', function () {
    var link = location.origin + '/online.html?room=' + state.room.id;
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
     голос: микрофон и озвучка
     ======================================================================= */
  function paintMic() {
    setHTML($('btnMic'), ico(state.micOn ? 'mic' : 'micoff', 20));
    $('btnMic').style.color = state.micOn ? 'var(--verdigris)' : '';
    $('btnMic').title = state.micOn ? 'Микрофон включён' : 'Включить микрофон';
  }
  function paintTts() {
    setHTML($('btnTts'), ico(Voice.enabled ? 'sound' : 'mute', 20));
    $('btnTts').style.color = Voice.enabled ? 'var(--tallow)' : '';
    $('btnTts').title = Voice.enabled ? 'Реплики читаются вслух' : 'Читать реплики вслух';
  }

  function ensureRtc() {
    if (state.rtc) return state.rtc;
    state.rtc = createVoiceChat({
      selfId: API.user.id,
      getPeers: function () {
        return state.room ? state.room.members.map(function (m) { return m.id; }) : [];
      },
      signal: function (to, kind, data) {
        return API.call('/api/rooms/signal', { to: to, kind: kind, data: data }).catch(function () { });
      },
      onLevel: function (id, lvl) {
        state.levels.set(id, lvl);
        var el = state.marks.get(id);
        if (el) el.querySelector('.lvl').style.width = Math.round(Math.min(1, lvl) * 100) + '%';
        if (lvl > 0.14) markSpeaking(id, 700);
      },
      onError: function (e) { API.toast('Голос: ' + (e && e.message ? e.message : 'сбой соединения'), 'bad'); }
    });
    return state.rtc;
  }

  async function toggleMic(want) {
    var on = want === undefined ? !state.micOn : !!want;
    try {
      if (on) { await ensureRtc().start(); API.toast('Микрофон включён — вас слышат за столом'); }
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
  }
  function paintTabs() {
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

  paintMic(); paintTts(); paintTabs();
  document.documentElement.style.setProperty('--barH', ($('topbar').offsetHeight || 58) + 'px');

  API.load();
  if (!API.user) {
    show('auth');
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

    var wanted = new URLSearchParams(location.search).get('room');
    if (wanted) return API.call('/api/rooms/join', { roomId: wanted }).then(function (x) { renderRoom(x.room); });
    return API.call('/api/rooms/state').then(function (x) { renderRoom(x.room); })
      .catch(function () { renderRoom(null); });
  }).catch(function (e) {
    /* Раньше здесь любая ошибка отрисовки трактовалась как «нет аккаунта»:
       сессия стиралась, SSE не подключался, и партия замирала на экране
       регистрации. Теперь выход из аккаунта только по 401. */
    if (e && e.status === 401) { API.clear(); show('auth'); return; }
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
      signal: function (pkt) { if (state.rtc) state.rtc.handleSignal(pkt); }
    });
    $('netDot').classList.remove('off');
  });

  window.addEventListener('beforeunload', function () {
    if (state.rtc && state.rtc.running) state.rtc.stop();
  });
})();
