/* Общий клиентский слой: токен, запросы, SSE, тосты, мелкие хелперы */
(function (w) {
  'use strict';
  var KEY = 'mafia.online.user';

  var API = {
    user: null,

    load: function () {
      try { API.user = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { API.user = null; }
      return API.user;
    },
    save: function (u) { API.user = u; localStorage.setItem(KEY, JSON.stringify(u)); return u; },
    clear: function () { API.user = null; localStorage.removeItem(KEY); },

    call: function (path, body) {
      var h = { 'Content-Type': 'application/json' };
      if (API.user && API.user.token) h['x-token'] = API.user.token;
      return fetch(path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) { var e = new Error(j.error || ('Ошибка ' + r.status)); e.status = r.status; throw e; }
            return j;
          });
        });
    },

    events: function (handlers) {
      if (!API.user) return null;
      var es = new EventSource('/api/events?token=' + encodeURIComponent(API.user.token));
      Object.keys(handlers).forEach(function (name) {
        es.addEventListener(name, function (ev) {
          var data = null;
          try { data = JSON.parse(ev.data); } catch (e) { return; }
          handlers[name](data);
        });
      });
      return es;
    },

    toast: function (text, kind) {
      var el = document.getElementById('toast');
      if (!el) { console.log(text); return; }
      el.textContent = text;
      el.style.borderColor = kind === 'bad' ? 'rgba(194,65,58,.6)' : 'var(--line)';
      el.classList.add('on');
      clearTimeout(API._t);
      API._t = setTimeout(function () { el.classList.remove('on'); }, 3200);
    },

    fail: function (e) { API.toast(e && e.message ? e.message : 'Что-то пошло не так', 'bad'); },

    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },

    initial: function (name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); },

    plural: function (n, one, few, many) {
      var a = Math.abs(n) % 100, b = a % 10;
      if (a > 10 && a < 20) return many;
      if (b > 1 && b < 5) return few;
      if (b === 1) return one;
      return many;
    },

    mmss: function (sec) {
      sec = Math.max(0, Math.round(sec || 0));
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
  };

  w.API = API;
})(window);
