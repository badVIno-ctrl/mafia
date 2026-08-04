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

  /* ------------------------------------------------------------------ */
  /* рендерер, сцена, камера                                             */
  /* ------------------------------------------------------------------ */
  const renderer = new THREE.WebGLRenderer({ antialias: !M.LOWQ, powerPreference: 'high-performance' });
  let pixelCap = M.LOWQ ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelCap));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = M.LOWQ ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.34;
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
  const lamp = M.buildLamp(root, { ceilY: 8.3, bulbY: 3.0 });

  /* Общий свет. Держим ссылки: по фазам он меняется целиком. */
  const ambient = new THREE.AmbientLight(0x6a6070, 1.2);
  const hemi = new THREE.HemisphereLight(0x8b9bb4, 0x3a2c26, 0.95);
  const moon = new THREE.DirectionalLight(0x5878b8, 0);
  moon.position.set(-6, 7, -5);
  const emberGlow = new THREE.PointLight(0xc4563a, 0, 9, 2);
  emberGlow.position.set(0, 2.1, 0);
  const fills = [];
  [[0, 3.4, 4.6, 0xffd7ad, 26], [-4.4, 3.0, -3.0, 0x9db4de, 16], [4.4, 3.0, -3.0, 0xdda98a, 16]].forEach(c => {
    const l = new THREE.PointLight(c[3], c[4], 16, 2);
    l.position.set(c[0], c[1], c[2]);
    fills.push(l); scene.add(l);
  });
  const tableLight = new THREE.SpotLight(0xfff0d6, 34, 9, Math.PI / 3.1, 0.9, 1.2);
  tableLight.position.set(0, 4.2, 0.6);
  tableLight.target.position.set(0, 0.9, 0);
  scene.add(ambient, hemi, moon, emberGlow, tableLight, tableLight.target);

  /* ------------------------------------------------------------------ */
  /* камера: собственная орбита с инерцией                               */
  /* ------------------------------------------------------------------ */
  const cam = { az: 0, pol: 1.18, dist: 7.4, target: new THREE.Vector3(0, 1.15, 0), vAz: 0, vPol: 0, fit: 7.4 };
  const LIMIT = { polMin: 0.42, polMax: 1.46, distMin: 2.6, distMax: 16 };

  /* Сколько нужно отойти, чтобы стол со стульями целиком влез в кадр.
     На телефоне кадр узкий, и та же дистанция обрезает половину стола —
     поэтому считаем по меньшему из двух углов обзора. */
  function fitDistance(radius) {
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const fov = Math.min(vFov, hFov);
    return clamp((radius + 0.9) / Math.tan(fov / 2) * 0.92, LIMIT.distMin, LIMIT.distMax);
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
      chair.position.z = -0.46;
      group.add(chair);

      const figure = M.buildFigure(COATS[i % COATS.length], p.hat || (i % 5 === 0 ? 'cap' : 'hair'), i + 1, { sex: i % 3 === 1 ? 'f' : 'm' });
      group.add(figure);

      /* Медный обруч под стулом: подсветка выбираемой цели. */
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.38, 0.46, M.sg(30, 16)),
        new THREE.MeshBasicMaterial({ color: 0xe2b478, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.02, -0.42);
      group.add(ring);

      const cross = new THREE.Sprite(new THREE.SpriteMaterial({
        map: M.texFromCanvas(M.crossCanvas()), transparent: true, opacity: 0
      }));
      cross.scale.set(0.46, 0.46, 1);
      cross.position.set(sx, 2.28, sz);
      root.add(cross);

      const s = {
        id: p.id, seat: p.seat, name: p.name, you: !!p.you,
        group, figure, ring, cross,
        pos: new THREE.Vector3(sx, 0, sz),
        angle: a, dead: false, speaking: false,
        blinkAt: 900 + Math.random() * 4000, blinkFor: 0,
        breath: Math.random() * Math.PI * 2
      };
      seats.push(s);
      seatsById.set(p.id, s);
    });

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
      ember: emberGlow.intensity
    };
  }

  /* Куда светим в каждой фазе. Ночь — почти без света, только лампа и луна;
     голосование — жёсткий верхний свет; смерть — короткая вспышка угля. */
  const LIGHT = {
    day: { spot: 58, point: 10, amb: 1.2, hemi: 0.95, moon: 0, fog: 0.022, fill: 22, table: 34, glow: 1, ember: 0, ambColor: 0x6a6070, hemiColor: 0x8b9bb4 },
    night: { spot: 8, point: 1.9, amb: 0.5, hemi: 0.5, moon: 1.5, fog: 0.046, fill: 4, table: 5, glow: 0.14, ember: 0, ambColor: 0x3a4a70, hemiColor: 0x56769f },
    vote: { spot: 74, point: 12, amb: 0.9, hemi: 0.7, moon: 0, fog: 0.026, fill: 12, table: 46, glow: 1, ember: 0.6, ambColor: 0x6d5f5a, hemiColor: 0x8b8a86 },
    morning: { spot: 44, point: 8, amb: 1.35, hemi: 1.2, moon: 0, fog: 0.018, fill: 26, table: 30, glow: 0.8, ember: 0, ambColor: 0x7a7268, hemiColor: 0xa8b0bb },
    over: { spot: 30, point: 6, amb: 0.8, hemi: 0.6, moon: 0.4, fog: 0.03, fill: 10, table: 20, glow: 0.6, ember: 1.1, ambColor: 0x5c4c52, hemiColor: 0x6f6a72 }
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
    const v = new THREE.Vector3(s.pos.x, yOff === undefined ? 2.0 : yOff, s.pos.z).project(camera);
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
      if (t >= 1) lightTween = null;
    }
    nightPose += (nightTarget - nightPose) * Math.min(1, dt / 900);

    lamp.animate(now, dt);
    if (table) table.animate(now);

    /* --- фигуры --- */
    for (const s of seats) {
      const u = s.figure.userData;

      if (s.dead) {
        /* Оседание: корпус валится на сторону и вниз, крест проявляется. */
        const k = Math.min(1, (now - s.deadFrom) / 950);
        const ease = 1 - Math.pow(1 - k, 3);
        s.figure.rotation.z = lerp(0, s.slumpSide * 1.28, ease);
        s.figure.rotation.x = lerp(s.figure.rotation.x, 0.12, 0.05);
        s.figure.position.y = lerp(0, -0.14, ease);
        s.cross.material.opacity = Math.min(0.9, k);
        u.headPivot.rotation.set(0.4 * ease, 0, 0);
        s.ring.material.opacity = 0;
        continue;
      }

      /* Дыхание: грудь и плечи ходят на 1.5 %. Ночью — реже и глубже. */
      s.breath += dt * (nightPose > 0.5 ? 0.0016 : 0.0024);
      const br = Math.sin(s.breath);
      u.chest.scale.set(1.05 + br * 0.014, 0.86 + br * 0.012, 0.74 + br * 0.01);
      s.figure.position.y = br * 0.006;

      /* Ночь: все склоняются к столу и опускают головы. */
      s.figure.rotation.x = nightPose * 0.3;

      /* Взгляд: голова доворачивается к говорящему. */
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
      u.headPivot.rotation.y += (want - u.headPivot.rotation.y) * Math.min(1, dt / 420);

      /* Мигание: редкое, короткое, у каждого свой ритм. */
      s.blinkAt -= dt;
      if (s.blinkFor > 0) {
        s.blinkFor -= dt;
        u.lids.forEach(l => { l.visible = true; });
        if (s.blinkFor <= 0) u.lids.forEach(l => { l.visible = false; });
      } else if (s.blinkAt <= 0) {
        s.blinkFor = 110;
        s.blinkAt = 2200 + Math.random() * 5200;
      }

      /* Речь: челюсть двигается, фигура чуть подаётся вперёд. */
      if (s.speaking) {
        u.jaw.position.y = u.restJawY - 0.014 - Math.abs(Math.sin(now * 0.016)) * 0.02;
        u.headPivot.rotation.x = Math.sin(now * 0.004) * 0.04;
      } else if (u.jaw.position.y !== u.restJawY) {
        u.jaw.position.y = lerp(u.jaw.position.y, u.restJawY, 0.2);
      }

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

    renderer.render(scene, camera);
  }

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 360;
    renderer.setSize(w, h, false);
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
        const a = (left / 380) * 0.045;
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
