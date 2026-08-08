/* =========================================================================
   Curtain — заставка загрузки: театр теней за полотном.

   Ничего не грузится извне: всё рисуется на canvas. За натянутым полотном
   медленно проходят силуэты (шляпа, женская фигура, спинка стула, лампа),
   по полотну ходит свет, летит пыль, а внизу строками появляется шёпот.
   Полоска прогресса — не украшение: её двигает страница по мере того, как
   действительно готовы шрифты, сцена и данные.

     const c = Curtain.show({ title:'Мафия', lines:[...] });
     c.progress(0.4); c.note('Собираем стол');
     await c.close();
   ========================================================================= */
(function (w) {
  'use strict';

  var DEFAULT_LINES = [
    'город засыпает',
    'кто-то не спит',
    'считайте своих',
    'до утра дойдут не все'
  ];

  function show(opts) {
    opts = opts || {};
    var lines = opts.lines || DEFAULT_LINES;

    var root = document.createElement('div');
    root.className = 'curtain';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.innerHTML =
      '<canvas class="curtain-cv"></canvas>' +
      '<div class="curtain-mid">' +
      '<div class="curtain-title">' + (opts.title || 'Мафия') + '</div>' +
      '<div class="curtain-whisper" id="curtainWhisper"></div>' +
      '</div>' +
      '<div class="curtain-foot">' +
      '<div class="curtain-note" id="curtainNote">' + (opts.note || 'Готовим стол…') + '</div>' +
      '<div class="curtain-thread"><i id="curtainBar"></i></div>' +
      '</div>';
    document.body.appendChild(root);

    var cv = root.querySelector('.curtain-cv');
    var g = cv.getContext('2d');
    var bar = root.querySelector('#curtainBar');
    var note = root.querySelector('#curtainNote');
    var whisper = root.querySelector('#curtainWhisper');

    var W = 0, H = 0, dpr = Math.min(2, w.devicePixelRatio || 1);
    function resize() {
      W = root.clientWidth; H = root.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    w.addEventListener('resize', resize);

    /* пылинки */
    var dust = [];
    for (var i = 0; i < 70; i++) {
      dust.push({ x: Math.random(), y: Math.random(), v: 0.00004 + Math.random() * 0.00012, r: 0.5 + Math.random() * 1.6, p: Math.random() * 6.28 });
    }

    /* Силуэты. Рисуются заливкой в локальных координатах 0..1 по высоте. */
    var FIGS = [
      function hatMan(c, s) {                    // человек в шляпе
        c.beginPath();
        c.ellipse(0, -0.30 * s, 0.115 * s, 0.135 * s, 0, 0, 6.28); c.fill();
        c.beginPath();
        c.ellipse(0, -0.42 * s, 0.26 * s, 0.03 * s, 0, 0, 6.28); c.fill();
        c.fillRect(-0.12 * s, -0.55 * s, 0.24 * s, 0.14 * s);
        c.beginPath();
        c.moveTo(-0.23 * s, 0.5 * s); c.quadraticCurveTo(-0.2 * s, -0.18 * s, 0, -0.2 * s);
        c.quadraticCurveTo(0.2 * s, -0.18 * s, 0.23 * s, 0.5 * s); c.closePath(); c.fill();
      },
      function woman(c, s) {                     // женская фигура с узлом волос
        c.beginPath(); c.ellipse(0, -0.32 * s, 0.1 * s, 0.125 * s, 0, 0, 6.28); c.fill();
        c.beginPath(); c.ellipse(-0.02 * s, -0.44 * s, 0.075 * s, 0.06 * s, 0, 0, 6.28); c.fill();
        c.beginPath();
        c.moveTo(-0.2 * s, 0.5 * s); c.quadraticCurveTo(-0.13 * s, -0.16 * s, 0, -0.22 * s);
        c.quadraticCurveTo(0.13 * s, -0.16 * s, 0.2 * s, 0.5 * s); c.closePath(); c.fill();
      },
      function chair(c, s) {                     // венский стул
        c.fillRect(-0.19 * s, 0.02 * s, 0.38 * s, 0.035 * s);
        c.fillRect(-0.18 * s, 0.05 * s, 0.028 * s, 0.45 * s);
        c.fillRect(0.152 * s, 0.05 * s, 0.028 * s, 0.45 * s);
        c.beginPath();
        c.arc(0, -0.16 * s, 0.19 * s, 3.14, 6.28); c.lineTo(0.17 * s, 0.02 * s);
        c.lineTo(-0.17 * s, 0.02 * s); c.closePath(); c.fill();
      },
      function lamp(c, s) {                      // лампа на шнуре
        c.fillRect(-0.006 * s, -0.62 * s, 0.012 * s, 0.34 * s);
        c.beginPath();
        c.moveTo(-0.2 * s, -0.2 * s); c.lineTo(0.2 * s, -0.2 * s);
        c.lineTo(0.07 * s, -0.3 * s); c.lineTo(-0.07 * s, -0.3 * s);
        c.closePath(); c.fill();
      }
    ];
    var actors = FIGS.map(function (fn, k) {
      return { fn: fn, x: (k + 0.5) / FIGS.length, sp: (k % 2 ? 1 : -1) * (0.00003 + k * 0.000015), sc: 0.8 + (k % 3) * 0.16 };
    });

    var t0 = performance.now(), raf = 0, closing = 0, prog = 0, progShown = 0, alive = true;
    var lineIdx = -1, lineAt = 0;

    function frame(now) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      var t = now - t0;

      /* --- полотно: подсвеченное изнутри, с мерцанием --- */
      var flick = 0.9 + Math.sin(t * 0.004) * 0.04 + (Math.random() < 0.02 ? -0.12 : 0);
      g.clearRect(0, 0, W, H);
      var grd = g.createRadialGradient(W * 0.5, H * 0.42, 10, W * 0.5, H * 0.42, Math.max(W, H) * 0.72);
      grd.addColorStop(0, 'rgba(226,180,120,' + (0.30 * flick).toFixed(3) + ')');
      grd.addColorStop(0.45, 'rgba(120,80,60,' + (0.16 * flick).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(5,4,5,1)');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);

      /* складки полотна */
      g.save();
      for (var x = 0; x < W; x += 34) {
        var k = Math.sin(x * 0.03 + t * 0.0004);
        g.fillStyle = k > 0 ? 'rgba(255,240,220,.022)' : 'rgba(0,0,0,.09)';
        g.fillRect(x, 0, 34, H);
      }
      g.restore();

      /* --- силуэты за полотном --- */
      var baseY = H * 0.72, s = Math.min(W, H) * 0.9;
      g.save();
      g.fillStyle = 'rgba(6,5,6,.82)';
      g.filter = 'blur(1.5px)';
      actors.forEach(function (a) {
        a.x += a.sp * 16;
        if (a.x > 1.25) a.x = -0.25;
        if (a.x < -0.25) a.x = 1.25;
        var px = a.x * W;
        var sway = Math.sin(t * 0.0009 + a.x * 6) * 0.02;
        g.save();
        g.translate(px, baseY);
        g.scale(a.sc * (1 + sway), a.sc * (1 - sway));
        a.fn(g, s * 0.55);
        g.restore();
      });
      g.restore();

      /* --- пыль --- */
      g.fillStyle = 'rgba(255,236,206,.5)';
      dust.forEach(function (d) {
        d.y -= d.v * 16 * 60;
        if (d.y < -0.05) { d.y = 1.05; d.x = Math.random(); }
        var px = (d.x + Math.sin(t * 0.0005 + d.p) * 0.01) * W;
        g.globalAlpha = 0.15 + Math.abs(Math.sin(t * 0.001 + d.p)) * 0.4;
        g.beginPath(); g.arc(px, d.y * H, d.r, 0, 6.28); g.fill();
      });
      g.globalAlpha = 1;

      /* --- шёпот: строки сменяют друг друга --- */
      if (now - lineAt > 2600) {
        lineAt = now;
        lineIdx = (lineIdx + 1) % lines.length;
        whisper.textContent = lines[lineIdx];
        whisper.classList.remove('in');
        void whisper.offsetWidth;
        whisper.classList.add('in');
      }

      /* --- прогресс: догоняем цель, а не прыгаем --- */
      progShown += (prog - progShown) * 0.08;
      bar.style.width = (progShown * 100).toFixed(1) + '%';

      if (closing) {
        var k2 = Math.min(1, (now - closing) / 620);
        root.style.opacity = String(1 - k2);
        if (k2 >= 1) destroy();
      }
    }
    raf = requestAnimationFrame(frame);

    function destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      w.removeEventListener('resize', resize);
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    return {
      el: root,
      progress: function (v) { prog = Math.max(prog, Math.max(0, Math.min(1, v))); },
      note: function (text) { note.textContent = text; },
      close: function () {
        prog = 1;
        return new Promise(function (res) {
          setTimeout(function () {
            closing = performance.now();
            setTimeout(res, 660);
          }, 220);
        });
      },
      destroy: destroy
    };
  }

  w.Curtain = { show: show, LINES: DEFAULT_LINES };
})(window);
