/* =========================================================================
   Клиент сетевой игры: лобби (комната, друзья, сюжет) и игровой экран
   ========================================================================= */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var state = { lobby: null, room: null, tab: 'town', friendsOpen: false, tick: null, lastPhase: null, lastMentionTs: null };

  /* --------------------------- словари --------------------------- */
  var PHASE_RU = {
    prologue: 'Пролог', night: 'Ночь', morning: 'Утро',
    day: 'День — обсуждение', vote: 'Голосование', runoff: 'Переголосовка', over: 'Финал'
  };
  var CH_RU = { town: 'Город', mafia: 'Мафия', ghost: 'За чертой' };
  var ACT_RU = { kill: 'Выберите жертву', heal: 'Кого спасаете этой ночью', check: 'Кого проверяете', vote: 'За кого голосуете' };

  /* --------------------------- виды --------------------------- */
  function show(which) {
    $('needAuth').hidden = which !== 'auth';
    $('lobbyView').hidden = which !== 'lobby';
    $('gameView').hidden = which !== 'game';
  }

  /* =======================================================================
     ЛОББИ
     ======================================================================= */
  function renderLobby(lobby) {
    state.lobby = lobby;
    if (state.room && !state.room.started) renderFriends();

    var html = '';
    (lobby.invites || []).forEach(function (i) {
      html += '<div class="item" style="border-color:rgba(201,162,39,.45)">' +
        '<span class="avatar">✉</span>' +
        '<span class="nm">' + API.esc(i.from) + ' зовёт в «' + API.esc(i.title) + '» <span class="muted">' + i.players + '/' + i.size + '</span></span>' +
        '<button class="btn primary sm" data-join="' + i.roomId + '">Принять</button></div>';
    });
    (lobby.rooms || []).filter(function (r) { return !r.mine; }).forEach(function (r) {
      html += '<div class="item">' +
        '<span class="avatar">' + API.esc(API.initial(r.hostName)) + '</span>' +
        '<span class="nm">' + API.esc(r.title) + ' <span class="muted">· ' + API.esc(r.scenario) + ' · ' + r.players + '/' + r.size + '</span></span>' +
        (r.started
          ? '<span class="pill red">идёт игра</span>'
          : '<button class="btn sm" data-join="' + r.id + '">Войти</button>') +
        '</div>';
    });
    if (!html) html = '<div class="empty">Открытых комнат пока нет. Создайте свою и позовите друзей.</div>';
    $('roomList').innerHTML = html;
  }

  function renderFriends() {
    var box = $('friends');
    if (!box || !state.lobby || !state.room) return;
    var q = ($('friendSearch').value || '').trim().toLowerCase();
    var inRoom = {};
    state.room.members.forEach(function (m) { inRoom[m.id] = true; });
    var invited = {};
    state.room.invites.forEach(function (i) { invited[i.id] = true; });
    var isHost = state.room.hostId === API.user.id;

    var list = (state.lobby.users || []).filter(function (u) {
      return !q || u.name.toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<div class="empty">Никого не нашлось. Пришлите друзьям ссылку на сайт — они введут имя и появятся здесь.</div>';
      return;
    }
    box.innerHTML = list.slice(0, 60).map(function (u) {
      var right;
      if (inRoom[u.id]) right = '<span class="pill green">в комнате</span>';
      else if (invited[u.id]) right = '<span class="pill">приглашён</span>';
      else if (!isHost) right = '<span class="pill grey">зовёт хозяин</span>';
      else right = '<button class="btn sm" data-invite="' + u.id + '">Добавить</button>';
      return '<div class="item"><span class="avatar">' + API.esc(API.initial(u.name)) + '</span>' +
        '<span class="nm">' + API.esc(u.name) + '</span>' +
        '<span class="dot ' + (u.online ? '' : 'off') + '"></span>' + right + '</div>';
    }).join('');
  }

  function renderRoom(room) {
    state.room = room;

    if (room && room.started) { show('game'); renderGame(room.game); return; }

    show('lobby');
    $('noRoom').hidden = !!room;
    $('roomPane').hidden = !room;
    if (!room) { if (state.lobby) renderLobby(state.lobby); return; }

    var isHost = room.hostId === API.user.id;
    $('lobbyTitle').innerHTML = API.esc(room.title) + '<em>хозяин — ' + API.esc(room.hostName) + '</em>';
    $('roomCode').textContent = room.code;
    $('cntNow').textContent = room.members.length + ' из ' + room.size;
    $('cntGoal').textContent = room.autoStart ? (room.size + ' игроках автоматически') : 'ручном старте';
    $('compo').textContent = room.compositionLabel;

    $('hostBox').hidden = !isHost;
    if (isHost) {
      if (document.activeElement !== $('sizeRange')) $('sizeRange').value = room.size;
      $('sizeVal').textContent = room.size;
      $('autoStart').checked = room.autoStart;
      $('btnStart').disabled = !room.canStart;
      $('btnStart').textContent = room.canStart
        ? 'Начать партию (' + room.members.length + ')'
        : 'Нужно минимум 6 игроков';
    }

    $('members').innerHTML = room.members.map(function (m) {
      return '<div class="item"><span class="avatar">' + API.esc(API.initial(m.name)) + '</span>' +
        '<span class="nm">' + API.esc(m.name) + (m.id === API.user.id ? ' <span class="muted">— это вы</span>' : '') + '</span>' +
        (m.host ? '<span class="pill">хозяин</span>' : '') +
        '<span class="dot ' + (m.online ? '' : 'off') + '"></span>' +
        (isHost && !m.host ? '<button class="btn ghost sm" data-kick="' + m.id + '">✕</button>' : '') +
        '</div>';
    }).join('') + room.invites.map(function (i) {
      return '<div class="item" style="opacity:.6"><span class="avatar">✉</span>' +
        '<span class="nm">' + API.esc(i.name) + '</span><span class="pill grey">ждём ответа</span></div>';
    }).join('');

    $('scenarios').innerHTML = room.scenarios.map(function (s) {
      return '<button data-scen="' + s.id + '" class="' + (s.id === room.scenarioId ? 'on' : '') + '"' + (isHost ? '' : ' disabled') + '>' +
        '<div class="t">' + API.esc(s.title) + '</div>' +
        '<div class="d">' + API.esc(s.place) + ' · ' + s.min + '–' + s.max + ' игроков</div></button>';
    }).join('') || '<div class="empty">Нет сюжетов под такой состав</div>';

    var feed = $('lobbyFeed');
    feed.innerHTML = (room.chat || []).map(function (m) {
      return m.system
        ? '<div class="m sys">' + API.esc(m.text) + '</div>'
        : '<div class="m"><b>' + API.esc(m.name) + ':</b> ' + API.esc(m.text) + '</div>';
    }).join('');
    feed.scrollTop = feed.scrollHeight;

    $('friendsBox').hidden = !state.friendsOpen;
    renderFriends();
  }

  /* =======================================================================
     ИГРА
     ======================================================================= */
  function renderGame(g) {
    if (!g) return;
    var you = g.you || {};
    var room = state.room;

    if (state.lastPhase && state.lastPhase !== g.phase) {
      API.toast(PHASE_RU[g.phase] + (g.day ? ' · день ' + g.day : ''));
    }
    state.lastPhase = g.phase;

    $('gScenario').textContent = g.scenario.title + ' · ' + g.scenario.place;
    $('gPhase').textContent = PHASE_RU[g.phase] + (g.day ? ' · день ' + g.day : '');
    $('gAlive').textContent = 'в игре ' + g.aliveCount + ' из ' + g.players.length;
    paintTimer(g.secondsLeft, g.phaseSeconds);

    $('gHint').textContent = hintFor(g, you);

    /* --- роль --- */
    var rc = '<div class="g">' + (you.roleGlyph || '—') + '</div><h3>' + API.esc(you.roleRu || 'Наблюдатель') + '</h3>' +
      '<p>' + API.esc(you.roleDesc || 'Вы смотрите со стороны.') + '</p>';
    if (you.partners && you.partners.length) {
      rc += '<p style="margin-top:10px" class="gold">Сообщники: ' +
        you.partners.map(function (p) { return API.esc(p.name) + ' (№' + p.seat + (p.alive ? '' : ', выбыл') + ')'; }).join(', ') + '</p>';
    }
    if (you.checks && you.checks.length) {
      rc += '<p style="margin-top:10px">Проверки: ' + you.checks.map(function (c) {
        return API.esc(c.name) + ' — <b style="color:' + (c.isMafia ? '#e08c86' : '#a9d8b4') + '">' + (c.isMafia ? 'чёрный' : 'мирный') + '</b>';
      }).join('; ') + '</p>';
    }
    if (!you.alive && !g.finished) rc += '<p style="margin-top:10px" class="muted">Вы выбыли из игры, но видите всё.</p>';
    $('roleCard').innerHTML = rc;

    /* --- стол --- */
    var act = you.canAct;
    var voteCount = {};
    if (g.phase === 'vote' || g.phase === 'runoff') {
      // сервер не раскрывает чужие голоса до итогов — показываем только факт голосования
      voteCount = null;
    }
    $('gPickHint').textContent = act && ACT_RU[act] ? ACT_RU[act] : '';
    $('seats').innerHTML = g.players.map(function (p) {
      var cls = ['seat'];
      if (!p.alive) cls.push('dead');
      if (you.id === p.id) cls.push('me');
      if (p.role === 'mafia' || p.role === 'don') cls.push('mafia');
      var picked = (act === 'kill' && you.myKill === p.id) || (act === 'heal' && you.myHeal === p.id) ||
        (act === 'check' && you.myCheck === p.id) || (act === 'vote' && you.myVote === p.id);
      if (picked) cls.push('pick');
      var clickable = canTarget(g, you, p);
      if (clickable) cls.push('clickable');

      var sub;
      if (!p.alive) sub = (p.roleRu || '—') + ' · ' + (p.deathCause === 'vote' ? 'город вывел' : 'ночь забрала');
      else if (p.role) sub = p.roleGlyph + ' ' + p.roleRu;
      else if ((g.phase === 'vote' || g.phase === 'runoff') && p.voted) sub = 'голос подан';
      else if (g.phase === 'day' && p.ready) sub = 'готов голосовать';
      else sub = 'за столом';

      return '<' + (clickable ? 'button' : 'div') + ' class="' + cls.join(' ') + '"' +
        (clickable ? ' data-target="' + p.id + '"' : '') + '>' +
        '<span class="no">№' + p.seat + '</span>' +
        '<span class="avatar' + (p.alive ? '' : ' dead') + '">' + API.esc(API.initial(p.name)) + '</span>' +
        '<span class="nm">' + API.esc(p.name) + (you.id === p.id ? ' · вы' : '') + '</span>' +
        '<span class="sub">' + API.esc(sub) + '</span>' +
        '</' + (clickable ? 'button' : 'div') + '>';
    }).join('');

    /* --- кнопки действий --- */
    var a = '';
    if (g.finished) {
      a = '<span class="muted">Партия окончена.</span>';
      if (room && room.hostId === API.user.id) a += '<button class="btn primary sm" id="btnRestart">Собрать новую партию</button>';
      a += '<a class="btn ghost sm" href="/">На главную</a>';
    } else if (act === 'vote') {
      a = '<button class="btn sm" data-target="skip">Воздержаться</button>' +
        '<span class="muted">' + (you.myVote ? 'Голос подан — можно передумать' : 'Нажмите на игрока за столом') + '</span>';
    } else if (act === 'talk') {
      a = '<button class="btn sm ' + (you.ready ? 'primary' : '') + '" id="btnReady">' +
        (you.ready ? 'Готов ✓' : 'Я высказался — к голосованию') + '</button>' +
        '<span class="muted">Когда все готовы, день заканчивается досрочно</span>';
    } else if (act === 'heal' && you.healBlocked) {
      a = '<span class="muted">Прошлой ночью вы спасали этого человека — подряд нельзя.</span>';
    } else if (act) {
      a = '<span class="muted">' + ACT_RU[act] + ' — нажмите на карточку игрока.</span>';
    } else {
      a = '<span class="muted">' + (you.alive === false ? 'Вы наблюдаете за игрой.' : 'Сейчас от вас ничего не требуется.') + '</span>';
    }
    $('actions').innerHTML = a;

    /* --- чат --- */
    if (g.channels.indexOf(state.tab) < 0) state.tab = g.channels[0];
    $('chatTabs').innerHTML = g.channels.map(function (c) {
      return '<button data-tab="' + c + '" class="' + (c === state.tab ? 'on' : '') + '">' + CH_RU[c] + '</button>';
    }).join('');
    var feed = $('gFeed');
    var msgs = g.chat.filter(function (m) { return m.channel === state.tab; });
    feed.innerHTML = msgs.length
      ? msgs.map(function (m) {
        var toMe = (m.mentions || []).indexOf(you.id) >= 0;
        var mine = m.from === you.id;
        var body = API.esc(m.text);
        (m.mentionNames || []).forEach(function (nm) {          // имя в реплике видно сразу
          var stem = API.esc(nm).slice(0, Math.max(2, nm.length - 1));
          body = body.replace(new RegExp('(' + stem + '[\\u0430-\\u044f]*)', 'gi'), '<u class="men">$1</u>');
        });
        return '<div class="m ' + m.channel + (toMe ? ' toyou' : '') + (mine ? ' mine' : '') + '">' +
          (toMe ? '<span class="tag">вам</span> ' : '') +
          '<b>№' + m.seat + ' ' + API.esc(m.name) + ':</b> ' + body + '</div>';
      }).join('')
      : '<div class="empty">Пока тишина. Начните разговор — к вам точно прислушаются.</div>';

    /* если к вам обратились — это нельзя пропустить */
    var lastToMe = null;
    msgs.forEach(function (m) { if ((m.mentions || []).indexOf(you.id) >= 0 && m.from !== you.id) lastToMe = m; });
    if (lastToMe && state.lastMentionTs !== lastToMe.ts) {
      state.lastMentionTs = lastToMe.ts;
      API.toast(lastToMe.name + ' обращается к вам');
    }
    feed.scrollTop = feed.scrollHeight;

    var canSay = (state.tab === 'town' && you.alive && ['prologue', 'day', 'vote', 'runoff', 'morning', 'over'].indexOf(g.phase) >= 0) ||
      (state.tab === 'mafia' && g.phase === 'night' && you.alive) ||
      (state.tab === 'ghost' && you.alive === false);
    $('gMsg').disabled = !canSay;
    $('gSend').disabled = !canSay;
    $('gMsg').placeholder = canSay
      ? 'Ваша речь… назовите имя — человек увидит, что вы к нему'
      : (state.tab === 'town'
        ? (g.phase === 'night' ? 'Город спит — слово вернётся утром' : 'Сейчас говорить нельзя')
        : (state.tab === 'mafia' ? 'Мафия шепчется только ночью' : 'Этот канал для выбывших'));

    /* --- протокол --- */
    var log = $('gLog');
    log.innerHTML = g.log.map(function (l) {
      return '<div class="l ' + API.esc(l.kind) + '">' + API.esc(l.text) + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;

    /* --- финал --- */
    if (g.finished) {
      $('finale').hidden = false;
      $('finale').innerHTML =
        '<span class="eyebrow">Занавес</span>' +
        '<div class="win ' + g.winner + '">' + (g.winner === 'town' ? 'Победил город' : 'Победила мафия') + '</div>' +
        '<p class="lede" style="margin:12px auto 18px">' +
        API.esc(g.winner === 'town' ? g.scenario.finaleTown || 'Город вычистил себя сам.' : g.scenario.finaleMafia || 'Тишина осталась за чёрными.') + '</p>' +
        '<div class="seats">' + g.players.map(function (p) {
          return '<div class="seat ' + (p.alive ? '' : 'dead') + '">' +
            '<span class="no">№' + p.seat + '</span>' +
            '<span class="avatar' + (p.alive ? '' : ' dead') + '">' + API.esc(API.initial(p.name)) + '</span>' +
            '<span class="nm">' + API.esc(p.name) + '</span>' +
            '<span class="sub">' + (p.roleGlyph || '') + ' ' + API.esc(p.roleRu || '') + '</span></div>';
        }).join('') + '</div>';
    } else {
      $('finale').hidden = true;
    }
  }

  function hintFor(g, you) {
    if (g.finished) return 'Партия окончена — роли раскрыты ниже.';
    if (g.phase === 'prologue') return g.scenario.prologue;
    if (g.phase === 'night') return 'Город засыпает. ' + (you.canAct ? ACT_RU[you.canAct] + '.' : 'Ждите утра.');
    if (g.phase === 'morning') return 'Утро. Город считает потери.';
    if (g.phase === 'day') return 'День: спорьте, оправдывайтесь, сопоставляйте. ' + g.scenario.rule;
    if (g.phase === 'vote') return 'Голосование: выберите того, кого город выводит.';
    if (g.phase === 'runoff') return 'Переголосовка между лидерами — если снова ничья, никто не выйдет.';
    return '';
  }

  function canTarget(g, you, p) {
    var act = you.canAct;
    if (!act || g.finished) return false;
    if (act === 'talk') return false;
    if (!p.alive) return false;
    if (act === 'kill') return !you.partners.some(function (x) { return x.id === p.id; }) && p.id !== you.id;
    if (act === 'check') return p.id !== you.id;
    if (act === 'heal') return p.id !== you.healBlocked;
    if (act === 'vote') return !g.runoffOf || g.runoffOf.indexOf(p.id) >= 0;
    return false;
  }

  function paintTimer(left, total) {
    var t = $('gTimer');
    t.textContent = API.mmss(left);
    t.classList.toggle('warn', left <= 10);
    $('gBar').style.width = total ? Math.max(0, Math.min(100, left / total * 100)) + '%' : '0%';
  }

  /* =======================================================================
     ДЕЙСТВИЯ
     ======================================================================= */
  function call(path, body) { return API.call(path, body || {}).catch(API.fail); }

  function act(type, target) {
    return API.call('/api/rooms/action', { type: type, target: target }).catch(API.fail);
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-join],[data-invite],[data-kick],[data-scen],[data-target],[data-tab]');
    if (el) {
      if (el.dataset.join) return call('/api/rooms/join', { roomId: el.dataset.join });
      if (el.dataset.invite) return call('/api/rooms/invite', { userId: el.dataset.invite })
        .then(function () { API.toast('Приглашение отправлено'); });
      if (el.dataset.kick) return call('/api/rooms/kick', { userId: el.dataset.kick });
      if (el.dataset.scen) return call('/api/rooms/config', { scenarioId: el.dataset.scen });
      if (el.dataset.tab) { state.tab = el.dataset.tab; if (state.room && state.room.game) renderGame(state.room.game); return; }
      if (el.dataset.target) {
        var g = state.room && state.room.game;
        if (!g || !g.you || !g.you.canAct) return;
        return act(g.you.canAct, el.dataset.target);
      }
    }
    if (e.target.id === 'btnReady') return act('ready', null);
    if (e.target.id === 'btnRestart') return call('/api/rooms/restart');
  });

  $('btnCreate').addEventListener('click', function () {
    call('/api/rooms/create', { size: 8, autoStart: true }).then(function (r) { if (r) renderRoom(r.room); });
  });
  $('btnJoinCode').addEventListener('click', function () {
    var code = $('joinCode').value.trim();
    if (!code) return API.toast('Введите код комнаты', 'bad');
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
  $('sizeRange').addEventListener('input', function () { $('sizeVal').textContent = this.value; });
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
  }
  $('gSend').addEventListener('click', sendGame);
  $('gMsg').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendGame(); });

  /* =======================================================================
     СТАРТ
     ======================================================================= */
  API.load();
  if (!API.user) { show('auth'); return; }
  $('whoName').textContent = API.user.name;

  // локальный таймер между пушами — чтобы цифры тикали плавно
  setInterval(function () {
    var g = state.room && state.room.game;
    if (!g || g.finished) return;
    g.secondsLeft = Math.max(0, g.secondsLeft - 1);
    paintTimer(g.secondsLeft, g.phaseSeconds);
  }, 1000);

  API.call('/api/me').then(function (r) {
    API.save(r.user);
    $('whoName').textContent = r.user.name;
    renderLobby(r.lobby);

    var wanted = new URLSearchParams(location.search).get('room');
    if (wanted) return API.call('/api/rooms/join', { roomId: wanted }).then(function (x) { renderRoom(x.room); });

    return API.call('/api/rooms/state').then(function (x) { renderRoom(x.room); })
      .catch(function () { renderRoom(null); });
  }).catch(function () {
    API.clear(); show('auth');
  }).then(function () {
    API.events({
      lobby: renderLobby,
      room: function (room) { renderRoom(room); }
    });
  });
})();
