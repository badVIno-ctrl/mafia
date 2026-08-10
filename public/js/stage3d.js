/* =========================================================================
   stage3d.js — сцена партии: комната, стол, лампа, живые фигуры.

   Модуль собирает декорации из models3d.js и добавляет то, что относится
   именно к «спектаклю»: свет по фазам, дыхание и мигание фигур, взгляд на
   говорящего, оседание после смерти, выбор цели мышью и проекцию мест
   в экранные координаты (чтобы подписи рисовал HTML, а не текстуры).

   Управление камерой написано здесь же: OrbitControls тянет за собой
   импорт-карту, а нам нужен всего один вращающийся вид с ограничителями.

   Использование:
     const stage = await mountStage(container, { onPick(id){} });
     stage.setSeats([{ id, name, seat, you }]);
     stage.sync({ phase, players, speakerId, targets });
   ========================================================================= */

import { createModels } from './models3d.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* Палитра одежды фигур: пыльные, приглушённые тона одного семейства,
   чтобы стол выглядел как компания людей, а не как коробка карандашей. */
const COATS = [
  0x6a4b52, 0x4c5a63, 0x6b5f45, 0x543f4d, 0x455448,
  0x74544a, 0x3f4a5c, 0x5f5340, 0x6d4a45, 0x4a4f5b,
  0x5b4a3f, 0x50575f, 0x654a58, 0x455049, 0x6b5b4d,
  0x3f4752, 0x5d4f4a, 0x4e4457, 0x59604f, 0x6a5449
];

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) { return false; }
}

export async function mountStage(container, opts) {
  opts = opts || {};
  if (!webglAvailable()) throw new Error('no-webgl');

  const THREE = await import('/vendor/three/three.module.js');
  const M = createModels(THREE, opts.config || {});
  /* Постобработка и IBL живут отдельным модулем и грузятся динамически: если
     их не удалось поднять (старый браузер, нет float-текстур), партия должна
     идти без них, а не падать. */
  let RS = null;
  try { RS = await import('/js/render-stack.js'); } catch (e) { RS = null; }

  /* ------------------------------------------------------------------ */
  /* рендерер, сцена, камера                                             */
  /* ------------------------------------------------------------------ */
  const renderer = new THREE.WebGLRenderer({ antialias: !M.LOWQ, powerPreference: 'high-performance' });
  /* Плотность пикселей — самая дорогая настройка из всех. На телефоне с
     тройным DPR честная отрисовка стоит девять раз больше пикселей, чем на
     обычном экране, и разницы на пяти дюймах не видно. */
  let pixelCap = M.LOWQ ? 1.4 : (M.TIER === 'mid' ? 1.8 : 2);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelCap));
  /* Тени на слабом устройстве выключены с самого начала: одна карта теней
     от лампы стоит дороже, чем все фигуры вместе. Сцена без них читается —
     свет лампы и отсвет от сукна дают объём и без падающих теней. */
  renderer.shadowMap.enabled = !M.LOWQ;
  renderer.shadowMap.type = M.TIER === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RS ? RS.LIGHT_RIG.exposure : 1.34;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0809);
  scene.fog = new THREE.FogExp2(0x0a0809, 0.022);

  const camera = new THREE.PerspectiveCamera(52, 1.6, 0.1, 120);
  const root = new THREE.Group();
  scene.add(root);

  const room = M.buildRoom(root);
  const lamp = M.buildLamp(root, { ceilY: 4.5, bulbY: 2.2 });

  /* Общий свет. Держим ссылки: по фазам он меняется целиком. */
  /* Свет. Комната освещена одной лампой над столом, и это должно быть
     видно: заполняющий свет здесь только чтобы тени не были чёрными
     дырами. Раньше ambient 1.2 и три заполняющих по 14 заливали сцену так,
     что тёмный костюм становился светлым, а кожа — фарфоровой. */
  /* Числа света теперь одни на все сцены — в render-stack.js. Раньше их было
     три набора (боты, сеть, стенд), и они расходились. */
  const RIG = RS ? RS.LIGHT_RIG : { spot: 34, point: 5.6, ambient: 0.42, hemi: 0.34, fill: 4.6, table: 3.4, exposure: 1.34, envIntensity: { day: 0, night: 0 } };
  const ambient = new THREE.AmbientLight(0x6a6070, RIG.ambient);
  const hemi = new THREE.HemisphereLight(0x8b9bb4, 0x3a2c26, RIG.hemi);
  const moon = new THREE.DirectionalLight(0x5878b8, 0);
  moon.position.set(-6, 7, -5);
  const emberGlow = new THREE.PointLight(0xc4563a, 0, 7, 2);
  emberGlow.position.set(0, 1.55, 0);
  const fills = [];
  [[0, 2.6, 3.4, 0xffd7ad, RIG.fill * 1.1], [-3.2, 2.4, -2.2, 0x9db4de, RIG.fill * 0.75],
   [3.2, 2.4, -2.2, 0xdda98a, RIG.fill * 0.75]].forEach(c => {
    const l = new THREE.PointLight(c[3], c[4], 12, 2);
    l.position.set(c[0], c[1], c[2]);
    fills.push(l); scene.add(l);
  });
  /* Отсвет от сукна. Лампа висит над столом, поэтому сверху освещены
     макушки, а лица оказываются в собственной тени — играть в такое нельзя,
     лица и есть игра. В жизни лицо в этой ситуации освещает свет,
     отражённый от стола, поэтому здесь стоит тёплая точка чуть выше сукна:
     она подсвечивает лица и кисти снизу-спереди, как театральная рампа.
     Раньше на этом месте стоял ещё один прожектор сверху. */
  const tableLight = new THREE.PointLight(0xffe0b4, RIG.table, 3.2, 2);
  tableLight.position.set(0, 0.94, 0);
  scene.add(ambient, hemi, moon, emberGlow, tableLight);

  /* ------------------------------------------------------------------ */
  /* камера: собственная орбита с инерцией                               */
  /* ------------------------------------------------------------------ */
  const cam = { az: 0, pol: 1.16, dist: 4.2, target: new THREE.Vector3(0, 1.02, 0), vAz: 0, vPol: 0, fit: 4.2 };
  const LIMIT = { polMin: 0.42, polMax: 1.46, distMin: 1.5, distMax: 9 };

  /* Сколько нужно отойти, чтобы стол со стульями целиком влез в кадр.
     На телефоне кадр узкий, и та же дистанция обрезает половину стола —
     поэтому считаем по меньшему из двух углов обзора. */
  function fitDistance(radius) {
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const fov = Math.min(vFov, hFov);
    return clamp((radius + 0.72) / Math.tan(fov / 2) * 0.94, LIMIT.distMin, LIMIT.distMax);
  }

  function applyCamera() {
    cam.pol = clamp(cam.pol, LIMIT.polMin, LIMIT.polMax);
    cam.dist = clamp(cam.dist, LIMIT.distMin, LIMIT.distMax);
    const sp = Math.sin(cam.pol), cp = Math.cos(cam.pol);
    camera.position.set(
      cam.target.x + Math.sin(cam.az) * sp * cam.dist,
      cam.target.y + cp * cam.dist,
      cam.target.z + Math.cos(cam.az) * sp * cam.dist
    );
    camera.lookAt(cam.target);
  }

  let drag = null;
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0 };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.vAz = -dx * 0.0055;
    cam.vPol = -dy * 0.004;
  });
  el.addEventListener('pointerup', e => {
    if (!drag || drag.id !== e.pointerId) return;
    /* Короткое касание без протяжки — это выбор игрока, а не вращение. */
    if (drag.moved < 8) pickAt(e.clientX, e.clientY);
    drag = null;
  });
  el.addEventListener('pointercancel', () => { drag = null; });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    cam.dist = clamp(cam.dist * (1 + Math.sign(e.deltaY) * 0.08), LIMIT.distMin, LIMIT.distMax);
    applyCamera();
  }, { passive: false });

  /* два пальца — приближение */
  let pinch = null;
  el.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinch) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      cam.dist = clamp(cam.dist * (pinch / d), LIMIT.distMin, LIMIT.distMax);
      pinch = d;
      applyCamera();
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { pinch = null; });

  /* ------------------------------------------------------------------ */
  /* места за столом                                                     */
  /* ------------------------------------------------------------------ */
  let table = null;
  let seats = [];             // { id, seat, name, group, figure, ring, cross, plate, pos, dead, gaze }
  let seatsById = new Map();
  let targets = new Set();
  let speakerId = null;
  let phase = 'prologue';
  let nightPose = 0;          // 0 — день, 1 — все склонились в ночь

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function clearSeats() {
    if (table) { root.remove(table.group); M.disposeTree(table.group); table = null; }
    seats.forEach(s => { root.remove(s.group); M.disposeTree(s.group); });
    seats = [];
    seatsById = new Map();
  }

  /** Пересобрать стол под новый состав. Вызывается редко: при старте партии. */
  function setSeats(list) {
    clearSeats();
    const n = Math.max(1, list.length);
    table = M.buildTable(root, n);
    const R = table.seatRadius;

    list.forEach((p, i) => {
      /* Первое место — «ваше»: садим игрока лицом к камере, чтобы он сразу
         узнавал себя за столом. */
      const a = (i / n) * Math.PI * 2;
      const sx = Math.sin(a) * R, sz = Math.cos(a) * R;

      const group = new THREE.Group();
      group.position.set(sx, 0, sz);
      group.lookAt(0, 0, 0);
      root.add(group);

      const chair = M.buildChair();
      chair.position.z = -0.30;
      group.add(chair);

      const figure = M.buildFigure(COATS[i % COATS.length], p.hat || (i % 5 === 0 ? 'cap' : 'hair'), i + 1,
        { sex: i % 3 === 1 ? 'f' : 'm', pose: i % 4 });
      group.add(figure);

      /* Медный обруч под стулом: подсветка выбираемой цели. */
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.38, 0.46, M.sg(30, 16)),
        new THREE.MeshBasicMaterial({ color: 0xe2b478, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.02, -0.28);
      group.add(ring);

      const cross = new THREE.Sprite(new THREE.SpriteMaterial({
        map: M.texFromCanvas(M.crossCanvas()), transparent: true, opacity: 0
      }));
      cross.scale.set(0.3, 0.3, 1);
      cross.position.set(sx, 1.86, sz);
      root.add(cross);

      const s = {
        id: p.id, seat: p.seat, name: p.name, you: !!p.you,
        group, figure, ring, cross,
        pos: new THREE.Vector3(sx, 0, sz),
        angle: a, dead: false, speaking: false
      };
      seats.push(s);
      seatsById.set(p.id, s);
    });

    /* Фигуры садятся за стол уже после того, как поднялся слой картинки, и
       их материалы не получили силу отражённого света. Без этой строки новые
       люди светятся вдвое ярче комнаты — заметно сразу, как только кто-то
       подсел к столу. */
    if (stack) stack.setEnvIntensity(stack.envIntensity);

    cam.fit = R;
    cam.dist = fitDistance(R);
    /* Смотрим со стороны своего места — но не строго в затылок, а вполоборота,
       иначе собственная фигура закрывает треть стола. */
    const me = seats.find(s => s.you);
    cam.az = (me ? me.angle : 0) + 0.34;
    applyCamera();
  }

  /* ------------------------------------------------------------------ */
  /* состояние партии → сцена                                            */
  /* ------------------------------------------------------------------ */
  function setDead(id) {
    const s = seatsById.get(id);
    if (!s || s.dead) return;
    s.dead = true;
    s.speaking = false;
    s.deadFrom = performance.now();
    s.slumpSide = (s.seat % 2) ? 1 : -1;
    lamp.nudge(0.05);
  }

  function setSpeaker(id) { speakerId = id || null; }

  function setTargets(ids) { targets = new Set(ids || []); }

  function setPhase(p) {
    if (p === phase) return;
    phase = p;
    const night = p === 'night';
    lightTween = { t: 0, night, from: snapshotLight() };
    nightTarget = night ? 1 : 0;
  }

  function snapshotLight() {
    return {
      spot: lamp.baseSpot, point: lamp.basePoint, amb: ambient.intensity, hemi: hemi.intensity,
      moon: moon.intensity, fog: scene.fog.density, fill: fills[0].intensity, table: tableLight.intensity,
      ambColor: ambient.color.clone(), hemiColor: hemi.color.clone(), glow: lamp.glowLevel,
      ember: emberGlow.intensity,
      env: stack ? stack.envIntensity : 0
    };
  }

  /* Куда светим в каждой фазе. Ночь — почти без света, только лампа и луна;
     голосование — жёсткий верхний свет; смерть — короткая вспышка угля. */
  /* Все интенсивности пересчитаны от общего рига: пятно 34 выбивало сукно,
     кисти и рукава в чистый белый независимо от их цвета — под таким светом
     любая ткань становится кремовой. Теперь основной свет доносит отражённая
     комната (IBL), а лампа только акцентирует. */
  const S = RIG.spot / 34, Pt = RIG.point / 5.6, F = RIG.fill / 4.6, Tb = RIG.table / 3.4;
  const LIGHT = {
    day: { spot: 34 * S, point: 5.6 * Pt, amb: 0.42 * (RIG.ambient / 0.42), hemi: 0.34 * (RIG.hemi / 0.34), moon: 0, fog: 0.022, fill: 4.6 * F, table: 3.4 * Tb, glow: 1, ember: 0, ambColor: 0x6a6070, hemiColor: 0x8b9bb4, grade: 'day', env: RIG.envIntensity.day },
    night: { spot: 5.2 * S, point: 1.1 * Pt, amb: 0.16, hemi: 0.16, moon: 1.1, fog: 0.046, fill: 0.9 * F, table: 1.5 * Tb, glow: 0.14, ember: 0, ambColor: 0x3a4a70, hemiColor: 0x56769f, grade: 'night', env: RIG.envIntensity.night },
    vote: { spot: 44 * S, point: 7 * Pt, amb: 0.34, hemi: 0.26, moon: 0, fog: 0.026, fill: 2.8 * F, table: 4.4 * Tb, glow: 1, ember: 0.6, ambColor: 0x6d5f5a, hemiColor: 0x8b8a86, grade: 'vote', env: RIG.envIntensity.day },
    morning: { spot: 27 * S, point: 4.6 * Pt, amb: 0.52, hemi: 0.44, moon: 0, fog: 0.018, fill: 6 * F, table: 3.2 * Tb, glow: 0.8, ember: 0, ambColor: 0x7a7268, hemiColor: 0xa8b0bb, grade: 'day', env: RIG.envIntensity.day * 1.2 },
    over: { spot: 18 * S, point: 3.4 * Pt, amb: 0.28, hemi: 0.22, moon: 0.4, fog: 0.03, fill: 2.2 * F, table: 2.1 * Tb, glow: 0.6, ember: 1.1, ambColor: 0x5c4c52, hemiColor: 0x6f6a72, grade: 'curtain', env: RIG.envIntensity.night }
  };
  function lightFor(p) {
    if (p === 'night') return LIGHT.night;
    if (p === 'vote' || p === 'runoff') return LIGHT.vote;
    if (p === 'morning') return LIGHT.morning;
    if (p === 'over') return LIGHT.over;
    return LIGHT.day;
  }

  let lightTween = null;
  let nightTarget = 0;

  /** Принять целиком вид партии: живые/мёртвые, фаза, цели, говорящий. */
  function sync(g) {
    if (!g) return;
    if (g.players) {
      g.players.forEach(p => { if (!p.alive) setDead(p.id); });
    }
    if (g.phase) setPhase(g.phase);
    if ('speakerId' in g) setSpeaker(g.speakerId);
    if (g.targets) setTargets(g.targets);
  }

  /* ------------------------------------------------------------------ */
  /* выбор игрока мышью                                                  */
  /* ------------------------------------------------------------------ */
  function pickAt(clientX, clientY) {
    if (!opts.onPick || !seats.length) return;
    const r = el.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(seats.map(s => s.group), true);
    if (!hits.length) return;
    /* поднимаемся от полигона к группе места */
    let o = hits[0].object;
    while (o && !seats.some(s => s.group === o)) o = o.parent;
    const s = seats.find(x => x.group === o);
    if (s) opts.onPick(s.id);
  }

  /** Экранные координаты места — для HTML-подписи над фигурой. */
  function project(id, yOff) {
    const s = seatsById.get(id);
    if (!s) return null;
    const v = new THREE.Vector3(s.pos.x, yOff === undefined ? 1.62 : yOff, s.pos.z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * el.clientWidth,
      y: (-v.y * 0.5 + 0.5) * el.clientHeight,
      visible: v.z < 1,
      depth: v.z
    };
  }

  /* ------------------------------------------------------------------ */
  /* кадр                                                                */
  /* ------------------------------------------------------------------ */
  let raf = 0, last = 0, alive = true;
  let fpsAcc = 0, fpsN = 0, degraded = false, lastAdapt = 0;

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(60, now - last) : 16;
    last = now;

    /* На слабом устройстве один раз снижаем нагрузку, а не тормозим всю партию. */
    if (dt > 0) { fpsAcc += 1000 / dt; fpsN++; }
    if (!degraded && fpsN > 120 && now - lastAdapt > 3000) {
      const fps = fpsAcc / fpsN; fpsAcc = 0; fpsN = 0; lastAdapt = now;
      if (fps < 34) {
        degraded = true;
        pixelCap = Math.max(1, pixelCap - 0.5);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelCap));
        if (fps < 24) renderer.shadowMap.enabled = false;
      }
    }

    /* --- камера: инерция вращения --- */
    if (Math.abs(cam.vAz) > 1e-5 || Math.abs(cam.vPol) > 1e-5) {
      cam.az += cam.vAz; cam.pol += cam.vPol;
      cam.vAz *= drag ? 0.4 : 0.9;
      cam.vPol *= drag ? 0.4 : 0.9;
      applyCamera();
    }

    /* --- свет по фазам --- */
    if (lightTween) {
      lightTween.t = Math.min(1, lightTween.t + dt / 1500);
      const t = lightTween.t, f = lightTween.from, to = lightFor(phase);
      const e = t * t * (3 - 2 * t);
      lamp.baseSpot = lerp(f.spot, to.spot, e);
      lamp.basePoint = lerp(f.point, to.point, e);
      lamp.glowLevel = lerp(f.glow, to.glow, e);
      ambient.intensity = lerp(f.amb, to.amb, e);
      hemi.intensity = lerp(f.hemi, to.hemi, e);
      moon.intensity = lerp(f.moon, to.moon, e);
      scene.fog.density = lerp(f.fog, to.fog, e);
      fills.forEach(l => { l.intensity = lerp(f.fill, to.fill, e); });
      tableLight.intensity = lerp(f.table, to.table, e);
      emberGlow.intensity = lerp(f.ember, to.ember, e);
      ambient.color.copy(f.ambColor).lerp(new THREE.Color(to.ambColor), e);
      hemi.color.copy(f.hemiColor).lerp(new THREE.Color(to.hemiColor), e);
      /* Цветокоррекция и сила отражённого света едут вместе со светом: ночь
         уходит в холодную зелень, голосование — в жёсткую тёплую известь,
         занавес — в сепию. Раньше фаза читалась только по яркости лампы. */
      if (stack) {
        stack.applyGrade(to.grade, Math.min(1, dt / 900));
        stack.setEnvIntensity(lerp(
          f.env === undefined ? to.env : f.env, to.env, e));
      }
      if (t >= 1) lightTween = null;
    }
    nightPose += (nightTarget - nightPose) * Math.min(1, dt / 900);

    lamp.animate(now, dt);
    if (table) table.animate(now);

    /* --- фигуры ---
       Всю жизнь фигуры (дыхание, мигание, речь, качание волос, перенос
       веса, мелкие движения кистей) считает сама мастерская: одна функция
       animate в models3d.js. Сцена только сообщает, что происходит за
       столом. Так живыми оказываются люди и в партии с ботами, и по сети —
       раньше дыхание и мигание были написаны здесь и работали лишь в одном
       из двух режимов. */
    for (const s of seats) {
      const u = s.figure.userData;

      if (s.dead) {
        /* Оседание: корпус валится на сторону и вниз, крест проявляется. */
        const k = Math.min(1, (now - s.deadFrom) / 950);
        const ease = 1 - Math.pow(1 - k, 3);
        s.figure.rotation.z = lerp(0, s.slumpSide * 0.92, ease);
        s.figure.rotation.x = lerp(s.figure.rotation.x, -0.16, 0.05);
        s.figure.position.y = lerp(0, -0.10, ease);
        s.cross.material.opacity = Math.min(0.9, k);
        u.headPivot.rotation.set(0.4 * ease, 0, 0);
        s.ring.material.opacity = 0;
        u.animate(now, dt, { dead: true });
        continue;
      }

      /* Взгляд: голова и глаза доворачиваются к говорящему. */
      let want = 0;
      if (speakerId && speakerId !== s.id) {
        const sp = seatsById.get(speakerId);
        if (sp) {
          /* угол между «своим» направлением на центр и направлением на говорящего */
          const dx = sp.pos.x - s.pos.x, dz = sp.pos.z - s.pos.z;
          const toSp = Math.atan2(dx, dz);
          const own = Math.atan2(-s.pos.x, -s.pos.z);
          let d = toSp - own;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          want = clamp(d, -1.0, 1.0);
        }
      }
      u.lookAt(want, 0);
      u.animate(now, dt, { speaking: s.speaking, night: nightPose > 0.5 });

      /* Ночь: все склоняются к столу. Это движение всей фигуры, а не головы. */
      s.figure.rotation.x = nightPose * 0.26;

      /* Обруч цели пульсирует — так видно, кого можно выбрать. */
      const wantRing = targets.has(s.id) ? 0.35 + Math.sin(now * 0.005) * 0.22 : 0;
      s.ring.material.opacity += (wantRing - s.ring.material.opacity) * 0.15;
    }

    /* говорящий подсвечен тёплым */
    for (const s of seats) {
      const on = s.id === speakerId && !s.dead;
      if (on !== s.speaking) {
        s.speaking = on;
        s.figure.userData.materials.forEach(m => {
          if (m.emissive) m.emissive.setRGB(on ? 0.11 : 0, on ? 0.08 : 0, on ? 0.03 : 0);
        });
      }
    }

    if (stack) stack.render(dt, now); else renderer.render(scene, camera);
  }

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 360;
    renderer.setSize(w, h, false);
    if (stack) stack.setSize(w, h);
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    camera.aspect = Math.max(0.2, w / Math.max(1, h));
    camera.updateProjectionMatrix();
    /* После поворота телефона кадр меняет пропорции: пересчитываем отход,
       но только если игрок сам не отъехал колесом. */
    if (cam.fit && Math.abs(cam.dist - fitDistance(cam.fit)) > 2.6) cam.dist = fitDistance(cam.fit);
    applyCamera();
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', resize, { passive: true });

  /* Слой картинки поднимается после того, как комната собрана: панораму для
     IBL снимаем с готовой сцены, иначе отражать нечего. */
  let stack = null;
  if (RS && !M.LOWQ) {
    try {
      stack = RS.createRenderStack(THREE, {
        renderer, scene, camera, tier: M.TIER,
        envIntensity: RIG.envIntensity.day
      });
      stack.buildEnvironment({ y: 1.2 });
    } catch (e) { stack = null; }
  }

  resize();
  applyCamera();
  raf = requestAnimationFrame(frame);

  return {
    THREE, renderer, scene, camera, lamp,
    setSeats, sync, setPhase, setSpeaker, setTargets, setDead, project, resize,
    /* удар по столу: лампа качнётся, кадр дрогнет */
    shake(k) {
      lamp.nudge(k || 0.06);
      const until = performance.now() + 380;
      (function jitter() {
        const left = until - performance.now();
        if (left <= 0) { root.position.set(0, 0, 0); return; }
        const a = (left / 380) * 0.026;
        root.position.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, 0);
        requestAnimationFrame(jitter);
      })();
    },
    seatCount() { return seats.length; },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', resize);
      clearSeats();
      M.disposeTree(scene);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  };
}

export default mountStage;
