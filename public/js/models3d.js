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
    hipY: 0.525,          // таз сидящего
    chestY: 0.978,        // линия плечевых суставов
    headY: 1.217,         // центр черепа
    crownY: 1.324,        // макушка
    tableSurfaceY: 0.80,  // сукно: на 0,33 выше сиденья — как за обычным столом
    seatGap: 0.21,        // от края стола до центра места: предплечье ложится на сукно
    seatPitch: 0.86       // сколько места нужно одному человеку по кругу
  };

  /** Радиус стола под число игроков: сначала круг мест, потом столешница. */
  function tableRadiusFor(n) {
    const seatR = Math.max(0.73, (Math.max(1, n) * METRICS.seatPitch) / (Math.PI * 2));
    return Math.max(0.52, seatR - METRICS.seatGap);
  }

  /* ---------------------------------------------------------------------
     КАЧЕСТВО

     Одна и та же сцена должна идти и на настольной машине, и на телефоне за
     десять тысяч рублей. Решение принимается один раз при сборке мастерской
     и дальше живёт в двух числах: sg(много, мало) для сегментов сетки и
     LOWQ для всего остального (число прядей, пылинок, размер карт теней).

     Порядок такой: узкий экран, мало ядер, мало памяти или высокая плотность
     пикселей на слабом железе — всё это признаки телефона, и любой из них
     переводит сцену в облегчённый режим. Экономия здесь идёт не за счёт
     красоты силуэта, а за счёт того, чего не видно на пяти дюймах: сегментов
     по кругу, числа волосяных прядей, мягкости теней.
     --------------------------------------------------------------------- */
  const TIER = (() => {
    try {
      const nav = typeof navigator === 'undefined' ? {} : navigator;
      const cores = nav.hardwareConcurrency || 8;
      const mem = nav.deviceMemory || nav.memory || 8;      // не во всех браузерах
      const small = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 860px)').matches;
      const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
      const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
      let score = 0;
      if (small) score += 2;
      if (coarse) score += 1;
      if (cores <= 4) score += 2;
      if (mem <= 4) score += 1;
      if (dpr >= 2.5 && cores <= 6) score += 1;
      if (score >= 3) return 'low';
      if (score >= 1) return 'mid';
      return 'high';
    } catch (e) { return 'mid'; }
  })();
  const LOWQ = TIER === 'low';
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

     Здесь живёт человек: кости, мясо, одежда, лицо и волосы. Всё это
     считается от одной таблицы размеров BODY, и это главное правило файла.
     Пока каждая часть мерилась своей линейкой, получалось то, на что и
     жаловался игрок: голова шириной 23 см при плечах 45, шея, уходящая в
     воротник-ведро, кисти, висящие в воздухе в пяти сантиметрах от сукна.

     Числа взяты из антропометрии сидящего взрослого человека (в метрах):
     плечи 38 см между суставами, голова 16 см в ширину и 21 в высоту,
     плечо 27 см, предплечье 27, кисть 18, бедро от таза до колена 38.
     Сложенные вместе, они дают силуэт, который глаз узнаёт как человека
     ещё до того, как разглядит лицо.

     Две операции, из которых собрано всё живое.

     loft — натягивает поверхность на набор эллиптических сечений вдоль
     кривой в плоскости YZ. Так делается торс: круглые плечи, гнутая
     спина, сужение к поясу.

     limb — вымётывает трубу переменного радиуса по кривой Catmull-Rom.
     Рука и нога получаются одним куском, без шва на локте и колене; конец
     руки нарочно начинается внутри торса, поэтому в плече нет щели.
     ===================================================================== */

  /* Скелет сидящего человека. Координаты в системе фигуры: начало — на полу
     под тазом, +z — куда человек смотрит (к центру стола), y — вверх. */
  const BODY = {
    seatY: 0.470,                                   // сиденье стула
    tableY: METRICS.tableSurfaceY,                  // сукно
    hip:      { x: 0.088, y: 0.525, z: -0.212 },
    knee:     { x: 0.118, y: 0.468, z:  0.152 },
    ankle:    { x: 0.126, y: 0.072, z:  0.198 },
    shoulder: { x: 0.185, y: 0.978, z: -0.186 },
    neckBase: { y: 1.036, z: -0.176, r: 0.057 },
    neckTop:  { y: 1.118, z: -0.157, r: 0.048 },
    headPivot:{ y: 1.146, z: -0.150 },
    /* Череп: половинные размеры. 7,9 см в ширину — это голова 158 мм,
       ровно средняя человеческая. Раньше здесь стояло 11,5. */
    skull:    { rx: 0.0755, ry: 0.1105, rz: 0.0975, cy: 0.0735 }
  };

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

  function sstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function gauss(x, s) { return Math.exp(-(x * x) / (s * s)); }

  /* ---------------------------------------------------------------------
     ЧЕРЕП

     Одна функция задаёт форму, и по ней потом сажается всё остальное:
     глаза, брови, нос, уши, волосы, шляпа. Пока размеры головных убоРов
     задавались числами вручную, они неизбежно расходились с головой —
     отсюда и брались козырьки, висящие в воздухе.

     Нос, губы и глаза — отдельные меши, а не рисунок на сфере: на
     расстоянии стола это почти незаметно, зато в упор видно сразу, и
     именно из-за нарисованных глаз лица выглядели плоскими масками.
     --------------------------------------------------------------------- */

  /* Множитель радиуса черепа в направлении (nx, ny, nz). Направление уже
     нормировано; nz > 0 — вперёд, ny > 0 — вверх. */
  function skullShape(nx, ny, nz, female) {
    let k = 1;
    const low = sstep(-0.02, -0.92, ny);          // насколько мы в нижней части лица

    /* Затылок полнее лба — иначе голова читается как шар. */
    k *= 1 + 0.050 * sstep(0, -0.75, nz) * (0.5 + 0.25 * (ny + 1));

    /* Челюсть сужается книзу, у женщин сильнее. */
    k *= 1 - (female ? 0.235 : 0.185) * low * low;

    /* Подбородок выдаётся вперёд и чуть вниз. */
    k += 0.052 * low * sstep(0.10, 0.90, nz);

    /* Углы челюсти: без них лицо выглядит как яйцо. Угол стоит там, где
       он и стоит у человека — под ухом, на середине высоты лица. */
    k += 0.034 * gauss(low - 0.45, 0.30) * sstep(0.40, 0.92, Math.abs(nx)) * sstep(-0.75, 0.10, nz);

    /* Щёки не надувные: подскуловая впадина забирает пухлость, из-за
       которой любое процедурное лицо выглядит младенческим. */
    k -= 0.026 * gauss(ny + 0.30, 0.22) * sstep(0.20, 0.80, nz) * sstep(0.25, 0.70, Math.abs(nx));

    /* Надбровные дуги. */
    k += 0.020 * sstep(0.50, 1, nz) * gauss(ny - 0.27, 0.17);

    /* Скулы. */
    k += 0.024 * sstep(0.20, 0.90, nz) * gauss(ny + 0.02, 0.20) * sstep(0.28, 0.80, Math.abs(nx));

    /* Виски поджаты. */
    k -= 0.024 * gauss(ny - 0.30, 0.24) * sstep(0.55, 0.95, Math.abs(nx)) * sstep(0.55, 0, Math.abs(nz));

    /* Глазницы: лёгкая впадина, чтобы глазное яблоко сидело в орбите. */
    k -= 0.020 * sstep(0.40, 0.95, nz) * gauss(ny - 0.16, 0.14) * gauss(Math.abs(nx) - 0.34, 0.18);

    return k;
  }

  /* Точка на поверхности черепа в системе headBox. grow > 1 — чуть над кожей. */
  function skullPoint(nx, ny, nz, female, grow) {
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const k = skullShape(nx, ny, nz, female) * (grow || 1);
    const S = BODY.skull;
    return new THREE.Vector3(nx * k * S.rx, S.cy + ny * k * S.ry, nz * k * S.rz);
  }

  /* Лепим сферу (или её кусок) по форме черепа. UV не трогаем: развёртка
     кожи остаётся на месте. */
  function sculptSkull(geo, female, grow) {
    const pos = geo.attributes.position;
    const g = grow || 1;
    const S = BODY.skull;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      const nx = x / l, ny = y / l, nz = z / l;
      const k = skullShape(nx, ny, nz, female) * g;
      pos.setXYZ(i, nx * k * S.rx, S.cy + ny * k * S.ry, nz * k * S.rz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  /* Морф «рот открыт»: нижняя часть лица опускается и чуть подаётся вперёд.
     Считается по исходной сфере, до лепки, — поэтому маска берётся от
     нормированного направления. */
  function jawMorph(geo, female) {
    const pos = geo.attributes.position;
    const S = BODY.skull;
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i) - S.cy, z = pos.getZ(i);
      /* Направление восстанавливаем из уже вылепленной точки: делить на
         радиусы достаточно, форма черепа искажает его слабо. */
      const nx = x / S.rx, ny = y / S.ry, nz = z / S.rz;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const w = sstep(-0.05, -0.72, ny / l) * sstep(-0.55, 0.25, nz / l);
      arr[i * 3] = x * (1 - 0.03 * w);
      arr[i * 3 + 1] = pos.getY(i) - 0.030 * w;
      arr[i * 3 + 2] = z + 0.008 * w;
    }
    geo.morphAttributes.position = [new THREE.Float32BufferAttribute(arr, 3)];
    return geo;
  }

  /* ---------------------------------------------------------------------
     ГЛАЗ

     Настоящее глазное яблоко в орбите с двумя веками. Раньше глаза были
     нарисованы на сфере головы, а «веко» было шапочкой, которая на время
     мигания просто появлялась перед лицом. Живой глаз ловит свет, ходит
     за говорящим и закрывается веком, которое поворачивается.
     --------------------------------------------------------------------- */
  function eyeTexture(irisHex) {
    const W = 128, H = 64;
    const c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = '#f2ece2'; g.fillRect(0, 0, W, H);
    /* сосуды и лёгкая желтизна по краям — белок не бывает белым */
    for (let i = 0; i < 16; i++) {
      g.strokeStyle = 'rgba(178,108,96,' + (0.06 + Math.random() * 0.10).toFixed(3) + ')';
      g.lineWidth = 0.7;
      const y = Math.random() * H;
      g.beginPath(); g.moveTo(Math.random() * W, y);
      g.quadraticCurveTo(Math.random() * W, y + 6, Math.random() * W, y + (Math.random() - 0.5) * 10);
      g.stroke();
    }
    /* Радужка приходится на u = 0.25 — направление +z, куда смотрит глаз. */
    const cx = W * 0.25, cy = H * 0.5, r = 11;
    const grd = g.createRadialGradient(cx, cy, 1, cx, cy, r);
    grd.addColorStop(0, '#120c0a');
    grd.addColorStop(0.34, '#120c0a');
    grd.addColorStop(0.38, irisHex);
    grd.addColorStop(1, 'rgba(20,12,10,.85)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    /* волокна радужки */
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 0.8;
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42);
      g.lineTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
      g.stroke();
    }
    g.strokeStyle = 'rgba(24,16,12,.55)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    return c;
  }

  const IRISES = ['#5b4326', '#3f5a46', '#33556e', '#6b4a2c', '#6f665a', '#2f4436'];

  /** Глаз целиком: яблоко, верхнее и нижнее веко. side: -1 слева, +1 справа. */
  function buildEye(skinMat, lidMat, seed, side, female, iris) {
    /* Радужка приходит снаружи: пока каждый глаз брал свой случайный цвет,
       у человека оказывался один глаз зелёный, другой карий. */
    const R = 0.0116;
    const g = new THREE.Group();

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(R, sg(20, 10), sg(14, 8)),
      new THREE.MeshStandardMaterial({
        map: texFromCanvas(eyeTexture(iris || IRISES[0])),
        roughness: 0.16, metalness: 0.02
      })
    );
    g.add(ball);

    /* Веко — колпак чуть больше яблока. Открытое веко приподнято, закрытое
       опускается до нижнего: поворот, а не появление из воздуха. */
    /* Раскрытие. Глазная щель у человека — около 10 мм в высоту при
       ширине 30: видно радужку целиком и полоску белка по бокам. Пока
       веки стояли почти сомкнутыми, глаз читался бусиной. */
    function lid(upper) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.05, sg(18, 9), sg(12, 6), 0, Math.PI * 2, 0, upper ? 1.42 : 1.28),
        lidMat
      );
      m.rotation.x = upper ? -0.30 : Math.PI + 0.26;
      return m;
    }
    const up = lid(true), down = lid(false);
    g.add(up, down);

    /* Ресницы: тонкая тёмная кромка по краю верхнего века. Без неё глаз
       выглядит стеклянным шариком, вставленным в лицо. */
    const lash = new THREE.Mesh(
      new THREE.TorusGeometry(R * 1.02, R * 0.075, sg(6, 4), sg(16, 8), Math.PI * (female ? 1.15 : 1.0)),
      new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 0.8 })
    );
    lash.rotation.set(-0.30, 0, Math.PI * (female ? -0.08 : 0));
    lash.position.z = R * 0.10;
    up.add(lash);

    g.userData = {
      ball,
      /* 0 — глаз открыт, 1 — закрыт. */
      close(k) {
        up.rotation.x = -0.30 + k * 1.22;
        down.rotation.x = Math.PI + 0.26 - k * 0.18;
      },
      /* Взгляд: доворот яблока. Больше 0,4 радиана человек не косит. */
      look(yaw, pitch) {
        ball.rotation.y = Math.max(-0.42, Math.min(0.42, yaw || 0));
        ball.rotation.x = Math.max(-0.30, Math.min(0.30, pitch || 0));
      }
    };
    return g;
  }

  /* ---------------------------------------------------------------------
     ЛИЦО: кожа, нос, губы, брови, уши
     --------------------------------------------------------------------- */

  /* Кожа головы в equirect-развёртке: центр лица приходится на u = 0.25,
     то есть на направление +z, куда смотрит фигура.

     Черты лица здесь больше не рисуются — они собраны из мешей. Текстура
     отвечает за то, что геометрией не сделать дешёвле: тон кожи, тень в
     глазницах и под скулой, румянец, щетина и тёмный корень волос под
     причёской, чтобы между прядями не просвечивала лысина. */
  function skinCanvas(skinHex, hairHex, seed, female) {
    const W = LOWQ ? 512 : 1024, H = W / 2;
    const c = cvs(W, H), g = c.getContext('2d');
    const rnd = prng(seed * 31 + 5);
    const cx = W * 0.25, cy = H * 0.50;
    /* Развёртка растянута по вертикали: череп выше, чем шире (ry/rx ≈ 1,35).
       Все размеры по y делим на этот множитель, иначе черты «поедут». */
    const AY = BODY.skull.ry / BODY.skull.rx;
    const f = W * 0.22;              // условная «ширина лица» в пикселях
    const sc = hex(skinHex);

    g.fillStyle = sc; g.fillRect(0, 0, W, H);

    /* Тёмный корень волос: верх развёртки и затылок. Видно только в
       просветах между прядями — и именно это делает причёску густой. */
    const roots = g.createLinearGradient(0, 0, 0, H * 0.42);
    roots.addColorStop(0, hex(hairHex));
    roots.addColorStop(0.55, hex(hairHex));
    roots.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = roots; g.fillRect(0, 0, W, H * 0.42);
    /* сзади (u около 0.75) корень спускается ниже */
    const back = g.createRadialGradient(W * 0.75, H * 0.30, f * 0.2, W * 0.75, H * 0.30, f * 1.5);
    back.addColorStop(0, hex(hairHex));
    back.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = back; g.fillRect(0, 0, W, H * 0.75);

    /* Объём: виски темнее, середина лица светлее. */
    const sd = g.createLinearGradient(cx - f * 1.1, 0, cx + f * 1.1, 0);
    sd.addColorStop(0, 'rgba(26,14,11,.30)');
    sd.addColorStop(0.5, 'rgba(255,240,222,.10)');
    sd.addColorStop(1, 'rgba(26,14,11,.30)');
    g.save();
    g.beginPath(); g.ellipse(cx, cy + f * 0.10 / AY, f * 0.72, f * 1.05 / AY, 0, 0, Math.PI * 2); g.clip();
    g.fillStyle = sd; g.fillRect(0, 0, W, H);
    g.restore();

    /* Тень в глазницах: под ней сидят настоящие глазные яблоки. */
    const ey = cy - f * 0.16 / AY, ex = f * 0.40;
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      const sk = g.createRadialGradient(x, ey, f * 0.02, x, ey, f * 0.20);
      sk.addColorStop(0, 'rgba(48,26,20,.30)');
      sk.addColorStop(1, 'rgba(48,26,20,0)');
      g.fillStyle = sk;
      g.beginPath(); g.ellipse(x, ey, f * 0.22, f * 0.17 / AY, 0, 0, Math.PI * 2); g.fill();
    }

    /* Тень под скулой и у крыльев носа. */
    for (const s of [-1, 1]) {
      const x = cx + s * f * 0.40, y = cy + f * 0.16 / AY;
      const ch = g.createRadialGradient(x, y, f * 0.02, x, y, f * 0.26);
      ch.addColorStop(0, 'rgba(120,60,44,.16)');
      ch.addColorStop(1, 'rgba(120,60,44,0)');
      g.fillStyle = ch;
      g.beginPath(); g.ellipse(x, y, f * 0.26, f * 0.22 / AY, 0, 0, Math.PI * 2); g.fill();
    }
    /* румянец */
    for (const s of [-1, 1]) {
      const x = cx + s * f * 0.46, y = cy + f * 0.06 / AY;
      const bl = g.createRadialGradient(x, y, f * 0.02, x, y, f * 0.22);
      bl.addColorStop(0, 'rgba(196,102,84,' + (female ? 0.16 : 0.10) + ')');
      bl.addColorStop(1, 'rgba(196,102,84,0)');
      g.fillStyle = bl;
      g.beginPath(); g.ellipse(x, y, f * 0.22, f * 0.18 / AY, 0, 0, Math.PI * 2); g.fill();
    }

    /* Щетина: не у всех и не всегда — но одна эта деталь отличает людей
       друг от друга сильнее, чем цвет пиджака. */
    if (!female && rnd() > 0.42) {
      g.save();
      const sy = cy + f * 0.72 / AY;
      g.beginPath();
      g.ellipse(cx, sy, f * 0.44, f * 0.30 / AY, 0, 0, Math.PI * 2);
      g.clip();
      /* Щетина — это тень, а не точки. Мелкие штрихи поверх мягкого
         затемнения: россыпь крупных точек читалась как грязь на лице. */
      const sh = g.createRadialGradient(cx, sy, f * 0.05, cx, sy, f * 0.44);
      sh.addColorStop(0, 'rgba(44,30,24,.26)');
      sh.addColorStop(1, 'rgba(44,30,24,0)');
      g.fillStyle = sh; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(38,26,22,.16)';
      for (let i = 0; i < (LOWQ ? 400 : 1400); i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
        g.fillRect(cx + Math.cos(a) * r * f * 0.44, sy + Math.sin(a) * r * f * 0.30 / AY, 1.1, 1.1);
      }
      g.restore();
    }

    /* Поры и неровности тона: кожа не бывает ровной заливкой. */
    noisify(g, W, H, 9);
    return c;
  }

  /** Нос: спинка, кончик, крылья. Отдельным мешем — так он не «спица». */
  function buildNose(skinMat, female, seed) {
    const rnd = prng(seed * 53 + 11);
    const S = BODY.skull;
    const long = 0.9 + rnd() * 0.30;
    const wide = (female ? 0.86 : 1) * (0.92 + rnd() * 0.22);
    const g = new THREE.Group();

    /* Нос строится от самой поверхности черепа: точка на лице плюс вынос
       вперёд. Пока координаты писались множителями к радиусу, кончик носа
       оказывался ровно на коже — и нос пропадал вовсе.

       Вынос: у переносицы ноль, у кончика 15 мм. Столько и выступает
       человеческий нос. */
    const N = (ny, nz, out, rx, rz) => {
      const p = skullPoint(0, ny, nz, female, 1);
      return { y: p.y, z: p.z + out * long, rx: rx * wide, rz: rz };
    };
    const nose = new THREE.Mesh(loft([
      N(0.10, 0.99, 0.0000, 0.0098, 0.0060),   // переносица, ниже линии глаз
      N(-0.02, 1.00, 0.0042, 0.0106, 0.0082),  // спинка
      N(-0.15, 0.99, 0.0094, 0.0126, 0.0106),  // ниже спинки
      N(-0.245, 0.965, 0.0130, 0.0158, 0.0124),// кончик
      N(-0.30, 0.945, 0.0092, 0.0186, 0.0086), // крылья: часть той же формы
      N(-0.335, 0.925, 0.0016, 0.0150, 0.0044) // переход к губе
    ], sg(18, 10)), skinMat);
    nose.castShadow = true;
    g.add(nose);

    /* Ноздри: две тени под основанием. Отдельных шариков-крыльев больше
       нет — крылья вылеплены в самой форме носа, иначе они читались как
       два мячика, приклеенных по сторонам. */
    const baseS = skullPoint(0, -0.32, 0.93, female, 1);
    for (const s2 of [-1, 1]) {
      const nostril = new THREE.Mesh(
        new THREE.SphereGeometry(0.0040 * wide, sg(10, 6), sg(8, 4)),
        new THREE.MeshStandardMaterial({ color: 0x261613, roughness: 0.95 }));
      nostril.position.set(s2 * 0.0105 * wide, baseS.y - 0.0016, baseS.z + 0.0068 * long);
      nostril.scale.set(1, 0.42, 1.05);
      g.add(nostril);
    }
    return g;
  }

  /** Губы: верхняя с «луком Купидона» и нижняя, полнее. */
  function buildLips(seed, female, skinC) {
    const rnd = prng(seed * 37 + 3);
    /* Губа — это та же кожа, только темнее и краснее. Отдельный «помадный»
       тон превращал закрытый рот в улыбку клоуна. */
    const tone = (skinC ? skinC.clone() : new THREE.Color(0xc99a78))
      .lerp(new THREE.Color(female ? 0xa8514c : 0x8d4f47), female ? 0.62 : 0.44)
      .multiplyScalar(0.88);
    const mat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.46 });
    const seamM = new THREE.MeshStandardMaterial({
      color: tone.clone().multiplyScalar(0.34), roughness: 0.8 });
    const g = new THREE.Group();
    const w = 0.90 * (female ? 0.96 : 1) * (0.94 + rnd() * 0.14);

    /* Губы сажаем на саму поверхность черепа: направление задаётся, а
       расстояние берётся у формы головы. Пока координаты писались руками,
       рот то тонул в подбородке, то висел перед лицом. */
    const P = (nx, ny, nz, grow) => {
      const p = skullPoint(nx * w, ny, nz, female, grow === undefined ? 1.004 : grow);
      return [p.x, p.y, p.z];
    };
    const upper = limb([
      P(-0.30, -0.44, 0.86, 0.998),
      P(-0.15, -0.41, 0.90),
      P(0, -0.415, 0.905, 1.008),
      P(0.15, -0.41, 0.90),
      P(0.30, -0.44, 0.86, 0.998)
    ], [0.0020, 0.0040, 0.0038, 0.0040, 0.0020], mat, sg(10, 6), sg(12, 7));
    const lower = limb([
      P(-0.28, -0.50, 0.85, 0.998),
      P(-0.14, -0.525, 0.885),
      P(0, -0.53, 0.895, 1.010),
      P(0.14, -0.525, 0.885),
      P(0.28, -0.50, 0.85, 0.998)
    ], [0.0022, 0.0044, 0.0050, 0.0044, 0.0022], mat, sg(10, 6), sg(12, 7));
    /* Шов между губами: тонкая тёмная линия. Без неё рот читается как
       одна пухлая деталь, а не как закрытые губы. */
    const seam = limb([
      P(-0.29, -0.472, 0.855, 1.000),
      P(-0.14, -0.468, 0.895, 1.004),
      P(0, -0.470, 0.905, 1.006),
      P(0.14, -0.468, 0.895, 1.004),
      P(0.29, -0.472, 0.855, 1.000)
    ], [0.0009, 0.0016, 0.0016, 0.0016, 0.0009], seamM, sg(6, 4), sg(10, 6));
    g.add(upper, lower, seam);
    g.userData = { upper, lower, seam, mat, seamM };
    return g;
  }

  /** Бровь: тонкая дуга по надбровной дуге, чуть выше кожи. */
  function buildBrow(hairC, side, female, female2) {
    const S = BODY.skull;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hairC).multiplyScalar(0.72), roughness: 0.92
    });
    /* Бровь идёт по краю надбровной дуги, на полтора сантиметра выше
       глаза. Пока она стояла на 0,34–0,40 по вертикали, это была не бровь,
       а дуга, парящая посреди лба. */
    const inner = skullPoint(side * 0.17, 0.205, 0.945, female2, 1.010);
    const mid = skullPoint(side * 0.37, 0.235, 0.880, female2, 1.010);
    const outer = skullPoint(side * 0.55, 0.170, 0.760, female2, 1.008);
    const r = female ? 0.0034 : 0.0046;
    return limb(
      [[inner.x, inner.y, inner.z], [mid.x, mid.y, mid.z], [outer.x, outer.y, outer.z]],
      [r * 0.8, r, r * 0.45], mat, sg(8, 5), sg(9, 5));
  }

  /** Ухо: раковина с завитком и ямкой, прижатая к черепу. */
  function buildEar(skinMat, side, female) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.0225, sg(14, 7), sg(12, 6)), skinMat);
    shell.scale.set(0.30, 1.06, 0.70);
    g.add(shell);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.0150, 0.0032, sg(7, 4), sg(16, 8), Math.PI * 1.5), skinMat);
    rim.rotation.set(0.1, Math.PI / 2 * side, -0.30 * side);
    rim.scale.set(0.34, 1.24, 1);
    g.add(rim);
    const hole = new THREE.Mesh(
      new THREE.SphereGeometry(0.0052, sg(10, 5), sg(8, 4)),
      new THREE.MeshStandardMaterial({ color: 0x30201c, roughness: 0.95 }));
    hole.position.set(side * 0.0022, -0.0018, 0.0016);
    g.add(hole);
    /* Ухо стоит за скулой, на линии от глаза к кончику носа, и прижато
       к черепу: раньше оно вылезало на висок светлым плавником. */
    const p = skullPoint(side, -0.08, -0.20, female, 0.945);
    g.position.copy(p);
    g.rotation.z = -side * 0.08;
    g.rotation.y = side * 0.30;
    return g;
  }

  /* ---------------------------------------------------------------------
     ВОЛОСЫ

     Причёска собрана из трёх слоёв, и каждый отвечает за свою жалобу.

     1. Шапка по черепу с настоящей линией роста волос: над лбом высоко,
        у виска ниже, на затылке спускается к шее. Раньше это была
        полусфера, надетая на голову до самых глаз.
     2. Пряди — тонкие трубки радиусом 6–9 мм, идущие от пробора вниз по
        черепу и чуть отходящие на концах. Раньше на затылке висели
        капсулы толщиной 24 мм, те самые «колбаски».
     3. Каждая прядь висит на своём шарнире в точке корня и качается со
        своей фазой: голова повернулась — волосы догоняют её с запозданием.
     --------------------------------------------------------------------- */

  /* Полярный угол линии роста волос для азимута a (0 — вперёд, ±π — назад).
     wob — своя для каждого человека неровность линии: мысок над лбом,
     западины у висков. Ровная линия читается как надетый парик. */
  function hairlineTheta(a, female, wob) {
    const c = Math.cos(a);
    /* спереди 0.80 рад от макушки (волосы начинаются над бровью, а не
       на ней), у виска 1.25, на затылке 1.70 */
    let th = (1.25 - 0.45 * c) * (female ? 1.05 : 1);
    if (wob) {
      /* мысок по центру лба и две западины по бокам от него */
      th -= wob.peak * gauss(a, 0.30);
      th += wob.temple * (gauss(a - 0.85, 0.34) + gauss(a + 0.85, 0.34));
      th += wob.wave * Math.sin(a * 3.1 + wob.phase) * 0.04;
    }
    return th;
  }

  function buildHair(hairC, female, seed, style) {
    const rnd = prng(seed * 91 + 17);
    /* Линия роста волос у каждого своя: у одного мысок, у другого высокие
       залысины у висков. */
    const wob = {
      peak: (female ? 0.05 : 0.08) * rnd(),
      temple: (female ? 0.05 : 0.12) * rnd(),
      wave: 0.5 + rnd(),
      phase: rnd() * Math.PI * 2
    };
    const grp = new THREE.Group();
    const strands = [];
    const base = new THREE.Color(hairC);
    /* Волосы почти не блестят: с гладким материалом верхний слой ловит
       свет лампы и вся причёска светлеет на два тона — из каштановой
       становится соломенной. */
    const mat = new THREE.MeshStandardMaterial({ color: base, roughness: 0.86, metalness: 0.0 });
    /* Верхний слой светлее: свет лампы ложится на волосы блеском, и без
       второго тона причёска читается как резиновая шапка. */
    const glossMat = new THREE.MeshStandardMaterial({
      color: base.clone().lerp(new THREE.Color(0xffffff), 0.05), roughness: 0.70, metalness: 0.02
    });

    /* --- 1. шапка по черепу с линией роста волос --- */
    const cap = new THREE.SphereGeometry(1, sg(54, 26), sg(34, 16), 0, Math.PI * 2, 0, Math.PI * 0.74);
    const pos = cap.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      let nx = x / l, ny = y / l, nz = z / l;
      const a = Math.atan2(nx, nz);
      const th = Math.acos(Math.max(-1, Math.min(1, ny)));
      const end = hairlineTheta(a, female, wob);
      /* Вершины ниже линии роста подтягиваем на саму линию: получается
         кромка, а не обрубленный купол. */
      const t = Math.min(th, end);
      const sn = Math.sin(t);
      nx = sn * Math.sin(a); nz = sn * Math.cos(a); ny = Math.cos(t);
      /* Толщина: у макушки 14 мм, к кромке сходит в ноль. */
      /* Толщина: у макушки полтора сантиметра, к кромке сходит в ноль
         плавно — иначе край причёски идёт зубчиками. */
      const thick = 1 + 0.145 * sstep(end, end * 0.30, t);
      const k = skullShape(nx, ny, nz, female) * thick;
      const S = BODY.skull;
      pos.setXYZ(i, nx * k * S.rx, S.cy + ny * k * S.ry, nz * k * S.rz);
    }
    pos.needsUpdate = true;
    cap.computeVertexNormals();
    const capMesh = new THREE.Mesh(cap, glossMat);
    capMesh.castShadow = true;
    grp.add(capMesh);

    /* --- 2. пряди --- */
    /* Прядей много и они тонкие: именно из числа и толщины и складывается
       разница между причёской и резиновой шапкой. На слабом устройстве
       прядей меньше, но толщину не увеличиваем — лучше реже, чем толще. */
    const COUNT = LOWQ ? 14 : (female ? 44 : 34);
    const longHair = female && style !== 'short';
    for (let i = 0; i < COUNT; i++) {
      /* Азимуты раскладываем от лба назад по обе стороны от пробора. */
      const u = (i + 0.5) / COUNT;
      const a = (u < 0.5 ? -1 : 1) * (0.10 + Math.abs(u - 0.5) * 2 * 2.95) + (rnd() - 0.5) * 0.22;
      const front = Math.abs(a) < 0.95;
      const backSide = Math.abs(a) > 2.1;
      /* Длинная прядь начинается за виском. Пока длинные пряди шли и
         спереди, они падали на лицо и читались как дреды. */
      const canBeLong = Math.abs(a) > 1.25;

      /* Корень — у пробора, чуть в стороне от макушки. */
      const root = skullPoint(Math.sin(a) * 0.30, 0.94, Math.cos(a) * 0.30, female, 1.09);
      const midTh = hairlineTheta(a, female, wob) * 0.62;
      const mid = skullPoint(
        Math.sin(midTh) * Math.sin(a), Math.cos(midTh), Math.sin(midTh) * Math.cos(a), female, 1.115);
      const endTh = hairlineTheta(a, female, wob) * (front ? 0.99 : 1.02);
      const end = skullPoint(
        Math.sin(endTh) * Math.sin(a), Math.cos(endTh), Math.sin(endTh) * Math.cos(a), female, 1.10);

      /* Кончик уходит за кромку: у мужчин на сантиметр, у женщин прядь
         падает на плечо. */
      /* Кончик у мужчин почти не выходит за кромку: сантиметр, не больше.
         Иначе на виске получается торчащий клин — его и было видно в упор
         первым делом. Длинные волосы падают ниже, но по шее, а не рядом
         с ней: у палок, висящих в воздухе, нет ничего общего с волосами. */
      const drop = front ? 0.007 + rnd() * 0.005
        : (longHair && canBeLong) ? (backSide ? 0.15 + rnd() * 0.13 : 0.07 + rnd() * 0.11)
          : 0.009 + rnd() * 0.007;
      const dir = new THREE.Vector3(end.x - mid.x, end.y - mid.y, end.z - mid.z).normalize();
      /* Кончик идёт туда же, куда шла прядь, и вниз, поджимаясь к оси:
         так прядь ложится на шею и плечо, а не отходит от головы палкой. */
      const tip = new THREE.Vector3(
        (end.x + dir.x * drop * 0.55) * 0.86,
        end.y - drop * (front ? 0.5 : 0.95),
        (end.z + dir.z * drop * 0.55) * 0.86
      );
      /* Промежуточная точка между кромкой и кончиком: с ней прядь выходит
         дугой, а не отрезком. */
      const bend = new THREE.Vector3(
        (end.x + (tip.x - end.x) * 0.45) * 1.015,
        end.y + (tip.y - end.y) * 0.42,
        (end.z + (tip.z - end.z) * 0.45) * 1.015
      );

      const r0 = (female ? 0.0044 : 0.0050) * (0.8 + rnd() * 0.45);
      const mesh = limb(
        [[root.x, root.y, root.z], [mid.x, mid.y, mid.z], [end.x, end.y, end.z],
         [bend.x, bend.y, bend.z], [tip.x, tip.y, tip.z]],
        [r0 * 0.7, r0, r0 * 0.9, r0 * 0.6, r0 * 0.22],
        i % 3 === 0 ? glossMat : mat, sg(6, 4), sg(14, 7));
      mesh.castShadow = false;

      /* Шарнир в корне: качается именно прядь, а не вся причёска целиком. */
      const pivot = new THREE.Group();
      pivot.position.copy(root);
      mesh.position.set(-root.x, -root.y, -root.z);
      pivot.add(mesh);
      grp.add(pivot);
      strands.push({
        pivot,
        phase: rnd() * Math.PI * 2,
        /* Длинная прядь качается заметнее короткой. */
        amp: (front ? 0.010 : (longHair && canBeLong) ? 0.052 : 0.016) * (0.7 + rnd() * 0.6)
      });
    }

    /* --- 3. пучок или хвост у женщин с длинными волосами --- */
    if (female && style === 'bun') {
      const bp = skullPoint(0, 0.28, -1, female, 1.02);
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.042, sg(20, 10), sg(16, 8)), glossMat);
      bun.position.set(0, bp.y + 0.008, bp.z - 0.026);
      bun.scale.set(1.05, 0.92, 0.9);
      grp.add(bun);
      /* витки, чтобы пучок не выглядел приклеенным шаром */
      for (let i = 0; i < (LOWQ ? 2 : 4); i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.040 - i * 0.004, 0.0052, sg(6, 4), sg(16, 8)), mat);
        ring.position.copy(bun.position);
        ring.rotation.set(1.3 + i * 0.18, 0.2 * i, 0.3 * i);
        grp.add(ring);
      }
    }

    return { group: grp, strands, mat, glossMat };
  }

  /* ---------------------------------------------------------------------
     КИСТЬ

     Своя система координат: начало — сустав кисти, +z — куда смотрят
     пальцы, y вверх, ладонь книзу. Дальше рука ставится целиком одним
     поворотом, поэтому пальцы всегда продолжают предплечье.
     --------------------------------------------------------------------- */
  function buildHand(skinMat, side, opts) {
    opts = opts || {};
    const g = new THREE.Group();
    const flat = opts.flat !== false;      // ладонь лежит на сукне
    const K = opts.scale || 1;

    /* Пясть: от сустава к костяшкам, чуть шире у костяшек. */
    const palm = new THREE.Mesh(loft([
      { y: 0, z: 0.004 * K, rx: 0.0295 * K, rz: 0.0150 * K },
      { y: 0, z: 0.040 * K, rx: 0.0345 * K, rz: 0.0158 * K },
      { y: 0, z: 0.072 * K, rx: 0.0355 * K, rz: 0.0140 * K },
      { y: 0, z: 0.086 * K, rx: 0.0330 * K, rz: 0.0120 * K }
    ], sg(18, 10)), skinMat);
    palm.castShadow = true;
    g.add(palm);

    /* Четыре пальца: три фаланги, подушечка лежит на сукне. Длина растёт
       к среднему и падает к мизинцу — иначе кисть выглядит гребёнкой. */
    const LEN = [0.070, 0.078, 0.073, 0.058];
    for (let k = 0; k < 4; k++) {
      const x = (k - 1.5) * 0.0208 * K;
      const len = LEN[k] * K;
      /* Лежащая кисть: пальцы почти прямые, кончики чуть приподняты.
         Свободная: фаланги подогнуты. */
      const y0 = 0.0012 * K, y1 = flat ? 0.0004 * K : -0.016 * K, y2 = flat ? -0.0022 * K : -0.034 * K;
      const r = 0.0128 * K * (k === 3 ? 0.85 : 1);
      const f = limb([
        [x, y0, 0.086 * K],
        [x * 1.05, y0 + y1 * 0.4, 0.086 * K + len * 0.40],
        [x * 1.09, y1, 0.086 * K + len * 0.72],
        [x * 1.11, y2, 0.086 * K + len]
      ], [r, r * 0.94, r * 0.84, r * 0.66], skinMat, sg(8, 5), sg(10, 5));
      g.add(f);
      /* костяшка: маленький бугорок в основании пальца */
      const kn = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, sg(10, 5), sg(8, 4)), skinMat);
      kn.position.set(x, y0 + 0.0016 * K, 0.082 * K);
      kn.scale.set(1, 0.8, 1.1);
      g.add(kn);
    }

    /* Большой палец отходит в сторону и вперёд, как и должен. */
    const thumb = limb([
      [side * 0.026 * K, 0.001 * K, 0.020 * K],
      [side * 0.046 * K, -0.002 * K, 0.044 * K],
      [side * 0.055 * K, -0.005 * K, 0.068 * K],
      [side * 0.058 * K, -0.007 * K, 0.086 * K]
    ], [0.0155 * K, 0.0135 * K, 0.0118 * K, 0.0098 * K], skinMat, sg(9, 5), sg(9, 5));
    g.add(thumb);
    return g;
  }

  /* ---------------------------------------------------------------------
     ФИГУРА ЦЕЛИКОМ
     --------------------------------------------------------------------- */

  /* Посадки. Каждая обязана оставить кисть на опоре: на сукне или на
     колене. Пока рука кончалась там, где кончалась её труба, кисти
     висели в воздухе — это и была жалоба «руки в воздухе». */
  function poseFor(n, wristY, edgeZ) {
    const S = BODY.shoulder;
    if (n === 1) {
      /* пальцы сцеплены перед собой на столе */
      return {
        L: { eb: [-0.228, 0.786, -0.030], wr: [-0.048, wristY + 0.004, edgeZ + 0.070], yaw: 0.92, flat: false },
        R: { eb: [0.228, 0.786, -0.030], wr: [0.048, wristY + 0.026, edgeZ + 0.062], yaw: -0.92, flat: false }
      };
    }
    if (n === 2) {
      /* правая на сукне, левая — на колене: живая асимметрия */
      return {
        L: { eb: [-0.238, 0.766, -0.096], wr: [-0.132, 0.556, 0.070], yaw: 0.18, pitch: -0.30, flat: false },
        R: { eb: [0.230, 0.762, -0.044], wr: [0.150, wristY, edgeZ + 0.030], yaw: -0.06, flat: true }
      };
    }
    if (n === 3) {
      /* руки сложены на столе: правое предплечье лежит на левом */
      return {
        L: { eb: [-0.244, 0.778, -0.020], wr: [0.062, wristY + 0.002, edgeZ + 0.028], yaw: -1.16, flat: true },
        R: { eb: [0.244, 0.790, -0.020], wr: [-0.062, wristY + 0.044, edgeZ + 0.020], yaw: 1.16, flat: true }
      };
    }
    /* по умолчанию: оба предплечья на сукне, ладони вниз */
    return {
      L: { eb: [-0.224, 0.760, -0.048], wr: [-0.148, wristY, edgeZ + 0.034], yaw: 0.08, flat: true },
      R: { eb: [0.224, 0.760, -0.048], wr: [0.148, wristY, edgeZ + 0.034], yaw: -0.08, flat: true }
    };
  }

  function buildFigure(color, hatKind, seed, opts) {
    opts = opts || {};
    const female = opts.sex === 'f';
    const grp = new THREE.Group();
    const base = new THREE.Color(color);
    const rnd = prng(seed * 17 + 3);

    /* Люди за столом должны быть разными: тон кожи, цвет волос, рост.
       Раньше всё считалось от seed % 3 — и половина стола была близнецами. */
    /* Кожа и волосы задаются в HSL — и здесь пряталась ошибка, из-за
       которой стол выглядел собранием блондинов с фарфоровыми лицами.

       Color.setHSL по умолчанию пишет в рабочее пространство рендерера, а
       оно линейное. Яркость 0,15, написанная в коде как «почти чёрные
       волосы», после гаммы превращается на экране в 0,43 — то есть в
       светло-русый. Просить sRGB надо явно, тогда числа в коде значат
       ровно то, что видит игрок. */
    const SRGB = THREE.SRGBColorSpace;
    const irisHex = IRISES[Math.floor(rnd() * IRISES.length)];
    const skinC = new THREE.Color().setHSL(
      0.055 + rnd() * 0.030, 0.34 + rnd() * 0.16, 0.30 + rnd() * 0.20, SRGB);
    /* Волосы: чёрные, каштановые, русые, редко седые. */
    const hairTone = rnd();
    const hairC = hairTone < 0.12
      ? new THREE.Color().setHSL(0.08, 0.06, 0.50, SRGB)               // седой
      : new THREE.Color().setHSL(0.055 + rnd() * 0.030, 0.26 + rnd() * 0.22,
          0.07 + hairTone * 0.20, SRGB);

    const cloth = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(1.02), roughness: 0.80, metalness: 0.03 });
    const dark = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.58), roughness: 0.84, metalness: 0.04 });
    /* Шляпа и кепка — не из того же сукна, что пиджак: тёмный войлок,
       иначе головной убор сливается с плечами в одно пятно. */
    const feltM = new THREE.MeshStandardMaterial({
      color: base.clone().lerp(new THREE.Color(0x14100f), 0.72), roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: skinC, roughness: 0.62 });
    /* Сорочка не белая: на сцене со свечой чистый белый становится самым
       ярким пятном кадра и перетягивает взгляд с лица. */
    const shirt = new THREE.MeshStandardMaterial({ color: 0x9c9482, roughness: 0.76 });
    const tieM = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.38), roughness: 0.54 });
    const trous = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.46), roughness: 0.88 });
    const shoeM = new THREE.MeshStandardMaterial({ color: 0x1a1416, roughness: 0.58, metalness: 0.12 });
    const faceM = new THREE.MeshStandardMaterial({
      map: texFromCanvas(skinCanvas(skinC.getHex(), hairC.getHex(), seed, female)),
      roughness: 0.64
    });

    const edgeZ = (opts.reach === undefined ? METRICS.seatGap : opts.reach);
    const tblY = (opts.tableY === undefined ? BODY.tableY : opts.tableY);
    /* Кисть лежит на сукне: сустав поднят на половину толщины ладони,
       и подушечки пальцев касаются ткани, а не парят над ней. */
    const wristY = tblY + 0.019;
    const POSE = (opts.pose === undefined ? 0 : opts.pose) % 4;
    const pose = poseFor(POSE, wristY, edgeZ);

    /* Рост: ±3 % от таблицы. Больше нельзя — стол общий, и сукно одно. */
    const tall = 0.985 + rnd() * 0.035;
    const wide = female ? 0.93 : 1;

    /* ---- ноги: бедро и голень одной трубой, ступня на полу ---- */
    const H = BODY.hip, K = BODY.knee, A = BODY.ankle;
    for (const s of [-1, 1]) {
      grp.add(limb([
        [s * H.x, H.y, H.z],
        [s * (H.x + 0.014), H.y - 0.012, H.z + 0.10],
        [s * (K.x - 0.004), K.y + 0.012, K.z - 0.08],
        [s * K.x, K.y, K.z],
        [s * (K.x + 0.006), K.y - 0.13, K.z + 0.026],
        [s * A.x, A.y, A.z]
      ], [0.094 * wide, 0.090 * wide, 0.076, 0.068, 0.054, 0.042], trous, sg(15, 8), sg(26, 13)));

      /* Ступня: подошва на полу, подъём и носок. */
      const shoe = new THREE.Mesh(loft([
        { y: 0.016, z: A.z - 0.045, rx: 0.043, rz: 0.016 },
        { y: 0.046, z: A.z - 0.010, rx: 0.050, rz: 0.046 },
        { y: 0.040, z: A.z + 0.055, rx: 0.050, rz: 0.040 },
        { y: 0.028, z: A.z + 0.112, rx: 0.042, rz: 0.028 },
        { y: 0.018, z: A.z + 0.140, rx: 0.028, rz: 0.018 }
      ], sg(16, 9)), shoeM);
      shoe.position.x = s * A.x;
      shoe.castShadow = true;
      grp.add(shoe);
      /* каблук: тонкая опора, без неё обувь висит над полом */
      const heel = new THREE.Mesh(
        new THREE.BoxGeometry(0.062, 0.016, 0.052),
        new THREE.MeshStandardMaterial({ color: 0x120e10, roughness: 0.7 }));
      heel.position.set(s * A.x, 0.008, A.z - 0.030);
      grp.add(heel);
    }

    /* ---- торс: сечения по хребту от таза до основания шеи ----
       Плечи 38 см между суставами и 46 по дельтам — это человек, а не
       шкаф. Раньше сечение на линии плеч было 45 см само по себе, плюс
       два шара сверху. */
    const torsoStations = [
      { y: 0.500, z: -0.226, rx: 0.163 * wide, rz: 0.116 },
      { y: 0.585, z: -0.224, rx: 0.150 * wide, rz: 0.108 },
      { y: 0.672, z: -0.216, rx: 0.140 * wide, rz: 0.100 },
      { y: 0.770, z: -0.208, rx: 0.155 * wide, rz: 0.111 },
      { y: 0.862, z: -0.198, rx: 0.175 * wide, rz: 0.121 },
      { y: 0.938, z: -0.190, rx: 0.190 * wide, rz: 0.119 },
      { y: 0.988, z: -0.184, rx: 0.184 * wide, rz: 0.108 },
      { y: 1.024, z: -0.180, rx: 0.128 * wide, rz: 0.088 },
      { y: 1.048, z: -0.176, rx: 0.082 * wide, rz: 0.068 }
    ];
    if (female) {
      /* грудь: одно сечение чуть глубже спереди — силуэт, а не анатомия */
      torsoStations[4] = { y: 0.862, z: -0.192, rx: 0.170, rz: 0.132 };
    }
    const torsoGeo = loft(torsoStations, sg(28, 14));
    /* Геометрию центруем, чтобы дыхание масштабировало торс вокруг груди,
       а не растягивало его от начала координат фигуры. */
    const CX = 0, CY = 0.80, CZ = -0.20;
    torsoGeo.translate(-CX, -CY, -CZ);
    const torso = new THREE.Mesh(torsoGeo, cloth);
    torso.position.set(CX, CY, CZ);
    torso.castShadow = true; torso.receiveShadow = true;
    grp.add(torso);

    /* Грудь сорочки: светлый клин между отворотами. */
    const front = new THREE.Mesh(loft([
      { y: 0.836, z: -0.074, rx: 0.020, rz: 0.012 },
      { y: 0.930, z: -0.064, rx: 0.030, rz: 0.013 },
      { y: 1.008, z: -0.066, rx: 0.036, rz: 0.013 }
    ], sg(12, 7)), shirt);
    grp.add(front);

    /* Отвороты пиджака: две тёмные грани от воротника к груди. */
    for (const s of [-1, 1]) {
      grp.add(limb([
        [s * 0.086, 1.014, -0.062],
        [s * 0.074, 0.930, -0.048],
        [s * 0.040, 0.842, -0.066]
      ], [0.022, 0.019, 0.012], dark, sg(9, 5), sg(9, 5)));
    }

    /* Воротник сорочки: узкая лента вокруг шеи, а не ведро. Раньше это был
       цилиндр радиусом 8,6 см при шее 6 — он и читался как слюнявчик. */
    /* Воротник: узкая лента вплотную к шее, чуть выше линии плеч, и почти
       целиком спрятана в вырез пиджака — видно только клин спереди.
       Раньше это был цилиндр вдвое шире шеи, и он читался как хомут. */
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY.neckTop.r + 0.002, BODY.neckBase.r + 0.003, 0.026, sg(20, 11), 1, true),
      shirt);
    collar.position.set(0, BODY.neckBase.y + 0.020, BODY.neckBase.z + 0.002);
    collar.rotation.x = -0.05;
    grp.add(collar);
    /* Уголки воротника лежат на самой ленте и смотрят вниз-вперёд. */
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.019, 0.003), shirt);
      tip.position.set(s * 0.022, BODY.neckBase.y + 0.010, BODY.neckBase.z + 0.044);
      tip.rotation.set(-0.28, -s * 0.40, s * 0.30);
      grp.add(tip);
    }

    /* Воротник пиджака: закрывает сорочку сзади и по бокам, оставляя
       спереди клин. Пока его не было, белая лента воротника обходила шею
       кольцом и была самым ярким пятном фигуры. */
    const jcollar = new THREE.Mesh(
      new THREE.CylinderGeometry(BODY.neckTop.r + 0.014, BODY.neckBase.r + 0.020, 0.046,
        sg(22, 12), 1, true, Math.PI * 0.30, Math.PI * 1.40),
      cloth);
    jcollar.position.set(0, BODY.neckBase.y + 0.014, BODY.neckBase.z - 0.004);
    jcollar.rotation.x = -0.10;
    jcollar.castShadow = true;
    grp.add(jcollar);

    if (!female) {
      const tie = new THREE.Mesh(loft([
        { y: 0.836, z: -0.060, rx: 0.019, rz: 0.008 },
        { y: 0.930, z: -0.048, rx: 0.022, rz: 0.009 },
        { y: 1.006, z: -0.054, rx: 0.013, rz: 0.008 }
      ], sg(10, 6)), tieM);
      grp.add(tie);
      /* узел: маленький, плотный, у самого воротника */
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.0165, sg(12, 6), sg(10, 5)), tieM);
      knot.position.set(0, 1.014, -0.052);
      knot.scale.set(1, 1.15, 0.8);
      grp.add(knot);
    } else {
      /* брошь вместо галстука: та же роль — точка внимания на груди */
      const brooch = new THREE.Mesh(
        new THREE.TorusGeometry(0.011, 0.0035, sg(8, 5), sg(14, 7)),
        new THREE.MeshStandardMaterial({ color: PAL.brass, roughness: 0.35, metalness: 0.8 }));
      brooch.position.set(0.036, 0.980, -0.070);
      brooch.rotation.x = 0.3;
      grp.add(brooch);
    }

    /* ---- руки: от точки внутри торса до кисти на опоре ----
       Труба начинается внутри груди, поэтому в плече нет щели, а первый
       радиус играет роль дельтовидной мышцы. */
    const arms = [];
    for (const s of [-1, 1]) {
      const A2 = s < 0 ? pose.L : pose.R;
      const S2 = BODY.shoulder;
      const root = [s * (S2.x - 0.045), S2.y + 0.012, S2.z];
      const sh = [s * S2.x, S2.y, S2.z + 0.004];
      const eb = A2.eb;
      const wr = A2.wr;

      grp.add(limb([
        root, sh,
        [(sh[0] + eb[0]) / 2 + s * 0.016, (sh[1] + eb[1]) / 2 - 0.004, (sh[2] + eb[2]) / 2 - 0.014],
        eb,
        [(eb[0] + wr[0]) / 2, (eb[1] + wr[1]) / 2 + 0.010, (eb[2] + wr[2]) / 2],
        wr
      ], [0.070, 0.062, 0.053, 0.046, 0.041, 0.034], cloth, sg(14, 8), sg(24, 13)));

      /* Манжета у самой кисти: показывает, где кончается рукав. */
      const dir = new THREE.Vector3(wr[0] - eb[0], wr[1] - eb[1], wr[2] - eb[2]);
      const cuffFrom = new THREE.Vector3(wr[0], wr[1], wr[2]).addScaledVector(dir, -0.19);
      grp.add(limb([
        [cuffFrom.x, cuffFrom.y, cuffFrom.z], [wr[0], wr[1], wr[2]]
      ], [0.040, 0.036], shirt, sg(12, 7), sg(4, 3)));

      const hand = buildHand(skin, s, { flat: A2.flat });
      hand.position.set(wr[0], wr[1], wr[2]);
      /* Пальцы продолжают предплечье: так кисть не «отломана» от руки. */
      hand.rotation.y = Math.atan2(dir.x, dir.z) + (A2.yaw || 0);
      hand.rotation.x = A2.pitch || 0;
      grp.add(hand);
      arms.push({ hand, side: s, home: hand.position.clone(), flat: A2.flat });
    }

    /* ---- шея: от плеч к черепу, с трапецией ---- */
    const NB = BODY.neckBase, NT = BODY.neckTop;
    grp.add(limb([
      [0, NB.y - 0.030, NB.z - 0.010],
      [0, NB.y, NB.z],
      [0, (NB.y + NT.y) / 2, (NB.z + NT.z) / 2],
      [0, NT.y, NT.z]
    ], [NB.r + 0.014, NB.r, (NB.r + NT.r) / 2, NT.r], skin, sg(16, 9), sg(10, 6)));

    /* ---- голова ---- */
    const headPivot = new THREE.Group();
    headPivot.position.set(0, BODY.headPivot.y, BODY.headPivot.z);
    grp.add(headPivot);

    /* headBox остаётся точкой масштаба головы: череп уже человеческий,
       поэтому множитель здесь около единицы и играет роль «крупная —
       мелкая голова», а не спасает пропорции. */
    const headBox = new THREE.Group();
    headBox.scale.setScalar(0.97 + rnd() * 0.07);
    headPivot.add(headBox);

    const headGeo = jawMorph(sculptSkull(
      new THREE.SphereGeometry(1, sg(46, 22), sg(34, 16)), female), female);
    const head = new THREE.Mesh(headGeo, faceM);
    head.castShadow = true;
    headBox.add(head);
    if (head.morphTargetInfluences && head.morphTargetInfluences.length) {
      head.morphTargetInfluences[0] = 0;
    }

    /* глаза в орбитах */
    /* Веко темнее лица: оно всегда в собственной тени от надбровной дуги.
       Со светлым веком глаз выглядел вставленным в белое кольцо. */
    const lidMat = new THREE.MeshStandardMaterial({ color: skinC.clone().multiplyScalar(0.80), roughness: 0.66 });
    const eyes = [];
    for (const s of [-1, 1]) {
      const e = buildEye(skin, lidMat, seed, s, female, irisHex);
      const p = skullPoint(s * 0.430, 0.075, 0.885, female, 0.880);
      e.position.copy(p);
      /* Глаз смотрит наружу-вперёд, как и орбита. */
      e.rotation.y = s * 0.22;
      e.rotation.x = -0.04;
      /* Разрез глаза шире, чем выше: без этого в лице сидят два шарика. */
      e.scale.set(1.14, 0.94, 1);
      headBox.add(e);
      eyes.push(e);
      headBox.add(buildBrow(hairC, s, female, female));
      headBox.add(buildEar(skin, s, female));
    }

    headBox.add(buildNose(skin, female, seed));

    /* Губы: нижняя висит на челюсти и опускается вместе с ней. */
    const lips = buildLips(seed, female, skinC);
    const jaw = new THREE.Object3D();
    jaw.position.set(0, BODY.skull.cy - BODY.skull.ry * 0.10, -BODY.skull.rz * 0.55);
    headBox.add(jaw);
    const lipsLower = lips.userData.lower;
    lips.remove(lipsLower);
    lipsLower.position.sub(jaw.position);
    jaw.add(lipsLower);
    headBox.add(lips);

    /* ---- головной убор или причёска ---- */
    const hat = new THREE.Group();
    const fitR = skullPoint(1, 0.38, 0, female, 1).x;
    const crownTop = skullPoint(0, 1, 0, female, 1).y;
    let hair = null;

    if (hatKind === 'fedora') {
      /* Под шляпой всё равно нужны волосы: иначе из-под полей смотрит
         голая кожа, и это видно первым. */
      hair = buildHair(hairC, female, seed, 'short');
      hat.add(hair.group);
      const seatY = BODY.skull.cy + BODY.skull.ry * 0.44;
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.92, fitR * 2.04, 0.014, sg(34, 17)), feltM);
      brim.position.y = seatY;
      /* Поля не плоский диск: спереди опущены, сзади подняты. */
      const bp = brim.geometry.attributes.position;
      for (let i = 0; i < bp.count; i++) {
        const z = bp.getZ(i), x = bp.getX(i);
        const r = Math.hypot(x, z) / (fitR * 2);
        bp.setY(i, bp.getY(i) - r * r * (z > 0 ? 0.026 : -0.014));
      }
      bp.needsUpdate = true; brim.geometry.computeVertexNormals();

      const hCrown = (crownTop - seatY) + 0.052;
      const crown = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.10, fitR * 1.16, hCrown, sg(30, 15), 1, true), feltM);
      crown.position.y = seatY + hCrown / 2;
      const top = new THREE.Mesh(new THREE.CircleGeometry(fitR * 1.10, sg(30, 15)), feltM);
      top.rotation.x = -Math.PI / 2;
      top.position.y = seatY + hCrown;
      /* вмятина на тулье: без неё шляпа выглядит ведром */
      const dent = new THREE.Mesh(
        new THREE.SphereGeometry(fitR * 0.62, sg(18, 9), sg(12, 6)), feltM);
      dent.position.set(0, seatY + hCrown + fitR * 0.42, 0);
      dent.scale.set(1, 0.42, 0.7);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.18, fitR * 1.18, 0.036, sg(30, 15), 1, true),
        new THREE.MeshStandardMaterial({ color: 0x191315, roughness: 0.72 }));
      band.position.y = seatY + 0.024;
      brim.castShadow = crown.castShadow = true;
      hat.add(brim, crown, top, dent, band);
      hat.rotation.set(-0.06, 0, 0.05);
    } else if (hatKind === 'cap') {
      hair = buildHair(hairC, female, seed, 'short');
      hat.add(hair.group);
      /* Кепка сидит на голове, а не надета на глаза: тулья начинается
         выше линии роста волос, козырёк выходит вперёд надо лбом. */
      const dome = new THREE.SphereGeometry(1, sg(28, 14), sg(18, 9), 0, Math.PI * 2, 0, Math.PI * 0.40);
      const dp = dome.attributes.position;
      for (let i = 0; i < dp.count; i++) {
        const x = dp.getX(i), y = dp.getY(i), z = dp.getZ(i);
        const l = Math.sqrt(x * x + y * y + z * z) || 1;
        const nx = x / l, ny = y / l, nz = z / l;
        const k = skullShape(nx, ny, nz, female) * 1.14;
        const S3 = BODY.skull;
        dp.setXYZ(i, nx * k * S3.rx, S3.cy + ny * k * S3.ry, nz * k * S3.rz);
      }
      dp.needsUpdate = true; dome.computeVertexNormals();
      const domeMesh = new THREE.Mesh(dome, feltM);
      domeMesh.castShadow = true;
      const peak = new THREE.Mesh(
        new THREE.CylinderGeometry(fitR * 1.02, fitR * 1.10, 0.011, sg(24, 12), 1, false, 0, Math.PI), feltM);
      peak.position.set(0, BODY.skull.cy + BODY.skull.ry * 0.62, BODY.skull.rz * 0.74);
      peak.rotation.set(0.20, Math.PI, 0);
      hat.add(domeMesh, peak);
    } else {
      hair = buildHair(hairC, female, seed, female && rnd() > 0.45 ? 'bun' : 'long');
      hat.add(hair.group);
    }
    headBox.add(hat);

    /* Слегка разный рост — по вертикали, от пола. */
    grp.scale.y = tall;

    /* ------------------------------------------------------------------
       ЖИЗНЬ

       Всё, что делает фигуру живой, собрано здесь, а не в сцене: дыхание,
       мигание, речь, покачивание, качание волос. Сцена только сообщает,
       что происходит за столом, и вызывает animate каждый кадр — поэтому
       обе страницы (боты и сеть) получают одинаково живых людей.
       ------------------------------------------------------------------ */
    const life = {
      breath: rnd() * Math.PI * 2,
      sway: rnd() * Math.PI * 2,
      blinkIn: 900 + rnd() * 3600,
      blinkFor: 0,
      lookYaw: 0, lookPitch: 0,
      talkLevel: 0,
      hairT: rnd() * 100
    };

    function setBreath(k) {
      torso.scale.set(1 + k * 0.012, 1 + k * 0.005, 1 + k * 0.016);
    }
    function setBlink(k) {
      eyes.forEach(e => e.userData.close(k));
    }
    function setTalk(open) {
      const v = Math.max(0, Math.min(1, open));
      life.talkLevel = v;
      const inf = head.morphTargetInfluences;
      if (inf && inf.length) inf[0] = v;
      /* Челюсть тянет за собой нижнюю губу — иначе рот «открывается»
         только на текстуре, а губа остаётся на месте. */
      jaw.rotation.x = v * 0.20;
      jaw.position.y = BODY.skull.cy - BODY.skull.ry * 0.10 - v * 0.004;
    }

    setBlink(0);
    setTalk(0);

    grp.userData = {
      torso, head, headPivot, headBox, jaw, hat, eyes, lips,
      hair, arms, seed, female,
      restJawY: jaw.position.y,
      /* Совместимость со старым кодом сцены: раньше веки были мешами,
         которые прятали и показывали. */
      lids: eyes,

      talk: setTalk,
      talkAmt() { return life.talkLevel; },
      blink(closed) { setBlink(closed > 0.5 ? 1 : 0); },
      breathe: setBreath,

      /** Куда смотрит человек: доворот головы и глаз к говорящему. */
      lookAt(yaw, pitch) {
        life.lookYaw = yaw || 0;
        life.lookPitch = pitch || 0;
      },

      /**
       * Один кадр жизни. Сцена сообщает, что с человеком происходит:
       *   speaking — говорит сейчас;
       *   dead     — выбыл (тогда живого ничего не остаётся);
       *   night    — ночь, все склонились к столу и дышат реже.
       */
      animate(now, dt, st) {
        st = st || {};
        const d = Math.min(60, dt || 16);
        if (st.dead) { setTalk(0); setBlink(0); return; }

        /* дыхание: ночью реже и глубже */
        life.breath += d * (st.night ? 0.0016 : 0.0024);
        const br = Math.sin(life.breath);
        setBreath(br);

        /* Живой человек не сидит камнем: корпус переносит вес с одной
           половины таза на другую, и это единственное, что отличает
           «модельку» от «человека, который ждёт своей очереди». */
        life.sway += d * 0.00035;
        const sw = Math.sin(life.sway) * 0.6 + Math.sin(life.sway * 2.3 + 1.1) * 0.4;
        grp.rotation.z = sw * 0.010;
        grp.position.y = br * 0.004;

        /* голова: доворот к говорящему плюс своя мелкая жизнь */
        const wantY = life.lookYaw + Math.sin(life.sway * 1.7) * 0.02;
        const wantX = life.lookPitch + Math.sin(life.sway * 2.6 + 0.7) * 0.012
          + (st.night ? 0.14 : 0);
        headPivot.rotation.y += (wantY - headPivot.rotation.y) * Math.min(1, d / 420);
        headPivot.rotation.x += (wantX - headPivot.rotation.x) * Math.min(1, d / 480);
        /* Глаза успевают раньше головы — так делает и живой человек. */
        eyes.forEach(e => e.userData.look(
          (life.lookYaw - headPivot.rotation.y) * 1.6, -life.lookPitch * 0.6));

        /* мигание: короткое, у каждого свой ритм */
        if (life.blinkFor > 0) {
          life.blinkFor -= d;
          const k = life.blinkFor > 55 ? 1 : life.blinkFor / 55;
          setBlink(k);
          if (life.blinkFor <= 0) setBlink(0);
        } else {
          life.blinkIn -= d;
          if (life.blinkIn <= 0) { life.blinkFor = 120; life.blinkIn = 2400 + Math.random() * 5200; }
        }

        /* речь: рот открывается не ровной синусоидой, а слогами */
        if (st.speaking) {
          const s1 = Math.abs(Math.sin(now * 0.013));
          const s2 = Math.abs(Math.sin(now * 0.0072 + 1.3));
          setTalk(0.14 + s1 * s2 * 0.86);
        } else if (life.talkLevel > 0.004) {
          setTalk(life.talkLevel * 0.82);
        }

        /* Волосы догоняют голову: каждая прядь качается на своём шарнире
           со своей фазой, и вся причёска отзывается на поворот головы. */
        if (hair) {
          life.hairT += d * 0.001;
          const lag = headPivot.rotation.y * 0.30;
          for (let i = 0; i < hair.strands.length; i++) {
            const st2 = hair.strands[i];
            st2.pivot.rotation.z = Math.sin(life.hairT * 1.6 + st2.phase) * st2.amp - lag * 0.5;
            st2.pivot.rotation.x = Math.cos(life.hairT * 1.2 + st2.phase * 1.7) * st2.amp * 0.6;
            st2.pivot.rotation.y = lag;
          }
        }

        /* Рука на сукне живёт: пальцы чуть переступают, кисть смещается
           на миллиметры. В упор это видно, и именно это читается как
           «человек», а не «манекен». */
        for (let i = 0; i < arms.length; i++) {
          const a = arms[i];
          if (!a.flat) continue;
          const p = Math.sin(life.sway * 2.1 + i * 2.3);
          a.hand.position.set(a.home.x + p * 0.0022, a.home.y, a.home.z + p * 0.0030);
        }
      },

      materials: [cloth, dark, skin, shirt, tieM, trous, shoeM, faceM, lidMat,
        lips.userData.mat, lips.userData.seamM]
        .concat([feltM]).concat(hair ? [hair.mat, hair.glossMat] : []),
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
    PAL, TIER, LOWQ, sg, prng, cvs, roundRect, texFromCanvas, disposeTree,
    METRICS, tableRadiusFor, loft, limb, buildHand,
    plankCanvas, plasterCanvas, backdropCanvas, feltCanvas,
    cardBackCanvas, cardFaceCanvas, nameCanvas, crossCanvas,
    skinCanvas,
    BODY, skullPoint, buildEye, buildHair,
    buildRoom, buildLamp, buildTable, buildChair, buildFigure
  };
}
