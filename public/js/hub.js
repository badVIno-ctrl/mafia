/* Главная: регистрация по имени + две плашки режимов */
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
    var online = users.filter(function (u) { return u.online; }).length + 1;
    $('quickStat').textContent = online + ' ' + API.plural(online, 'игрок онлайн', 'игрока онлайн', 'игроков онлайн') +
      ' · всего зарегистрировано ' + (users.length + 1);

    var invites = lobby.invites || [];
    var html = '';
    invites.forEach(function (i) {
      html += '<div class="item" style="border-color:rgba(201,162,39,.45)">' +
        '<span class="avatar">✉</span>' +
        '<span class="nm">' + API.esc(i.from) + ' зовёт в комнату «' + API.esc(i.title) + '» ' +
        '<span class="muted">(' + i.players + '/' + i.size + ')</span></span>' +
        '<a class="btn primary sm" href="/online.html?room=' + encodeURIComponent(i.roomId) + '">Принять</a></div>';
    });
    if (!users.length && !invites.length) {
      html += '<div class="empty">Пока вы единственный зарегистрированный игрок.<br>' +
        'Откройте комнату и пришлите друзьям адрес сайта и код комнаты.</div>';
    }
    users.slice(0, 30).forEach(function (u) {
      html += '<div class="item">' +
        '<span class="avatar">' + API.esc(API.initial(u.name)) + '</span>' +
        '<span class="nm">' + API.esc(u.name) + '</span>' +
        '<span class="dot ' + (u.online ? '' : 'off') + '"></span>' +
        '<span class="tag">' + (u.online ? 'онлайн' : 'офлайн') + '</span></div>';
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

  function rename() {
    var name = prompt('Новое имя за столом:', API.user.name);
    if (name == null) return;
    API.call('/api/rename', { name: name.trim() })
      .then(function (r) { API.save(r.user); showHub(); API.toast('Имя обновлено'); })
      .catch(API.fail);
  }

  /* --- старт --- */
  API.load();
  $('btnReg').addEventListener('click', register);
  $('regName').addEventListener('keydown', function (e) { if (e.key === 'Enter') register(); });
  $('btnRename').addEventListener('click', rename);
  $('btnRefresh').addEventListener('click', function () {
    API.call('/api/lobby').then(renderLobby).then(function () { API.toast('Список обновлён'); }).catch(API.fail);
  });

  if (API.user) {
    API.call('/api/me')
      .then(function (r) { API.save(r.user); connect(); })
      .catch(function () { API.clear(); showAuth(); });
  } else {
    showAuth();
  }
})();
