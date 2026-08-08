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

  /* ---------------------------------------------------------------------
     Единая метрика сцены. Раньше стол, стулья и фигуры мерились каждый
     своей линейкой: стол стоял на высоте 0,955 при сиденье 0,47 (разница
     полметра при живой 0,30), а круг мест проходил в 0,92 от края стола —
     то есть кисти сидящих заканчивались в воздухе, не доставая до сукна
     почти на полруки. Отсюда и «руки висят».

     Теперь все размеры считаются от этих чисел, и любой сдвиг делается
     здесь, а не в пяти файлах.
     --------------------------------------------------------------------- */
  const METRICS = {
    seatTopY: 0.47,       // сиденье стула
    hipY: 0.56,           // таз сидящего
    chestY: 0.99,         // линия плеч
    headY: 1.22,          // центр головы
    crownY: 1.37,         // макушка
    tableSurfaceY: 0.80,  // сукно: на 0,33 выше сиденья — как за обычным столом
    seatGap: 0.21,        // от края стола до центра места: предплечье ложится на сукно
    seatPitch: 0.86       // сколько места нужно одному человеку по кругу
  };

  /** Радиус стола под число игроков: сначала круг мест, потом столешница. */
  function tableRadiusFor(n) {
    const seatR = Math.max(0.73, (Math.max(1, n) * METRICS.seatPitch) / (Math.PI * 2));
    return Math.max(0.52, seatR - METRICS.seatGap);
  }

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

    const sub = (role === ROLE.MAFIA || role === ROLE.DON) ? 'вы играете за мафию' : 'вы играете за город';
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
    /* f задаёт размер лица на равнопромежуточной развёртке. При 0.20
       лицо занимало ±36° долготы и с расстояния стола не читалось вовсе.
       У живого человека лицо — около ±45°, этому соответствует 0.235. */
    const cx = W * 0.25, cy = H * 0.50, f = W * 0.235;
    const sc = hex(skinHex), hc = hex(hairHex);

    /* Волосы кладём на всю развёртку, а лицо вырезаем овалом. Раньше
       причёска была горизонтальной полосой по верху: сзади голова
       оставалась голой и светилась кожей, как яйцо. */
    g.fillStyle = hc; g.fillRect(0, 0, W, H);

    /* Кожу кладём с растушёванным краем. Жёсткий клип по эллипсу давал
       на голове «маску»: светлое пятно лица обрывалось видимой линией.
       Теперь кожа уходит в волосы плавно, как линия роста волос. */
    const sR = (skinHex >> 16) & 255, sG = (skinHex >> 8) & 255, sB = skinHex & 255;
    g.save();
    g.translate(cx, cy + f * 0.07);
    g.scale(f * 0.53, f * 0.75);
    const skinG = g.createRadialGradient(0, 0, 0.08, 0, 0, 1);
    skinG.addColorStop(0, sc);
    skinG.addColorStop(0.78, sc);
    skinG.addColorStop(1, 'rgba(' + sR + ',' + sG + ',' + sB + ',0)');
    g.fillStyle = skinG;
    g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill();
    g.restore();

    /* Объём: виски темнее, середина лица светлее. */
    g.save();
    g.beginPath(); g.ellipse(cx, cy + f * 0.07, f * 0.50, f * 0.72, 0, 0, Math.PI * 2); g.clip();
    const sd = g.createLinearGradient(cx - f * 0.85, 0, cx + f * 0.85, 0);
    sd.addColorStop(0, 'rgba(24,12,10,.34)');
    sd.addColorStop(0.5, 'rgba(255,238,220,.10)');
    sd.addColorStop(1, 'rgba(24,12,10,.34)');
    g.fillStyle = sd; g.fillRect(0, 0, W, H);
    g.restore();

    /* линия волос над лбом: у мужчин выше, у женщин ниже */
    const hairY = cy - f * (female ? 0.30 : 0.40);
    g.fillStyle = hc;
    g.beginPath(); g.ellipse(cx, hairY - f * 0.13, f * 0.52, f * 0.24, 0, 0, Math.PI * 2); g.fill();
    /* мягкая тень под чёлкой — иначе волосы обрываются плоским кантом */
    const hg = g.createLinearGradient(0, hairY - f * 0.18, 0, hairY + f * 0.10);
    hg.addColorStop(0, 'rgba(20,12,10,.30)');
    hg.addColorStop(1, 'rgba(20,12,10,0)');
    g.fillStyle = hg;
    g.beginPath(); g.ellipse(cx, hairY - f * 0.02, f * 0.50, f * 0.20, 0, 0, Math.PI * 2); g.fill();
    if (female) {
      g.fillStyle = hc;
      for (const s of [-1, 1]) {
        g.beginPath(); g.ellipse(cx + s * f * 0.48, cy + f * 0.15, f * 0.16, f * 0.62, 0, 0, Math.PI * 2); g.fill();
      }
    }

    /* Глаз занимает около пятой части ширины лица. При 0.155·f они
       читались кукольными — 26° долготы вместо живых 14–18°. */
    const ey = cy - f * 0.09, ex = f * 0.195, ew = f * 0.108, eh = f * 0.058;
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
      /* Бровь цветом в волос терялась на светлых шевелюрах. Берём
         тёмный нейтральный тон: именно брови делают лицо лицом. */
      g.strokeStyle = 'rgba(46,28,20,.88)';
      g.lineWidth = f * (female ? 0.030 : 0.044);
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
      new THREE.CircleGeometry(11, sg(48, 24)),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.93, metalness: 0.02 })
    );
    out.floor.rotation.x = -Math.PI / 2;
    out.floor.receiveShadow = true;
    parent.add(out.floor);

    const wallTex = texFromCanvas(plasterCanvas(), [3, 1]);
    out.walls = new THREE.Mesh(
      new THREE.CylinderGeometry(8.4, 8.4, 4.7, sg(32, 18), 1, true),
      new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.99, metalness: 0, side: THREE.BackSide })
    );
    out.walls.position.y = 2.3;
    parent.add(out.walls);

    /* Задник: полотно натянуто позади стола, чуть не доходя до стен. */
    const backTex = texFromCanvas(backdropCanvas(), [2, 1]);
    out.backdrop = new THREE.Mesh(
      new THREE.CylinderGeometry(6.0, 6.0, 4.3, sg(28, 16), 1, true, Math.PI * 0.62, Math.PI * 0.76),
      new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.96, side: THREE.DoubleSide })
    );
    out.backdrop.position.y = 2.15;
    parent.add(out.backdrop);

    /* Плинтус — тонкая тёмная лента по низу стены: пол «сходится» со стеной. */
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(8.3, 8.3, 0.28, sg(32, 18), 1, true),
      new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.9, side: THREE.BackSide })
    );
    skirt.position.y = 0.14;
    parent.add(skirt);

    out.ceiling = new THREE.Mesh(
      new THREE.CircleGeometry(8.4, sg(28, 16)),
      new THREE.MeshStandardMaterial({ color: 0x100d0c, roughness: 1, side: THREE.DoubleSide })
    );
    out.ceiling.rotation.x = Math.PI / 2;
    out.ceiling.position.y = 4.6;
    parent.add(out.ceiling);

    /* Силуэты у стен: шкаф, ящики, вешалка. Дают глубину и тени. */
    const shadowMat = new THREE.MeshStandardMaterial({ color: 0x191412, roughness: 1 });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      const r = 5.6 + (i % 3) * 0.55;
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
    const ceilY = opts.ceilY || 4.5;
    const bulbY = opts.bulbY || 2.2;

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
      new THREE.ConeGeometry(0.40, 0.26, sg(28, 14), 1, true),
      new THREE.MeshStandardMaterial({ color: PAL.enamel, roughness: 0.35, metalness: 0.5, side: THREE.FrontSide })
    );
    shade.position.y = -drop + 0.13;
    pivot.add(shade);
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.39, 0.25, sg(28, 14), 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf6e6cf, side: THREE.BackSide })
    );
    inner.position.copy(shade.position);
    pivot.add(inner);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.40, 0.016, sg(8, 5), sg(30, 16)),
      new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.4, metalness: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -drop;
    pivot.add(ring);

    /* Нить накала и светящийся диск под абажуром. */
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.052, sg(14, 8), sg(10, 6)),
      new THREE.MeshBasicMaterial({ color: 0xffe0b0 })
    );
    glow.position.y = -drop - 0.04;
    pivot.add(glow);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.37, sg(24, 14)),
      new THREE.MeshBasicMaterial({ color: 0xffd8a4, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    disc.rotation.x = Math.PI / 2;
    disc.position.y = -drop - 0.02;
    pivot.add(disc);

    const spot = new THREE.SpotLight(0xffd9a8, 34, 14, Math.PI / 2.9, 0.62, 1.1);
    spot.position.set(0, -drop - 0.05, 0);
    spot.target.position.set(0, -drop - 1.6, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(LOWQ ? 512 : 1024, LOWQ ? 512 : 1024);
    spot.shadow.bias = -0.0016;
    pivot.add(spot, spot.target);

    const point = new THREE.PointLight(0xffc891, 6, 11, 2);
    point.position.set(0, -drop - 0.08, 0);
    pivot.add(point);

    /* Пыль в конусе света: медленно опускается и появляется сверху заново. */
    const dustN = LOWQ ? 90 : 260;
    const pos = new Float32Array(dustN * 3);
    const vel = new Float32Array(dustN);
    for (let i = 0; i < dustN; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.85;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = bulbY - Math.random() * 1.7;
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
      baseSpot: 34, basePoint: 6, glowLevel: 1,
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
          if (y < 0.45) y = bulbY - 0.05;
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

    /* Стол растёт вместе с числом игроков, но не отрывается от людей:
       радиус считается от шага мест по кругу, а не берётся из таблицы. */
    const R = tableRadiusFor(n);
    const topY = METRICS.tableSurfaceY - 0.055;

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
    /* Балясина подгоняется под столешницу: и по высоте, и по толщине,
       иначе на маленьком столе нога выглядит бочкой. */
    const legK = Math.max(0.5, Math.min(1, R / 1.5));
    pts.forEach(p => prof.push(new THREE.Vector2(p[0] * legK, p[1] * (topY / 0.86))));
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
        new THREE.BoxGeometry(0.14 * legK, 0.085, R * 0.78),
        new THREE.MeshStandardMaterial({ color: PAL.woodDark, roughness: 0.9 })
      );
      paw.position.set(Math.sin(a) * R * 0.3, 0.043, Math.cos(a) * R * 0.3);
      paw.rotation.y = a;
      paw.castShadow = true;
      g.add(paw);
    }

    /* --- реквизит --- */
    const props = new THREE.Group();
    props.position.y = topY + 0.055;
    props.scale.setScalar(Math.max(0.62, Math.min(1, R / 1.5)));
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
      group: g, top, radius: R, topY, surfaceY: METRICS.tableSurfaceY, props, flame, candleLight,
      /* Круг мест проходит в 21 см от края: ровно столько, чтобы предплечье
         легло на сукно, а колени ушли под столешницу. */
      seatRadius: R + METRICS.seatGap,
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

    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.25, 0.055, sg(20, 10)), m);
    seat.position.y = METRICS.seatTopY - 0.028; seat.castShadow = true; g.add(seat);

    /* обод спинки: полукольцо + две стойки */
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.02, sg(8, 5), sg(24, 12), Math.PI), m);
    hoop.position.set(0, 0.94, -0.215);
    hoop.rotation.set(0, 0, 0);
    g.add(hoop);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.51, sg(10, 6)), m);
      post.position.set(s * 0.21, 0.69, -0.215);
      g.add(post);
    }
    const slat = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.015, sg(6, 4), sg(18, 9), Math.PI), m);
    slat.position.set(0, 0.80, -0.215);
    g.add(slat);

    const legG = new THREE.CylinderGeometry(0.026, 0.018, METRICS.seatTopY - 0.03, sg(8, 5));
    [[-0.17, -0.155], [0.17, -0.155], [-0.17, 0.175], [0.17, 0.175]].forEach(p => {
      const l = new THREE.Mesh(legG, m);
      l.position.set(p[0], (METRICS.seatTopY - 0.03) / 2, p[1]);
      l.rotation.set(p[1] * 0.12, 0, -p[0] * 0.12);
      g.add(l);
    });
    return g;
  }

  /* =====================================================================
     ГЕОМЕТРИЯ ТЕЛА

     Две операции, из которых собрано всё живое на сцене.

     loft — натягивает поверхность на набор эллиптических сечений вдоль
     кривой в плоскости YZ. Так делается торс: круглые плечи, гнутая
     спина, сужение к поясу. Раньше спина была капсулой, сплющенной до
     0,42 по глубине, — отсюда «квадратная спина».

     limb — вымётывает трубу переменного радиуса по кривой Catmull-Rom.
     Рука и нога получаются одним куском, без шва на локте и колене.
     ===================================================================== */

  /** stations: [{ y, z, rx, rz }] снизу вверх. Сечения перпендикулярны хребту. */
  function loft(stations, segs, opts) {
    opts = opts || {};
    const N = stations.length;
    const S = segs || sg(24, 12);
    const pos = [], idx = [];

    for (let i = 0; i < N; i++) {
      const s = stations[i];
      const prev = stations[Math.max(0, i - 1)], next = stations[Math.min(N - 1, i + 1)];
      let ty = next.y - prev.y, tz = next.z - prev.z;
      const tl = Math.hypot(ty, tz) || 1;
      ty /= tl; tz /= tl;
      /* Сечение лежит в плоскости, перпендикулярной хребту: одна ось — x,
         вторая получается векторным произведением. */
      for (let k = 0; k < S; k++) {
        const a = (k / S) * Math.PI * 2;
        const cx = Math.cos(a) * s.rx, cz = Math.sin(a) * s.rz;
        pos.push(cx, s.y + cz * tz, s.z - cz * ty);
      }
    }
    for (let i = 0; i < N - 1; i++) {
      for (let k = 0; k < S; k++) {
        const a = i * S + k, b = i * S + (k + 1) % S;
        const c = a + S, d = b + S;
        idx.push(a, c, b, b, c, d);
      }
    }
    /* Донышко и крышка: центральная точка и веер треугольников. */
    if (opts.cap !== false) {
      const first = stations[0], last = stations[N - 1];
      const cLow = pos.length / 3;
      pos.push(0, first.y - first.rz * 0.35, first.z);
      for (let k = 0; k < S; k++) idx.push(cLow, (k + 1) % S, k);
      const cHigh = pos.length / 3;
      pos.push(0, last.y + last.rz * 0.35, last.z);
      const base = (N - 1) * S;
      for (let k = 0; k < S; k++) idx.push(cHigh, base + k, base + (k + 1) % S);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Труба переменного радиуса по кривой: pts — [[x,y,z]…], radii — по длине. */
  function limbGeometry(pts, radii, segs, steps) {
    const S = segs || sg(12, 7);
    const T = steps || sg(14, 8);
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', 0.5);
    const frames = curve.computeFrenetFrames(T, false);
    const pos = [], idx = [];
    const radAt = (u) => {
      if (radii.length === 1) return radii[0];
      const x = u * (radii.length - 1);
      const i = Math.min(radii.length - 2, Math.floor(x));
      return radii[i] + (radii[i + 1] - radii[i]) * (x - i);
    };
    for (let i = 0; i <= T; i++) {
      const u = i / T;
      const p = curve.getPoint(u), r = radAt(u);
      const nrm = frames.normals[Math.min(T - 1, i)], bin = frames.binormals[Math.min(T - 1, i)];
      for (let k = 0; k < S; k++) {
        const a = (k / S) * Math.PI * 2;
        pos.push(
          p.x + (nrm.x * Math.cos(a) + bin.x * Math.sin(a)) * r,
          p.y + (nrm.y * Math.cos(a) + bin.y * Math.sin(a)) * r,
          p.z + (nrm.z * Math.cos(a) + bin.z * Math.sin(a)) * r
        );
      }
    }
    for (let i = 0; i < T; i++) {
      for (let k = 0; k < S; k++) {
        const a = i * S + k, b = i * S + (k + 1) % S;
        idx.push(a, a + S, b, b, a + S, b + S);
      }
    }
    /* заглушки на концах, чтобы в сустав не было видно «трубу» */
    const p0 = curve.getPoint(0), p1 = curve.getPoint(1);
    const c0 = pos.length / 3; pos.push(p0.x, p0.y, p0.z);
    for (let k = 0; k < S; k++) idx.push(c0, (k + 1) % S, k);
    const c1 = pos.length / 3; pos.push(p1.x, p1.y, p1.z);
    for (let k = 0; k < S; k++) idx.push(c1, T * S + k, T * S + (k + 1) % S);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function limb(pts, radii, mat, segs, steps) {
    const m = new THREE.Mesh(limbGeometry(pts, radii, segs, steps), mat);
    m.castShadow = true;
    return m;
  }

  /* Кисть: ладонь, четыре подогнутых пальца и большой отдельно.
     Своя система координат: начало — сустав кисти, +z — куда смотрят
     пальцы, y вверх. Дальше рука ставится целиком одним поворотом. */
  function buildHand(skinMat, side, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const flat = opts.flat !== false;      // ладонь лежит на сукне

    const palm = new THREE.Mesh(loft([
      { y: 0, z: 0.005, rx: 0.036, rz: 0.019 },
      { y: 0, z: 0.045, rx: 0.043, rz: 0.021 },
      { y: 0, z: 0.085, rx: 0.041, rz: 0.018 }
    ], sg(16, 9)), skinMat);
    palm.castShadow = true;
    g.add(palm);

    const fingerR = [0.0145, 0.0135, 0.0105];
    for (let k = 0; k < 4; k++) {
      const x = (k - 1.5) * 0.023;
      const len = 0.072 - Math.abs(k - 1.2) * 0.006;
      const drop = flat ? 0.004 : 0.03;
      const f = limb([
        [x, 0.002, 0.082],
        [x * 1.06, -drop * 0.6, 0.082 + len * 0.55],
        [x * 1.1, -drop, 0.082 + len]
      ], fingerR, skinMat, sg(8, 5), sg(7, 4));
      g.add(f);
    }
    const thumb = limb([
      [side * 0.032, 0.004, 0.028],
      [side * 0.056, -0.004, 0.056],
      [side * 0.062, -0.01, 0.086]
    ], [0.017, 0.015, 0.012], skinMat, sg(8, 5), sg(7, 4));
    g.add(thumb);
    return g;
  }

  /* Фигура человека, сидящего за столом: ноги, руки с кистями, торс,
     шея, голова с лицом, причёска или головной убор.
     В userData отдаём ручки, за которые сцена дёргает анимацию:
     голова (взгляд и мигание), челюсть (речь), грудь (дыхание). */
  /* -----------------------------------------------------------------------
     ФОРМА ГОЛОВЫ
     Одна функция на всё: по ней лепится череп, по ней же сажаются уши,
     веки, волосы и шляпы. Пока размеры задавались числами вручную,
     они неизбежно расходились с головой — отсюда и брались козырьки.
     ----------------------------------------------------------------------- */
  const HEAD_R = 0.205;

  function sstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* Множитель радиуса черепа в направлении (nx, ny, nz). */
  function headShape(nx, ny, nz, female) {
    let k = 1;

    /* Череп чуть выше, чем шире; виски поджаты. */
    k *= 1 + 0.052 * ny - 0.030 * nx * nx * sstep(0, 0.5, ny);

    /* Затылок полнее лба. */
    k *= 1 + 0.055 * sstep(0, -0.7, nz) * (0.45 + 0.275 * (ny + 1));

    /* Челюсть сужается книзу. */
    const low = sstep(-0.05, -0.95, ny);
    k *= 1 - (female ? 0.30 : 0.24) * low * low;

    /* Подбородок выдаётся вперёд. */
    k += 0.055 * low * sstep(0.15, 0.95, nz);

    /* Надбровные дуги. */
    k += 0.016 * sstep(0.55, 1, nz) * Math.exp(-Math.pow((ny - 0.26) / 0.16, 2));

    /* Скулы. */
    k += 0.020 * sstep(0.30, 0.95, nz) * Math.exp(-Math.pow((ny + 0.02) / 0.20, 2))
       * sstep(0.30, 0.85, Math.abs(nx));

    /* Нос — вытянут из той же сетки, а не приставлен конусом. */
    const nd = Math.acos(Math.max(-1, Math.min(1, nz * 0.985 - ny * 0.17)));
    k += 0.082 * Math.exp(-Math.pow(nd / 0.20, 2)) * Math.exp(-Math.pow(nx / 0.17, 2));

    /* Глазницы: лёгкая впадина, чтобы нарисованные глаза сидели в орбитах. */
    k -= 0.013 * sstep(0.45, 0.95, nz)
       * Math.exp(-Math.pow((ny - 0.13) / 0.13, 2))
       * Math.exp(-Math.pow((Math.abs(nx) - 0.30) / 0.17, 2));

    return k;
  }

  /* Точка на поверхности черепа. grow > 1 — чуть над кожей. */
  function headPoint(nx, ny, nz, female, grow) {
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const k = headShape(nx, ny, nz, female) * (grow || 1) * HEAD_R;
    return new THREE.Vector3(nx * k, ny * k * 1.045, nz * k * 0.985);
  }

  /* Лепим готовую сферу (или её кусок) по форме черепа.
     UV не трогаем: развёртка лица остаётся на своём месте. */
  function sculptHead(geo, female, grow) {
    const pos = geo.attributes.position;
    const g = grow || 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      const nx = x / l, ny = y / l, nz = z / l;
      const k = headShape(nx, ny, nz, female) * g * HEAD_R;
      pos.setXYZ(i, nx * k, ny * k * 1.045, nz * k * 0.985);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  /* Морф «рот открыт»: нижняя часть лица опускается и чуть подаётся
     вперёд. Раньше роль челюсти играл отдельный шар, и при разговоре
     он разъезжался с головой. */
  function jawMorph(geo) {
    const pos = geo.attributes.position;
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      const w = sstep(-0.02, -0.75, y / l) * sstep(-0.45, 0.30, z / l);
      arr[i * 3] = x * (1 - 0.035 * w);
      arr[i * 3 + 1] = y - 0.052 * w;
      arr[i * 3 + 2] = z + 0.014 * w;
    }
    geo.morphAttributes.position = [new THREE.Float32BufferAttribute(arr, 3)];
    return geo;
  }

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

    /* ---- посадка: как именно человек держит руки ----
       Четыре посадки раздаются по номеру места, иначе стол выглядит строем
       клонов. Все четыре кладут руки на сукно: край столешницы приходится
       на местную координату z = METRICS.seatGap, и предплечье достаёт до
       него с запасом. */
    const edgeZ = (opts.reach === undefined ? METRICS.seatGap : opts.reach);
    const tblY = (opts.tableY === undefined ? METRICS.tableSurfaceY : opts.tableY);
    const wrY = tblY + 0.022;                 // кисть лежит, не проваливаясь
    const female2 = female;
    const shX = female2 ? 0.225 : 0.248;
    const shY = 0.995, shZ = -0.168;

    const POSE = (opts.pose === undefined ? 0 : opts.pose) % 4;
    function armFor(s) {
      /* s = -1 слева, +1 справа. Возвращает локоть, кисть и доводку кисти. */
      if (POSE === 1) {                       // руки сложены перед собой
        return { eb: [s * 0.265, wrY + 0.022, 0.045], wr: [s * 0.052, wrY + (s > 0 ? 0.028 : 0.004), edgeZ + 0.02],
                 yaw: -s * 0.85, flat: true };
      }
      if (POSE === 2 && s < 0) {               // левая рука лежит на колене
        return { eb: [s * 0.27, 0.80, -0.04], wr: [s * 0.165, 0.665, 0.075], yaw: 0.12, pitch: -0.22, flat: false };
      }
      if (POSE === 3) {                        // руки скрещены на столе
        const up = s > 0 ? 0.026 : 0;
        return { eb: [s * 0.285, wrY + 0.03 + up, 0.02], wr: [-s * 0.03, wrY + 0.03 + up, edgeZ - 0.075],
                 yaw: -s * 1.25, flat: false };
      }
      return { eb: [s * 0.30, wrY + 0.024, 0.02], wr: [s * 0.20, wrY, edgeZ + 0.05], yaw: 0, flat: true };
    }

    /* ---- таз и ноги: одна вымётанная труба от бедра до ступни ---- */
    const hipY = METRICS.hipY, hipZ = -0.245;
    for (const s of [-1, 1]) {
      grp.add(limb([
        [s * 0.125, hipY - 0.01, hipZ],
        [s * 0.15, 0.515, -0.05],
        [s * 0.158, 0.495, 0.13],
        [s * 0.16, 0.30, 0.20],
        [s * 0.162, 0.105, 0.205]
      ], [0.102, 0.094, 0.084, 0.072, 0.055], trous, sg(14, 8), sg(20, 11)));
      const shoe = new THREE.Mesh(loft([
        { y: 0.014, z: 0.15, rx: 0.052, rz: 0.014 },
        { y: 0.042, z: 0.185, rx: 0.058, rz: 0.042 },
        { y: 0.040, z: 0.27, rx: 0.054, rz: 0.034 },
        { y: 0.026, z: 0.325, rx: 0.038, rz: 0.020 }
      ], sg(16, 9)), shoeM);
      shoe.position.x = s * 0.162;
      shoe.castShadow = true;
      grp.add(shoe);
    }

    /* ---- торс: сечения по хребту, круглые плечи, гнутая спина ----
       Раньше здесь стояли цилиндр, шар и капсула, сплющенная до 0,42 по
       глубине: со спины фигура читалась как доска. */
    const chestY = METRICS.chestY;
    const wide = female2 ? 0.94 : 1;
    const torsoStations = [
      { y: 0.520, z: hipZ - 0.01, rx: 0.195 * wide, rz: 0.140 },
      { y: 0.620, z: hipZ + 0.005, rx: 0.172 * wide, rz: 0.124 },
      { y: 0.720, z: -0.222, rx: 0.178 * wide, rz: 0.126 },
      { y: 0.830, z: -0.200, rx: 0.198 * wide, rz: 0.132 },
      { y: 0.925, z: -0.180, rx: 0.218 * wide, rz: 0.138 },
      { y: 0.995, z: -0.172, rx: 0.224 * wide, rz: 0.134 },
      { y: 1.020, z: -0.168, rx: 0.176 * wide, rz: 0.112 },
      { y: 1.050, z: -0.164, rx: 0.115 * wide, rz: 0.082 }
    ];
    const torsoGeo = loft(torsoStations, sg(26, 13));
    /* Геометрию центруем, чтобы дыхание масштабировало торс вокруг груди,
       а не растягивало его от начала координат фигуры. */
    const CX = 0, CY = 0.80, CZ = -0.20;
    torsoGeo.translate(-CX, -CY, -CZ);
    const torso = new THREE.Mesh(torsoGeo, cloth);
    torso.position.set(CX, CY, CZ);
    torso.castShadow = true; torso.receiveShadow = true;
    grp.add(torso);

    /* Отвороты пиджака: две тёмные полоски по краям груди. */
    for (const s of [-1, 1]) {
      const lap = limb([
        [s * 0.085, 1.012, -0.055],
        [s * 0.072, 0.925, -0.036],
        [s * 0.040, 0.845, -0.055]
      ], [0.024, 0.021, 0.014], dark, sg(8, 5), sg(8, 5));
      grp.add(lap);
    }

    /* Был шире шеи и читался как слюнявчик. Сейчас это ворот сорочки. */
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.061, 0.086, 0.062, sg(18, 10)), shirt);
    collar.position.set(0, 1.045, -0.156);
    collar.rotation.x = -0.05; grp.add(collar);
    const tie = new THREE.Mesh(loft([
      { y: 0.815, z: -0.052, rx: 0.024, rz: 0.011 },
      { y: 0.925, z: -0.036, rx: 0.027, rz: 0.012 },
      { y: 1.008, z: -0.052, rx: 0.016, rz: 0.010 }
    ], sg(10, 6)), tieM);
    grp.add(tie);

    /* ---- руки: плечо → локоть → кисть, кисть ложится на сукно ---- */
    for (const s of [-1, 1]) {
      const A = armFor(s);
      const sh = [s * shX, shY, shZ];
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.062, sg(16, 8), sg(12, 6)), cloth);
      shoulder.position.set(sh[0], sh[1], sh[2]);
      shoulder.scale.set(1, 0.92, 1);
      shoulder.castShadow = true; grp.add(shoulder);

      grp.add(limb([
        sh,
        [(sh[0] + A.eb[0]) / 2 + s * 0.018, (sh[1] + A.eb[1]) / 2 - 0.01, (sh[2] + A.eb[2]) / 2 - 0.012],
        A.eb,
        [(A.eb[0] + A.wr[0]) / 2, (A.eb[1] + A.wr[1]) / 2 + 0.006, (A.eb[2] + A.wr[2]) / 2],
        A.wr
      ], [0.068, 0.062, 0.052, 0.045, 0.040], cloth, sg(13, 7), sg(22, 12)));

      /* манжета рубашки у самой кисти */
      const dir = new THREE.Vector3(A.wr[0] - A.eb[0], A.wr[1] - A.eb[1], A.wr[2] - A.eb[2]);
      const cuffFrom = new THREE.Vector3(A.wr[0], A.wr[1], A.wr[2]).addScaledVector(dir, -0.16);
      const cuff = limb([
        [cuffFrom.x, cuffFrom.y, cuffFrom.z],
        [A.wr[0], A.wr[1], A.wr[2]]
      ], [0.046, 0.042], shirt, sg(12, 7), sg(4, 3));
      grp.add(cuff);

      const hand = buildHand(skin, s, { flat: A.flat });
      hand.position.set(A.wr[0], A.wr[1], A.wr[2]);
      /* Пальцы продолжают предплечье: так кисть не «отломана» от руки. */
      hand.rotation.y = Math.atan2(dir.x, dir.z) + (A.yaw || 0);
      hand.rotation.x = A.pitch || 0;
      grp.add(hand);
    }


    /* ---- шея и голова ---- */
    grp.add(limb([
      [0, 1.005, shZ + 0.010],
      [0, 1.065, shZ + 0.024],
      [0, 1.125, shZ + 0.034]
    ], [0.068, 0.058, 0.052], skin, sg(14, 8), sg(8, 5)));

    /* Голова висит на своём пивоте: так её можно поворачивать к говорящему,
       не разбирая всю фигуру. */
    const headY = METRICS.headY, headZ = shZ + 0.032;
    const headPivot = new THREE.Group();
    headPivot.position.set(0, headY, headZ);
    grp.add(headPivot);

    /* Голова и всё, что на ней, живут в своём масштабе. Раньше сфера радиусом
       0,205 давала голову шириной 41 см при плечах 50 — фигура читалась как
       кукла. Теперь голова человеческая, а лицо и причёска пересчитываются
       вместе с ней одним множителем. */
    const headBox = new THREE.Group();
    headBox.scale.setScalar(0.56);
    headPivot.add(headBox);

    /* Одна сетка на всю голову: лоб, скулы, нос, челюсть и подбородок
       вылеплены из сферы. Пересекающихся шаров больше нет, а значит
       нет и ступенек с тенями поперёк лица. */
    const headGeo = jawMorph(sculptHead(
      new THREE.SphereGeometry(1, sg(44, 20), sg(32, 15)), female));
    const head = new THREE.Mesh(headGeo, faceM);
    head.castShadow = true;
    headBox.add(head);
    if (head.morphTargetInfluences && head.morphTargetInfluences.length) {
      head.morphTargetInfluences[0] = 0;
    }

    /* Веки — не шапочки перед лицом, а кусок той же поверхности черепа,
       поднятый на полтора процента над кожей. Поэтому веко повторяет
       кривизну глазницы и не торчит козырьком. */
    const lids = [];
    for (const s of [-1, 1]) {
      const dx = s * 0.34, dy = 0.13, dz = 0.93;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const phi = Math.atan2(dz / dl, -dx / dl);
      const theta = Math.acos(dy / dl);
      const lid = new THREE.Mesh(sculptHead(
        new THREE.SphereGeometry(1, sg(14, 7), sg(10, 5),
          phi - 0.32, 0.64, theta - 0.24, 0.40), female, 1.015), skin);
      lid.visible = false;
      headBox.add(lid);
      lids.push(lid);
    }

    /* Совместимость: раньше сцена двигала отдельный меш челюсти.
       Теперь рот открывает морф, а эта пустая группа осталась точкой
       крепления для старого кода анимации. */
    const jaw = new THREE.Object3D();
    headBox.add(jaw);

    /* Уши сажаются на саму поверхность черепа, а не на глазок. */
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.045, sg(14, 7), sg(12, 6)), skin);
      /* Прижаты к черепу: при тёмных волосах крупное ухо цвета кожи
         читалось светлой шишкой сбоку головы. */
      ear.scale.set(0.32, 0.84, 0.64);
      ear.position.copy(headPoint(s, -0.05, -0.07, female, 0.86));
      ear.rotation.z = -s * 0.10;
      headBox.add(ear);
    }

    /* ---- головной убор или причёска ---- */
    const hat = new THREE.Group();
    /* Ширина головы на линии лба — по ней меряется любой головной убор.
       Раньше радиусы были зашиты числами, и шляпа висела над черепом. */
    const fitR = headPoint(1, 0.42, 0, female, 1).x;
    const crownTop = headPoint(0, 1, 0, female, 1).y;

    if (hatKind === 'fedora') {
      const seatY = crownTop * 0.36;
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.74, fitR * 1.82, 0.026, sg(32, 16)), dark);
      brim.position.y = seatY;
      /* тулья накрывает макушку с запасом, а не парит над ней */
      const hCrown = (crownTop - seatY) + 0.075;
      const crown = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.00, fitR * 1.09, hCrown, sg(30, 15)), dark);
      crown.position.y = seatY + hCrown / 2;
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.11, fitR * 1.11, 0.048, sg(30, 15)),
        new THREE.MeshStandardMaterial({ color: 0x1c1618, roughness: 0.74 }));
      band.position.y = seatY + 0.030;
      brim.castShadow = crown.castShadow = true;
      hat.add(brim, crown, band);
      hat.rotation.set(-0.05, 0, 0.045);
      hat.position.set(0, 0, -0.012);
    } else if (hatKind === 'cap') {
      /* кепка — тот же череп, раздутый на шесть процентов */
      const dome = new THREE.Mesh(sculptHead(
        new THREE.SphereGeometry(1, sg(28, 14), sg(18, 9), 0, Math.PI * 2, 0, Math.PI * 0.54),
        female, 1.06), dark);
      dome.castShadow = true;
      const peak = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 0.98, fitR * 1.04, 0.024, sg(24, 12), 1, false, 0, Math.PI), dark);
      peak.position.set(0, crownTop * 0.30, fitR * 0.80);
      peak.rotation.set(0.12, Math.PI, 0);
      hat.add(dome, peak);
    } else {
      /* Волосы тоже лепятся по черепу. Раньше это была полусфера
         радиусом 0,216 при голове шириной 0,199: по бокам она торчала
         козырьком, а на макушке тонула в черепе. */
      const cap = new THREE.Mesh(sculptHead(
        new THREE.SphereGeometry(1, sg(32, 16), sg(22, 11), 0, Math.PI * 2, 0,
          Math.PI * (female ? 0.60 : 0.54)), female, 1.035), hairM);
      cap.castShadow = true;
      hat.add(cap);

      /* затылок: сзади волосы спускаются ниже */
      const nape = new THREE.Mesh(sculptHead(
        new THREE.SphereGeometry(1, sg(24, 12), sg(16, 8),
          Math.PI * 1.04, Math.PI * 0.92, Math.PI * 0.22,
          Math.PI * (female ? 0.54 : 0.40)), female, 1.028), hairM);
      hat.add(nape);

      /* Пряди только по затылку и вплотную к черепу. Раньше они шли
         по всему кругу, включая лицо, и торчали в стороны рогами. */
      const strands = LOWQ ? 3 : 7;
      for (let k2 = 0; k2 < strands; k2++) {
        const a = Math.PI * (0.55 + (k2 / (strands - 1)) * 0.90);
        const dx = Math.sin(a), dz = Math.cos(a);
        const len = 0.09 + rnd() * (female ? 0.30 : 0.06);
        const lock = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, len, sg(6, 3), sg(10, 5)), hairM);
        const p = headPoint(dx, -0.30, dz, female, 0.98);
        lock.position.set(p.x * 0.94, p.y - len * 0.40, p.z * 0.94);
        lock.rotation.set(0.06, 0, -dx * 0.30);
        hat.add(lock);
      }
      if (female) {
        const bun = new THREE.Mesh(new THREE.SphereGeometry(0.10, sg(18, 9), sg(14, 7)), hairM);
        const bp = headPoint(0, 0.10, -1, female, 0.98);
        bun.position.set(0, bp.y, bp.z - 0.040);
        hat.add(bun);
      }
    }
    headBox.add(hat);

    grp.userData = {
      torso, head, headPivot, jaw, hat, lids,
      restJawY: jaw.position.y,
      /* Речь и мигание отдаются наружу ручками: сцена не должна
         знать, чем именно открывается рот. */
      talk(open) {
        const inf = head.morphTargetInfluences;
        if (inf && inf.length) inf[0] = Math.max(0, Math.min(1, open));
      },
      talkAmt() {
        const inf = head.morphTargetInfluences;
        return (inf && inf.length) ? inf[0] : 0;
      },
      blink(closed) {
        const on = closed > 0.5;
        for (const l of lids) l.visible = on;
      },
      /* Дыхание: торс чуть раздаётся в грудь и на волос поднимается.
         Ручка отдаётся наружу, чтобы сцена не знала про сечения. */
      breathe(k) {
        torso.scale.set(1 + k * 0.013, 1 + k * 0.006, 1 + k * 0.016);
      },
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
    METRICS, tableRadiusFor, loft, limb, buildHand,
    plankCanvas, plasterCanvas, backdropCanvas, feltCanvas,
    cardBackCanvas, cardFaceCanvas, nameCanvas, crossCanvas, faceCanvas,
    buildRoom, buildLamp, buildTable, buildChair, buildFigure
  };
}
