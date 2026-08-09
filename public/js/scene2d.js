/* =============================================================================
   scene2d.js — плоская сцена партии с ботами.

   Партия с ботами ведёт сцену иначе, чем сетевая: она не присылает состояние
   целиком, а командует по шагам и ждёт, пока анимация доиграет — «раздай
   карты», «наступила ночь», «этот выбывает, переверни его карту». Поэтому
   здесь живут обещания и плавные переходы, а рисование целиком отдано ядру
   flat-table.js: и на сетевом столе, и здесь стоит один и тот же писаный
   задник вертепа.

   Набор методов совпадает с объёмной сценой страницы один в один — на этом
   держится переключение декораций посреди партии.
   ============================================================================= */
(function (global) {
  'use strict';

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  global.createScene2D = function createScene2D() {
    var core = null;
    var host = null;
    var tweens = [];
    var deck = { armed: [] };
    var glowWant = 0;
    var bright = true;
    var top = false;
    var calm = false;

    function now() { return (global.performance || Date).now(); }

    /* Плавный переход как обещание: партия ждёт его так же, как ждала
       поворота камеры в объёмной сцене. */
    function tween(ms, fn) {
      if (calm) { try { fn(1, 1); } catch (e) { } return Promise.resolve(); }
      return new Promise(function (res) {
        tweens.push({ t0: now(), ms: Math.max(1, ms), fn: fn, done: res });
      });
    }
    function wait(ms) {
      return new Promise(function (r) { setTimeout(r, calm ? Math.min(ms, 80) : ms); });
    }
    function runTweens(t) {
      for (var i = tweens.length - 1; i >= 0; i--) {
        var tw = tweens[i];
        var k = clamp((t - tw.t0) / tw.ms, 0, 1);
        try { tw.fn(easeInOut(k), k); } catch (e) { /* один переход не роняет кадр */ }
        if (k >= 1) { tweens.splice(i, 1); tw.done(); }
      }
    }

    function st() { return core ? core.state : null; }
    function seat(i) { return core ? core.seat(i) : null; }

    /* --------------------------------------------------------------------- */
    /* сборка                                                                */
    /* --------------------------------------------------------------------- */
    function init(container) {
      host = container;
      core = global.createFlatTable(container, {
        pixelCap: 2,
        /* Панели интерфейса висят поверх сцены по краям: сцена обязана о них
           знать, иначе крайние места окажутся под картой роли и протоколом. */
        avoid: ['#leftpanel', '#rightpanel', '#bottombar'],
        onPick: function (id) {
          /* Партия с ботами выбирает цель кнопками под столом; нажатие по
             фигуре — короткий путь к тому же действию. */
          if (typeof global.onSeatPick === 'function') global.onSeatPick(id);
        }
      });
      calm = core.calm();
      core.state.plates = true;
      core.state.deal = 1;
    }

    function setup(list) {
      if (!core) return;
      core.setSeats((list || []).map(function (p, i) {
        return {
          id: i, seat: i + 1, name: p.name, color: p.color, hat: p.hat,
          you: !!p.isHuman
        };
      }));
      deck.armed = [];
      core.state.deal = 0;
      core.state.victim = null;
      core.state.arrows = [];
    }

    /* --------------------------------------------------------------------- */
    /* карты                                                                 */
    /* --------------------------------------------------------------------- */
    function armCard(i, role) { deck.armed[i] = role; }

    function dealCards() {
      /* Колода расходится по рукам: одно движение на весь стол, дальше
         карты просто лежат закрытыми. */
      return tween(760, function (t) { core.state.deal = t; }).then(function () {
        core.state.deal = 1;
      });
    }

    function flipCard(i, role) {
      var s = seat(i);
      if (s) s.revealed = role || deck.armed[i] || null;
    }

    /* --------------------------------------------------------------------- */
    /* свет и фазы                                                           */
    /* --------------------------------------------------------------------- */
    function toNight() {
      core.state.victim = null;
      return tween(620, function (t) {
        core.state.night = t;
        core.state.plan = t * 0.18;
        core.layout();
      }).then(function () { core.state.night = 1; });
    }

    function toDay() {
      core.state.victim = null;
      var from = core.state.night;
      return tween(620, function (t) {
        core.state.night = from * (1 - t);
        core.state.plan = core.state.night * 0.18;
        core.layout();
      }).then(function () { core.state.night = 0; core.state.plan = 0; core.layout(); });
    }

    function mafiaGlow(on) {
      glowWant = on ? 1 : 0;
      var from = core.state.glow;
      return tween(380, function (t) {
        core.state.glow = from + (glowWant - from) * t;
      }).then(function () { core.state.glow = glowWant; });
    }

    function markVictim(i) {
      var s = seat(i);
      core.state.victim = s ? s.id : null;
      return wait(460);
    }

    function setSpeaking(i, on) {
      var s = seat(i);
      if (s) s.speaking = !!on && s.alive;
    }

    function killAnim(i, role) {
      var s = seat(i);
      if (!s || !s.alive) return Promise.resolve();
      core.shake(1);
      if (role) s.revealed = role;
      s.speaking = false;
      s.alive = false;
      s.dead = { t0: now() };
      return wait(calm ? 120 : 980);
    }

    /* --------------------------------------------------------------------- */
    /* голосование                                                           */
    /* --------------------------------------------------------------------- */
    function showVoteArrow(from, to) {
      var a = seat(from), b = seat(to);
      if (!a || !b) return Promise.resolve();
      var arrow = { from: a.id, to: b.id, k: 0 };
      core.state.arrows.push(arrow);
      b.votes = (b.votes || 0) + 1;
      return tween(280, function (t) { arrow.k = t; }).then(function () { arrow.k = 1; });
    }

    function clearArrows() {
      core.state.arrows = [];
      core.seats().forEach(function (s) { s.votes = 0; });
      return Promise.resolve();
    }

    /* Финал: карты открываются по кругу, одна за другой. Раньше это был
       облёт камерой; на плоской сцене облетать нечего, зато порядок
       раскрытия читается даже лучше. */
    function finalOrbit(roles) {
      var list = core.seats();
      var step = calm ? 40 : 170;
      var chain = Promise.resolve();
      list.forEach(function (s, i) {
        if (s.revealed) return;
        chain = chain.then(function () {
          s.revealed = (roles && roles[i]) || deck.armed[i] || null;
          return wait(step);
        });
      });
      return chain.then(function () { return wait(calm ? 80 : 480); });
    }

    /* --------------------------------------------------------------------- */
    /* вид, кадр, служебное                                                  */
    /* --------------------------------------------------------------------- */
    function setBright(on) {
      bright = on === undefined ? !bright : !!on;
      core.state.bright = bright ? 1 : 0;
      return bright;
    }

    /* На плоской сцене «вид сверху» — это не полёт камеры, а распрямление
       овала: стол становится планом, и весь состав виден разом. Для стола на
       двадцать человек это ровно то, зачем кнопку и нажимают. */
    function topView(on) {
      var want = on === undefined ? !top : !!on;
      if (want === top) return top;
      top = want;
      var from = core.state.plan;
      var to = want ? 1 : core.state.night * 0.18;
      tween(560, function (t) {
        core.state.plan = from + (to - from) * t;
        core.layout();
      });
      return top;
    }
    function isTopView() { return top; }

    function project(i, yOff) { return core ? core.project(seatId(i), yOff) : null; }
    function seatId(i) { var s = seat(i); return s ? s.id : i; }

    function tick(t) {
      if (!core) return;
      t = t === undefined ? now() : t;
      runTweens(t);
      if (global.document && global.document.hidden) return;
      core.draw(t);
    }

    /* Мгновенная смерть: без толчка стола и без ожидания. Нужна ровно тогда,
       когда декорацию сменили посреди партии и новая сцена догоняет стол —
       падение уже случилось на прошлой сцене, второй раз его не показывают. */
    function setDeadInstant(i, role) {
      var s = seat(i);
      if (!s || !s.alive) return;
      if (role) s.revealed = role;
      s.speaking = false;
      s.alive = false;
      s.dead = { t0: now() - 2000 };
    }

    function resize() { if (core) core.resize(); }

    /* Спрятать декорацию, не разбирая её: при переключении вида вторая сцена
       остаётся собранной, и возврат к ней мгновенный. */
    function setVisible(on) {
      if (core && core.canvas) core.canvas.style.display = on ? 'block' : 'none';
    }

    function dispose() {
      tweens.forEach(function (tw) { try { tw.done(); } catch (e) { } });
      tweens = [];
      if (core) core.dispose();
      core = null;
    }

    /* Слепок состояния: нужен, чтобы при смене декораций новая сцена начала
       не с чистого листа, а с того, что уже произошло за столом. */
    function snapshot() {
      if (!core) return null;
      return {
        night: core.state.night,
        glow: core.state.glow,
        bright: bright,
        top: top,
        deal: core.state.deal,
        victim: core.state.victim,
        seats: core.seats().map(function (s) {
          return { alive: s.alive, revealed: s.revealed, speaking: s.speaking, votes: s.votes };
        })
      };
    }

    function restore(snap) {
      if (!core || !snap) return;
      core.state.night = snap.night || 0;
      core.state.glow = snap.glow || 0;
      core.state.deal = snap.deal === undefined ? 1 : snap.deal;
      core.state.victim = snap.victim === undefined ? null : snap.victim;
      bright = snap.bright !== false;
      core.state.bright = bright ? 1 : 0;
      top = !!snap.top;
      core.state.plan = top ? 1 : core.state.night * 0.18;
      (snap.seats || []).forEach(function (row, i) {
        var s = seat(i);
        if (!s) return;
        s.revealed = row.revealed || null;
        s.votes = row.votes || 0;
        s.speaking = !!row.speaking;
        if (!row.alive && s.alive) { s.alive = false; s.dead = { t0: now() - 2000 }; }
      });
      core.layout();
    }

    return {
      init: init, setup: setup, resize: resize, armCard: armCard, dealCards: dealCards,
      toNight: toNight, toDay: toDay, mafiaGlow: mafiaGlow, markVictim: markVictim,
      setSpeaking: setSpeaking, killAnim: killAnim, flipCard: flipCard,
      showVoteArrow: showVoteArrow, clearArrows: clearArrows, finalOrbit: finalOrbit,
      project: project, tick: tick, setBright: setBright, topView: topView, isTopView: isTopView,
      dispose: dispose, snapshot: snapshot, restore: restore, setVisible: setVisible,
      /* Мгновенные состояния: нужны переключателю декораций, чтобы новая сцена
         догнала стол без повторных анимаций. */
      flipCardInstant: flipCard, setDeadInstant: setDeadInstant,
      is2D: true, mode: 'flat'
    };
  };
})(window);
