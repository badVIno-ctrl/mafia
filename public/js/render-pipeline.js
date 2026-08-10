/* =========================================================================
   render-pipeline.js — как сцена превращается в кадр.

   Диагноз, из которого вырос этот файл. Геометрия людей за столом была уже
   неплохой: череп лепится по форме, глаза — настоящие яблоки в орбитах, нос
   и губы отдельными мешами. А выглядело всё пластиком. Причина не в мешах,
   а в том, что между мешем и экраном ничего не было:

     • свет шёл от точечных источников — а точечный свет даёт резкий блик и
       линейное падение, чего в комнате с абажуром не бывает никогда;
     • не было окружения (IBL) — значит, roughness и metalness почти ни на
       что не влияли: отражать было нечего, кроме чёрного фона;
     • не было ни затенения в складках (AO), ни свечения вокруг накала
       (bloom), ни размытия по глубине, ни цветокоррекции. Зерно было в CSS —
       то есть поверх кадра, а не внутри него.

   Этот модуль закрывает всё перечисленное и ничего не знает ни о правилах
   партии, ни о людях за столом. Ему дают renderer, scene и camera — он
   возвращает ручку, у которой есть render(), resize() и setGrade('night').

   Три уровня качества. Решение принимается по замеру, а не по гаданию:
   первые секунды сцена рисуется в самом дешёвом виде, и если кадры идут
   быстро — включается всё остальное.

     'cinema'  — IBL + GTAO + bloom + DOF + грейд + SMAA
     'balance' — IBL + bloom + грейд + FXAA
     'light'   — IBL + грейд, дальше renderer.render напрямую

   ========================================================================= */

const BASE = '/vendor/three/addons/';

/* -------------------------------------------------------------------------
   ОКРУЖЕНИЕ

   Комната освещена одной лампой с абажуром над столом. Для физически
   честного материала важно не только «откуда свет», но и «что вокруг»:
   кожа, сукно и медь отражают комнату, и без этого отражения любая
   поверхность выглядит нарисованной.

   Настоящего HDRI-файла здесь нет намеренно: он весит мегабайты, а нужен
   нам всего-то тёплый купол сверху, холодная щель окна на одной стене и
   тёплый отсвет сукна снизу. Такую карту дешевле посчитать в четыре цикла,
   чем везти по сети. Значения выше единицы — это и есть HDR: купол лампы
   светит в двенадцать раз ярче белой стены.
   ------------------------------------------------------------------------- */
export function buildEnvironment(THREE, renderer, opts) {
  opts = opts || {};
  const W = 128, H = 64;
  const data = new Float32Array(W * H * 4);

  /* Палитра «Вертепа»: сальная свеча сверху, извёстка на стенах,
     зеленоватое сукно снизу, синяя ночь в окне. */
  /* Мощность окружения. Числа маленькие, и это принципиально: карта
     окружения освещает сцену со всех сторон сразу, поэтому её вклад надо
     считать как интеграл по полусфере, а не как «яркость картинки». Купол
     со светимостью 0,8 даёт освещённость около 0,8 — то есть ровно столько,
     сколько раньше давали ambient и hemi вместе. Первая версия этого файла
     ставила 9,0 «чтобы было видно», и сцена уходила в белое. */
  const lampK = opts.lamp === undefined ? 0.80 : opts.lamp;
  const wallK = opts.wall === undefined ? 0.022 : opts.wall;
  const feltK = opts.felt === undefined ? 0.016 : opts.felt;
  const moonK = opts.moon === undefined ? 0.07 : opts.moon;

  for (let y = 0; y < H; y++) {
    /* theta: 0 — прямо вверх, PI — прямо вниз. */
    const theta = (y + 0.5) / H * Math.PI;
    const up = Math.cos(theta);                 // +1 вверх, -1 вниз
    for (let x = 0; x < W; x++) {
      const phi = (x + 0.5) / W * Math.PI * 2;  // 0 — на камеру по умолчанию
      let r, g, b;

      /* Стены: извёстка, чуть теплее у пола. */
      const warmth = 0.5 + 0.5 * (-up);
      r = wallK * (0.92 + warmth * 0.34);
      g = wallK * (0.86 + warmth * 0.22);
      b = wallK * (0.84 + warmth * 0.04);

      /* Купол лампы. Абажур светит вниз, но потолок над ним залит
         отражённым тёплым светом — именно этот купол и «лепит» лица. */
      const domeK = Math.pow(Math.max(0, up), 2.2);
      r += lampK * domeK * 1.00;
      g += lampK * domeK * 0.74;
      b += lampK * domeK * 0.44;

      /* Отсвет от сукна: слабый, зеленовато-тёплый, снизу. */
      const downK = Math.pow(Math.max(0, -up), 1.6);
      r += feltK * downK * 0.90;
      g += feltK * downK * 1.00;
      b += feltK * downK * 0.78;

      /* Окно: узкая холодная щель на одной стене, на уровне глаз. */
      const band = Math.exp(-Math.pow((up - 0.06) / 0.16, 2));
      const slit = Math.exp(-Math.pow((((phi - 3.9 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / 0.34, 2));
      r += moonK * band * slit * 0.42;
      g += moonK * band * slit * 0.60;
      b += moonK * band * slit * 1.00;

      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}


/* -------------------------------------------------------------------------
   СТРАЖ

   Один проход между сценой и постобработкой, который делает две скучные,
   но необходимые вещи: убирает NaN и ограничивает яркость сверху.

   Зачем. Любая постобработка размывает кадр — то есть смешивает соседние
   пиксели. Одна испорченная точка (вырожденная нормаль, деление на ноль в
   чужом шейдере, отрицательная яркость после интерполяции) после размытия
   превращается в квадрат размером с ядро свёртки. Ловить каждый такой
   случай в исходниках надо, и мы ловим, но пайплайн обязан быть устойчив к
   тому, чего мы не поймали: белый квадрат посреди лица — это сломанная
   партия, а обрезанный до восьми блик — нет.
   ------------------------------------------------------------------------- */
export const GuardShader = {
  name: 'VertepGuard',
  uniforms: { tDiffuse: { value: null }, uCeil: { value: 8.0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCeil;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      /* NaN не равен сам себе — это единственный надёжный способ его поймать
         в GLSL без расширений. */
      c = mix( c, vec3( 0.0 ), vec3( lessThan( abs( c ), vec3( 0.0 ) ) ) );
      if ( ! ( c.r == c.r ) ) c.r = 0.0;
      if ( ! ( c.g == c.g ) ) c.g = 0.0;
      if ( ! ( c.b == c.b ) ) c.b = 0.0;
      gl_FragColor = vec4( clamp( c, vec3( 0.0 ), vec3( uCeil ) ), 1.0 );
    }
  `
};

/* -------------------------------------------------------------------------
   ГРЕЙД

   Один проход, который делает то, что раньше делали CSS-фильтры поверх
   канвы (а значит — поверх интерфейса тоже) или не делал никто:

     • lift / gamma / gain — раздельная правка тени, полутона и света;
     • температура и насыщенность — характер фазы;
     • виньетка — свет одной лампы гаснет к краям кадра;
     • halation — тёплый разлив вокруг самых ярких мест, как на плёнке;
     • зерно — внутри кадра, поэтому оно живёт вместе с картинкой и не
       ложится сеткой на кнопки.

   Зерно и halation считаются по яркости: в тени зерна больше, в свету
   меньше — так ведёт себя настоящая эмульсия.
   ------------------------------------------------------------------------- */
export const GradeShader = {
  name: 'VertepGrade',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.055 },
    uVignette: { value: 0.42 },
    uHalation: { value: 0.16 },
    uSaturation: { value: 1.0 },
    uTemperature: { value: 0.0 },
    uContrast: { value: 1.0 },
    uLift: { value: null },
    uGain: { value: null },
    uResolution: { value: null }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uHalation, uSaturation, uTemperature, uContrast;
    uniform vec3 uLift, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    /* Хеш без текстуры: три умножения и синус. Дешевле любого шума-семпла. */
    float hash( vec2 p ) {
      p = fract( p * vec2( 233.34, 851.73 ) );
      p += dot( p, p + 23.45 );
      return fract( p.x * p.y );
    }

    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;

      /* Halation: тёплый разлив вокруг ярких мест. Берём четыре отсчёта
         крестом на расстоянии в пару пикселей и подмешиваем только то,
         что ярче единицы по «плёночной» шкале. */
      if ( uHalation > 0.0 ) {
        vec2 px = 2.5 / uResolution;
        vec3 s = texture2D( tDiffuse, vUv + vec2( px.x, 0.0 ) ).rgb
               + texture2D( tDiffuse, vUv - vec2( px.x, 0.0 ) ).rgb
               + texture2D( tDiffuse, vUv + vec2( 0.0, px.y ) ).rgb
               + texture2D( tDiffuse, vUv - vec2( 0.0, px.y ) ).rgb;
        s *= 0.25;
        float hot = max( 0.0, max( s.r, max( s.g, s.b ) ) - 0.62 );
        c += vec3( 1.0, 0.62, 0.34 ) * hot * uHalation;
      }

      /* lift / gain: тень поднимаем, свет тянем. Раздельно по каналам —
         так «холодная ночь» получается без общего синего фильтра. */
      c = c * uGain + uLift * ( 1.0 - c );

      /* Температура: плюс — теплее, минус — холоднее. */
      c.r *= 1.0 + uTemperature * 0.14;
      c.b *= 1.0 - uTemperature * 0.12;

      /* Контраст вокруг сцены-серого 0.42, а не 0.5: кадр тёмный. */
      c = ( c - 0.42 ) * uContrast + 0.42;

      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, uSaturation );

      /* Виньетка. Мягкая и не круглая: по вертикали чуть сильнее, потому
         что свет идёт сверху и низ кадра всегда темнее. */
      vec2 d = vUv - 0.5;
      d.y *= 1.12;
      float v = 1.0 - uVignette * pow( clamp( dot( d, d ) * 2.05, 0.0, 1.0 ), 1.35 );
      c *= v;

      /* Зерно: в тени видно, в свету почти нет. */
      float n = hash( vUv * uResolution + fract( uTime ) * 371.0 ) - 0.5;
      c += n * uGrain * ( 1.25 - 0.85 * smoothstep( 0.0, 0.85, l ) );

      gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
    }
  `
};

/* Характер каждой фазы. Числа подбирались по снимкам, а не по вкусу:
   ночь должна остаться читаемой (лица видно), но перестать быть дневной
   сценой с приглушённой лампой. */
export const GRADES = {
  day:     { sat: 1.02, temp: 0.10, contrast: 1.06, vignette: 0.40, grain: 0.030, halation: 0.10, lift: [0.012, 0.010, 0.014], gain: [1.01, 1.00, 0.98], bloom: 0.34, dof: 0.6 },
  night:   { sat: 0.74, temp: -0.28, contrast: 1.20, vignette: 0.62, grain: 0.052, halation: 0.16, lift: [0.004, 0.008, 0.020], gain: [0.94, 0.97, 1.06], bloom: 0.60, dof: 1.0 },
  morning: { sat: 1.06, temp: 0.16, contrast: 0.98, vignette: 0.32, grain: 0.026, halation: 0.12, lift: [0.026, 0.024, 0.022], gain: [1.04, 1.02, 0.98], bloom: 0.30, dof: 0.4 },
  vote:    { sat: 0.90, temp: 0.02, contrast: 1.22, vignette: 0.50, grain: 0.036, halation: 0.08, lift: [0.006, 0.006, 0.008], gain: [1.04, 1.01, 0.97], bloom: 0.28, dof: 0.7 },
  over:    { sat: 0.80, temp: 0.20, contrast: 1.10, vignette: 0.66, grain: 0.044, halation: 0.18, lift: [0.020, 0.014, 0.010], gain: [1.02, 0.96, 0.88], bloom: 0.44, dof: 0.9 }
};

export function gradeFor(phase) {
  if (phase === 'night') return GRADES.night;
  if (phase === 'morning') return GRADES.morning;
  if (phase === 'vote' || phase === 'runoff') return GRADES.vote;
  if (phase === 'over') return GRADES.over;
  return GRADES.day;
}

/* -------------------------------------------------------------------------
   СБОРКА
   ------------------------------------------------------------------------- */

/**
 * @param {object} THREE
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{tier?:'cinema'|'balance'|'light', width?:number, height?:number}} opts
 */
export async function createPipeline(THREE, renderer, scene, camera, opts) {
  opts = opts || {};
  let tier = opts.tier || 'balance';

  /* Тон-маппинг и цветовое пространство. С композитором преобразование
     делает последний проход (OutputPass), поэтому здесь ставим линейный
     выход в промежуточные буферы, а вот сам режим тон-маппинга читает
     OutputPass прямо из рендерера — его и настраиваем. */
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure === undefined ? 1.12 : opts.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* Прямоугольные источники (абажур) без этой таблицы рисуются чёрными:
     LTC-текстуры не входят в основную сборку three. */
  let areaReady = false;
  try {
    const { RectAreaLightUniformsLib } = await import(BASE + 'lights/RectAreaLightUniformsLib.js');
    RectAreaLightUniformsLib.init();
    areaReady = true;
  } catch (e) { /* без area-света обойдёмся: останется точечный */ }

  /* Окружение. Ставим всегда, даже на слабом железе: PMREM считается один
     раз, стоит доли секунды и даёт больше правдоподобия, чем что угодно
     ещё за те же деньги. */
  let env = null;
  try {
    env = buildEnvironment(THREE, renderer, opts.env);
    scene.environment = env;
  } catch (e) { /* нет float-текстур — работаем без IBL */ }

  const size = new THREE.Vector2();
  renderer.getSize(size);
  let W = Math.max(2, opts.width || size.x || 640);
  let H = Math.max(2, opts.height || size.y || 360);

  const state = {
    tier, grade: GRADES.day, gradeMix: null,
    focusTarget: null, focus: 3.4, aperture: 0.0016,
    time: 0, enabled: true
  };

  let composer = null, gtao = null, bloom = null, bokeh = null, gradePass = null, aaPass = null;

  async function buildComposer() {
    disposeComposer();
    if (tier === 'light') return;

    const [{ EffectComposer }, { RenderPass }, { ShaderPass }, { OutputPass }] = await Promise.all([
      import(BASE + 'postprocessing/EffectComposer.js'),
      import(BASE + 'postprocessing/RenderPass.js'),
      import(BASE + 'postprocessing/ShaderPass.js'),
      import(BASE + 'postprocessing/OutputPass.js')
    ]);

    const target = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.HalfFloatType,
      /* Сглаживание внутри буфера, если оно есть: дешевле любого пост-AA.
         На cinema поверх всё равно встанет SMAA — там края правит и он. */
      samples: tier === 'cinema' ? 0 : 0
    });
    composer = new EffectComposer(renderer, target);
    composer.setSize(W, H);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new ShaderPass(GuardShader));

    if (tier === 'cinema') {
      try {
        const { GTAOPass } = await import(BASE + 'postprocessing/GTAOPass.js');
        gtao = new GTAOPass(scene, camera, W, H);
        /* Радиус — в метрах сцены. 0,18 м это складка воротника и впадина
           под скулой: именно то, что читается как объём на лице. */
        gtao.updateGtaoMaterial({ radius: 0.18, distanceExponent: 1.6, thickness: 0.6, scale: 1.0, samples: 12, screenSpaceRadius: false });
        gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1.6, rings: 2, samples: 12 });
        gtao.blendIntensity = 0.85;
        composer.addPass(gtao);
      } catch (e) { gtao = null; }
    }

    if (tier === 'cinema' || tier === 'balance') {
      try {
        const { UnrealBloomPass } = await import(BASE + 'postprocessing/UnrealBloomPass.js');
        /* Порог. Ставили 0,72 — и в него попадал каждый отблеск лампы на
           влажной губе и на манжете. UnrealBloomPass размывает такое пятно
           своим квадратным ядром, и вместо свечения на лице появлялись
           белые квадраты. Порог 1,15 оставляет за чертой всё, что просто
           хорошо освещено, и пропускает только то, что светит само: нить
           накала, отсвет абажура изнутри, окно. */
        bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.30, 0.48, 1.15);
        composer.addPass(bloom);
      } catch (e) { bloom = null; }
    }

    if (tier === 'cinema') {
      try {
        const { BokehPass } = await import(BASE + 'postprocessing/BokehPass.js');
        bokeh = new BokehPass(scene, camera, { focus: 3.4, aperture: 0.0016, maxblur: 0.006 });
        composer.addPass(bokeh);
      } catch (e) { bokeh = null; }
    }

    gradePass = new ShaderPass(GradeShader);
    gradePass.uniforms.uLift.value = new THREE.Vector3();
    gradePass.uniforms.uGain.value = new THREE.Vector3(1, 1, 1);
    gradePass.uniforms.uResolution.value = new THREE.Vector2(W, H);
    composer.addPass(gradePass);

    if (tier === 'cinema') {
      try {
        const { SMAAPass } = await import(BASE + 'postprocessing/SMAAPass.js');
        aaPass = new SMAAPass(W, H);
        composer.addPass(aaPass);
      } catch (e) { aaPass = null; }
    }
    if (!aaPass) {
      try {
        const { FXAAShader } = await import(BASE + 'shaders/FXAAShader.js');
        aaPass = new ShaderPass(FXAAShader);
        aaPass.material.uniforms.resolution.value.set(1 / W, 1 / H);
        composer.addPass(aaPass);
      } catch (e) { aaPass = null; }
    }

    composer.addPass(new OutputPass());
    applyGrade(state.grade, 1);
  }

  function disposeComposer() {
    if (composer) {
      composer.passes.forEach(p => { if (p.dispose) try { p.dispose(); } catch (e) {} });
      if (composer.renderTarget1) composer.renderTarget1.dispose();
      if (composer.renderTarget2) composer.renderTarget2.dispose();
    }
    composer = null; gtao = null; bloom = null; bokeh = null; gradePass = null; aaPass = null;
  }

  /** Мгновенно применить грейд (k = 1) или подмешать к текущему. */
  function applyGrade(g, k) {
    state.grade = g;
    if (!gradePass) return;
    const u = gradePass.uniforms;
    u.uSaturation.value = g.sat;
    u.uTemperature.value = g.temp;
    u.uContrast.value = g.contrast;
    u.uVignette.value = g.vignette;
    u.uGrain.value = g.grain;
    u.uHalation.value = g.halation;
    u.uLift.value.set(g.lift[0], g.lift[1], g.lift[2]);
    u.uGain.value.set(g.gain[0], g.gain[1], g.gain[2]);
    if (bloom) bloom.strength = g.bloom;
  }

  await buildComposer();

  const tmp = new THREE.Vector3();

  return {
    get tier() { return tier; },
    get composer() { return composer; },
    environment: env,

    /** Плавный переход грейда: сцена сама зовёт это на смене фазы. */
    setGrade(phase, ms) {
      const to = gradeFor(phase);
      if (!gradePass || !ms) { applyGrade(to, 1); return; }
      state.gradeMix = { from: state.grade, to, t: 0, ms: ms };
    },

    /** На кого наводим резкость. Передайте Object3D или null. */
    focusOn(obj) { state.focusTarget = obj || null; },

    /** Сменить уровень качества на ходу (настройки игрока). */
    async setTier(next) {
      if (next === tier) return;
      tier = next;
      state.tier = next;
      await buildComposer();
    },

    resize(w, h) {
      W = Math.max(2, Math.round(w));
      H = Math.max(2, Math.round(h));
      if (composer) composer.setSize(W, H);
      if (gtao) gtao.setSize(W, H);
      if (bloom) bloom.setSize(W, H);
      if (gradePass) gradePass.uniforms.uResolution.value.set(W, H);
      if (aaPass && aaPass.material && aaPass.material.uniforms && aaPass.material.uniforms.resolution) {
        aaPass.material.uniforms.resolution.value.set(1 / W, 1 / H);
      }
      if (aaPass && aaPass.setSize) aaPass.setSize(W, H);
    },

    /** Один кадр. dt — миллисекунды с прошлого кадра. */
    render(dt) {
      const d = Math.min(64, dt || 16);
      state.time += d / 1000;

      if (state.gradeMix) {
        const m = state.gradeMix;
        m.t = Math.min(1, m.t + d / m.ms);
        const e = m.t * m.t * (3 - 2 * m.t);
        const mix = (a, b) => a + (b - a) * e;
        applyGrade({
          sat: mix(m.from.sat, m.to.sat),
          temp: mix(m.from.temp, m.to.temp),
          contrast: mix(m.from.contrast, m.to.contrast),
          vignette: mix(m.from.vignette, m.to.vignette),
          grain: mix(m.from.grain, m.to.grain),
          halation: mix(m.from.halation, m.to.halation),
          bloom: mix(m.from.bloom, m.to.bloom),
          dof: mix(m.from.dof, m.to.dof),
          lift: [0, 1, 2].map(i => mix(m.from.lift[i], m.to.lift[i])),
          gain: [0, 1, 2].map(i => mix(m.from.gain[i], m.to.gain[i]))
        }, 1);
        if (m.t >= 1) state.gradeMix = null;
      }

      if (gradePass) gradePass.uniforms.uTime.value = state.time;

      /* Резкость идёт за говорящим не мгновенно: объектив тоже «догоняет». */
      if (bokeh) {
        let want = state.focus;
        if (state.focusTarget) {
          state.focusTarget.getWorldPosition(tmp);
          want = camera.position.distanceTo(tmp);
        }
        state.focus += (want - state.focus) * Math.min(1, d / 420);
        bokeh.uniforms.focus.value = state.focus;
        /* Глубина резкости завязана на фазу: ночью она уже — кадр держит
           одно лицо, днём шире — стол должен читаться целиком. */
        bokeh.uniforms.aperture.value = 0.00075 * (state.grade.dof || 0.6);
        bokeh.uniforms.maxblur.value = 0.0042 * (state.grade.dof || 0.6);
      }

      if (composer) composer.render(d / 1000);
      else renderer.render(scene, camera);
    },

    dispose() {
      disposeComposer();
      if (env) env.dispose();
      if (scene.environment === env) scene.environment = null;
    }
  };
}

/* -------------------------------------------------------------------------
   АВТОЗАМЕР

   Гадать по navigator.hardwareConcurrency можно, но это гадание: один и тот
   же процессор в телефоне и в ноутбуке ведёт себя по-разному. Здесь замер:
   сцена секунду рисуется как есть, считаются кадры, и по ним выбирается
   уровень. Дальше игрок может переключить руками в настройках.
   ------------------------------------------------------------------------- */
export function measureTier(sampleMs) {
  return new Promise(resolve => {
    const until = performance.now() + (sampleMs || 900);
    let frames = 0, start = performance.now();
    function step(t) {
      frames++;
      if (t < until) requestAnimationFrame(step);
      else {
        const fps = frames / ((performance.now() - start) / 1000);
        resolve(fps >= 55 ? 'cinema' : fps >= 32 ? 'balance' : 'light');
      }
    }
    requestAnimationFrame(step);
  });
}

export default createPipeline;
