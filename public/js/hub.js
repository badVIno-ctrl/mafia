/* Главная: имя за столом и афиша вечера.
   Эмодзи здесь больше нет: знаки рисует icons.js, поэтому на любом
   телефоне они выглядят одинаково и всегда в цвет текста. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var es = null;

  function showAuth() {
    $('authView').hidden = false;
    $('hubView').hidden = true;
    $('who').hidden = true;
    setTimeout(function () { $('regName').focus(); }, 60);
  }

  function showHub() {
    $('authView').hidden = true;
    $('hubView').hidden = false;
    $('who').hidden = false;
    $('whoName').textContent = API.user.name;
    $('hubName').textContent = API.user.name;
    document.title = 'Мафия — ' + API.user.name;
  }

  function renderLobby(lobby) {
    var users = lobby.users || [];
    var rooms = lobby.rooms || [];
    var invites = lobby.invites || [];
    var online = users.filter(function (u) { return u.online; }).length + 1;

    $('quickStat').textContent = online + ' ' + API.plural(online, 'игрок онлайн', 'игрока онлайн', 'игроков онлайн') +
      (rooms.length
        ? ' · ' + rooms.length + ' ' + API.plural(rooms.length, 'открытый стол ждёт', 'открытых стола ждут', 'открытых столов ждут') + ' людей'
        : ' · открытых столов пока нет');

    var html = '';

    invites.forEach(function (i) {
      html += '<div class="item" style="border-color:var(--line-warm)">' +
        '<span class="avatar">' + Icons.svg('envelope', { size: 18 }) + '</span>' +
        '<span class="nm">' + API.esc(i.from) + ' зовёт в комнату «' + API.esc(i.title) + '» ' +
        '<span class="muted">(' + i.players + '/' + i.size + ')</span></span>' +
        '<a class="btn primary sm" href="/online.html?room=' + encodeURIComponent(i.roomId) + '">Принять</a></div>';
    });

    /* Главное, чего здесь не хватало: видно, куда можно сесть прямо
       с главной — без чужих ссылок и без переписки со знакомыми. */
    rooms.slice(0, 6).forEach(function (r) {
      var n = r.humans || 0;
      html += '<div class="item">' +
        '<span class="avatar">' + API.esc(API.initial(r.host)) + '</span>' +
        '<span class="nm">' + API.esc(r.title) +
        '<span class="muted"> — ' + n + ' ' + API.plural(n, 'человек', 'человека', 'человек') +
        ' из ' + r.size + '</span></span>' +
        '<a class="btn primary sm" href="/online.html?join=' + encodeURIComponent(r.invite) + '">Сесть</a></div>';
    });

    if (!rooms.length && !invites.length) {
      /* Пустой список — это состояние, а не ошибка, и оно обязано говорить,
         что делать дальше. Кнопка «Играть» здесь работает в любом случае:
         людей нет — сядут соседи, и стол всё равно останется объявленным. */
      html += users.length
        ? '<div class="empty">Открытых столов сейчас нет. Нажмите «Играть» — ваш стол появится ' +
            'в общем зале, и к вам смогут подсесть, пока идёт партия с соседями.</div>'
        : '<div class="empty">Пока вы здесь один. Нажмите «Играть»: партия начнётся сразу, ' +
            'соседи займут пустые места, а стол увидят все, кто зайдёт после вас.</div>';
    }

    users.slice(0, 30).forEach(function (u) {
      html += '<div class="item">' +
        '<span class="avatar">' + API.esc(API.initial(u.name)) + '</span>' +
        '<span class="nm">' + API.esc(u.name) + '</span>' +
        '<span class="dot ' + (u.online ? '' : 'off') + '"></span>' +
        '<span class="pill">' + (u.online ? 'на месте' : 'ушёл') + '</span></div>';
    });
    $('quickList').innerHTML = html;
  }

  function connect() {
    showHub();
    API.call('/api/lobby').then(renderLobby).catch(function () {});
    if (es) es.close();
    es = API.events({ lobby: renderLobby });
  }

  function register() {
    var name = $('regName').value.trim();
    if (name.length < 2) { API.toast('Имя от 2 до 16 символов', 'bad'); return; }
    $('btnReg').disabled = true;
    API.call('/api/register', { name: name })
      .then(function (r) { API.save(r.user); API.toast('Добро пожаловать, ' + r.user.name + '!'); connect(); })
      .catch(API.fail)
      .then(function () { $('btnReg').disabled = false; });
  }

  /* Своё окно вместо prompt(): системное выпадает из оформления, не переводится
     и на телефоне выглядит как ошибка сайта. Закрывается по Esc, по фону
     и кнопкой — три привычных способа передумать. */
  function askName(current) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'modalback';
      back.innerHTML =
        '<div class="modalbox panel pad lit" role="dialog" aria-modal="true" aria-labelledby="askTtl">' +
          '<h3 id="askTtl" style="margin:0 0 var(--s2)">Новое имя за столом</h3>' +
          '<p class="note" style="margin:0 0 var(--s3)">От 2 до 16 символов. Под этим именем вас позовут за стол.</p>' +
          '<input class="inp" id="askInp" maxlength="16" autocomplete="nickname" aria-label="Новое имя">' +
          '<div class="row" style="margin-top:var(--s4);justify-content:flex-end;flex-wrap:wrap">' +
            '<button class="btn ghost" id="askNo">Отмена</button>' +
            '<button class="btn primary" id="askYes">Сохранить</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);

      var inp = back.querySelector('#askInp');
      var last = document.activeElement;
      inp.value = current || '';
      setTimeout(function () { inp.focus(); inp.select(); }, 30);

      function close(value) {
        document.removeEventListener('keydown', onKey);
        back.remove();
        if (last && last.focus) last.focus();
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Enter' && document.activeElement === inp) { e.preventDefault(); close(inp.value); }
      }
      document.addEventListener('keydown', onKey);
      back.querySelector('#askNo').addEventListener('click', function () { close(null); });
      back.querySelector('#askYes').addEventListener('click', function () { close(inp.value); });
      back.addEventListener('mousedown', function (e) { if (e.target === back) close(null); });
    });
  }

  function rename() {
    askName(API.user.name).then(function (name) {
      if (name == null) return;
      name = name.trim();
      if (name.length < 2) { API.toast('Имя от 2 до 16 символов', 'bad'); return; }
      if (name === API.user.name) return;
      API.call('/api/rename', { name: name })
        .then(function (r) { API.save(r.user); showHub(); API.toast('Теперь вы ' + r.user.name); })
        .catch(API.fail);
    });
  }

  /* --- знаки на воронке ---
     Каждый знак ставится через проверку: страница переживает разметку без
     этого элемента, и падать из-за отсутствующей иконки главная не должна. */
  function paintSigns() {
    if (!window.Icons) return;
    var put = function (id, name, size) {
      var el = $(id);
      if (el) el.innerHTML = Icons.svg(name, { size: size || 26 });
    };
    put('signPlay', 'play', 24);
    put('goPlay', 'chevron', 20);
    put('signBots', 'cards', 22);
    put('signNet', 'net', 22);
    put('signRules', 'scroll', 22);
  }

  /* --- старт --- */
  var curtain = window.Curtain ? Curtain.show({ title: 'Мафия', note: 'Готовим стол…' }) : null;
  if (curtain) curtain.progress(0.5);
  paintSigns();
  API.load();
  $('btnReg').addEventListener('click', register);
  /* Игра без имени. Раньше это обещание держала отдельная страница с ботами —
     она не спрашивала ничего. Теперь стол с соседями это обычная комната
     общего движка, и комнате нужен игрок с именем; значит имя придумываем мы,
     а человек переименуется, когда захочет. Терять из-за одного поля того,
     кто зашёл посмотреть, нельзя: это самый дорогой отказ на сайте. */
  if ($('btnGuest')) {
    $('btnGuest').addEventListener('click', function () {
      var b = this;
      b.disabled = true;
      API.guest()
        .then(function () { location.href = '/online.html?solo=1'; })
        .catch(API.fail)
        .then(function () { b.disabled = false; });
    });
  }
  $('regName').addEventListener('keydown', function (e) { if (e.key === 'Enter') register(); });
  $('btnRename').addEventListener('click', rename);
  $('btnRefresh').addEventListener('click', function () {
    API.call('/api/lobby').then(renderLobby).then(function () { API.toast('Список обновлён'); }).catch(API.fail);
  });

  function done() {
    if (!curtain) return;
    curtain.progress(1);
    curtain.close();
    curtain = null;
  }

  if (API.user) {
    API.call('/api/me')
      .then(function (r) { API.save(r.user); connect(); })
      .catch(function () { API.clear(); showAuth(); })
      .then(done);
  } else {
    showAuth();
    /* Заставке даём договорить строку шёпота, иначе она мигает и исчезает. */
    setTimeout(done, 900);
  }
})();
