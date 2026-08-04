/* =========================================================================
   models3d.js — общая мастерская сцены.

   Здесь живут все декорации и фигуры: комната, стол, лампа, стулья, люди,
   карты и таблички. Модуль ничего не знает ни о правилах партии, ни о DOM —
   он только строит объекты three.js и отдаёт наружу ручки для анимации.

   Так режим с ботами и сетевой режим получают буквально одну и ту же сцену:
   раньше 3D была только у ботов, а по сети игроки видели плоскую сетку
   карточек — отсюда и жалоба на «очень кривые модельки».

   three.js передаётся параметром, потому что страницы грузят его по-разному
   (бот-режим — динамическим импортом с проверкой WebGL).

     import { createModels } from '/js/models3d.js';
     const M = createModels(THREE, { ROLE, ROLE_INFO });
   ========================================================================= */

export function createModels(THREE, cfg) {
  cfg = cfg || {};

  const ROLE = cfg.ROLE || { MAFIA: 'mafia', DON: 'don', DOCTOR: 'doctor', SHERIFF: 'sheriff', CIVILIAN: 'civilian' };
  const ROLE_INFO = cfg.ROLE_INFO || {
    mafia: { ru: 'Мафия' }, don: { ru: 'Дон' }, doctor: { ru: 'Доктор' },
    sheriff: { ru: 'Шериф' }, civilian: { ru: 'Мирный' }
  };

  /* ---------------------------------------------------------------------
     Палитра сцены. Держим её здесь, а не в CSS: это краски декораций.
     Ни золота, ни «нуарного» лака — извёстка, крашеное дерево, медь,
     сукно и свет сальной свечи.
     --------------------------------------------------------------------- */
  const PAL = {
    plaster: 0x8d8375,      // стены
    plasterDark: 0x4a423b,
    board: 0x4a3a2c,        // половая доска
    boardDark: 0x2e241c,
    cloth: 0x5d4b52,        // полотняный задник
    felt: 0x3f4a44,         // сукно на столе
    wood: 0x40301f,         // точёная мебель
    woodDark: 0x281d14,
    enamel: 0x3f5b52,       // эмаль абажура
    brass: 0x8a6a3c,
    tallow: 0xe2b478,       // свет
    ember: 0xc4563a,
    bone: 0xefe9dd
  };

  /* --- качество: на слабых и мобильных устройствах режем сетку --- */
  const LOWQ = (() => {
    try {
      if (typeof matchMedia === 'undefined') return false;
      const small = matchMedia('(max-width: 860px)').matches;
      const weak = (navigator.hardwareConcurrency || 8) <= 4;
      return small || weak;
    } catch (e) { return false; }
  })();
  const sg = (hi, lo) => (LOWQ ? lo : hi);

  /* --- служебное --- */
  function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function texFromCanvas(c, repeat) {
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    t.needsUpdate = true;
    return t;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  function prng(seed) {
    let s = ((seed | 0) * 1664525 + 1013904223) & 0x7fffffff;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  function noisify(g, w, h, amp) {
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amp;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }

  const hex = (c) => '#' + new THREE.Color(c).getHexString();

  /* =====================================================================
     ТЕКСТУРЫ ДЕКОРАЦИЙ
     ===================================================================== */

  /* Половая доска: тёплое дерево, продольные волокна, тёмные щели. */
  function plankCanvas() {
    const W = 512, H = 512;
    const c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = hex(PAL.board); g.fillRect(0, 0, W, H);
    const plank = 74;
    for (let y = 0; y < H; y += plank) {
      const shade = 0.86 + Math.random() * 0.3;
      g.fillStyle = 'rgba(0,0,0,' + (0.2 - shade * 0.12).toFixed(3) + ')';
      g.fillRect(0, y, W, plank);
      /* волокна */
      for (let k = 0; k < 26; k++) {
        g.strokeStyle = 'rgba(0,0,0,' + (0.03 + Math.random() * 0.06).toFixed(3) + ')';
        g.lineWidth = 0.6 + Math.random() * 1.6;
        const yy = y + Math.random() * plank;
        g.beginPath();
        g.moveTo(0, yy);
        g.bezierCurveTo(W * 0.3, yy + (Math.random() - 0.5) * 8, W * 0.7, yy + (Math.random() - 0.5) * 8, W, yy);
        g.stroke();
      }
      /* щель между досками */
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, y, W, 2.5);
      /* стыки вразбежку */
      const jx = Math.random() * W;
      g.fillStyle = 'rgba(0,0,0,.42)'; g.fillRect(jx, y, 2, plank);
    }
    noisify(g, W, H, 16);
    return c;
  }

  /* Штукатурка: побелка с проступающей кладкой, потёками и трещинами. */
  function plasterCanvas() {
    const W = 1024, H = 512;
    const c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = hex(PAL.plaster); g.fillRect(0, 0, W, H);

    /* пятна сырости */
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = 30 + Math.random() * 130;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(46,36,28,' + (0.05 + Math.random() * 0.12).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(46,36,28,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    /* вертикальные потёки от протечек */
    for (let i = 0; i < 22; i++) {
      const x = Math.random() * W;
      g.strokeStyle = 'rgba(30,22,18,' + (0.05 + Math.random() * 0.1).toFixed(3) + ')';
      g.lineWidth = 4 + Math.random() * 22;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 30, H * (0.4 + Math.random() * 0.6)); g.stroke();
    }
    /* трещины: ветвящаяся ломаная, светлая сверху и тёмная в глубине */
    function crack(x, y, len, ang, depth) {
      if (len < 6 || depth > 4) return;
      const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
      g.strokeStyle = 'rgba(18,13,11,.55)'; g.lineWidth = Math.max(0.7, 2.6 - depth * 0.5);
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      g.strokeStyle = 'rgba(226,214,190,.22)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x + 1.2, y - 1.2); g.lineTo(nx + 1.2, ny - 1.2); g.stroke();
      crack(nx, ny, len * (0.55 + Math.random() * 0.3), ang + (Math.random() - 0.5) * 1.1, depth + 1);
      if (Math.random() > 0.5) crack(nx, ny, len * 0.45, ang + (Math.random() - 0.5) * 1.8, depth + 1);
    }
    for (let i = 0; i < 9; i++) crack(Math.random() * W, Math.random() * H * 0.8, 40 + Math.random() * 70, Math.random() * Math.PI * 2, 0);

    /* обвалившаяся штукатурка: проступает кирпич */
    for (let i = 0; i < 5; i++) {
      const x = Math.random() * W, y = H * (0.3 + Math.random() * 0.6), w = 60 + Math.random() * 90, h = 40 + Math.random() * 60;
      g.save();
      g.beginPath(); g.ellipse(x, y, w / 2, h / 2, Math.random(), 0, Math.PI * 2); g.clip();
      g.fillStyle = '#4a3128'; g.fillRect(x - w, y - h, w * 2, h * 2);
      g.strokeStyle = 'rgba(20,14,12,.6)'; g.lineWidth = 2;
      for (let by = y - h; by < y + h; by += 13) { g.beginPath(); g.moveTo(x - w, by); g.lineTo(x + w, by); g.stroke(); }
      for (let bx = x - w, r = 0; bx < x + w; bx += 27, r++) { g.beginPath(); g.moveTo(bx + (r % 2 ? 13 : 0), y - h); g.lineTo(bx + (r % 2 ? 13 : 0), y + h); g.stroke(); }
      g.restore();
    }
    noisify(g, W, H, 12);
    return c;
  }

  /* Полотняный задник: грубая ткань крупными вертикальными складками. */
  function backdropCanvas() {
    const W = 1024, H = 512;
    const c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = hex(PAL.cloth); g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 26) {
      const k = (Math.sin(x * 0.06) + Math.sin(x * 0.017) * 1.4) * 0.5;
      g.fillStyle = k > 0 ? 'rgba(255,240,220,' + (0.03 + k * 0.05).toFixed(3) + ')'
        : 'rgba(0,0,0,' + (0.06 - k * 0.16).toFixed(3) + ')';
      g.fillRect(x, 0, 26, H);
    }
    /* подшивка снизу и пятна от пыли */
    g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(0, H - 46, W, 46);
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * W, y = H * (0.55 + Math.random() * 0.45), r = 20 + Math.random() * 70;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(20,14,14,.16)'); grd.addColorStop(1, 'rgba(20,14,14,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    noisify(g, W, H, 14);
    return c;
  }

  /* Сукно на столе: ворс, вытертый круг посередине, штопка по краю. */
  function feltCanvas() {
    const W = 512, H = 512;
    const c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = hex(PAL.felt); g.fillRect(0, 0, W, H);
    noisify(g, W, H, 26);
    const grd = g.createRadialGradient(256, 256, 20, 256, 256, 250);
    grd.addColorStop(0, 'rgba(230,214,186,.10)');
    grd.addColorStop(0.65, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,.34)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    /* потёртости: светлые дуги там, где годами лежали локти */
    for (let i = 0; i < 10; i++) {
      g.strokeStyle = 'rgba(226,214,186,' + (0.03 + Math.random() * 0.05).toFixed(3) + ')';
      g.lineWidth = 6 + Math.random() * 16;
      const a = Math.random() * Math.PI * 2, r = 150 + Math.random() * 80;
      g.beginPath(); g.arc(256, 256, r, a, a + 0.5 + Math.random()); g.stroke();
    }
    g.strokeStyle = 'rgba(20,16,14,.5)'; g.lineWidth = 3;
    g.beginPath(); g.arc(256, 256, 236, 0, Math.PI * 2); g.stroke();
    return c;
  }

  /* Рубашка карты: тёмный бордо и медный узор. */
  function cardBackCanvas() {
    const c = cvs(256, 352), g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 352);
    grd.addColorStop(0, '#43171d'); grd.addColorStop(1, '#200c10');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 352);
    g.strokeStyle = 'rgba(226,180,120,.7)'; g.lineWidth = 4; g.strokeRect(12, 12, 232, 328);
    g.strokeStyle = 'rgba(226,180,120,.3)'; g.lineWidth = 2; g.strokeRect(24, 24, 208, 304);
    g.save(); g.translate(128, 176);
    g.strokeStyle = 'rgba(226,180,120,.45)';
    for (let i = 0; i < 12; i++) { g.rotate(Math.PI / 6); g.beginPath(); g.ellipse(0, -70, 16, 44, 0, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = 'rgba(226,180,120,.8)';
    g.beginPath(); g.arc(0, 0, 14, 0, Math.PI * 2); g.fill();
    g.restore();
    return c;
  }

  /* Лицо карты: знак роли и название с автоподбором кегля. */
  function cardFaceCanvas(role) {
    const S = 2;
    const c = cvs(256 * S, 352 * S), g = c.getContext('2d');
    g.scale(S, S);
    const grd = g.createLinearGradient(0, 0, 0, 352);
    grd.addColorStop(0, '#fbf5e8'); grd.addColorStop(1, '#e9dcc4');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 352);
    g.strokeStyle = '#33161a'; g.lineWidth = 5; g.strokeRect(11, 11, 234, 330);
    g.strokeStyle = 'rgba(51,22,26,.3)'; g.lineWidth = 1.5; g.strokeRect(19, 19, 218, 314);

    g.save(); g.translate(128, 144);
    g.lineJoin = 'round';
    if (role === ROLE.MAFIA) {                       // шляпа
      g.fillStyle = '#1a1013';
      g.beginPath(); g.ellipse(0, 42, 74, 15, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(-40, 38); g.quadraticCurveTo(-46, -42, 0, -46); g.quadraticCurveTo(46, -42, 40, 38); g.closePath(); g.fill();
      g.fillStyle = '#7d2a24'; g.fillRect(-42, 18, 84, 14);
    } else if (role === ROLE.DON) {                  // пиковый знак
      g.fillStyle = '#1a1013';
      g.beginPath();
      g.moveTo(0, -58); g.bezierCurveTo(44, -14, 62, 6, 62, 26);
      g.bezierCurveTo(62, 46, 40, 54, 24, 42);
      g.lineTo(34, 62); g.lineTo(-34, 62); g.lineTo(-24, 42);
      g.bezierCurveTo(-40, 54, -62, 46, -62, 26);
      g.bezierCurveTo(-62, 6, -44, -14, 0, -58);
      g.closePath(); g.fill();
    } else if (role === ROLE.DOCTOR) {               // крест
      g.fillStyle = '#8a221e';
      g.fillRect(-19, -58, 38, 116); g.fillRect(-58, -19, 116, 38);
    } else if (role === ROLE.SHERIFF) {              // жетон
      g.fillStyle = '#9c7a34'; g.beginPath();
      for (let i = 0; i < 14; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 7, r = i % 2 ? 26 : 62;
        g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      g.fillStyle = '#f2e9d8'; g.beginPath(); g.arc(0, 0, 15, 0, Math.PI * 2); g.fill();
    } else {                                         // дом
      g.fillStyle = '#3c5a4c';
      g.beginPath(); g.moveTo(0, -58); g.lineTo(62, -2); g.lineTo(40, -2); g.lineTo(40, 56);
      g.lineTo(-40, 56); g.lineTo(-40, -2); g.lineTo(-62, -2); g.closePath(); g.fill();
      g.fillStyle = '#d9cdb4'; g.fillRect(-13, 14, 26, 42);
    }
    g.restore();

    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const PX = 22, PW = 212, PY = 256, PH = 48;
    g.fillStyle = '#33161a';
    roundRect(g, PX, PY, PW, PH, 8); g.fill();

    const title = (ROLE_INFO[role] || { ru: '—' }).ru.toUpperCase();
    const maxW = PW - 26;
    let size = 34;
    const font = (s) => 'bold ' + s + 'px Bitter, Georgia, serif';
    g.font = font(size);
    while (size > 15 && g.measureText(title).width > maxW) { size -= 1; g.font = font(size); }
    const tw = g.measureText(title).width;
    const squeeze = tw > maxW ? maxW / tw : 1;
    g.fillStyle = '#f6e8cd';
    g.save(); g.translate(128, PY + PH / 2 + size * 0.35); g.scale(squeeze, 1); g.fillText(title, 0, 0); g.restore();

    const sub = (role === ROLE.MAFIA || role === ROLE.DON) ? 'город против вас' : 'вы за город';
    let ss = 17;
    g.font = font(ss);
    while (ss > 10 && g.measureText(sub).width > maxW) { ss -= 1; g.font = font(ss); }
    g.fillStyle = '#5a2a2a';
    g.fillText(sub, 128, PY + PH + 20);
    return c;
  }

  /* Табличка с именем над местом. */
  function nameCanvas(name, opts) {
    opts = opts || {};
    const c = cvs(512, 140), g = c.getContext('2d');
    g.clearRect(0, 0, 512, 140);
    g.fillStyle = opts.dead ? 'rgba(22,8,9,.84)' : 'rgba(10,8,9,.74)';
    roundRect(g, 26, 24, 460, 88, 8); g.fill();
    g.strokeStyle = opts.dead ? 'rgba(196,86,58,.85)'
      : opts.speaking ? 'rgba(226,180,120,1)' : 'rgba(226,180,120,.4)';
    g.lineWidth = opts.speaking ? 6 : 3;
    roundRect(g, 26, 24, 460, 88, 8); g.stroke();
    g.font = 'bold 46px Bitter, Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = opts.dead ? 'rgba(241,236,225,.45)' : (opts.you ? '#e2b478' : '#efe9dd');
    g.fillText(opts.dead ? name + '  \u2020' : name, 256, opts.sub || opts.you ? 60 : 66);
    const sub = opts.sub || (opts.you ? '\u2014 вы \u2014' : '');
    if (sub) {
      g.font = '22px Golos Text, system-ui, sans-serif';
      g.fillStyle = opts.dead ? 'rgba(241,236,225,.4)' : 'rgba(226,180,120,.85)';
      g.fillText(sub, 256, 100);
    }
    return c;
  }

  /* Крест над выбывшим. */
  function crossCanvas() {
    const c = cvs(128, 128), g = c.getContext('2d');
    g.strokeStyle = hex(PAL.ember); g.lineWidth = 15; g.lineCap = 'round';
    g.shadowColor = hex(PAL.ember); g.shadowBlur = 18;
    g.beginPath(); g.moveTo(30, 30); g.lineTo(98, 98); g.moveTo(98, 30); g.lineTo(30, 98); g.stroke();
    return c;
  }

  /* Лицо в equirect-развёртке сферы: центр приходится на u = 0.25,
     то есть ровно на направление +z, куда смотрит фигура. */
  function faceCanvas(skinHex, hairHex, seed, female) {
    const W = LOWQ ? 512 : 1024, H = W / 2;
    const c = cvs(W, H), g = c.getContext('2d');
    const rnd = prng(seed * 31 + 5);
    const cx = W * 0.25, cy = H * 0.50, f = W * 0.20;
    const sc = hex(skinHex), hc = hex(hairHex);

    g.fillStyle = sc; g.fillRect(0, 0, W, H);
    const sd = g.createLinearGradient(cx - f * 0.85, 0, cx + f * 0.85, 0);
    sd.addColorStop(0, 'rgba(24,12,10,.34)');
    sd.addColorStop(0.5, 'rgba(255,238,220,.10)');
    sd.addColorStop(1, 'rgba(24,12,10,.34)');
    g.fillStyle = sd; g.fillRect(0, 0, W, H);

    const hairY = cy - f * (female ? 0.30 : 0.40);
    g.fillStyle = hc; g.fillRect(0, 0, W, hairY);
    g.beginPath(); g.ellipse(cx, hairY + f * 0.05, f * 0.47, f * 0.32, 0, Math.PI, Math.PI * 2);
    g.fillStyle = sc; g.fill();
    if (female) {
      g.fillStyle = hc;
      for (const s of [-1, 1]) {
        g.beginPath(); g.ellipse(cx + s * f * 0.48, cy + f * 0.15, f * 0.16, f * 0.62, 0, 0, Math.PI * 2); g.fill();
      }
    }

    const ey = cy - f * 0.09, ex = f * 0.20, ew = f * 0.155, eh = f * 0.082;
    const irises = ['#4a3524', '#3d5a46', '#2f4f6b', '#5a3f2a', '#6b6357'];
    const iris = irises[Math.floor(rnd() * irises.length)];
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      g.fillStyle = 'rgba(60,34,26,.16)';
      g.beginPath(); g.ellipse(x, ey, ew * 1.4, eh * 2.0, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f4ede3';
      g.beginPath(); g.ellipse(x, ey, ew, eh, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = iris;
      g.beginPath(); g.arc(x, ey, eh * 0.94, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0f0b0b';
      g.beginPath(); g.arc(x, ey, eh * 0.42, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.9)';
      g.beginPath(); g.arc(x - eh * 0.32, ey - eh * 0.34, eh * 0.22, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(44,26,20,.8)';
      g.lineWidth = Math.max(1.5, f * 0.024); g.lineCap = 'round';
      g.beginPath(); g.ellipse(x, ey, ew, eh, 0, Math.PI * 1.03, Math.PI * 1.97); g.stroke();
      g.strokeStyle = hc;
      g.lineWidth = f * (female ? 0.032 : 0.052);
      const outer = x + s * ew * 1.15, inner = x - s * ew * 1.15;
      g.beginPath(); g.moveTo(outer, ey - eh * 2.1);
      g.quadraticCurveTo(x, ey - eh * 3.3, inner, ey - eh * 2.6); g.stroke();
    }

    g.strokeStyle = 'rgba(52,26,18,.26)'; g.lineWidth = f * 0.022;
    g.beginPath();
    g.moveTo(cx - f * 0.025, ey + eh * 0.9);
    g.lineTo(cx - f * 0.052, cy + f * 0.095);
    g.quadraticCurveTo(cx, cy + f * 0.155, cx + f * 0.052, cy + f * 0.095);
    g.stroke();
    g.fillStyle = 'rgba(30,16,12,.4)';
    for (const s of [-1, 1]) {
      g.beginPath(); g.ellipse(cx + s * f * 0.046, cy + f * 0.113, f * 0.017, f * 0.011, 0, 0, Math.PI * 2); g.fill();
    }

    const my = cy + f * 0.255;
    g.fillStyle = female ? '#a8534f' : '#8c534c';
    g.beginPath();
    g.moveTo(cx - f * 0.125, my);
    g.quadraticCurveTo(cx, my - f * 0.048, cx + f * 0.125, my);
    g.quadraticCurveTo(cx, my + f * 0.078, cx - f * 0.125, my);
    g.fill();
    g.strokeStyle = 'rgba(58,28,24,.55)'; g.lineWidth = f * 0.013;
    g.beginPath(); g.moveTo(cx - f * 0.125, my);
    g.quadraticCurveTo(cx, my + f * 0.018, cx + f * 0.125, my); g.stroke();

    g.fillStyle = 'rgba(70,36,26,.13)';
    g.beginPath(); g.ellipse(cx, my + f * 0.20, f * 0.24, f * 0.13, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(190,96,80,.13)';
    for (const s of [-1, 1]) {
      g.beginPath(); g.ellipse(cx + s * f * 0.33, cy + f * 0.09, f * 0.12, f * 0.09, 0, 0, Math.PI * 2); g.fill();
    }
    if (!female && rnd() > 0.45) {
      g.fillStyle = 'rgba(38,28,26,.22)';
      g.beginPath(); g.ellipse(cx, my + f * 0.12, f * 0.31, f * 0.24, 0, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  /* =====================================================================
     ДЕКОРАЦИИ
     ===================================================================== */

  /* Комната-вертеп: дощатый пол, штукатурка в трещинах, полотняный задник,
     плинтус, тёмные силуэты мебели у стен. */
  function buildRoom(parent) {
    const out = {};

    const floorTex = texFromCanvas(plankCanvas(), [5, 5]);
    out.floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, sg(48, 24)),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.93, metalness: 0.02 })
    );
    out.floor.rotation.x = -Math.PI / 2;
    out.floor.receiveShadow = true;
    parent.add(out.floor);

    const wallTex = texFromCanvas(plasterCanvas(), [3, 1]);
    out.walls = new THREE.Mesh(
      new THREE.CylinderGeometry(13, 13, 8.5, sg(32, 18), 1, true),
      new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.99, metalness: 0, side: THREE.BackSide })
    );
    out.walls.position.y = 4.2;
    parent.add(out.walls);

    /* Задник: полотно натянуто позади стола, чуть не доходя до стен. */
    const backTex = texFromCanvas(backdropCanvas(), [2, 1]);
    out.backdrop = new THREE.Mesh(
      new THREE.CylinderGeometry(8.6, 8.6, 6.2, sg(28, 16), 1, true, Math.PI * 0.62, Math.PI * 0.76),
      new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.96, side: THREE.DoubleSide })
    );
    out.backdrop.position.y = 3.1;
    parent.add(out.backdrop);

    /* Плинтус — тонкая тёмная лента по низу стены: пол «сходится» со стеной. */
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(12.9, 12.9, 0.28, sg(32, 18), 1, true),
      new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.9, side: THREE.BackSide })
    );
    skirt.position.y = 0.14;
    parent.add(skirt);

    out.ceiling = new THREE.Mesh(
      new THREE.CircleGeometry(13, sg(28, 16)),
      new THREE.MeshStandardMaterial({ color: 0x100d0c, roughness: 1, side: THREE.DoubleSide })
    );
    out.ceiling.rotation.x = Math.PI / 2;
    out.ceiling.position.y = 8.4;
    parent.add(out.ceiling);

    /* Силуэты у стен: шкаф, ящики, вешалка. Дают глубину и тени. */
    const shadowMat = new THREE.MeshStandardMaterial({ color: 0x191412, roughness: 1 });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      const r = 8 + (i % 3);
      const h = 1.1 + (i % 4) * 0.75;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.8 + (i % 3) * 0.5, h, 0.6), shadowMat);
      box.position.set(Math.sin(a) * r, h / 2, Math.cos(a) * r);
      box.rotation.y = a;
      parent.add(box);
    }
    return out;
  }

  /* Эмалированная лампа на цепи. Возвращает ручки для качания и мерцания. */
  function buildLamp(parent, opts) {
    opts = opts || {};
    const ceilY = opts.ceilY || 8.3;
    const bulbY = opts.bulbY || 3.0;

    /* Точка подвеса: качаем именно её, тогда весь абажур ходит как маятник. */
    const pivot = new THREE.Group();
    pivot.position.set(0, ceilY, 0);
    parent.add(pivot);

    const drop = ceilY - bulbY;

    const rosette = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.16, 0.1, sg(18, 10)),
      new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.85 })
    );
    rosette.position.y = -0.05;
    pivot.add(rosette);

    /* Цепь: звенья через одно повёрнуты на 90° — как настоящая. */
    const linkGeo = new THREE.TorusGeometry(0.032, 0.011, sg(8, 5), sg(12, 7));
    const linkMat = new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.5, metalness: 0.75 });
    const links = Math.max(4, Math.round(drop / 0.062));
    for (let i = 0; i < links; i++) {
      const l = new THREE.Mesh(linkGeo, linkMat);
      l.position.y = -0.1 - i * 0.062;
      l.rotation.set(Math.PI / 2, i % 2 ? Math.PI / 2 : 0, 0);
      pivot.add(l);
    }
    /* Провод рядом с цепью — деталь, которая сразу читается как «настоящее». */
    const wire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, drop, 6),
      new THREE.MeshStandardMaterial({ color: 0x0d0b0b, roughness: 1 })
    );
    wire.position.set(0.055, -drop / 2, 0.01);
    pivot.add(wire);

    /* Абажур: снаружи зелёная эмаль, изнутри белая — свет отражается тёплым. */
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 0.56, sg(28, 14), 1, true),
      new THREE.MeshStandardMaterial({ color: PAL.enamel, roughness: 0.35, metalness: 0.5, side: THREE.FrontSide })
    );
    shade.position.y = -drop + 0.28;
    pivot.add(shade);
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.88, 0.54, sg(28, 14), 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf6e6cf, side: THREE.BackSide })
    );
    inner.position.copy(shade.position);
    pivot.add(inner);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.022, sg(8, 5), sg(30, 16)),
      new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.4, metalness: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -drop;
    pivot.add(ring);

    /* Нить накала и светящийся диск под абажуром. */
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, sg(14, 8), sg(10, 6)),
      new THREE.MeshBasicMaterial({ color: 0xffe0b0 })
    );
    glow.position.y = -drop - 0.04;
    pivot.add(glow);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.84, sg(24, 14)),
      new THREE.MeshBasicMaterial({ color: 0xffd8a4, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    disc.rotation.x = Math.PI / 2;
    disc.position.y = -drop - 0.02;
    pivot.add(disc);

    const spot = new THREE.SpotLight(0xffd9a8, 62, 20, Math.PI / 3.4, 0.62, 1.1);
    spot.position.set(0, -drop - 0.05, 0);
    spot.target.position.set(0, -drop - 2.2, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(LOWQ ? 512 : 1024, LOWQ ? 512 : 1024);
    spot.shadow.bias = -0.0016;
    pivot.add(spot, spot.target);

    const point = new THREE.PointLight(0xffc891, 11, 17, 2);
    point.position.set(0, -drop - 0.08, 0);
    pivot.add(point);

    /* Пыль в конусе света: медленно опускается и появляется сверху заново. */
    const dustN = LOWQ ? 90 : 260;
    const pos = new Float32Array(dustN * 3);
    const vel = new Float32Array(dustN);
    for (let i = 0; i < dustN; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.5;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = bulbY - Math.random() * 2.4;
      pos[i * 3 + 2] = Math.sin(a) * r;
      vel[i] = 0.02 + Math.random() * 0.05;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xffe6c4, size: 0.022, transparent: true, opacity: 0.5, depthWrite: false
    }));
    parent.add(dust);

    const lamp = {
      pivot, shade, inner, glow, disc, spot, point, dust,
      baseSpot: 62, basePoint: 11, glowLevel: 1,
      /* Маятник: две несинхронные синусоиды, поэтому качание не выглядит
         механическим. amp растёт после удара по столу. */
      swing: 0,
      animate(t, dt) {
        pivot.rotation.z = Math.sin(t * 0.00042) * (0.012 + lamp.swing) + Math.sin(t * 0.00097) * 0.004;
        pivot.rotation.x = Math.cos(t * 0.00036) * (0.009 + lamp.swing * 0.7);
        if (lamp.swing > 0) lamp.swing = Math.max(0, lamp.swing - (dt || 16) * 0.00002);

        /* мерцание накала: редкие просадки, а не ровная синусоида */
        const f = 0.94 + Math.sin(t * 0.011) * 0.02 + (Math.random() < 0.012 ? -0.22 : 0);
        spot.intensity = lamp.baseSpot * lamp.glowLevel * f;
        point.intensity = lamp.basePoint * lamp.glowLevel * f;
        disc.material.opacity = 0.3 * lamp.glowLevel * f;

        const p = dust.geometry.attributes.position;
        for (let i = 0; i < dustN; i++) {
          let y = p.array[i * 3 + 1] - vel[i] * (dt || 16) * 0.001;
          if (y < 0.6) y = bulbY - 0.1;
          p.array[i * 3 + 1] = y;
          p.array[i * 3] += Math.sin(t * 0.0004 + i) * 0.0004;
        }
        p.needsUpdate = true;
      },
      nudge(k) { lamp.swing = Math.min(0.09, lamp.swing + (k || 0.05)); }
    };
    return lamp;
  }

  /* Стол: точёная нога, сукно, медный кант и реквизит.
     n нужен, чтобы стол рос вместе с числом игроков. */
  function buildTable(parent, n) {
    const g = new THREE.Group();
    parent.add(g);

    const R = n > 12 ? 2.55 : n > 6 ? 2.15 : 1.92;
    const topY = 0.9;

    const feltTex = texFromCanvas(feltCanvas());
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.11, sg(56, 28)),
      new THREE.MeshStandardMaterial({ map: feltTex, roughness: 0.94, metalness: 0.02 })
    );
    top.position.y = topY;
    top.receiveShadow = true; top.castShadow = true;
    g.add(top);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R, 0.055, sg(10, 6), sg(64, 32)),
      new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.45, metalness: 0.72 })
    );
    rim.rotation.x = Math.PI / 2; rim.position.y = topY;
    g.add(rim);

    /* Точёная нога: профиль в LatheGeometry — балясина, а не «труба». */
    const prof = [];
    const pts = [
      [0.40, 0.00], [0.42, 0.05], [0.30, 0.10], [0.26, 0.20], [0.30, 0.28],
      [0.22, 0.36], [0.20, 0.52], [0.28, 0.60], [0.20, 0.66], [0.18, 0.78], [0.26, 0.86]
    ];
    pts.forEach(p => prof.push(new THREE.Vector2(p[0], p[1])));
    const leg = new THREE.Mesh(
      new THREE.LatheGeometry(prof, sg(24, 12)),
      new THREE.MeshStandardMaterial({ color: PAL.wood, roughness: 0.78, metalness: 0.06 })
    );
    leg.castShadow = true;
    g.add(leg);

    /* Крестовина у пола: три лапы вместо круглого блина. */
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const paw = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.09, 0.82),
        new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.9 })
      );
      paw.position.set(Math.sin(a) * 0.34, 0.045, Math.cos(a) * 0.34);
      paw.rotation.y = a;
      paw.castShadow = true;
      g.add(paw);
    }

    /* --- реквизит --- */
    const props = new THREE.Group();
    props.position.y = topY + 0.055;
    g.add(props);

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xbcd0cc, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.4
    });
    /* графин */
    const carafeProf = [[0.0, 0], [0.13, 0], [0.15, 0.06], [0.11, 0.18], [0.05, 0.24], [0.055, 0.3], [0.075, 0.32]]
      .map(p => new THREE.Vector2(p[0], p[1]));
    const carafe = new THREE.Mesh(new THREE.LatheGeometry(carafeProf, sg(20, 10)), glassMat);
    carafe.position.set(R * 0.34, 0, -R * 0.2);
    props.add(carafe);
    /* вода в графине */
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(0.115, 0.125, 0.14, sg(18, 9)),
      new THREE.MeshStandardMaterial({ color: 0x53706b, roughness: 0.2, transparent: true, opacity: 0.65 })
    );
    water.position.set(R * 0.34, 0.07, -R * 0.2);
    props.add(water);
    /* два стакана */
    for (let i = 0; i < 2; i++) {
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.043, 0.12, sg(16, 8), 1, true), glassMat);
      glass.position.set(R * 0.34 + (i ? 0.19 : -0.16), 0.06, -R * 0.2 + (i ? 0.14 : 0.1));
      props.add(glass);
    }
    /* свеча в подсвечнике: тёплая точка света у самого сукна */
    const holder = new THREE.Mesh(
      new THREE.LatheGeometry([[0, 0], [0.1, 0], [0.09, 0.02], [0.03, 0.04], [0.035, 0.1], [0.055, 0.12]]
        .map(p => new THREE.Vector2(p[0], p[1])), sg(16, 8)),
      new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.42, metalness: 0.7 })
    );
    holder.position.set(-R * 0.4, 0, -R * 0.26);
    props.add(holder);
    const candle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.036, 0.22, sg(14, 8)),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.8 })
    );
    candle.position.set(-R * 0.4, 0.23, -R * 0.26);
    props.add(candle);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.022, 0.075, sg(10, 6)),
      new THREE.MeshBasicMaterial({ color: 0xffd79a })
    );
    flame.position.set(-R * 0.4, 0.375, -R * 0.26);
    props.add(flame);
    const candleLight = new THREE.PointLight(0xffb066, 2.2, 2.6, 2);
    candleLight.position.copy(flame.position);
    props.add(candleLight);
    /* пепельница и спички — мелочи, из которых складывается «жилое» место */
    const tray = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.09, 0.035, sg(18, 9)),
      new THREE.MeshStandardMaterial({ color: 0x2b2422, roughness: 0.5, metalness: 0.3 })
    );
    tray.position.set(-R * 0.1, 0.015, R * 0.36);
    props.add(tray);
    const matchbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.03, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x6d4a3a, roughness: 0.9 })
    );
    matchbox.position.set(-R * 0.1 + 0.2, 0.02, R * 0.36 + 0.03);
    matchbox.rotation.y = 0.4;
    props.add(matchbox);

    return {
      group: g, top, radius: R, topY, props, flame, candleLight,
      seatRadius: R + 0.92,
      animate(t) {
        /* пламя дышит и слегка ведёт свет — самое дешёвое «живое» на сцене */
        const k = 1 + Math.sin(t * 0.009) * 0.16 + Math.sin(t * 0.021) * 0.09;
        flame.scale.set(1, k, 1);
        candleLight.intensity = 2.2 * (0.85 + (k - 1) * 0.8);
      }
    };
  }

  /* Венский стул: гнутая спинка, круглое сиденье. */
  function buildChair() {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.92 });

    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.29, 0.06, sg(20, 10)), m);
    seat.position.y = 0.44; seat.castShadow = true; g.add(seat);

    /* обод спинки: полукольцо + две стойки */
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.022, sg(8, 5), sg(24, 12), Math.PI), m);
    hoop.position.set(0, 1.06, -0.24);
    hoop.rotation.set(0, 0, 0);
    g.add(hoop);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.62, sg(10, 6)), m);
      post.position.set(s * 0.24, 0.75, -0.24);
      g.add(post);
    }
    const slat = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.017, sg(6, 4), sg(18, 9), Math.PI), m);
    slat.position.set(0, 0.86, -0.24);
    g.add(slat);

    const legG = new THREE.CylinderGeometry(0.028, 0.02, 0.44, sg(8, 5));
    [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.2], [0.2, 0.2]].forEach(p => {
      const l = new THREE.Mesh(legG, m);
      l.position.set(p[0], 0.22, p[1]);
      l.rotation.set(p[1] * 0.12, 0, -p[0] * 0.12);
      g.add(l);
    });
    return g;
  }

  /* Кость: цилиндр между двумя точками — руки и ноги в позе сидя. */
  function bone(a, b, r1, r2, mat, segs) {
    const grp = new THREE.Group();
    grp.position.set(a[0], a[1], a[2]);
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    grp.lookAt(new THREE.Vector3(b[0], b[1], b[2]));
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, segs || sg(14, 8)), mat);
    m.rotation.x = Math.PI / 2;
    m.position.z = len / 2;
    m.castShadow = true;
    grp.add(m);
    return grp;
  }

  /* Фигура человека, сидящего за столом: ноги, руки с кистями, торс,
     шея, голова с лицом, причёска или головной убор.
     В userData отдаём ручки, за которые сцена дёргает анимацию:
     голова (взгляд и мигание), челюсть (речь), грудь (дыхание). */
  function buildFigure(color, hatKind, seed, opts) {
    opts = opts || {};
    const female = opts.sex === 'f';
    const grp = new THREE.Group();
    const base = new THREE.Color(color);
    const rnd = prng(seed * 17 + 3);

    const skinC = new THREE.Color().setHSL(0.070 + (seed % 3) * 0.006, 0.36, 0.58 + (seed % 4) * 0.045);
    const hairC = new THREE.Color().setHSL(0.07, 0.42, 0.14 + (seed % 4) * 0.07);

    const cloth = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(1.18), roughness: 0.76, metalness: 0.03 });
    const dark = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.6), roughness: 0.84, metalness: 0.04 });
    const skin = new THREE.MeshStandardMaterial({ color: skinC, roughness: 0.58 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xe4ddcd, roughness: 0.66 });
    const tieM = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.4), roughness: 0.56 });
    const hairM = new THREE.MeshStandardMaterial({ color: hairC, roughness: 0.9 });
    const trous = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.48), roughness: 0.88 });
    const shoeM = new THREE.MeshStandardMaterial({ color: 0x1a1416, roughness: 0.62, metalness: 0.1 });
    const faceM = new THREE.MeshStandardMaterial({
      map: texFromCanvas(faceCanvas(skinC.getHex(), hairC.getHex(), seed, female)),
      roughness: 0.6
    });

    /* ---- таз и ноги ---- */
    const hipY = 0.56, hipZ = -0.28;
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.19, sg(20, 10), sg(14, 8)), trous);
    pelvis.scale.set(1.12, 0.72, 0.92);
    pelvis.position.set(0, hipY, hipZ);
    pelvis.castShadow = true; grp.add(pelvis);

    const kneeY = 0.53, kneeZ = 0.20, ankY = 0.11, ankZ = 0.26;
    for (const s of [-1, 1]) {
      const hx = s * 0.135, kx = s * 0.155, ax = s * 0.16;
      grp.add(bone([hx, hipY - 0.02, hipZ], [kx, kneeY, kneeZ], 0.115, 0.093, trous));
      grp.add(bone([kx, kneeY, kneeZ], [ax, ankY, ankZ], 0.088, 0.062, trous));
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.098, sg(14, 8), sg(12, 6)), trous);
      knee.position.set(kx, kneeY, kneeZ); knee.castShadow = true; grp.add(knee);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.075, 0.27), shoeM);
      shoe.position.set(ax, 0.045, ankZ + 0.06); shoe.castShadow = true; grp.add(shoe);
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.066, sg(12, 6), sg(10, 5)), shoeM);
      toe.scale.set(1, 0.56, 1.05);
      toe.position.set(ax, 0.045, ankZ + 0.18); grp.add(toe);
    }

    /* ---- торс: позвоночник по одной прямой, иначе появляется горб ---- */
    const chestY = 0.99;
    const lean = -0.045;
    const torsoZ = hipZ * 0.86;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(female ? 0.235 : 0.265, female ? 0.20 : 0.215, 0.46, sg(22, 12)), cloth);
    body.position.set(0, (hipY + chestY) / 2 + 0.02, torsoZ);
    body.rotation.x = lean;
    body.castShadow = true; body.receiveShadow = true; grp.add(body);

    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.27, sg(22, 12), sg(16, 9)), cloth);
    chest.scale.set(1.05, 0.86, 0.74);
    chest.position.set(0, chestY - 0.09, torsoZ + 0.035);
    chest.rotation.x = lean;
    chest.castShadow = true; grp.add(chest);

    const back = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.115, female ? 0.30 : 0.34, sg(8, 4), sg(16, 8)), cloth);
    back.scale.set(female ? 1.75 : 1.95, 1, 0.42);
    back.position.set(0, (hipY + chestY) / 2 + 0.04, torsoZ - (female ? 0.115 : 0.125));
    back.rotation.x = lean;
    back.castShadow = true; grp.add(back);

    const cloak = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.34, 0.5, sg(22, 12), 1, true), dark);
    cloak.position.set(0, hipY + 0.20, torsoZ * 0.92);
    cloak.rotation.x = lean;
    cloak.castShadow = true; grp.add(cloak);

    const shX = female ? 0.235 : 0.275, shY = chestY - 0.02, shZ = torsoZ + 0.055;
    const yoke = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, shX * 2 - 0.02, sg(8, 4), sg(14, 7)), cloth);
    yoke.rotation.z = Math.PI / 2;
    yoke.position.set(0, shY, shZ);
    yoke.castShadow = true; grp.add(yoke);

    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.16, 0.13, sg(18, 10)), shirt);
    collar.position.set(0, chestY + 0.06, shZ + 0.02);
    collar.rotation.x = lean; grp.add(collar);
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.30, 0.04), tieM);
    tie.position.set(0, chestY - 0.17, shZ + (female ? 0.175 : 0.195));
    tie.rotation.x = lean; grp.add(tie);

    /* ---- руки: кисти лежат на столе ---- */
    const wrY = 0.98, wrZ = 0.42;
    for (const s of [-1, 1]) {
      const sh = [s * shX, shY, shZ];
      const eb = [s * (shX + 0.07), 0.74, shZ + 0.16];
      const wr = [s * 0.205, wrY, wrZ];
      grp.add(bone(sh, eb, 0.098, 0.078, cloth));
      grp.add(bone(eb, wr, 0.076, 0.058, cloth));
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.105, sg(14, 8), sg(12, 6)), cloth);
      shoulder.position.set(sh[0], sh[1], sh[2]); shoulder.castShadow = true; grp.add(shoulder);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.079, sg(12, 7), sg(10, 5)), cloth);
      elbow.position.set(eb[0], eb[1], eb[2]); grp.add(elbow);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.05, sg(12, 7)), shirt);
      cuff.position.set(wr[0], wr[1] + 0.005, wr[2] - 0.055);
      cuff.rotation.x = Math.PI / 2.4; grp.add(cuff);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.042, 0.115), skin);
      palm.position.set(wr[0], wr[1] - 0.012, wr[2] + 0.045);
      palm.rotation.x = -0.08; palm.castShadow = true; grp.add(palm);
      const fingerG = new THREE.CapsuleGeometry(0.0155, 0.062, sg(5, 3), sg(8, 4));
      for (let k = 0; k < 4; k++) {
        const fg = new THREE.Mesh(fingerG, skin);
        fg.position.set(wr[0] + (k - 1.5) * 0.024, wr[1] - 0.018, wr[2] + 0.135);
        fg.rotation.x = Math.PI / 2 - 0.1;
        grp.add(fg);
      }
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.05, sg(5, 3), sg(8, 4)), skin);
      thumb.position.set(wr[0] - s * 0.052, wr[1] - 0.016, wr[2] + 0.075);
      thumb.rotation.set(Math.PI / 2 - 0.25, 0, s * 0.7);
      grp.add(thumb);
    }

    /* ---- шея и голова ---- */
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.092, 0.16, sg(14, 8)), skin);
    neck.position.set(0, chestY + 0.11, shZ + 0.005);
    neck.rotation.x = lean; grp.add(neck);

    /* Голова висит на своём пивоте: так её можно поворачивать к говорящему,
       не разбирая всю фигуру. */
    const headY = chestY + 0.32, headZ = shZ + 0.012;
    const headPivot = new THREE.Group();
    headPivot.position.set(0, headY, headZ);
    grp.add(headPivot);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.205, sg(32, 16), sg(24, 12)), faceM);
    head.scale.set(0.97, 1.09, 0.95);
    head.castShadow = true; headPivot.add(head);

    /* Веки: две тонкие «шапочки» цвета кожи. Опускаются при мигании. */
    const lids = [];
    for (const s of [-1, 1]) {
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.048, sg(14, 7), sg(10, 5), 0, Math.PI * 2, 0, Math.PI / 2), skin);
      lid.position.set(s * 0.062, 0.022, 0.186);
      lid.rotation.x = Math.PI / 2.1;
      lid.scale.set(1, 0.5, 1);
      lid.visible = false;
      headPivot.add(lid);
      lids.push(lid);
    }

    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.155, sg(20, 10), sg(14, 8)), skin);
    jaw.scale.set(0.95, 0.78, 0.92);
    jaw.position.set(0, -0.105, 0.022);
    headPivot.add(jaw);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.031, 0.072, sg(12, 6)), skin);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.012, 0.196);
    headPivot.add(nose);

    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.042, sg(12, 6), sg(10, 5)), skin);
      ear.scale.set(0.42, 1.05, 0.78);
      ear.position.set(s * 0.196, -0.01, -0.012);
      headPivot.add(ear);
    }

    /* ---- головной убор или причёска ---- */
    const hat = new THREE.Group();
    if (hatKind === 'fedora') {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.032, sg(28, 14)), dark);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.21, 0.25, sg(28, 14)), dark);
      top.position.y = 0.14;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.216, 0.216, 0.058, sg(28, 14)),
        new THREE.MeshStandardMaterial({ color: 0x1c1618, roughness: 0.74 }));
      band.position.y = 0.048;
      brim.castShadow = top.castShadow = true;
      hat.add(brim, top, band);
      hat.position.set(0, 0.15, -0.01);
      hat.rotation.z = 0.05;
    } else if (hatKind === 'cap') {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.222, sg(24, 12), sg(16, 8), 0, Math.PI * 2, 0, Math.PI / 2), dark);
      const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.228, 0.228, 0.028, sg(22, 11), 1, false, 0, Math.PI), dark);
      peak.position.set(0, 0.004, 0.155); peak.rotation.y = Math.PI;
      dome.castShadow = true;
      hat.add(dome, peak);
      hat.position.set(0, 0.04, -0.01);
    } else {
      /* волосы: шапка + затылок + отдельные пряди, чтобы силуэт не был «литым» */
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.216, sg(24, 12), sg(18, 9), 0, Math.PI * 2, 0, Math.PI * 0.58), hairM);
      cap.position.set(0, -0.005, -0.012);
      cap.scale.set(1, 1.05, 1);
      cap.castShadow = true; hat.add(cap);
      const nape = new THREE.Mesh(new THREE.SphereGeometry(0.208, sg(20, 10), sg(14, 7), 0, Math.PI * 2, Math.PI * 0.3, Math.PI * 0.42), hairM);
      nape.position.set(0, -0.005, -0.052);
      hat.add(nape);
      const strands = LOWQ ? 5 : 11;
      for (let k = 0; k < strands; k++) {
        const a = (k / strands) * Math.PI * 2;
        const len = 0.1 + rnd() * (female ? 0.4 : 0.12);
        const lock = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, len, sg(6, 3), sg(10, 5)), hairM);
        lock.position.set(Math.sin(a) * 0.17, -0.02 - len * 0.35, Math.cos(a) * 0.17 - 0.02);
        lock.rotation.set(rnd() * 0.2 - 0.1, a, Math.sin(a) * 0.2);
        hat.add(lock);
      }
      if (female) {
        const bun = new THREE.Mesh(new THREE.SphereGeometry(0.105, sg(18, 9), sg(14, 7)), hairM);
        bun.position.set(0, -0.03, -0.215);
        hat.add(bun);
      }
    }
    headPivot.add(hat);

    grp.userData = {
      body, chest, head, headPivot, jaw, hat, cloak, lids,
      restJawY: jaw.position.y,
      materials: [cloth, dark, skin, shirt, tieM, hairM, trous, shoeM, faceM],
      baseColor: base.clone()
    };
    return grp;
  }

  function disposeTree(obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach(x => x && x.dispose && x.dispose());
      else if (m && m.dispose) m.dispose();
    });
  }

  return {
    PAL, LOWQ, sg, prng, cvs, roundRect, texFromCanvas, disposeTree,
    plankCanvas, plasterCanvas, backdropCanvas, feltCanvas,
    cardBackCanvas, cardFaceCanvas, nameCanvas, crossCanvas, faceCanvas,
    buildRoom, buildLamp, buildTable, buildChair, buildFigure, bone
  };
}
