/* =============================================================================
   view-mode.js — какая декорация стоит на сцене.

   В театре одну и ту же пьесу играют по-разному: можно выстроить выгородку в
   глубину, а можно повесить писаный задник и вынести плоские фигуры на
   подставках. Здесь ровно этот выбор и живёт — один для обеих страниц.

   Базовый вид — глубокая сцена. Плоский включается кнопкой и запоминается.
   Порядок решения:
     1. адрес: ?view=flat | ?view=deep (то же, что 2d | 3d) — сильнее всего,
        чтобы ссылкой можно было позвать человека сразу в нужный вид;
     2. прошлый выбор игрока из localStorage;
     3. глубокая сцена.
   Если в браузере нет WebGL, выбора нет вовсе: остаётся плоский задник, и
   кнопка честно говорит почему.
   ============================================================================= */
(function (w) {
  'use strict';

  var KEY = 'mafia.scene.view';
  var DEEP = 'deep';
  var FLAT = 'flat';

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
  function fromStore() {
    try { return normalize(w.localStorage.getItem(KEY)); }
    catch (e) { return null; }
  }
  function store(mode) {
    try { w.localStorage.setItem(KEY, mode); } catch (e) { /* приватный режим */ }
  }

  function resolve() {
    if (!webglOk()) { forced = 'no-webgl'; return FLAT; }
    return fromUrl() || fromStore() || DEEP;
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
    set: function (mode, opts) {
      var want = normalize(mode);
      if (!want) return ViewMode.get();
      if (forced && want !== FLAT) return ViewMode.get();
      var prev = ViewMode.get();
      if (want === prev) return prev;
      current = want;
      if (!(opts && opts.temporary)) store(want);
      paintBody(want);
      listeners.forEach(function (fn) {
        try { fn(want, prev); } catch (e) { /* один слушатель не роняет остальные */ }
      });
      return want;
    },

    toggle: function () { return ViewMode.set(ViewMode.isFlat() ? DEEP : FLAT); },

    /** Куда переключит кнопка: режим, которого сейчас нет. */
    next: function () { return ViewMode.isFlat() ? DEEP : FLAT; },

    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    /* Названия. Одни и те же слова на обеих страницах и в озвучке. */
    title: function (mode) { return (mode || ViewMode.get()) === FLAT ? 'Плоский задник' : 'Глубокая сцена'; },
    icon: function (mode) { return (mode || ViewMode.get()) === FLAT ? 'stageflat' : 'stagedeep'; },
    /* Подпись кнопки: она обещает то, что произойдёт по нажатию. */
    action: function () {
      if (forced === 'no-webgl') return 'В этом браузере нет WebGL — играем на плоском заднике';
      return ViewMode.isFlat() ? 'Поставить глубокую сцену' : 'Повесить плоский задник';
    }
  };

  if (document.body) paintBody(ViewMode.get());
  else document.addEventListener('DOMContentLoaded', function () { paintBody(ViewMode.get()); });

  w.ViewMode = ViewMode;
})(window);
