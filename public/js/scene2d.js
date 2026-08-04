/* =============================================================================
   scene2d.js — запасная 2D-сцена стола на canvas: работает без интернета и без WebGL.
   ============================================================================= */
(function (global) {
  'use strict';

  var ROLE_VIS = {
    mafia:    { ru: '\u041c\u0410\u0424\u0418\u042f',            glyph: '\u265f', color: '#c2413a' },
    doctor:   { ru: '\u0414\u041e\u041a\u0422\u041e\u0420',      glyph: '\u271a', color: '#6fae7d' },
    sheriff:  { ru: '\u0428\u0415\u0420\u0418\u0424',            glyph: '\u2605', color: '#5f93c4' },
    civilian: { ru: '\u041c\u0418\u0420\u041d\u042b\u0419 \u0416\u0418\u0422\u0415\u041b\u042c', glyph: '\u2302', color: '#efe6d6' }
  };

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  global.createScene2D = function createScene2D() {
    var canvas = null, ctx = null, host = null;
    var W = 0, H = 0, DPR = 1;
    var seats = [];
    var night = false, bright = true, top = false;
    var glow = 0, glowWant = 0;
    var arrows = [];
    var victim = -1, shakeUntil = 0;
    var dealProgress = 0;
    var tweens = [];
    var started = 0;

    function tween(ms, fn) {
      return new Promise(function (res) {
        var t0 = (global.performance || Date).now();
        tweens.push({ t0: t0, ms: ms, fn: fn, done: res });
      });
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function runTweens(now) {
      for (var i = tweens.length - 1; i >= 0; i--) {
        var tw = tweens[i];
        var t = clamp((now - tw.t0) / tw.ms, 0, 1);
        try { tw.fn(easeInOut(t), t); } catch (e) {}
        if (t >= 1) { tweens.splice(i, 1); tw.done(); }
      }
    }

    /* ---------- геометрия и размеры ---------- */
    function resize() {
      if (!canvas || !host) return;
      DPR = Math.min(global.devicePixelRatio || 1, 2.5);
      W = host.clientWidth || global.innerWidth || 320;
      H = host.clientHeight || global.innerHeight || 480;
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      layout();
    }

    function geom() {
      var cx = W / 2, cy = H / 2;
      /* овал стола всегда с запасом по краям — ничего не выезжает за экран */
      var pad = Math.max(46, Math.min(W, H) * 0.16);
      var rx = Math.max(60, W / 2 - pad);
      var ry = Math.max(46, H / 2 - pad);
      if (rx > ry * 2.1) rx = ry * 2.1;
      var scale = clamp(Math.min(W, H) / 620, 0.62, 1.35);
      return { cx: cx, cy: cy, rx: rx, ry: ry, scale: scale };
    }

    function layout() {
      var g = geom(), n = seats.length;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2 + Math.PI / 2;
        var s = seats[i];
        s.x = g.cx + Math.cos(a) * g.rx;
        s.y = g.cy + Math.sin(a) * g.ry * 0.94;
        s.a = a;
        s.r = clamp(Math.min(g.rx, g.ry) / (n * 0.42), 13, 30) * (n > 10 ? 0.92 : 1);
      }
    }

    /* ---------- публичный API (тот же, что у 3D-сцены) ---------- */
    function init(container) {
      host = container;
      canvas = document.createElement('canvas');
      canvas.className = 'scene2d-canvas';
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      container.appendChild(canvas);
      ctx = canvas.getContext('2d');
      started = (global.performance || Date).now();
      resize();
    }

    function setup(list) {
      seats = list.map(function (p, i) {
        return {
          idx: i, name: p.name, color: p.color || '#caa96b', isHuman: !!p.isHuman,
          alive: true, speaking: false, flipped: false, role: null, armed: null,
          x: 0, y: 0, a: 0, r: 20, pulse: 0
        };
      });
      arrows = []; victim = -1; dealProgress = 0;
      layout();
    }

    function armCard(i, role) { if (seats[i]) seats[i].armed = role; }

    async function dealCards() {
      await tween(700, function (t) { dealProgress = t; });
      dealProgress = 1;
    }

    async function toNight() { night = true; await tween(520, function () {}); }
    async function toDay() { night = false; victim = -1; await tween(520, function () {}); }

    async function mafiaGlow(on) {
      glowWant = on ? 1 : 0;
      await tween(330, function (t) { glow = on ? t : 1 - t; });
      glow = glowWant;
    }

    async function markVictim(i) { victim = i; await wait(420); }

    function setSpeaking(i, on) { if (seats[i]) seats[i].speaking = !!on; }

    async function killAnim(i, role) {
      var s = seats[i];
      if (!s) return;
      shakeUntil = (global.performance || Date).now() + 420;
      if (role) { s.role = role; s.flipped = true; }
      await tween(520, function (t) { s.pulse = 1 - t; });
      s.alive = false; s.speaking = false; s.pulse = 0;
    }

    function flipCard(i, role) { if (seats[i]) { seats[i].role = role; seats[i].flipped = true; } }

    async function showVoteArrow(from, to) {
      if (!seats[from] || !seats[to]) return;
      var arrow = { from: from, to: to, k: 0 };
      arrows.push(arrow);
      await tween(260, function (t) { arrow.k = t; });
      arrow.k = 1;
    }

    async function clearArrows() { arrows = []; }

    async function finalOrbit(roles) {
      for (var i = 0; i < seats.length; i++) {
        if (!seats[i].flipped) { flipCard(i, roles[i]); await wait(150); }
      }
      await wait(500);
    }

    function project(i, yOff) {
      var s = seats[i];
      if (!s) return null;
      var lift = (yOff === undefined ? 1 : clamp(yOff / 2.26, 0.4, 1.6));
      return { x: s.x, y: s.y - s.r * 2.1 * lift, visible: true };
    }

    function setBright(on) { bright = (on === undefined) ? !bright : !!on; return bright; }
    function isTopView() { return top; }
    function topView(on) { top = (on === undefined) ? !top : !!on; return top; }

    /* ---------- отрисовка ---------- */
    function roomBg(now) {
      var g = geom();
      var base = ctx.createRadialGradient(g.cx, g.cy * 0.86, 10, g.cx, g.cy, Math.max(W, H) * 0.78);
      if (night) { base.addColorStop(0, '#1b2033'); base.addColorStop(1, '#07080e'); }
      else if (!bright) { base.addColorStop(0, '#2a2118'); base.addColorStop(1, '#0b0a0d'); }
      else { base.addColorStop(0, '#3a2c1f'); base.addColorStop(1, '#0d0c12'); }
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);

      if (glow > 0.01) {
        var rg = ctx.createRadialGradient(g.cx, g.cy, 8, g.cx, g.cy, Math.max(W, H) * 0.6);
        rg.addColorStop(0, 'rgba(255,43,43,' + (0.22 * glow).toFixed(3) + ')');
        rg.addColorStop(1, 'rgba(255,43,43,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, W, H);
      }
      /* тёплый свет лампы над столом */
      var flick = 0.9 + Math.sin(now / 420) * 0.05 + Math.sin(now / 137) * 0.02;
      var lamp = ctx.createRadialGradient(g.cx, g.cy - g.ry * 0.5, 4, g.cx, g.cy, Math.max(g.rx, g.ry) * 1.5);
      lamp.addColorStop(0, 'rgba(255,214,148,' + (night ? 0.10 : 0.20 * flick).toFixed(3) + ')');
      lamp.addColorStop(1, 'rgba(255,214,148,0)');
      ctx.fillStyle = lamp;
      ctx.fillRect(0, 0, W, H);
    }

    function drawTable() {
      var g = geom();
      var tr = { rx: g.rx * 0.66, ry: g.ry * 0.62 };
      ctx.save();
      ctx.translate(g.cx, g.cy);
      ctx.beginPath();
      ctx.ellipse(0, 8, tr.rx + 8, tr.ry + 8, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fill();

      var felt = ctx.createRadialGradient(0, -tr.ry * 0.3, 6, 0, 0, Math.max(tr.rx, tr.ry));
      felt.addColorStop(0, night ? '#25415c' : '#2f6046');
      felt.addColorStop(1, night ? '#111c2b' : '#153122');
      ctx.beginPath();
      ctx.ellipse(0, 0, tr.rx, tr.ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = felt;
      ctx.fill();
      ctx.lineWidth = Math.max(3, g.scale * 6);
      ctx.strokeStyle = '#4a3320';
      ctx.stroke();

      /* колода карт в центре */
      if (dealProgress < 1) {
        var cw = 12 * g.scale, ch = 17 * g.scale;
        ctx.fillStyle = '#7a1f28';
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        for (var k = 0; k < 5; k++) {
          ctx.save();
          ctx.rotate((k - 2) * 0.05);
          ctx.translate(0, -k * 1.2);
          rrect(-cw / 2, -ch / 2, cw, ch, 2.5);
          ctx.fill(); ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }

    function rrect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* текст с автоподбором кегля: длинное имя никогда не вылезает за плашку */
    function fitText(text, maxW, startPx, minPx, weight) {
      var px = startPx;
      var fam = '"Golos Text", "Segoe UI", system-ui, -apple-system, Arial, sans-serif';
      ctx.font = (weight || 600) + ' ' + px + 'px ' + fam;
      while (px > minPx && ctx.measureText(text).width > maxW) {
        px -= 0.5;
        ctx.font = (weight || 600) + ' ' + px + 'px ' + fam;
      }
      var out = text;
      if (ctx.measureText(out).width > maxW) {
        while (out.length > 1 && ctx.measureText(out + '\u2026').width > maxW) out = out.slice(0, -1);
        out += '\u2026';
      }
      return out;
    }

    function drawSeat(s, now) {
      var g = geom();
      var r = s.r;
      ctx.save();
      ctx.translate(s.x, s.y);

      if (s.speaking) {
        var pr = 1 + Math.sin(now / 240) * 0.06;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.7 * pr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(201,162,39,.16)';
        ctx.fill();
      }
      if (victim === s.idx) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(230,60,60,.85)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      /* плечи */
      ctx.beginPath();
      ctx.ellipse(0, r * 0.95, r * 1.15, r * 0.9, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = s.alive ? shade(s.color, night ? -0.45 : -0.15) : '#3a3a42';
      ctx.fill();

      /* голова */
      ctx.beginPath();
      ctx.arc(0, -r * 0.25, r * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = s.alive ? (night ? '#8e7f74' : '#d9b79a') : '#5b5b63';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(0,0,0,.4)';
      ctx.stroke();

      if (s.isHuman) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(201,162,39,.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (!s.alive) {
        ctx.strokeStyle = 'rgba(220,70,70,.9)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(-r * 0.75, -r * 1.0); ctx.lineTo(r * 0.75, r * 0.5);
        ctx.moveTo(r * 0.75, -r * 1.0); ctx.lineTo(-r * 0.75, r * 0.5);
        ctx.stroke();
      }
      ctx.restore();

      /* табличка с именем: всегда внутри экрана и никогда не обрезается */
      var plateW = clamp(r * 5.2, 78, 172);
      var plateH = clamp(r * 1.5, 22, 34);
      var px = clamp(s.x - plateW / 2, 4, Math.max(4, W - plateW - 4));
      var py = clamp(s.y + r * 1.7, 4, Math.max(4, H - plateH - 4));

      ctx.save();
      ctx.globalAlpha = s.alive ? 1 : 0.6;
      rrect(px, py, plateW, plateH, 6);
      ctx.fillStyle = 'rgba(14,12,16,.82)';
      ctx.fill();
      ctx.strokeStyle = s.isHuman ? 'rgba(201,162,39,.85)' : 'rgba(255,255,255,.14)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var label = fitText(s.name, plateW - 14, Math.min(15, plateH * 0.52), 8.5, 600);
      ctx.fillStyle = s.isHuman ? '#e8cf8a' : '#e8dcc6';
      ctx.fillText(label, px + plateW / 2, py + plateH / 2 + 0.5);
      ctx.restore();

      /* раскрытая роль */
      if (s.flipped && s.role && ROLE_VIS[s.role]) {
        var meta = ROLE_VIS[s.role];
        var cw = clamp(r * 4.6, 66, 150), chh = clamp(r * 1.3, 18, 28);
        var cxp = clamp(s.x - cw / 2, 4, Math.max(4, W - cw - 4));
        var cyp = clamp(py + plateH + 3, 4, Math.max(4, H - chh - 4));
        ctx.save();
        rrect(cxp, cyp, cw, chh, 5);
        ctx.fillStyle = 'rgba(240,231,214,.94)';
        ctx.fill();
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var rl = fitText(meta.glyph + ' ' + meta.ru, cw - 10, Math.min(12.5, chh * 0.6), 7.5, 700);
        ctx.fillStyle = shade(meta.color, -0.35);
        ctx.fillText(rl, cxp + cw / 2, cyp + chh / 2 + 0.5);
        ctx.restore();
      }
    }

    function shade(hex, k) {
      var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '#caa96b'));
      if (!m) return hex;
      var c = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].map(function (v) {
        return clamp(Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k), 0, 255);
      });
      return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }

    function drawArrows() {
      ctx.save();
      ctx.lineCap = 'round';
      arrows.forEach(function (ar) {
        var a = seats[ar.from], b = seats[ar.to];
        if (!a || !b) return;
        var x2 = a.x + (b.x - a.x) * ar.k, y2 = a.y + (b.y - a.y) * ar.k;
        ctx.strokeStyle = 'rgba(201,162,39,.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (ar.k > 0.92) {
          var ang = Math.atan2(b.y - a.y, b.x - a.x);
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x - Math.cos(ang - 0.4) * 11, b.y - Math.sin(ang - 0.4) * 11);
          ctx.lineTo(b.x - Math.cos(ang + 0.4) * 11, b.y - Math.sin(ang + 0.4) * 11);
          ctx.closePath();
          ctx.fillStyle = 'rgba(201,162,39,.8)';
          ctx.fill();
        }
      });
      ctx.restore();
    }

    var lastFrame = 0;
    function tick(now) {
      if (!ctx) return;
      if (now - lastFrame < 16) return;
      lastFrame = now;
      runTweens(now);

      var shake = 0;
      if (now < shakeUntil) shake = Math.sin(now / 22) * 3;

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      if (shake) ctx.translate(shake, shake * 0.4);
      roomBg(now);
      drawTable();
      /* дальние места рисуем раньше — правильное перекрытие фигур */
      seats.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (s) { drawSeat(s, now); });
      drawArrows();
      ctx.restore();
    }

    return {
      init: init, setup: setup, resize: resize, armCard: armCard, dealCards: dealCards,
      toNight: toNight, toDay: toDay, mafiaGlow: mafiaGlow, markVictim: markVictim,
      setSpeaking: setSpeaking, killAnim: killAnim, flipCard: flipCard,
      showVoteArrow: showVoteArrow, clearArrows: clearArrows, finalOrbit: finalOrbit,
      project: project, tick: tick, setBright: setBright, topView: topView, isTopView: isTopView,
      is2D: true
    };
  };
})(window);
