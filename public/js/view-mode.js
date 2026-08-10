/* =============================================================================
   view-mode.js — какой вид стоит на сцене: 2D или 3D.

   Правило простое, и оно должно читаться без объяснений: партия всегда
   начинается в 2D-виде. Плоский стол встаёт мгновенно, работает на любом
   телефоне и никогда не показывает недорисованную фигуру. Кто хочет объём —
   нажимает одну кнопку и переключается на 3D-вид.

   Слова тоже простые. Раньше эти два состояния назывались «писаный задник» и
   «глубокая сцена»: красиво, но игрок не знал, что он получит по нажатию.
   Теперь на кнопке написано «3D», а во всплывающей подсказке — ровно то, что
   произойдёт: «Переключить на 3D-вид».

   Порядок решения при загрузке страницы:
     1. адрес: ?view=3d | ?view=2d — сильнее всего, чтобы ссылкой можно было
        позвать человека сразу в нужный вид;
     2. 2D — всегда.
   Выбор нарочно не запоминается между партиями: «начал новую игру — видишь
   2D» важнее, чем «сайт помнит мой прошлый выбор». Внутри партии выбор,
   разумеется, держится: переключение живёт в памяти страницы.

   Если в браузере нет WebGL, выбора нет вовсе: остаётся 2D, и кнопка честно
   говорит почему.
   ============================================================================= */
(function (w) {
  'use strict';

  var DEEP = 'deep';      /* 3D-вид: объёмная сцена */
  var FLAT = 'flat';      /* 2D-вид: плоский стол */

  var listeners = [];
  var forced = null;      /* причина, по которой выбора нет */
  var current = null;

  function normalize(v) {
    v = String(v || '').toLowerCase();
    if (v === 'flat' || v === '2d' || v === '2' || v === 'plane') return FLAT;
    if (v === 'deep' || v === '3d' || v === '3' || v === 'stage') return DEEP;
    return null;
  }

  function webglOk() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }

  function fromUrl() {
    try { return normalize(new URLSearchParams(w.location.search).get('view')); }
    catch (e) { return null; }
  }

  function resolve() {
    if (!webglOk()) { forced = 'no-webgl'; return FLAT; }
    return fromUrl() || FLAT;
  }

  function paintBody(mode) {
    if (!document.body) return;
    document.body.dataset.sceneMode = mode === FLAT ? '2d' : '3d';
    document.body.dataset.sceneView = mode;
    document.body.classList.toggle('scene-2d', mode === FLAT);
    document.body.classList.toggle('scene-flat', mode === FLAT);
    document.body.classList.toggle('scene-deep', mode === DEEP);
  }

  var ViewMode = {
    DEEP: DEEP,
    FLAT: FLAT,

    get: function () {
      if (current === null) { current = resolve(); paintBody(current); }
      return current;
    },
    isFlat: function () { return ViewMode.get() === FLAT; },
    isDeep: function () { return ViewMode.get() === DEEP; },

    /** Почему выбор недоступен: 'no-webgl' или '' (выбор есть). */
    lockedBy: function () { ViewMode.get(); return forced || ''; },
    locked: function () { return !!ViewMode.lockedBy(); },

    /** Сменить вид. Возвращает итоговый режим — он может не совпасть с просьбой. */
    set: function (mode) {
      var want = normalize(mode);
      if (!want) return ViewMode.get();
      if (forced && want !== FLAT) return ViewMode.get();
      var prev = ViewMode.get();
      if (want === prev) return prev;
      current = want;
      paintBody(want);
      listeners.forEach(function (fn) {
        try { fn(want, prev); } catch (e) { /* один слушатель не роняет остальные */ }
      });
      return want;
    },

    /** Новая партия начинается в 2D — если только вид не задан адресом.

        Порядок решения описан в начале файла: «?view=3d сильнее всего, чтобы
        ссылкой можно было позвать человека сразу в нужный вид». Держался он
        ровно до старта партии — а на старте и страница с ботами, и сетевой
        клиент зовут эту функцию, и она молча ставила 2D. Получалось, что
        задокументированный параметр не работает нигде, где он и нужен: по
        ссылке в объёмный вид попасть было нельзя, «?view=3d» просто ничего
        не делал.

        Правило «новая партия начинается в 2D» при этом остаётся: без явного
        указания в адресе всё как было. */
    resetForNewGame: function () { return ViewMode.set(fromUrl() || FLAT); },

    toggle: function () { return ViewMode.set(ViewMode.isFlat() ? DEEP : FLAT); },

    /** Куда переключит кнопка: режим, которого сейчас нет. */
    next: function () { return ViewMode.isFlat() ? DEEP : FLAT; },

    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    /* Названия. Одни и те же слова на обеих страницах: 2D и 3D понимает каждый. */
    title: function (mode) { return (mode || ViewMode.get()) === FLAT ? '2D-вид' : '3D-вид'; },
    /** Короткая надпись на кнопке — это тот вид, который она включит. */
    short: function () { return ViewMode.isFlat() ? '3D' : '2D'; },
    icon: function (mode) { return (mode || ViewMode.get()) === FLAT ? 'stageflat' : 'stagedeep'; },
    /* Подсказка кнопки: она обещает то, что произойдёт по нажатию. */
    action: function () {
      if (forced === 'no-webgl') return 'В этом браузере нет 3D — играем в 2D-виде';
      return ViewMode.isFlat() ? 'Переключить на 3D-вид' : 'Переключить на 2D-вид';
    }
  };

  if (document.body) paintBody(ViewMode.get());
  else document.addEventListener('DOMContentLoaded', function () { paintBody(ViewMode.get()); });

  w.ViewMode = ViewMode;
})(window);
