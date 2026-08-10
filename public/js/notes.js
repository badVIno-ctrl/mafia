/* =========================================================================
   notes.js — личный блокнот на местах.

   За живым столом каждый игрок пишет на бумажке: «3 — чёрный», «7 — шериф»,
   «5 врёт». Это самая дешёвая и самая любимая механика мафии: без неё на
   столе из двенадцати человек к третьему дню невозможно удержать в голове,
   кто на кого показывал.

   Здесь она устроена ровно так же, как бумажка: пометки видны только своему
   хозяину и никуда не уходят с устройства. Сервер о них не знает и знать не
   должен — иначе это уже не блокнот, а публичная доска, то есть другая игра.

   Хранение: localStorage, по одному ключу на стол. Пометки живут ровно
   столько, сколько стол: партия кончилась — метки остаются (по ним удобно
   разбирать), новый стол начинается с чистого листа.

     Notes.open('room-7');
     Notes.set(playerId, 'black');
     Notes.get(playerId);          // { id:'black', ru:'Чёрный', color:'#c4563a' }
     Notes.tags();                 // список для меню
   ========================================================================= */
(function (root) {
  'use strict';

  /* Набор меток. Шесть — предел, после которого меню перестаёт читаться
     с одного взгляда, а блокнот превращается в работу.

     Порядок не случайный: сначала две команды (по ним думают чаще всего),
     потом две роли, потом два наблюдения. Так рука привыкает к номерам. */
  var TAGS = [
    { id: 'black', ru: 'Чёрный', hint: 'думаю, что мафия', color: '#c4563a' },
    { id: 'red', ru: 'Красный', hint: 'думаю, что мирный', color: '#7ba295' },
    { id: 'sheriff', ru: 'Шериф', hint: 'заявился или похож', color: '#e2b478' },
    { id: 'doctor', ru: 'Доктор', hint: 'заявился или похож', color: '#8fb3d9' },
    { id: 'lie', ru: 'Врёт', hint: 'слова не сходятся', color: '#b07ec4' },
    { id: 'watch', ru: 'Присмотреть', hint: 'пока не понял', color: '#b2a99c' }
  ];
  var BY_ID = {};
  TAGS.forEach(function (t) { BY_ID[t.id] = t; });

  var key = null;
  var data = {};
  var listeners = [];

  function load() {
    data = {};
    if (!key) return;
    try {
      var raw = localStorage.getItem(key);
      if (raw) data = JSON.parse(raw) || {};
    } catch (e) { data = {}; }
  }

  function save() {
    if (!key) return;
    try {
      /* Пустой блокнот не занимает места: если все метки сняты, ключ
         удаляется целиком. Иначе в localStorage годами копятся столы. */
      if (!Object.keys(data).length) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(data));
    } catch (e) { /* приватный режим — блокнот просто не переживёт перезагрузку */ }
  }

  function fire() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* один слушатель не ломает остальных */ }
    }
  }

  var Notes = {
    TAGS: TAGS,

    /** Открыть блокнот стола. Разные столы не смешиваются. */
    open: function (roomId) {
      var next = 'mafia.notes.' + String(roomId || 'solo');
      if (next === key) return;
      key = next;
      load();
      fire();
    },

    tags: function () { return TAGS.slice(); },

    /** Метка игрока или null. */
    get: function (playerId) {
      var t = data[playerId];
      return t && BY_ID[t] ? BY_ID[t] : null;
    },

    /** Поставить метку. null или тот же id — снять. */
    set: function (playerId, tagId) {
      if (!playerId) return;
      if (!tagId || data[playerId] === tagId) delete data[playerId];
      else if (BY_ID[tagId]) data[playerId] = tagId;
      save();
      fire();
    },

    /** Следующая метка по кругу: удобно для быстрого тыка. */
    cycle: function (playerId) {
      var cur = data[playerId];
      var i = cur ? TAGS.findIndex(function (t) { return t.id === cur; }) : -1;
      var next = TAGS[i + 1];
      this.set(playerId, next ? next.id : null);
    },

    /** Сколько меток поставлено — для подписи «блокнот: 4». */
    count: function () { return Object.keys(data).length; },

    clear: function () { data = {}; save(); fire(); },

    /** Подписаться на изменения: интерфейс перерисовывает метки сам. */
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  if (typeof module === 'object' && module.exports) module.exports = Notes;
  else root.Notes = Notes;
})(typeof globalThis !== 'undefined' ? globalThis : this);
