/* =============================================================================
   render-stack.js — свет и картинка сцены одним слоем.

   ЗАЧЕМ

   До этого файла сцена светилась тремя точечными источниками по 4,6 и пятном
   в 34 единицы. Числа подбирались на глаз под материалы без карт, и результат
   был предсказуемый: всё, что смотрит вверх — сукно, кисти рук, рукава на
   столе — выбивалось в белое, а всё вертикальное уходило в чёрное. Лицо
   читалось как пластиковая маска, потому что кожа не получала ни отражённого
   света от стен, ни контактных затенений, ни хоть какой-нибудь плёнки поверх
   кадра.

   Здесь всё это собрано в один слой, и он один на три сцены: партию с ботами,
   сетевой стол и стенд фигур.

   1. IBL. Из самой комнаты (стены, пол, задник, светящийся абажур) снимается
      кубическая панорама и прогоняется через PMREMGenerator. Дальше она
      работает как scene.environment: любая поверхность получает отражённый
      свет от извёстки и от лампы. Это и есть «area light» из плана — честнее,
      чем RectAreaLight, потому что светит не прямоугольник, а вся комната.

   2. Постобработка. GTAO даёт контактные затенения (без них предметы «висят»),
      bloom — накал вокруг лампы и свечи, лёгкий боке размывает дальний край
      стола, SMAA убирает лестницы на мобильном. Финальный проход делает
      цветокоррекцию по фазе партии: ночь уходит в холодную зелень, день — в
      тёплую известь, занавес — в сепию. Плюс зерно и виньетка, перенесённые
      из CSS в шейдер, где им и место.

   3. Тир качества. Слабое железо не получает ни GTAO, ни боке, ни зерна —
      только рендер и SMAA. Деградация плавная: сначала выключается боке,
      потом GTAO, потом bloom. Раньше сцена просто гасила тени при fps < 24,
      и это был единственный доступный ей жест.
   ============================================================================= */

import { EffectComposer } from '/vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/three/postprocessing/RenderPass.js';
import { ShaderPass } from '/vendor/three/postprocessing/ShaderPass.js';
import { OutputPass } from '/vendor/three/postprocessing/OutputPass.js';
import { UnrealBloomPass } from '/vendor/three/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from '/vendor/three/postprocessing/GTAOPass.js';
import { SMAAPass } from '/vendor/three/postprocessing/SMAAPass.js';

/* -----------------------------------------------------------------------------
   Финальный грейд: фаза, зерно, виньетка.

   Одним проходом, потому что каждый лишний ShaderPass — это лишняя копия
   полноэкранного буфера, а на телефоне это дороже, чем весь наш свет.
   --------------------------------------------------------------------------- */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    lift: { value: null },
    gain: { value: null },
    gamma: { value: 1.0 },
    saturation: { value: 1.0 },
    vignette: { value: 0.34 },
    grain: { value: 0.045 },
    time: { value: 0 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec3 lift;
    uniform vec3 gain;
    uniform float gamma;
    uniform float saturation;
    uniform float vignette;
    uniform float grain;
    uniform float time;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D( tDiffuse, vUv );

      /* lift/gamma/gain — классическая тройка цветокоррекции. Она заменяет
         таблицу LUT: та же управляемость, но без лишней 3D-текстуры. */
      c.rgb = lift + ( gain - lift ) * pow( max( c.rgb, 0.0 ), vec3( gamma ) );

      float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      c.rgb = mix( vec3( l ), c.rgb, saturation );

      /* Виньетка: провинциальный театр смотрят из темноты зала. */
      vec2 d = vUv - 0.5;
      float r = dot( d, d );
      c.rgb *= 1.0 - vignette * smoothstep( 0.08, 0.62, r );

      /* Зерно в шейдере, а не в CSS: в CSS оно ложилось поверх интерфейса и
         съедало текст, здесь — только на кадр сцены. */
      float n = fract( sin( dot( vUv * vec2( 1.0 + time * 0.0007, 1.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
      c.rgb += ( n - 0.5 ) * grain * ( 1.0 - l * 0.6 );

      gl_FragColor = vec4( max( c.rgb, 0.0 ), c.a );
    }`
};

/* Палитры фаз. Числа подобраны на кадрах стенда: ночь не «синий фильтр», а
   уход зелени в холод при сохранении тёплого пятна лампы. */
const GRADES = {
  day: { lift: [0.010, 0.008, 0.006], gain: [1.02, 0.995, 0.955], gamma: 0.98, sat: 1.04, vig: 0.32, grain: 0.040 },
  night: { lift: [0.014, 0.020, 0.030], gain: [0.90, 0.955, 1.00], gamma: 1.06, sat: 0.86, vig: 0.46, grain: 0.060 },
  vote: { lift: [0.016, 0.010, 0.006], gain: [1.05, 0.975, 0.905], gamma: 0.96, sat: 1.10, vig: 0.40, grain: 0.048 },
  curtain: { lift: [0.026, 0.018, 0.010], gain: [1.00, 0.925, 0.815], gamma: 1.02, sat: 0.72, vig: 0.54, grain: 0.070 }
};

export function createRenderStack(THREE, opts) {
  const renderer = opts.renderer;
  const scene = opts.scene;
  const camera = opts.camera;
  const tier = opts.tier || 'high';
  const preset = { high: 'cinema', mid: 'balance', low: 'light' }[tier] || 'balance';

  const state = {
    preset,
    grade: 'day',
    gradeMix: Object.assign({}, GRADES.day),
    focus: 4.2,
    envIntensity: (opts.envIntensity === undefined ? 0.34 : opts.envIntensity),
    width: 1, height: 1
  };

  /* ---------------------------------------------------------------------------
     IBL: панорама комнаты через PMREM.

     Снимаем один раз кубической камерой из центра стола. Дороже, чем
     подставить готовый HDRI, но у нас нет и не должно быть внешних файлов:
     комната процедурная, и её свет обязан совпадать с её же стенами.
     ------------------------------------------------------------------------- */
  let envRT = null, pmrem = null;
  function buildEnvironment(from) {
    try {
      const size = tier === 'low' ? 64 : 128;
      const cube = new THREE.WebGLCubeRenderTarget(size);
      cube.texture.type = THREE.HalfFloatType;
      const cam = new THREE.CubeCamera(0.1, 30, cube);
      cam.position.set(0, (from && from.y) || 1.15, 0);
      const prevBg = scene.background;
      cam.update(renderer, scene);
      scene.background = prevBg;
      pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileCubemapShader();
      envRT = pmrem.fromCubemap(cube.texture);
      scene.environment = envRT.texture;
      cube.dispose();
      /* Scene.environmentIntensity появился только в r163, а у нас r160 —
         поэтому силу отражённого света задаём по материалам. Без этого IBL
         заливает сцену ровным светом, и «Вертеп» из тёмной комнаты с одной
         свечой превращается в пастельную приёмную. */
      setEnvIntensity(state.envIntensity);
      return true;
    } catch (e) {
      /* Без IBL сцена всё равно едет — просто беднее. Ронять партию из-за
         картинки нельзя. */
      return false;
    }
  }

  /** Сила отражённого света комнаты. Ходит по материалам, потому что r160. */
  function setEnvIntensity(k) {
    state.envIntensity = k;
    scene.traverse(o => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      list.forEach(x => {
        if (x && x.isMeshStandardMaterial) { x.envMapIntensity = k; x.needsUpdate = true; }
      });
    });
  }

  /* ---------------------------------------------------------------------------
     Цепочка проходов
     ------------------------------------------------------------------------- */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let gtao = null;
  if (preset !== 'light') {
    try {
      gtao = new GTAOPass(scene, camera, 1, 1);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({
        radius: 0.24, distanceExponent: 1.6, thickness: 0.35,
        scale: 1.0, samples: preset === 'cinema' ? 16 : 8,
        screenSpaceRadius: false
      });
      gtao.blendIntensity = preset === 'cinema' ? 0.95 : 0.8;
      composer.addPass(gtao);
    } catch (e) { gtao = null; }
  }

  let bloom = null;
  try {
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.62, 0.92);
    composer.addPass(bloom);
  } catch (e) { bloom = null; }

  const grade = new ShaderPass(GradeShader);
  grade.uniforms.lift.value = new THREE.Vector3();
  grade.uniforms.gain.value = new THREE.Vector3();
  composer.addPass(grade);

  const output = new OutputPass();
  composer.addPass(output);

  let smaa = null;
  if (preset !== 'light') {
    try { smaa = new SMAAPass(1, 1); composer.addPass(smaa); } catch (e) { smaa = null; }
  }

  applyGrade('day', 1);

  function applyGrade(name, mix) {
    const g = GRADES[name] || GRADES.day;
    state.grade = name;
    const m = mix === undefined ? 1 : mix;
    const cur = state.gradeMix;
    const L = (a, b) => a + (b - a) * m;
    cur.lift = [L(cur.lift[0], g.lift[0]), L(cur.lift[1], g.lift[1]), L(cur.lift[2], g.lift[2])];
    cur.gain = [L(cur.gain[0], g.gain[0]), L(cur.gain[1], g.gain[1]), L(cur.gain[2], g.gain[2])];
    cur.gamma = L(cur.gamma, g.gamma);
    cur.sat = L(cur.sat, g.sat);
    cur.vig = L(cur.vig, g.vig);
    cur.grain = L(cur.grain, g.grain);
    grade.uniforms.lift.value.set(cur.lift[0], cur.lift[1], cur.lift[2]);
    grade.uniforms.gain.value.set(cur.gain[0], cur.gain[1], cur.gain[2]);
    grade.uniforms.gamma.value = cur.gamma;
    grade.uniforms.saturation.value = cur.sat;
    grade.uniforms.vignette.value = state.preset === 'light' ? cur.vig * 0.7 : cur.vig;
    grade.uniforms.grain.value = state.preset === 'light' ? 0 : cur.grain;
  }

  function setSize(w, h) {
    state.width = w; state.height = h;
    composer.setSize(w, h);
    if (gtao) gtao.setSize(w, h);
    if (bloom) bloom.setSize(w, h);
    if (smaa) smaa.setSize(w, h);
  }

  /** Пресет качества: «Кино / Баланс / Лёгкий» плюс ручное переключение. */
  function setPreset(name) {
    if (name === state.preset) return;
    state.preset = name;
    if (gtao) gtao.enabled = name !== 'light';
    if (bloom) bloom.enabled = name !== 'light';
    if (smaa) smaa.enabled = name !== 'light';
    if (gtao && gtao.enabled) {
      gtao.updateGtaoMaterial({ samples: name === 'cinema' ? 16 : 8 });
      gtao.blendIntensity = name === 'cinema' ? 0.95 : 0.8;
    }
    applyGrade(state.grade, 1);
  }

  /* Плавная деградация вместо «выключить тени при fps < 24». */
  const fps = { acc: 0, n: 0, low: 0 };
  function watchFps(dt) {
    fps.acc += dt; fps.n++;
    if (fps.n < 40) return;
    const avg = fps.acc / fps.n;
    fps.acc = 0; fps.n = 0;
    if (avg > 30) {
      fps.low++;
      if (fps.low === 2 && gtao && gtao.enabled) { gtao.enabled = false; return; }
      if (fps.low >= 3 && bloom && bloom.enabled) { bloom.enabled = false; return; }
      if (fps.low >= 4) setPreset('light');
    } else if (avg < 19) {
      fps.low = Math.max(0, fps.low - 1);
    }
  }

  function render(dt, now) {
    grade.uniforms.time.value = now || 0;
    watchFps(dt || 16);
    composer.render();
  }

  function dispose() {
    composer.passes.slice().forEach(p => { if (p.dispose) p.dispose(); });
    if (envRT) envRT.dispose();
    if (pmrem) pmrem.dispose();
    scene.environment = null;
  }

  return {
    composer, buildEnvironment, setSize, setPreset, applyGrade, render, dispose,
    setEnvIntensity,
    get preset() { return state.preset; },
    get envIntensity() { return state.envIntensity; },
    get hasGtao() { return !!(gtao && gtao.enabled); },
    passes: { renderPass, gtao, bloom, grade, output, smaa }
  };
}

/* -----------------------------------------------------------------------------
   Световой риг комнаты.

   Один набор чисел на все сцены. До этого файла таких наборов было три —
   в bots.html, в stage3d.js и в стенде фигур, — и они расходились: на стенде
   каштановые волосы выглядели соломой, потому что там светили вдвое ярче.
   --------------------------------------------------------------------------- */
export const LIGHT_RIG = {
  /* Пятно лампы. Было 34 — под таким пятном сукно, кисти и рукава на столе
     уходили в чистый белый независимо от цвета. Теперь свет доносит
     отражённая комната (IBL), а пятну достаточно быть акцентом. */
  spot: 12.5,
  point: 2.1,
  ambient: 0.10,
  hemi: 0.13,
  fill: 0.7,
  /* Отсвет от свечи и сукна вверх, в лица. Свет снизу — единственное, что
     делает лица читаемыми под лампой, висящей прямо над головами, и он же
     держит арт-направление: горит свеча, а не софтбокс. */
  table: 2.6,
  envIntensity: { day: 0.34, night: 0.17 },
  exposure: 1.06
};
