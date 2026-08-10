/* =============================================================================
   human.js — человек за столом.

   ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ

   До него люди на сцене собирались из примитивов: череп — сфера, продавленная
   функцией skullShape(), шея — цилиндр, руки — две трубы, волосы — плоские
   полоски. Такой подход даёт узнаваемый силуэт и упирается в потолок сразу за
   ним. На крупном плане было видно ровно то, на что жаловался игрок: рта нет,
   нос клином, шея не соединена с плечами, из воротника торчат осколки, и
   фигура не сидит на стуле, а висит рядом.

   Здесь пайплайн другой, и он держится на трёх решениях.

   1. СКЕЛЕТ И СКИННИНГ. Тело — один SkinnedMesh на скелете с именами костей
      как в Mixamo (Hips, Spine, Spine1, Spine2, Neck, Head, LeftArm…). Кости
      расставляются по анатомическим точкам сидящего человека, и сетка
      привязывается к ним весами. Из-за этого локоть гнётся, а не заламывается,
      корпус дышит и наклоняется целиком, голова доворачивается вместе с шеей.
      Кисть больше не «висит»: положение запястья вычисляется от края стола, а
      не подбирается на глаз.

   2. ЛИЦО ПОЛЕМ, А НЕ ПРИМИТИВАМИ. Голова — лофт по станциям от макушки до
      основания шеи, поверх которого работает набор аналитических полей:
      надбровье, глазницы, скулы, спинка носа, крылья, ноздри, фильтрум, обе
      губы со швом между ними, уголки рта, подбородочная борозда, угол
      челюсти, висок. Каждое поле — это «сдвинь поверхность вот здесь вот
      настолько», и все они складываются. Мимика получается бесплатно: те же
      поля с другими параметрами дают морф-таргеты (jawOpen, mouthSmile,
      browInnerUp, eyeSquint и ещё пять).

   3. ТЕКСТУРЫ ИЗ ТОЙ ЖЕ МАТЕМАТИКИ. Карта лица считается не «на глазок в
      фотошопе», а прогоном тех же полей по (u,v): для каждого пикселя мы
      знаем, попал он в бровь, в губу, в глазницу или в щёку. Поэтому бровь
      лежит на надбровье, а не в двух сантиметрах над ним. Отсюда albedo,
      roughness и карта нормалей с порами.

   Материал кожи — MeshPhysicalMaterial с картами, тонким clearcoat на
   T-зоне, sheen вместо «пластика» и дешёвой подстановкой подповерхностного
   рассеивания: в шейдер дописан wrap-diffuse с красным сдвигом, из-за
   которого свет «протекает» сквозь ухо и крыло носа, как у живого человека.

   Модуль ничего не знает про игру. На вход — цвет пиджака, тип головного
   убора, семя и настройки; на выходе — группа с тем же контрактом userData,
   что был раньше (animate/lookAt/talk/materials), чтобы обе сцены — партия с
   ботами и сетевой стол — получили новых людей без правок.
   ============================================================================= */

export function createHuman(THREE, deps) {
  const D = deps || {};
  const METRICS = D.METRICS || {
    seatTopY: 0.47, hipY: 0.525, chestY: 0.978, headY: 1.217, crownY: 1.324,
    tableSurfaceY: 0.80, seatGap: 0.21, seatPitch: 0.86
  };
  const LOWQ = !!D.LOWQ;
  const TIER = D.TIER || (LOWQ ? 'low' : 'high');
  const sg = D.sg || ((hi, lo) => (LOWQ ? lo : hi));
  const SRGB = THREE.SRGBColorSpace;

  /* --------------------------------------------------------------------------
     МЕЛКАЯ МАТЕМАТИКА

     Всё лицо строится на двух функциях: «мягкий шар влияния» и «мягкая
     колбаса влияния». Первая делает бугор или ямку, вторая — валик вдоль
     отрезка. Из них собираются надбровье, нос, губы, желвак челюсти — всё.
     -------------------------------------------------------------------------- */
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };
  const smoother = t => { t = clamp01(t); return t * t * t * (t * (6 * t - 15) + 10); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function prng(seed) {
    let s = (Math.floor(seed) >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /** Мягкий шар: 1 в центре, 0 на радиусе. Кубическое затухание — без изломов. */
  function ball(px, py, pz, cx, cy, cz, r) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= r) return 0;
    const k = 1 - d / r;
    return k * k * (3 - 2 * k);
  }

  /** Ближайшая точка на отрезке — нужна и для влияния, и для направления сдвига. */
  const _q = { x: 0, y: 0, z: 0, t: 0 };
  function onSeg(px, py, pz, ax, ay, az, bx, by, bz) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const L2 = ux * ux + uy * uy + uz * uz || 1e-9;
    let t = ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    _q.x = ax + ux * t; _q.y = ay + uy * t; _q.z = az + uz * t; _q.t = t;
    return _q;
  }

  /** Мягкая колбаса вдоль отрезка. */
  function tubeK(px, py, pz, ax, ay, az, bx, by, bz, r) {
    const q = onSeg(px, py, pz, ax, ay, az, bx, by, bz);
    const dx = px - q.x, dy = py - q.y, dz = pz - q.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= r) return 0;
    const k = 1 - d / r;
    return k * k * (3 - 2 * k);
  }

  /** Катмулл-Ром по массиву чисел: гладкая интерполяция таблицы станций. */
  function spline(arr, t) {
    const n = arr.length - 1;
    const x = clamp01(t) * n;
    const i = Math.min(n - 1, Math.floor(x));
    const f = x - i;
    const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n, i + 2)];
    const f2 = f * f, f3 = f2 * f;
    return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
  }

  /* ==========================================================================
     ЧАСТЬ 1 · ГОЛОВА

     Череп задан таблицей станций: высота, полуширина, полуглубина и сдвиг
     центра сечения назад. Числа в метрах и от центра черепа, потому что все
     дальнейшие поля лица считаются в этой же системе и должны сходиться с
     геометрией до миллиметра.
     ========================================================================== */

  /* y, rx, rz, zc — от макушки до основания шеи. */
  const SKULL = [
    [0.1035, 0.0150, 0.0158, -0.0072],
    [0.0980, 0.0310, 0.0335, -0.0058],
    [0.0925, 0.0455, 0.0505, -0.0052],
    [0.0840, 0.0570, 0.0648, -0.0046],
    [0.0720, 0.0648, 0.0752, -0.0036],
    [0.0570, 0.0692, 0.0828, -0.0024],
    [0.0400, 0.0710, 0.0876, -0.0012],
    [0.0230, 0.0716, 0.0884, -0.0002],
    [0.0060, 0.0714, 0.0892, 0.0000],
    [-0.0110, 0.0706, 0.0886, -0.0006],
    [-0.0280, 0.0694, 0.0892, -0.0014],
    [-0.0450, 0.0674, 0.0870, -0.0026],
    [-0.0620, 0.0644, 0.0832, -0.0042],
    [-0.0790, 0.0602, 0.0782, -0.0062],
    [-0.0950, 0.0548, 0.0722, -0.0090],
    [-0.1090, 0.0480, 0.0648, -0.0130],
    [-0.1210, 0.0398, 0.0552, -0.0186],
    [-0.1310, 0.0338, 0.0446, -0.0246],
    [-0.1450, 0.0302, 0.0338, -0.0300],
    [-0.1650, 0.0288, 0.0322, -0.0312]
  ];

  const SK_Y = SKULL.map(s => s[0]);
  const SK_RX = SKULL.map(s => s[1]);
  const SK_RZ = SKULL.map(s => s[2]);
  const SK_ZC = SKULL.map(s => s[3]);

  /** Точка базового черепа до полей лица. v: 0 макушка → 1 основание шеи. */
  function skullBase(v, theta, out) {
    const y = spline(SK_Y, v);
    const rx = spline(SK_RX, v);
    const rz = spline(SK_RZ, v);
    const zc = spline(SK_ZC, v);
    const st = Math.sin(theta), ct = Math.cos(theta);
    /* Передняя половина лица площе задней: у живого черепа лоб и щёки — это
       плоскость с носом посередине, а не бок шара. Показатель < 1 по |cos|
       спрямляет фронт, не трогая затылок. */
    const front = ct > 0 ? Math.pow(ct, 0.82) : ct;
    out.x = rx * st * (1 + 0.055 * Math.max(0, ct));
    out.y = y;
    out.z = zc + rz * front;
    return out;
  }

  /* --------------------------------------------------------------------------
     ПОЛЯ ЛИЦА

     face(p, P, disp) — складывает сдвиг поверхности в точке p. P — параметры
     конкретного человека (длина носа, полнота губ, тяжесть надбровья и так
     далее) плюс коэффициенты мимики. Одна и та же функция даёт и покой, и
     каждый морф-таргет: меняются только параметры.
     -------------------------------------------------------------------------- */

  /** Параметры лица по семени. Здесь рождается непохожесть людей друг на друга. */
  function faceParams(rnd, female, age) {
    const f = female ? 1 : 0;
    return {
      female: f,
      age: age,                                  // 0 молодой … 1 пожилой
      eyeX: 0.0308 + (rnd() - 0.5) * 0.0030,     // разлёт глаз
      eyeY: 0.0075 + (rnd() - 0.5) * 0.0028,
      eyeR: 0.0270 + (rnd() - 0.5) * 0.0022,     // размер глазницы
      brow: (0.85 + rnd() * 0.45) * (1 - f * 0.30),   // тяжесть надбровья
      browY: 0.0250 + (rnd() - 0.5) * 0.0040 + f * 0.0030,
      noseLen: 0.86 + rnd() * 0.26,              // длина спинки носа
      noseW: (0.90 + rnd() * 0.30) * (1 - f * 0.10),
      noseTip: 0.85 + rnd() * 0.40,              // насколько выражен кончик
      noseHook: (rnd() - 0.45) * 0.010,          // горбинка/курносость
      lip: (0.88 + rnd() * 0.28) * (1 + f * 0.16) * (1 - age * 0.18),
      lipW: 0.0232 + (rnd() - 0.5) * 0.0034,
      mouthY: -0.0620 + (rnd() - 0.5) * 0.0040,
      chin: (0.85 + rnd() * 0.42) * (1 - f * 0.16),
      chinCleft: rnd() < 0.22 ? 0.6 + rnd() * 0.5 : 0,
      jaw: (0.85 + rnd() * 0.45) * (1 - f * 0.34),
      cheek: 0.85 + rnd() * 0.45 + f * 0.10,     // полнота щёк
      zygo: 0.85 + rnd() * 0.42,                 // скулы
      nasolab: 0.5 + age * 0.9 + rnd() * 0.4,    // складка от носа к углу рта
      /* мимика — сюда пишут морф-таргеты */
      jawOpen: 0, smile: 0, frown: 0, pucker: 0,
      browInner: 0, browDown: 0, squint: 0, puff: 0, sneer: 0, blink: 0
    };
  }

  const DISP = { x: 0, y: 0, z: 0 };

  /**
   * Сдвиг поверхности лица в точке (px,py,pz) базового черепа.
   * Пишет в DISP и возвращает его. Мгновенная функция, вызывается миллионы раз,
   * поэтому без аллокаций и без объектов.
   */
  function faceDisp(px, py, pz, P) {
    let dx = 0, dy = 0, dz = 0;
    const ax = Math.abs(px);
    const side = px >= 0 ? 1 : -1;
    /* радиальное направление «наружу» от вертикальной оси черепа */
    const rl = Math.sqrt(px * px + (pz + 0.008) * (pz + 0.008)) || 1e-6;
    const ox = px / rl, oz = (pz + 0.008) / rl;
    const front = Math.max(0, pz + 0.02);       // маска «это спереди»

    /* --- надбровье: валик от переносицы к виску --- */
    {
      const by = P.browY + P.browInner * 0.0075 - P.browDown * 0.0060;
      const k = tubeK(px, py, pz, side * 0.0500, by - 0.0020, 0.0640,
        side * 0.0055, by + 0.0055, 0.0810, 0.0205);
      const a = 0.0092 * P.brow;
      dz += k * a; dy += k * a * 0.10;
    }
    /* переносица между бровями чуть ниже надбровья */
    {
      const k = ball(px, py, pz, 0, P.browY + 0.0015, 0.0855, 0.0130);
      dz -= k * 0.0022 * P.brow;
    }

    /* --- глазница и глазная щель.

       Веки здесь не накладные меши, а сама поверхность лица. Щель —
       миндалевидное окно, которое уходит назад за глазное яблоко: яблоко
       выступает через это окно, и видно ровно столько глаза, сколько видно у
       живого человека. Мигание — морф-таргет, который выводит поверхность
       обратно вперёд. Из-за этого нет ни шва между веком и лицом, ни
       рассогласования тона: веко покрашено той же картой, что и щека. --- */
    {
      const k = ball(px, py, pz, side * P.eyeX, P.eyeY, 0.0700, P.eyeR);
      dz -= k * 0.0074;
      dx -= k * ox * 0.0018;
      /* Ключевое исправление. Копать «окно» под глаз неверно анатомически: у
         живого человека роговица стоит почти вровень с веками, а видно её
         потому, что ВЕКИ выступают вперёд и оставляют между собой щель.
         Прошлая версия рыла яму глубиной больше сантиметра, глаз оказывался
         на дне колодца — на снимке вместо глаз были две тёмные прорези.

         Теперь глазница остаётся общим углублением, щель почти не заглублена
         (полтора миллиметра, чтобы читалась линия), а верхнее и нижнее веко —
         выраженные валики. Яблоко ставится вровень с поверхностью и само
         выглядывает между валиками. */
      const exr = (px - side * P.eyeX);
      const tilt = -exr * side * 0.14;                 // внешний угол выше внутреннего
      const ex = exr / 0.0152;
      const ey = (py - P.eyeY - tilt) / 0.0060;
      const eq = Math.sqrt(ex * ex + ey * ey);
      const ap = 1 - smooth((eq - 0.34) / 0.66);
      if (ap > 0 && pz > 0.03) {
        dz -= ap * 0.0016 * (1 - P.blink);
        dz += ap * 0.0105 * P.blink;
        dy -= ap * 0.0028 * P.blink;
      }
      /* верхнее веко: валик над щелью, главный объём вокруг глаза */
      {
        const t0 = P.eyeY + 0.0062;
        const upk = tubeK(px, py, pz, side * (P.eyeX - 0.0128), t0 + 0.0022, 0.0742,
          side * (P.eyeX + 0.0132), t0 - 0.0024, 0.0694, 0.0064);
        dz += upk * 0.0072 * (1 - P.blink * 0.30);
        const lok = tubeK(px, py, pz, side * (P.eyeX - 0.0108), P.eyeY - 0.0082, 0.0744,
          side * (P.eyeX + 0.0118), P.eyeY - 0.0064, 0.0700, 0.0050);
        dz += lok * 0.0048;
      }
      /* уголки: внутренний со слёзным бугорком, внешний острый */
      {
        const ki = ball(px, py, pz, side * (P.eyeX - 0.0158), P.eyeY - 0.0024, 0.0706, 0.0048);
        dz -= ki * 0.0034;
        const ko = ball(px, py, pz, side * (P.eyeX + 0.0164), P.eyeY + 0.0026, 0.0656, 0.0044);
        dz -= ko * 0.0040;
      }
      /* складка верхнего века */
      const kf = tubeK(px, py, pz, side * (P.eyeX - 0.019), P.eyeY + 0.0115, 0.0712,
        side * (P.eyeX + 0.019), P.eyeY + 0.0085, 0.0672, 0.0055);
      dz -= kf * 0.0026;
      /* слёзная борозда под глазом */
      const kt = tubeK(px, py, pz, side * (P.eyeX - 0.014), P.eyeY - 0.0165, 0.0700,
        side * (P.eyeX + 0.017), P.eyeY - 0.0120, 0.0640, 0.0062);
      dz -= kt * 0.0021 * (0.6 + P.age * 0.8);
      /* прищур поднимает нижнее веко и собирает уголок */
      if (P.squint > 0) {
        const ks = ball(px, py, pz, side * P.eyeX, P.eyeY - 0.0125, 0.0705, 0.0165);
        dy += ks * 0.0055 * P.squint;
        dz += ks * 0.0018 * P.squint;
      }
    }

    /* --- скула --- */
    {
      const k = ball(px, py, pz, side * 0.0500, -0.0075, 0.0555, 0.0320);
      dx += k * ox * 0.0080 * P.zygo;
      dz += k * oz * 0.0080 * P.zygo;
    }
    /* --- висок: небольшая впадина, без неё голова читается как шар --- */
    {
      const k = ball(px, py, pz, side * 0.0640, 0.0400, 0.0280, 0.0270);
      dx -= k * ox * 0.0048;
      dz -= k * oz * 0.0048;
    }
    /* --- мякоть щеки --- */
    {
      const k = ball(px, py, pz, side * 0.0330, -0.0430, 0.0700, 0.0280);
      dz += k * 0.0040 * P.cheek;
      dx += k * ox * 0.0026 * P.cheek;
      if (P.puff > 0) {
        dz += k * 0.0070 * P.puff;
        dx += k * ox * 0.0075 * P.puff;
      }
    }

    /* --- нос: спинка, кончик, крылья, ноздри, подносовая площадка --- */
    {
      const nl = P.noseLen;
      const rootY = 0.0250, tipY = -0.0345 - (nl - 1) * 0.0075;
      const rootZ = 0.0840, tipZ = 0.0965 + P.noseHook * 0.4;
      /* Спинка носа задана профилем, а не «расталкиванием от оси». В первой
         версии ось спинки лежала ровно на поверхности черепа, и точки позади
         неё уезжали НАЗАД: нос получался вмятиной. Теперь высота носа —
         функция от высоты, и она всегда толкает вперёд. */
      if (py < rootY + 0.008 && py > tipY - 0.020 && pz > 0.02) {
        /* t: 0 у переносицы, 1 у кончика */
        const t = clamp01((rootY - py) / (rootY - tipY));
        /* Высота спинки. У переносицы низкая, к кончику растёт: если сделать
           её ровной, получается «клин», на который и жаловались. */
        const h = (0.0034 + 0.0082 * smoother(t * 1.02)) * P.noseTip;
        /* Полуширина: сверху 5 мм, у крыльев 11 мм. Первая версия давала
           14 мм по всей длине — отсюда «нос доской». */
        const w = (0.0050 + 0.0058 * t * t) * P.noseW;
        const kx = 1 - smooth((Math.abs(px) / w - 0.25) / 0.80);
        const ky = 1 - smooth((t - 0.92) / 0.26);
        const k = kx * ky;
        dz += k * h;
        dx += Math.sign(px || 1) * k * h * 0.22;
        /* горбинка или курносость */
        const kh = ball(px, py, pz, 0, rootY - 0.016, rootZ + 0.004, 0.0150);
        dz += kh * P.noseHook;
      }
      /* кончик */
      {
        const k = ball(px, py, pz, 0, tipY - 0.0026, tipZ - 0.0060, 0.0128 * P.noseW);
        dz += k * 0.0128 * P.noseTip;
        dy -= k * 0.0018;
      }
      /* крылья: два небольших валика по сторонам от кончика */
      {
        const k = ball(px, py, pz, side * 0.0148 * P.noseW, tipY - 0.0030, tipZ - 0.0140, 0.0108);
        dz += k * 0.0074;
        dx += k * ox * 0.0048 * P.noseW;
      }
      /* борозда, отделяющая крыло от щеки */
      {
        const k = tubeK(px, py, pz, side * 0.0210, tipY + 0.0060, tipZ - 0.0230,
          side * 0.0180, tipY - 0.0090, tipZ - 0.0210, 0.0044);
        dz -= k * 0.0034;
      }
      /* ноздря — ямка, а не дырка: на просвет всё равно не видно */
      {
        const k = ball(px, py, pz, side * 0.0098, tipY - 0.0098, tipZ - 0.0075, 0.0064);
        dz -= k * 0.0068; dy -= k * 0.0020;
      }
      /* колонка и площадка под носом */
      {
        const k = tubeK(px, py, pz, 0, tipY - 0.0105, tipZ - 0.0155, 0, tipY - 0.0035, tipZ - 0.0045, 0.0062);
        dz += k * 0.0030;
        /* подносовая площадка: без неё нос сливается с верхней губой в одну
           колбасу — это была самая заметная поломка первой версии */
        const k2 = tubeK(px, py, pz, -0.0140, tipY - 0.0125, tipZ - 0.0215,
          0.0140, tipY - 0.0125, tipZ - 0.0215, 0.0072);
        dz -= k2 * 0.0052;
      }
      if (P.sneer > 0) {
        const k = ball(px, py, pz, side * 0.0140, tipY - 0.0060, tipZ - 0.0140, 0.0160);
        dy += k * 0.0060 * P.sneer;
      }
    }

    /* --- рот: линия губ, верхняя с луком Купидона, нижняя полнее, шов между --- */
    {
      const my = P.mouthY + P.jawOpen * -0.0090 + P.frown * -0.0018;
      const mz = 0.0846;
      const hw = P.lipW * (1 + P.smile * 0.14 - P.pucker * 0.26);
      /* линия рта — дуга: к уголкам уходит назад и чуть вверх */
      const lineY = t => my + 0.052 * t * t * hw * 40 * 0.001 + P.smile * 0.0105 * Math.abs(t)
        - P.frown * 0.0075 * Math.abs(t);
      const lineZ = t => mz - 0.235 * t * t * hw * 40 * 0.001 * 1.6 - Math.abs(t) * hw * 0.28;
      /* ближайшая точка линии — ищем по восьми отрезкам */
      let bd = 1e9, bx = 0, by = 0, bz = 0, bt = 0;
      for (let i = 0; i < 8; i++) {
        const t0 = -1 + (i / 8) * 2, t1 = -1 + ((i + 1) / 8) * 2;
        const ax0 = t0 * hw, ay0 = lineY(t0), az0 = lineZ(t0);
        const bx0 = t1 * hw, by0 = lineY(t1), bz0 = lineZ(t1);
        const q = onSeg(px, py, pz, ax0, ay0, az0, bx0, by0, bz0);
        const ddx = px - q.x, ddy = py - q.y, ddz = pz - q.z;
        const dd = ddx * ddx + ddy * ddy + ddz * ddz;
        if (dd < bd) { bd = dd; bx = q.x; by = q.y; bz = q.z; bt = t0 + (t1 - t0) * q.t; }
      }
      const d = Math.sqrt(bd);
      const above = py > by;
      const taper = 1 - smooth((Math.abs(bt) - 0.55) / 0.45) * 0.75;   // к уголкам губа тоньше
      if (above) {
        /* верхняя губа: лук Купидона — два бугорка по сторонам от жёлобка */
        const bow = 1 - 0.42 * Math.exp(-(bt * bt) / 0.010) + 0.22 * Math.exp(-((Math.abs(bt) - 0.30) ** 2) / 0.020);
        const r = 0.0104 * P.lip * taper;
        if (d < r) {
          let k = 1 - d / r; k = k * k * (3 - 2 * k);
          dz += k * 0.0118 * P.lip * bow;
          dy += k * 0.0010;
        }
      } else {
        const r = 0.0124 * P.lip * taper;
        if (d < r) {
          let k = 1 - d / r; k = k * k * (3 - 2 * k);
          const full = 1 - 0.28 * smooth((Math.abs(bt) - 0.35) / 0.65);
          dz += k * 0.0132 * P.lip * full;
          dy -= k * 0.0008;
        }
      }
      /* шов: узкая борозда точно по линии — из-за неё губы читаются как две */
      if (d < 0.0042) {
        let k = 1 - d / 0.0042; k = k * k * (3 - 2 * k);
        dz -= k * 0.0058 * (1 - P.jawOpen * 0.55);
      }
      /* кайма губы: узкая канавка по внешнему краю вермилиона, из-за которой
         губа перестаёт быть «валиком» и становится губой */
      {
        const rim = 0.0122 * P.lip;
        const dd = Math.abs(d - rim);
        if (dd < 0.0026) {
          let k = 1 - dd / 0.0026; k = k * k * (3 - 2 * k);
          dz -= k * 0.0022;
        }
      }
      /* уголки: маленькие ямки, иначе рот выглядит нарисованным */
      {
        const k = ball(px, py, pz, side * hw * 1.02, lineY(side) - 0.0008, lineZ(1) - 0.0020, 0.0072);
        dz -= k * 0.0042;
        if (P.smile > 0) { dy += k * 0.0090 * P.smile; dx += k * ox * 0.0050 * P.smile; }
        if (P.frown > 0) { dy -= k * 0.0075 * P.frown; }
      }
      if (P.pucker > 0) {
        const k = ball(px, py, pz, 0, my, mz + 0.002, 0.0240);
        dz += k * 0.0075 * P.pucker;
        dx -= k * px * 0.28 * P.pucker;
      }
      /* фильтрум: жёлобок от носа к верхней губе */
      {
        const k = tubeK(px, py, pz, 0, my + 0.0175, mz + 0.0020, 0, my + 0.0065, mz + 0.0035, 0.0052);
        dz -= k * 0.0030;
      }
      /* носогубная складка */
      {
        const k = tubeK(px, py, pz, side * 0.0178, -0.0400, 0.0808,
          side * (hw + 0.0055), my + 0.0020, mz - 0.0130, 0.0062);
        dz -= k * 0.0030 * P.nasolab;
      }
    }

    /* --- подбородок и борозда над ним --- */
    {
      /* Подбородок. В профиле именно он отличает человека от обезьяны: без
         выступа линия от нижней губы уходит прямо назад в шею. */
      const k = ball(px, py, pz, 0, -0.1000 - P.jawOpen * 0.006, 0.0680, 0.0300);
      dz += k * 0.0230 * P.chin;
      dy -= k * 0.0030;
      const k2 = ball(px, py, pz, 0, -0.1120, 0.0560, 0.0230);
      dz += k2 * 0.0130 * P.chin;
      if (P.chinCleft) {
        const kc = tubeK(px, py, pz, 0, -0.0870, 0.0790, 0, -0.1005, 0.0740, 0.0048);
        dz -= kc * 0.0026 * P.chinCleft;
      }
      const ks = tubeK(px, py, pz, -0.0130, -0.0790, 0.0800, 0.0130, -0.0790, 0.0800, 0.0105);
      dz -= ks * 0.0042;
    }
    /* --- угол челюсти и линия от него к подбородку --- */
    {
      const k = ball(px, py, pz, side * 0.0520, -0.0730, 0.0060, 0.0250);
      dx += k * ox * 0.0104 * P.jaw;
      dz += k * oz * 0.0104 * P.jaw;
      const kl = tubeK(px, py, pz, side * 0.0505, -0.0760, 0.0050, 0, -0.0985, 0.0620, 0.0105);
      dx += kl * ox * 0.0060 * P.jaw;
      dz += kl * oz * 0.0060 * P.jaw;
      dy -= kl * 0.0020;
    }
    /* --- лоб: бугры и плоскость между ними --- */
    {
      const k = ball(px, py, pz, side * 0.0225, 0.0510, 0.0855, 0.0230);
      dz += k * 0.0026;
      const kf = ball(px, py, pz, 0, 0.0490, 0.0890, 0.0155);
      dz -= kf * 0.0016;
      if (P.age > 0.35) {
        for (let i = 0; i < 2; i++) {
          const yy = 0.0400 + i * 0.0135;
          const kw = tubeK(px, py, pz, -0.0300, yy, 0.0800, 0.0300, yy, 0.0800, 0.0032);
          dz -= kw * 0.0012 * (P.age - 0.35);
        }
      }
    }
    /* --- затылок: небольшая выпуклость, иначе голова сзади плоская --- */
    {
      const k = ball(px, py, pz, 0, 0.0080, -0.0870, 0.0420);
      dz -= k * 0.0032;
    }
    /* --- челюсть открывается: всё ниже линии рта поворачивается вокруг сустава --- */
    if (P.jawOpen > 0) {
      const w = smooth((P.mouthY + 0.012 - py) / 0.030);
      if (w > 0) {
        const a = P.jawOpen * 0.30 * w;
        const cy = -0.0180, cz = -0.0250;
        const ry = py - cy, rz = pz - cz;
        const ca = Math.cos(a), sa = Math.sin(a);
        dy += (ry * ca - rz * sa) - ry;
        dz += (ry * sa + rz * ca) - rz;
      }
    }
    /* спереди подбородок и губы двигаются свободнее, сзади — нет */
    void front; void ax;
    DISP.x = dx; DISP.y = dy; DISP.z = dz;
    return DISP;
  }

  /* --------------------------------------------------------------------------
     ГЕОМЕТРИЯ ГОЛОВЫ
     -------------------------------------------------------------------------- */
  const HEAD_RES = { seg: sg(96, 44), rows: sg(72, 34) };

  const MORPHS = [
    { name: 'jawOpen', set: P => { P.jawOpen = 1; } },
    { name: 'mouthSmile', set: P => { P.smile = 1; } },
    { name: 'mouthFrown', set: P => { P.frown = 1; } },
    { name: 'mouthPucker', set: P => { P.pucker = 1; } },
    { name: 'browInnerUp', set: P => { P.browInner = 1; } },
    { name: 'browDown', set: P => { P.browDown = 1; } },
    { name: 'eyeSquint', set: P => { P.squint = 1; } },
    { name: 'cheekPuff', set: P => { P.puff = 1; } },
    { name: 'noseSneer', set: P => { P.sneer = 1; } },
    { name: 'eyeBlink', set: P => { P.blink = 1; } }
  ];

  function headGeometry(P) {
    const SEG = HEAD_RES.seg, ROWS = HEAD_RES.rows;
    const vCount = (SEG + 1) * ROWS;
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const base = new Float32Array(vCount * 3);        // базовый череп: нужен морфам
    const bp = { x: 0, y: 0, z: 0 };

    /* Ряды сгущаются там, где детали: середина лица важнее макушки. */
    const vAt = j => {
      const t = j / (ROWS - 1);
      return t - 0.13 * Math.sin(Math.PI * t) * Math.cos(Math.PI * (t - 0.42));
    };

    for (let j = 0; j < ROWS; j++) {
      const v = clamp01(vAt(j));
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        /* theta = 0 смотрит вперёд (+Z); u = 0.5 — центр лица в текстуре */
        const theta = (u - 0.5) * Math.PI * 2;
        skullBase(v, theta, bp);
        const o = (j * (SEG + 1) + i);
        base[o * 3] = bp.x; base[o * 3 + 1] = bp.y; base[o * 3 + 2] = bp.z;
        const d = faceDisp(bp.x, bp.y, bp.z, P);
        pos[o * 3] = bp.x + d.x;
        pos[o * 3 + 1] = bp.y + d.y;
        pos[o * 3 + 2] = bp.z + d.z;
        uv[o * 2] = u; uv[o * 2 + 1] = 1 - v;
      }
    }

    const idx = [];
    for (let j = 0; j < ROWS - 1; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * (SEG + 1) + i, b = a + 1, c = a + SEG + 1, dd = c + 1;
        idx.push(a, c, b, b, c, dd);
      }
    }
    /* Макушка закрывается веером в полюс, низ шеи — диском (он внутри воротника). */
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();

    /* Морфы считаем тем же полем — регистрация с покоем гарантирована. */
    const morphAttrs = [];
    const morphNames = {};
    for (let m = 0; m < MORPHS.length; m++) {
      const Q = Object.assign({}, P);
      MORPHS[m].set(Q);
      const mp = new Float32Array(vCount * 3);
      for (let o = 0; o < vCount; o++) {
        const bx = base[o * 3], by = base[o * 3 + 1], bz = base[o * 3 + 2];
        const d = faceDisp(bx, by, bz, Q);
        mp[o * 3] = bx + d.x; mp[o * 3 + 1] = by + d.y; mp[o * 3 + 2] = bz + d.z;
      }
      morphAttrs.push(new THREE.BufferAttribute(mp, 3));
      morphNames[MORPHS[m].name] = m;
    }
    g.morphAttributes.position = morphAttrs;
    g.userData.morphNames = morphNames;
    g.userData.base = base;
    return g;
  }

  /* ==========================================================================
     ЧАСТЬ 2 · КАРТЫ ЛИЦА

     Маски считаются один раз на весь сайт и лежат в кэше: они зависят только
     от параметрии (u,v), а не от человека. Дальше каждый человек получает свою
     albedo — тем же набором масок, но со своими цветами кожи, волос и румянца.
     ========================================================================== */
  const TEX = sg(1024, 512);
  let MASKS = null;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Гладкий шум-фрактал: пятна кожи, поры, неровность бритья. */
  function valueNoise(seed) {
    const r = prng(seed);
    const N = 256;
    const tab = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) tab[i] = r();
    return function (x, y) {
      x = ((x % N) + N) % N; y = ((y % N) + N) % N;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = smooth(x - x0), fy = smooth(y - y0);
      const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
      const a = tab[y0 * N + x0], b = tab[y0 * N + x1];
      const c = tab[y1 * N + x0], d = tab[y1 * N + x1];
      return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
    };
  }

  function buildMasks() {
    if (MASKS) return MASKS;
    const W = TEX, H = TEX;
    const P = faceParams(prng(7), false, 0.35);
    const bp = { x: 0, y: 0, z: 0 };

    const lips = new Float32Array(W * H);
    const brow = new Float32Array(W * H);
    const beard = new Float32Array(W * H);
    const blush = new Float32Array(W * H);
    const shade = new Float32Array(W * H);
    const shine = new Float32Array(W * H);
    const bump = new Float32Array(W * H);
    const noise = valueNoise(31);
    const fine = valueNoise(97);

    /* Ряд j канваса соответствует uv.y = 1 - j/(H-1) (three переворачивает
       картинку), а геометрия пишет uv.y = 1 - v. Значит станция v равна
       j/(H-1) — если перепутать, борода уезжает на лоб, а брови на кадык.
       В первой версии было перепутано, и лицо разъезжалось с картой. */
    for (let j = 0; j < H; j++) {
      const v = clamp01(j / (H - 1));
      for (let i = 0; i < W; i++) {
        const u = i / (W - 1);
        const theta = (u - 0.5) * Math.PI * 2;
        skullBase(v, theta, bp);
        const x = bp.x, y = bp.y, z = bp.z;
        const o = j * W + i;
        const side = x >= 0 ? 1 : -1;
        const ax = Math.abs(x);
        const facing = Math.max(0, Math.cos(theta));

        /* губы: та же дуга, что в геометрии */
        {
          const my = P.mouthY, hw = P.lipW, mz = 0.0846;
          let bd = 1e9, byy = 0;
          for (let k = 0; k <= 10; k++) {
            const t = -1 + (k / 10) * 2;
            const lx = t * hw;
            const ly = my + P.smile * 0 + 0.0021 * t * t * 40;
            const lz = mz - 0.0150 * t * t - Math.abs(t) * hw * 0.28;
            const dd = (x - lx) ** 2 + (y - ly) ** 2 + (z - lz) ** 2;
            if (dd < bd) { bd = dd; byy = ly; }
          }
          const d = Math.sqrt(bd);
          const rr = y > byy ? 0.0118 : 0.0140;
          lips[o] = 1 - smooth((d - rr * 0.55) / (rr * 0.55));
        }
        /* бровь: чуть выше и шире валика надбровья */
        {
          const k = tubeK(x, y, z, side * 0.0470, P.browY + 0.0035, 0.0665,
            side * 0.0075, P.browY + 0.0110, 0.0805, 0.0130);
          let s = k;
          /* рваный край: бровь не полоска скотча */
          s *= 0.80 + 0.40 * noise(u * 160, v * 160);
          brow[o] = clamp01((s - 0.16) / 0.5) * facing;
        }
        /* область бороды: подбородок, над губой, вдоль челюсти */
        {
          let s = 0;
          s = Math.max(s, ball(x, y, z, 0, -0.0900, 0.0720, 0.0420));
          s = Math.max(s, ball(x, y, z, side * 0.0330, -0.0760, 0.0620, 0.0330));
          s = Math.max(s, ball(x, y, z, side * 0.0470, -0.0640, 0.0230, 0.0300));
          s = Math.max(s, ball(x, y, z, side * 0.0140, -0.0520, 0.0840, 0.0180) * 0.9);
          /* внутрь губ борода не заходит */
          s *= 1 - clamp01(lips[o] * 1.6);
          beard[o] = clamp01(s) * (0.66 + 0.55 * fine(u * 190, v * 190));
        }
        /* румянец: щёки, крылья носа, уши, подбородок */
        {
          let s = ball(x, y, z, side * 0.0430, -0.0270, 0.0640, 0.0400) * 1.0;
          s += ball(x, y, z, side * 0.0160, -0.0360, 0.0900, 0.0180) * 0.7;
          s += ball(x, y, z, 0, -0.0930, 0.0700, 0.0260) * 0.35;
          s += ball(x, y, z, side * 0.0700, -0.0080, -0.0060, 0.0300) * 0.8;
          blush[o] = clamp01(s) * (0.75 + 0.5 * noise(u * 90 + 11, v * 90));
        }
        /* затенения: глазница, крыло носа, носогубная, под челюстью, за ухом */
        {
          let s = ball(x, y, z, side * P.eyeX, P.eyeY - 0.0035, 0.0665, 0.0250) * 0.85;
          s += tubeK(x, y, z, side * 0.0178, -0.0400, 0.0808, side * 0.0290, P.mouthY, 0.0716, 0.0075) * 0.55;
          s += tubeK(x, y, z, -0.0130, -0.0790, 0.0800, 0.0130, -0.0790, 0.0800, 0.0110) * 0.35;
          s += (1 - smooth((y + 0.0980) / 0.030)) * 0.55;                      // под челюстью
          s += ball(x, y, z, side * 0.0620, -0.0060, -0.0300, 0.0280) * 0.5;   // за ухом
          s += tubeK(x, y, z, side * (P.lipW + 0.004), P.mouthY, 0.0800, side * (P.lipW + 0.010), P.mouthY - 0.002, 0.0760, 0.0060) * 0.6;
          /* линия ресниц по верхнему краю щели: тёмная полоска, без которой
             глаз выглядит стеклянным шариком в тесте */
          s += tubeK(x, y, z, side * (P.eyeX - 0.0130), P.eyeY + 0.0058, 0.0740,
            side * (P.eyeX + 0.0130), P.eyeY + 0.0042, 0.0700, 0.0030) * 1.35;
          s += tubeK(x, y, z, side * (P.eyeX - 0.0110), P.eyeY - 0.0060, 0.0740,
            side * (P.eyeX + 0.0115), P.eyeY - 0.0048, 0.0700, 0.0022) * 0.55;
          shade[o] = clamp01(s);
        }
        /* T-зона: лоб и нос блестят, щёки матовые */
        {
          let s = ball(x, y, z, 0, 0.0480, 0.0880, 0.0420) * 0.9;
          s += tubeK(x, y, z, 0, 0.0250, 0.0860, 0, -0.0350, 0.0960, 0.0150) * 1.0;
          s += ball(x, y, z, 0, -0.0930, 0.0720, 0.0180) * 0.4;
          shine[o] = clamp01(s);
        }
        /* рельеф: поры, морщинки, шов губ, край века */
        {
          let b = 0.5;
          b += (fine(u * 340, v * 340) - 0.5) * 0.22 * (0.4 + facing * 0.6);
          b += (noise(u * 110, v * 110) - 0.5) * 0.10;
          b -= tubeK(x, y, z, -0.024, P.mouthY, 0.0830, 0.024, P.mouthY, 0.0830, 0.0035) * 0.35;
          b += lips[o] * 0.06;
          b -= ball(x, y, z, side * 0.0098, -0.0450, 0.0880, 0.0060) * 0.3;
          for (let k = 0; k < 3; k++) {
            const yy = -0.0300 - k * 0.0060;
            b -= tubeK(x, y, z, side * 0.0400, yy, 0.0640, side * 0.0480, yy + 0.004, 0.0480, 0.0022) * 0.10;
          }
          bump[o] = clamp01(b);
        }
        void ax;
      }
    }
    MASKS = { W, H, lips, brow, beard, blush, shade, shine, bump };
    MASKS.normal = normalFromBump(bump, W, H, 5.0);
    MASKS.roughTex = null;
    return MASKS;
  }

  /** Карта нормалей из карты высот: Собель по двум осям. */
  function normalFromBump(bump, W, H, strength) {
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const at = (x, y) => bump[((y + H) % H) * W + ((x + W) % W)];
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const dx = (at(i + 1, j) - at(i - 1, j)) * strength;
        const dy = (at(i, j + 1) - at(i, j - 1)) * strength;
        /* nz задаёт «крутизну» карты. Первая версия ставила здесь 1/16 —
           нормали ложились почти в касательную плоскость, освещение теряло
           связь с геометрией, и всё лицо превращалось в наждачную бумагу без
           формы. Правильное значение — единица, а силу рельефа даёт strength. */
        let nx = -dx, ny = -dy, nz = 1;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const o = (j * W + i) * 4;
        d[o] = (nx * 0.5 + 0.5) * 255;
        d[o + 1] = (ny * 0.5 + 0.5) * 255;
        d[o + 2] = (nz * 0.5 + 0.5) * 255;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }

  /** Albedo и roughness конкретного человека из общих масок. */
  function faceTextures(skin, hair, lipHue, seed, female, age) {
    const M = buildMasks();
    const W = M.W, H = M.H;
    const cA = makeCanvas(W, H), gA = cA.getContext('2d');
    const cR = makeCanvas(W, H), gR = cR.getContext('2d');
    const iA = gA.createImageData(W, H), dA = iA.data;
    const iR = gR.createImageData(W, H), dR = iR.data;

    const rnd = prng(seed * 7919 + 13);
    const spots = valueNoise(seed * 31 + 5);
    const base = new THREE.Color(skin);
    const deep = base.clone().multiplyScalar(0.62).lerp(new THREE.Color(0x8a2f28), 0.30);
    const lipC = new THREE.Color(lipHue);
    const hairC = new THREE.Color(hair);
    const blushC = base.clone().lerp(new THREE.Color(0xc4564a), 0.34);
    const freck = 0.25 + rnd() * 0.5;

    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const o = j * W + i;
        const u = i / W, v = j / H;
        let r = base.r, g2 = base.g, b = base.b;
        /* неровность тона: живая кожа не заливка */
        const n = spots(u * 46, v * 46) - 0.5;
        const n2 = spots(u * 14 + 7, v * 14) - 0.5;
        const k = 1 + n * 0.055 + n2 * 0.085;
        r *= k; g2 *= k * 0.995; b *= k * 0.985;
        /* веснушки и пигмент */
        const fr = Math.max(0, spots(u * 120 + 3, v * 120) - 0.80) * freck * 2.2;
        r = lerp(r, r * 0.72, fr); g2 = lerp(g2, g2 * 0.62, fr); b = lerp(b, b * 0.58, fr);
        /* румянец */
        const bl = M.blush[o] * (0.30 + (female ? 0.22 : 0.06));
        r = lerp(r, blushC.r, bl); g2 = lerp(g2, blushC.g, bl); b = lerp(b, blushC.b, bl);
        /* затенения */
        const sh = M.shade[o];
        const shk = 1 - sh * 0.42;
        r *= shk; g2 *= shk * 0.97; b *= shk * 0.95;
        /* борода/щетина */
        if (!female) {
          const bd = M.beard[o] * (0.30 + rnd() * 0);
          if (bd > 0.01) {
            const t = clamp01(bd * 0.85);
            r = lerp(r, hairC.r * 0.75 + r * 0.25, t);
            g2 = lerp(g2, hairC.g * 0.75 + g2 * 0.25, t);
            b = lerp(b, hairC.b * 0.75 + b * 0.25, t);
          }
        }
        /* губы */
        const lp = M.lips[o];
        if (lp > 0.01) {
          const t = clamp01(lp * (female ? 1.0 : 0.86));
          r = lerp(r, lipC.r, t * 0.85); g2 = lerp(g2, lipC.g, t * 0.85); b = lerp(b, lipC.b, t * 0.85);
        }
        /* бровь */
        const br = M.brow[o];
        if (br > 0.01) {
          const t = clamp01(br * 1.15);
          r = lerp(r, hairC.r * 0.9, t); g2 = lerp(g2, hairC.g * 0.9, t); b = lerp(b, hairC.b * 0.9, t);
        }
        /* возраст: тон глуше и чуть желтее */
        if (age > 0.3) {
          const t = (age - 0.3) * 0.5;
          r = lerp(r, deep.r * 1.25, t * 0.3); g2 = lerp(g2, deep.g * 1.3, t * 0.25);
        }
        const oo = o * 4;
        dA[oo] = clamp01(r) * 255; dA[oo + 1] = clamp01(g2) * 255; dA[oo + 2] = clamp01(b) * 255; dA[oo + 3] = 255;

        /* roughness: T-зона глянцевее, губы влажные, щетина матовая */
        let rough = 0.60 - M.shine[o] * 0.26 + M.shade[o] * 0.06;
        rough -= lp * 0.26;
        rough += (female ? 0 : M.beard[o] * 0.10);
        rough += (spots(u * 80 + 21, v * 80) - 0.5) * 0.05;
        const rv = clamp01(rough) * 255;
        dR[oo] = rv; dR[oo + 1] = rv; dR[oo + 2] = rv; dR[oo + 3] = 255;
      }
    }
    gA.putImageData(iA, 0, 0);
    gR.putImageData(iR, 0, 0);
    const tA = new THREE.CanvasTexture(cA);
    tA.colorSpace = SRGB;
    tA.wrapS = THREE.RepeatWrapping;
    tA.anisotropy = 4;
    const tR = new THREE.CanvasTexture(cR);
    tR.wrapS = THREE.RepeatWrapping;
    return { albedo: tA, rough: tR, normal: M.normal };
  }

  /* --------------------------------------------------------------------------
     МАТЕРИАЛ КОЖИ

     MeshPhysicalMaterial сам по себе даёт «мытый пластик»: у кожи свет уходит
     под поверхность и выходит рядом, покраснев. Полноценный SSS в браузере
     дорог, поэтому в шейдер дописан wrap-diffuse: доля света, попавшая на
     «тень» в пределах терминатора, возвращается красным. Это тот самый
     просвет в ухе и в крыле носа, из-за которого кожа перестаёт быть камнем.
     -------------------------------------------------------------------------- */
  function skinMaterial(tex, skinColor) {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: tex.albedo,
      normalMap: tex.normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: tex.rough,
      roughness: 1,
      metalness: 0,
      clearcoat: 0.045,
      clearcoatRoughness: 0.42,
      sheen: 0.07,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(0xffd9c4)
    });
    const sss = new THREE.Color(skinColor).lerp(new THREE.Color(0xd8503c), 0.55);
    m.userData.sssColor = { value: new THREE.Vector3(sss.r, sss.g, sss.b) };
    m.userData.sssAmount = { value: 0.24 };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.sssColor = m.userData.sssColor;
      shader.uniforms.sssAmount = m.userData.sssAmount;
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec3 sssColor;\nuniform float sssAmount;\nvoid main() {')
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
          {
            /* Подповерхностное рассеивание «на бедность»: свет, попавший под
               углом больше 90°, не отсекается в нуль, а размазывается за
               терминатор и краснеет. */
            vec3 wrapLight = vec3(0.0);
            #if ( NUM_POINT_LIGHTS > 0 )
            #pragma unroll_loop_start
            for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
              {
              PointLight pl = pointLights[ i ];
              vec3 lv = pl.position - vViewPosition * -1.0;
              float dist = length( lv );
              vec3 L = lv / max( dist, 0.0001 );
              float ndl = dot( normal, L );
              float wrap = max( 0.0, ( ndl + 0.45 ) / 1.45 );
              float back = max( 0.0, wrap - max( 0.0, ndl ) );
              float att = pow( clamp( 1.0 - dist / max( pl.distance, 0.0001 ), 0.0, 1.0 ), 2.0 );
              wrapLight += pl.color * back * att;
              }
            }
            #pragma unroll_loop_end
            #endif
            #if ( NUM_SPOT_LIGHTS > 0 )
            #pragma unroll_loop_start
            for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
              {
              SpotLight sl = spotLights[ i ];
              vec3 lv = sl.position - vViewPosition * -1.0;
              float dist = length( lv );
              vec3 L = lv / max( dist, 0.0001 );
              float ndl = dot( normal, L );
              float wrap = max( 0.0, ( ndl + 0.45 ) / 1.45 );
              float back = max( 0.0, wrap - max( 0.0, ndl ) );
              float att = pow( clamp( 1.0 - dist / max( sl.distance, 0.0001 ), 0.0, 1.0 ), 2.0 );
              float sc = smoothstep( sl.coneCos, sl.penumbraCos, dot( normalize( -L ), sl.direction ) );
              wrapLight += sl.color * back * att * sc;
              }
            }
            #pragma unroll_loop_end
            #endif
            /* pl.color в шейдере уже умножен на интенсивность, а она на сцене
               доходит до тридцати. Ненормированная добавка выбивала лицо в
               белое пятно, и весь рельеф пропадал. Насыщаем вклад: сколько бы
               света ни было, кожа краснеет не больше чем на sssAmount. */
            vec3 wl = wrapLight / ( 1.0 + max( max( wrapLight.r, wrapLight.g ), wrapLight.b ) );
            diffuseColor.rgb += diffuseColor.rgb * sssColor * wl * sssAmount;
          }`
        );
    };
    m.customProgramCacheKey = () => 'mafia-skin-sss';
    return m;
  }

  /* ==========================================================================
     ЧАСТЬ 3 · ГЛАЗА

     Глаз — половина впечатления «живой». Здесь три слоя: яблоко с текстурой
     склеры и радужки, влажная роговица (clearcoat почти зеркальный), и веки
     как сферические сегменты, которые вращаются вокруг центра глаза. Мигание
     идёт не по таймеру, а по пуассоновскому потоку — паузы получаются разной
     длины, и стол перестаёт мигать в такт.
     ========================================================================== */
  const IRIS = [0x5a4a34, 0x3f5a5e, 0x4c6b46, 0x6b5334, 0x2f3f52, 0x7a5c3a, 0x3a3a3f];
  let EYE_GEO = null, LID_GEO = null, LASH_TEX = null;

  function eyeTexture(iris) {
    const S = 256;
    const c = makeCanvas(S, S), g = c.getContext('2d');
    /* Текстура на сфере: экватор — вперёд. Радужка в центре карты. */
    g.fillStyle = '#e9e3dc';
    g.fillRect(0, 0, S, S);
    /* сосуды склеры */
    const rnd = prng(iris ^ 0x9e37);
    g.lineWidth = 1;
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2, r0 = S * (0.30 + rnd() * 0.22);
      let x = S / 2 + Math.cos(a) * r0, y = S / 2 + Math.sin(a) * r0;
      g.strokeStyle = 'rgba(178,74,66,' + (0.10 + rnd() * 0.22).toFixed(2) + ')';
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += Math.cos(a + (rnd() - 0.5) * 1.5) * 7;
        y += Math.sin(a + (rnd() - 0.5) * 1.5) * 7;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    /* тень от верхнего века на яблоке */
    const sh = g.createLinearGradient(0, 0, 0, S);
    sh.addColorStop(0, 'rgba(60,40,34,0.42)');
    sh.addColorStop(0.42, 'rgba(60,40,34,0.06)');
    sh.addColorStop(1, 'rgba(60,40,34,0.0)');
    g.fillStyle = sh; g.fillRect(0, 0, S, S);

    const cx = S / 2, cy = S / 2, R = S * 0.185;
    const base = new THREE.Color(iris);
    /* радужка: волокна от зрачка к лимбу */
    const ig = g.createRadialGradient(cx, cy, R * 0.18, cx, cy, R);
    ig.addColorStop(0, '#' + base.clone().multiplyScalar(0.55).getHexString());
    ig.addColorStop(0.55, '#' + base.getHexString());
    ig.addColorStop(1, '#' + base.clone().multiplyScalar(0.62).getHexString());
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = ig; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 220; i++) {
      const a = rnd() * Math.PI * 2;
      const r1 = R * (0.22 + rnd() * 0.10), r2 = R * (0.80 + rnd() * 0.20);
      g.strokeStyle = 'rgba(' + (rnd() < 0.5 ? '255,246,230,' : '20,12,8,') + (0.05 + rnd() * 0.14).toFixed(2) + ')';
      g.lineWidth = 0.8 + rnd() * 1.2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a + (rnd() - 0.5) * 0.2) * r2, cy + Math.sin(a + (rnd() - 0.5) * 0.2) * r2);
      g.stroke();
    }
    /* воротничок радужки */
    g.strokeStyle = 'rgba(30,18,12,0.35)'; g.lineWidth = R * 0.10;
    g.beginPath(); g.arc(cx, cy, R * 0.42, 0, Math.PI * 2); g.stroke();
    g.restore();
    /* лимбальное кольцо: без него глаз выглядит наклейкой */
    g.strokeStyle = 'rgba(18,12,10,0.62)'; g.lineWidth = R * 0.13;
    g.beginPath(); g.arc(cx, cy, R * 0.965, 0, Math.PI * 2); g.stroke();
    /* зрачок */
    g.fillStyle = '#08060a';
    g.beginPath(); g.arc(cx, cy, R * 0.40, 0, Math.PI * 2); g.fill();

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = SRGB;
    return t;
  }

  function lashTexture() {
    if (LASH_TEX) return LASH_TEX;
    const W = 128, H = 64;
    const c = makeCanvas(W, H), g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const rnd = prng(4242);
    /* линия ресниц: густо у корня, врозь к концам */
    g.strokeStyle = '#0d0a0b';
    for (let i = 0; i < 150; i++) {
      const x = rnd() * W;
      const edge = 1 - Math.abs(x / W - 0.5) * 1.7;
      if (edge <= 0) continue;
      const len = H * (0.30 + rnd() * 0.45) * edge;
      g.lineWidth = 0.7 + rnd() * 0.9;
      g.globalAlpha = 0.35 + rnd() * 0.55;
      g.beginPath();
      g.moveTo(x, H);
      g.quadraticCurveTo(x + (x / W - 0.5) * 10, H - len * 0.6, x + (x / W - 0.5) * 22, H - len);
      g.stroke();
    }
    g.globalAlpha = 1;
    const grd = g.createLinearGradient(0, H, 0, H * 0.55);
    grd.addColorStop(0, 'rgba(14,10,11,0.95)');
    grd.addColorStop(1, 'rgba(14,10,11,0)');
    g.fillStyle = grd; g.fillRect(0, H * 0.55, W, H * 0.45);
    LASH_TEX = new THREE.CanvasTexture(c);
    LASH_TEX.colorSpace = SRGB;
    return LASH_TEX;
  }

  /**
   * Глаз: яблоко и влажная роговица. Веки принадлежат лицу (морф eyeBlink),
   * поэтому здесь их нет — и нет шва, из-за которого прежние веки читались
   * как приклеенные кусочки кожи другого оттенка.
   */
  function buildEye(irisHex) {
    const R = 0.0122;
    if (!EYE_GEO) EYE_GEO = new THREE.SphereGeometry(1, sg(28, 14), sg(22, 11));
    const grp = new THREE.Group();

    const ball = new THREE.Mesh(EYE_GEO, new THREE.MeshPhysicalMaterial({
      map: eyeTexture(irisHex),
      roughness: 0.28, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.035
    }));
    ball.scale.setScalar(R);
    /* Карта нарисована радужкой в центре: разворачиваем полюс вперёд. */
    ball.rotation.x = -Math.PI / 2;
    grp.add(ball);

    /* Роговица: небольшой купол над радужкой. Зеркальный блик именно из этого
       слоя читается как «влажный глаз» — без него взгляд мёртвый. */
    const cornea = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.02, sg(20, 10), sg(14, 7), 0, Math.PI * 2, 0, Math.PI * 0.34),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff, transparent: true, opacity: 0.13, roughness: 0.015,
        metalness: 0, clearcoat: 1, clearcoatRoughness: 0.01,
        depthWrite: false, side: THREE.FrontSide
      }));
    cornea.rotation.x = Math.PI / 2;
    grp.add(cornea);

    const st = { yaw: 0, pitch: 0 };
    function apply() {
      grp.rotation.y = st.yaw;
      grp.rotation.x = st.pitch;
    }
    grp.userData = {
      close() { /* мигание живёт в морфе лица */ },
      look(yaw, pitch) {
        st.yaw = Math.max(-0.42, Math.min(0.42, yaw || 0));
        st.pitch = Math.max(-0.28, Math.min(0.28, pitch || 0));
        apply();
      },
      mats: [ball.material, cornea.material]
    };
    apply();
    return grp;
  }

  /* --------------------------------------------------------------------------
     Где именно стоит глазное яблоко.

     Подбирать это число на глаз бессмысленно: поверхность лица в области щели
     зависит от десятка полей сразу. Поэтому мы честно считаем, где проходит
     поверхность в точке глаза, и садим яблоко так, чтобы роговица выступала
     ровно на полтора миллиметра. Тогда глаз не «выпучен» и не утоплен ни на
     одном лице, каким бы ни было семя.
     -------------------------------------------------------------------------- */
  function surfacePoint(P, tx, ty) {
    /* v по высоте: таблица монотонно убывает, поэтому обычный поиск делением */
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (spline(SK_Y, mid) > ty) lo = mid; else hi = mid;
    }
    const v = (lo + hi) / 2;
    /* theta по x */
    let a = 0, b = Math.PI * 0.5;
    const bp = { x: 0, y: 0, z: 0 };
    const at = th => { skullBase(v, th, bp); return bp.x; };
    const want = Math.abs(tx);
    for (let k = 0; k < 26; k++) {
      const mid = (a + b) / 2;
      if (at(mid) < want) a = mid; else b = mid;
    }
    const theta = ((a + b) / 2) * (tx < 0 ? -1 : 1);
    skullBase(v, theta, bp);
    const d = faceDisp(bp.x, bp.y, bp.z, P);
    return { x: bp.x + d.x, y: bp.y + d.y, z: bp.z + d.z };
  }

  /* ==========================================================================
     ЧАСТЬ 4 · ВОЛОСЫ

     Hair cards: изогнутые полоски с alpha-картой пряди. Прозрачность —
     хешированным дизерингом, а не alpha-test: у alpha-test край получается
     пилой, а сортировать полсотни полупрозрачных полосок на каждом кадре
     дороже, чем один discard по шуму.
     ========================================================================== */
  let HAIR_TEX = null;
  function hairTexture() {
    if (HAIR_TEX) return HAIR_TEX;
    const W = 128, H = 256;
    const c = makeCanvas(W, H), g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const rnd = prng(8181);
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W;
      const w = 0.8 + rnd() * 2.6;
      const top = rnd() * H * 0.12;
      const bot = H * (0.72 + rnd() * 0.28);
      const lum = 130 + Math.floor(rnd() * 125);
      g.strokeStyle = 'rgba(' + lum + ',' + lum + ',' + lum + ',' + (0.55 + rnd() * 0.45).toFixed(2) + ')';
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x, top);
      g.bezierCurveTo(x + (rnd() - 0.5) * 16, H * 0.35, x + (rnd() - 0.5) * 22, H * 0.7, x + (rnd() - 0.5) * 20, bot);
      g.stroke();
    }
    /* к корню прядь плотная, к концу расходится */
    const fade = g.createLinearGradient(0, H, 0, H * 0.55);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, H * 0.55, W, H * 0.45);
    g.globalCompositeOperation = 'source-over';
    HAIR_TEX = new THREE.CanvasTexture(c);
    HAIR_TEX.colorSpace = SRGB;
    return HAIR_TEX;
  }

  /** Дописывает в материал хешированный дизеринг альфы. */
  function hashedAlpha(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
        {
          float h = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          if ( diffuseColor.a < h * 0.98 + 0.01 ) discard;
          diffuseColor.a = 1.0;
        }`
      );
    };
    mat.customProgramCacheKey = () => 'mafia-hair-hashed';
  }

  /* Причёски: набор «полей», по которым раскладываются полоски.
     Каждая описана как область на черепе (диапазон theta и v) плюс длина. */
  const HAIRSTYLES = [
    { id: 'short', rows: 7, len: [0.035, 0.075], back: 0.95, cover: 1.0, part: 0.0 },
    { id: 'crop', rows: 6, len: [0.022, 0.042], back: 0.9, cover: 1.0, part: 0.0 },
    { id: 'side', rows: 7, len: [0.045, 0.095], back: 0.95, cover: 1.0, part: 0.55 },
    { id: 'wave', rows: 8, len: [0.055, 0.115], back: 1.0, cover: 1.0, part: 0.25 },
    { id: 'bun', rows: 7, len: [0.038, 0.066], back: 1.0, cover: 1.0, part: 0.1, bun: true },
    { id: 'long', rows: 9, len: [0.090, 0.235], back: 1.0, cover: 1.0, part: 0.2 },
    { id: 'braid', rows: 8, len: [0.070, 0.180], back: 1.0, cover: 1.0, part: 0.0, braid: true },
    { id: 'bald', rows: 0, len: [0, 0], back: 0, cover: 0, part: 0 }
  ];

  function buildHair(styleId, hairColor, rnd, hidden) {
    const st = HAIRSTYLES.find(s => s.id === styleId) || HAIRSTYLES[0];
    const grp = new THREE.Group();
    const strands = [];
    if (!st.rows || hidden) return { group: grp, strands, mats: [] };

    const mat = new THREE.MeshPhysicalMaterial({
      color: hairColor,
      map: hairTexture(),
      alphaMap: hairTexture(),
      transparent: false,
      roughness: 0.52, metalness: 0.02,
      sheen: 0.35, sheenRoughness: 0.40, sheenColor: new THREE.Color(hairColor).lerp(new THREE.Color(0xffffff), 0.5),
      side: THREE.DoubleSide
    });
    hashedAlpha(mat);

    const bp = { x: 0, y: 0, z: 0 };
    const perRow = sg(26, 13);
    const CARD = new THREE.PlaneGeometry(1, 1, 1, 5);

    for (let r = 0; r < st.rows; r++) {
      const vr = 0.015 + (r / st.rows) * 0.40;     // от макушки вниз по черепу
      for (let i = 0; i < perRow; i++) {
        /* Волосы не растут на лице: пропускаем передний сектор ниже линии роста. */
        const u = i / perRow;
        const theta = (u - 0.5) * Math.PI * 2;
        const frontness = Math.cos(theta);
        const hairline = 0.055 + st.part * 0.02;
        if (frontness > 0.55 && vr > hairline + 0.10) continue;
        skullBase(vr, theta, bp);
        const nx = bp.x, ny = bp.y, nz = bp.z;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

        const pivot = new THREE.Group();
        pivot.position.set(nx * 1.012, ny * 1.006, nz * 1.012);
        const len = lerp(st.len[0], st.len[1], r / Math.max(1, st.rows - 1)) * (0.8 + rnd() * 0.45);
        const wide = 0.013 + rnd() * 0.011;

        const card = new THREE.Mesh(CARD, mat);
        card.scale.set(wide, len, 1);
        card.position.set(0, -len / 2, 0);
        /* Прядь свисает по черепу. В первой версии карточки разворачивались
           «вдоль нормали» и торчали из макушки шипами — на снимке это читалось
           как ёж. Теперь ось карточки смотрит вниз по поверхности: берём
           направление «вниз по касательной» и по нему ориентируем полоску. */
        const nrm = new THREE.Vector3(nx, ny, nz).normalize();
        const down = new THREE.Vector3(0, -1, 0);
        const tang = down.clone().addScaledVector(nrm, -down.dot(nrm));
        if (tang.lengthSq() < 1e-6) tang.set(0, 0, -1);
        tang.normalize();
        const m = new THREE.Matrix4();
        /* локальный Y карточки — вниз по касательной, локальный Z — наружу */
        const bx = new THREE.Vector3().crossVectors(tang, nrm).normalize();
        m.makeBasis(bx, tang.clone().negate(), nrm);
        pivot.quaternion.setFromRotationMatrix(m);
        pivot.rotateX(-(0.10 + rnd() * 0.18));
        pivot.rotateY((rnd() - 0.5) * 0.4);
        /* изгиб полоски, чтобы она обнимала голову */
        card.geometry = CARD;
        pivot.add(card);
        grp.add(pivot);
        strands.push({ pivot, phase: rnd() * 6.28, amp: 0.02 + rnd() * 0.05, base: pivot.rotation.clone() });
        void nl;
      }
    }
    /* Пучок на затылке */
    if (st.bun) {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.030, sg(18, 9), sg(14, 7)), mat.clone());
      bun.material.alphaMap = null; bun.material.map = null;
      bun.material.color = new THREE.Color(hairColor);
      bun.material.onBeforeCompile = null;
      bun.material.customProgramCacheKey = () => 'mafia-hair-solid';
      bun.position.set(0, 0.030, -0.088);
      bun.scale.set(1, 0.85, 0.9);
      grp.add(bun);
    }
    return { group: grp, strands, mats: [mat] };
  }

  /* ==========================================================================
     ЧАСТЬ 5 · УШИ
     ========================================================================== */
  /**
   * Ухо. Тор с полусферой давал на снимке булочку с корицей, поэтому здесь
   * другая сборка: плоская раковина-овал, прижатая к черепу, завиток по краю
   * тонким валиком, углубление и мочка. На расстоянии стола этого достаточно,
   * а в упор читается как ухо, а не как спираль.
   */
  function buildEar(side, mat) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.0215, sg(18, 10), sg(16, 8)), mat);
    shell.scale.set(0.46, 1.02, 0.68);
    shell.rotation.z = -side * 0.16;
    g.add(shell);
    /* завиток: половина тонкого тора по краю раковины */
    const helix = new THREE.Mesh(
      new THREE.TorusGeometry(0.0198, 0.0024, sg(7, 4), sg(20, 10), Math.PI * 1.15), mat);
    helix.rotation.set(0, Math.PI / 2 * side, Math.PI * 0.70);
    helix.scale.set(1, 1.02, 0.62);
    helix.position.set(side * 0.0052, 0.0012, -0.0014);
    g.add(helix);
    /* углубление раковины: тёмный кратер, без него ухо выглядит лепёшкой */
    const bowl = new THREE.Mesh(
      new THREE.SphereGeometry(0.0092, sg(12, 7), sg(10, 5)), mat);
    bowl.scale.set(0.34, 1.05, 0.85);
    bowl.position.set(-side * 0.0060, -0.0010, -0.0010);
    g.add(bowl);
    /* противозавиток */
    const anti = new THREE.Mesh(
      new THREE.TorusGeometry(0.0092, 0.0018, sg(7, 4), sg(12, 6), Math.PI * 0.9), mat);
    anti.rotation.set(0, Math.PI / 2 * side, Math.PI * 0.50);
    anti.scale.set(1, 1, 0.6);
    anti.position.set(side * 0.0040, 0.0028, -0.0020);
    g.add(anti);
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.0082, sg(12, 6), sg(10, 5)), mat);
    lobe.position.set(0, -0.0182, 0.0026);
    lobe.scale.set(0.46, 1.05, 0.80);
    g.add(lobe);
    return g;
  }

  /* ==========================================================================
     ЧАСТЬ 6 · ТЕЛО

     Тело — один SkinnedMesh. Он собирается «протяжкой»: вдоль ломаной из
     станций (точка + полуоси эллипса + веса костей) катится сечение, и
     соседние сечения сшиваются в четырёхугольники. Рама сечения переносится
     параллельно — минимальным поворотом от предыдущей касательной к
     следующей. Без этого на изгибе локтя рама переворачивается и труба
     закручивается лентой Мёбиуса.

     Кости стоят по анатомическим точкам сидящего человека, а не «где
     получилось»: положение запястья считается от края стола, поэтому кисть
     всегда лежит на сукне, а не парит над ним. Дальше веса делают своё —
     плечо и локоть гнутся мясом, а не шарниром.
     ========================================================================== */

  const BONE_NAMES = [
    'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot',
    'RightUpLeg', 'RightLeg', 'RightFoot'
  ];
  const BI = {};
  BONE_NAMES.forEach((n, i) => { BI[n] = i; });
  const BONE_PARENT = {
    Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1',
    Neck: 'Spine2', Head: 'Neck',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg'
  };

  /* --------------------------------------------------------------------------
     ПОЗЫ ЗА СТОЛОМ

     Слепое сравнение вскрыло то, чего не видно в упор: важнее детализации
     лица оказалась поза. Прежняя фигура складывала руки на сукне у себя перед
     грудью и читалась компактной группой людей, склонившихся к свече. Новая
     тянула прямые руки к центру стола — анатомически честно (край стола в
     двадцати сантиметрах от корпуса, кисть достаёт до двух третей радиуса), но
     на кадре это шесть пауков.

     Поэтому позы теперь описаны явно, и все они «закрытые»: предплечья лежат
     вдоль края, кисти близко к телу, локти разведены. Так силуэт собирается,
     а не растопыривается.
     -------------------------------------------------------------------------- */
  const POSES = [
    /* 0 — руки сложены одна на другую у самого края */
    {
      wrist: s => [s * -0.044, 0.028 + (s > 0 ? 0.020 : 0), 0.010],
      elbow: s => [s * 0.188, -0.052, -0.062]
    },
    /* 1 — локти на столе, кисти сомкнуты у груди */
    {
      wrist: s => [s * 0.026, 0.086, -0.030],
      elbow: s => [s * 0.174, 0.006, 0.006]
    },
    /* 2 — предплечья вдоль края, кисти врозь */
    {
      wrist: s => [s * 0.086, 0.022, 0.014],
      elbow: s => [s * 0.192, -0.050, -0.054]
    },
    /* 3 — навалился на стол */
    {
      wrist: s => [s * 0.056, 0.030, 0.038],
      elbow: s => [s * 0.182, -0.030, -0.020]
    }
  ];

  /** Точки суставов сидящего человека. */
  function jointsFor(o) {
    const tY = o.tableY, eZ = o.edgeZ, W = o.wide, T = o.tall;
    const hipY = 0.512 * T;
    const pose = POSES[(o.pose || 0) % POSES.length];
    /* Слепое сравнение с прежней фигурой на дистанции стола показало три
       промаха новой сборки, и все три — в пропорциях, а не в детализации:
       голова мельче, шея длиннее и корпус сидит дальше от стола, из-за чего
       руки читаются как «паучьи». Числа ниже исправляют ровно это: корпус
       придвинут на 26 мм, шея укорочена, голова опущена. */
    const J = {
      Hips: [0, hipY, -0.114],
      Spine: [0, hipY + 0.096 * T, -0.126],
      Spine1: [0, hipY + 0.204 * T, -0.136],
      Spine2: [0, hipY + 0.326 * T, -0.142],
      Neck: [0, hipY + 0.458 * T, -0.132],
      Head: [0, hipY + 0.532 * T, -0.122]
    };
    for (const s of [1, -1]) {
      const p = s > 0 ? 'Left' : 'Right';
      J[p + 'Shoulder'] = [s * 0.046 * W, J.Spine2[1] + 0.096 * T, -0.138];
      J[p + 'Arm'] = [s * 0.188 * W, J.Spine2[1] + 0.080 * T, -0.142];
      /* Локоть и запястье берутся из позы. Высоты отсчитываются от сукна,
         поэтому кисть лежит на ткани при любом размере стола. */
      const el = pose.elbow(s), wr = pose.wrist(s);
      J[p + 'ForeArm'] = [el[0] * W, tY + el[1], eZ + el[2]];
      J[p + 'Hand'] = [wr[0] * W, tY + wr[1], eZ + wr[2]];
      J[p + 'UpLeg'] = [s * 0.086 * W, hipY - 0.012, -0.126];
      J[p + 'Leg'] = [s * 0.102 * W, hipY - 0.022, 0.196];
      J[p + 'Foot'] = [s * 0.104 * W, 0.080, 0.160];
    }
    return J;
  }

  function buildSkeleton(J) {
    const bones = {};
    const list = [];
    BONE_NAMES.forEach(name => {
      const b = new THREE.Bone();
      b.name = name;
      bones[name] = b;
      list.push(b);
    });
    BONE_NAMES.forEach(name => {
      const par = BONE_PARENT[name];
      const p = J[name];
      if (par) {
        const pp = J[par];
        bones[name].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
        bones[par].add(bones[name]);
      } else {
        bones[name].position.set(p[0], p[1], p[2]);
      }
    });
    return { bones, list, root: bones.Hips, skeleton: new THREE.Skeleton(list) };
  }

  /* --------------------------------------------------------------------------
     ПРОТЯЖКА С ВЕСАМИ
     -------------------------------------------------------------------------- */
  const V0 = new THREE.Vector3(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3();
  const Q0 = new THREE.Quaternion();

  /**
   * @param {Array} st станции: {p:[x,y,z], rx, rz, b:[[boneIdx,w],…], sq}
   * @param {number} seg сегментов по кругу
   * @param {object} opt {capStart, capEnd}
   */
  function sweep(st, seg, opt) {
    opt = opt || {};
    const n = st.length;
    const pos = [], nor = [], uv = [], si = [], sw = [], idx = [];

    const tan = [];
    for (let i = 0; i < n; i++) {
      const a = st[Math.max(0, i - 1)].p, b = st[Math.min(n - 1, i + 1)].p;
      V0.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (V0.lengthSq() < 1e-12) V0.set(0, 1, 0);
      tan.push(V0.clone().normalize());
    }
    let N = new THREE.Vector3(), B = new THREE.Vector3();
    {
      const t = tan[0];
      const ref = Math.abs(t.y) > 0.86 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      N.crossVectors(ref, t).normalize();
      if (N.lengthSq() < 1e-9) N.set(1, 0, 0);
      B.crossVectors(t, N).normalize();
    }
    let arc = 0;
    const arcs = [0];
    for (let i = 1; i < n; i++) {
      const a = st[i - 1].p, b = st[i].p;
      arc += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      arcs.push(arc);
    }

    for (let i = 0; i < n; i++) {
      if (i > 0) {
        Q0.setFromUnitVectors(tan[i - 1], tan[i]);
        N.applyQuaternion(Q0).normalize();
        B.crossVectors(tan[i], N).normalize();
        N.crossVectors(B, tan[i]).normalize();
      }
      const s = st[i];
      const sq = s.sq === undefined ? 1 : s.sq;
      const bw = s.b || [[0, 1]];
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        let ca = Math.cos(a), sa = Math.sin(a);
        if (sq !== 1) {
          /* Суперэллипс: 1 — круг, ниже — ближе к прямоугольнику. Нужен для
             торса, у которого сечение не бублик, а плоская фасоль. */
          ca = Math.sign(ca) * Math.pow(Math.abs(ca), sq);
          sa = Math.sign(sa) * Math.pow(Math.abs(sa), sq);
        }
        V1.copy(N).multiplyScalar(s.rx * sa);
        V2.copy(B).multiplyScalar(s.rz * ca);
        pos.push(s.p[0] + V1.x + V2.x, s.p[1] + V1.y + V2.y, s.p[2] + V1.z + V2.z);
        V0.copy(V1).divideScalar(s.rx * s.rx || 1).addScaledVector(V2, 1 / (s.rz * s.rz || 1)).normalize();
        nor.push(V0.x, V0.y, V0.z);
        uv.push(k / seg, arcs[i] / (arc || 1));
        for (let q = 0; q < 4; q++) {
          si.push(bw[q] ? bw[q][0] : 0);
          sw.push(bw[q] ? bw[q][1] : 0);
        }
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < seg; k++) {
        const a = i * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const capAt = (ring, flip) => {
      const cx = [0, 0, 0];
      for (let k = 0; k < seg; k++) {
        const o = (ring * (seg + 1) + k) * 3;
        cx[0] += pos[o]; cx[1] += pos[o + 1]; cx[2] += pos[o + 2];
      }
      cx[0] /= seg; cx[1] /= seg; cx[2] /= seg;
      const ci = pos.length / 3;
      pos.push(cx[0], cx[1], cx[2]);
      const t = tan[ring];
      nor.push(t.x * (flip ? -1 : 1), t.y * (flip ? -1 : 1), t.z * (flip ? -1 : 1));
      uv.push(0.5, ring === 0 ? 0 : 1);
      const bw = st[ring].b || [[0, 1]];
      for (let q = 0; q < 4; q++) { si.push(bw[q] ? bw[q][0] : 0); sw.push(bw[q] ? bw[q][1] : 0); }
      for (let k = 0; k < seg; k++) {
        const a = ring * (seg + 1) + k, b = a + 1;
        if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
      }
    };
    if (opt.capStart) capAt(0, true);
    if (opt.capEnd) capAt(n - 1, false);

    return { pos, nor, uv, si, sw, idx };
  }

  /** Склейка нескольких протяжек в одну геометрию с группами материалов. */
  function assemble(parts, skinned) {
    let vc = 0, ic = 0;
    parts.forEach(p => { vc += p.data.pos.length / 3; ic += p.data.idx.length; });
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
    const si = skinned ? new Uint16Array(vc * 4) : null;
    const sw = skinned ? new Float32Array(vc * 4) : null;
    const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
    let vo = 0, io = 0;
    const groups = {};
    parts.forEach(p => {
      const d = p.data;
      pos.set(d.pos, vo * 3); nor.set(d.nor, vo * 3); uv.set(d.uv, vo * 2);
      if (skinned) { si.set(d.si, vo * 4); sw.set(d.sw, vo * 4); }
      for (let i = 0; i < d.idx.length; i++) idx[io + i] = d.idx[i] + vo;
      if (!groups[p.mat]) groups[p.mat] = [];
      groups[p.mat].push([io, d.idx.length]);
      vo += d.pos.length / 3; io += d.idx.length;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (skinned) {
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const order = Object.keys(groups);
    const matOrder = [];
    order.forEach((m, mi) => {
      groups[m].forEach(([start, count]) => g.addGroup(start, count, mi));
      matOrder.push(m);
    });
    g.userData.matOrder = matOrder;
    return g;
  }

  /* --------------------------------------------------------------------------
     КИСТЬ

     Раньше это была рукавица с насечками. Здесь ладонь с пястными
     возвышениями, четыре пальца по три сустава и большой палец под своим
     углом. Подушечки лежат на сукне: последняя станция каждого пальца
     опущена до высоты ткани.
     -------------------------------------------------------------------------- */
  function buildHandParts(side, boneIdx, seg, scale) {
    const parts = [];
    const s = side;
    const K = scale === undefined ? 1 : scale;
    parts.push({
      mat: 'skin', data: sweep([
        { p: [0, 0, -0.026 * K], rx: 0.0250 * K, rz: 0.0150 * K, b: [[boneIdx, 1]], sq: 0.80 },
        { p: [0, -0.0015, 0.000], rx: 0.0310 * K, rz: 0.0142 * K, b: [[boneIdx, 1]], sq: 0.72 },
        { p: [0, -0.0030, 0.030 * K], rx: 0.0345 * K, rz: 0.0135 * K, b: [[boneIdx, 1]], sq: 0.66 },
        { p: [0, -0.0048, 0.058 * K], rx: 0.0330 * K, rz: 0.0120 * K, b: [[boneIdx, 1]], sq: 0.66 },
        { p: [0, -0.0060, 0.072 * K], rx: 0.0300 * K, rz: 0.0105 * K, b: [[boneIdx, 1]], sq: 0.70 }
      ], seg, { capStart: true, capEnd: true })
    });
    const FING = [
      { x: 0.0225, len: [0.030, 0.024, 0.019], r: 0.0092, drop: 0.0060 },
      { x: 0.0075, len: [0.033, 0.026, 0.020], r: 0.0096, drop: 0.0072 },
      { x: -0.0075, len: [0.031, 0.025, 0.019], r: 0.0092, drop: 0.0068 },
      { x: -0.0215, len: [0.024, 0.019, 0.016], r: 0.0080, drop: 0.0052 }
    ];
    FING.forEach((f, i) => {
      const x = s * f.x * K;
      let z = 0.072 * K, y = -0.0060;
      const stn = [{ p: [x, y, z], rx: f.r * K, rz: f.r * K * 0.92, b: [[boneIdx, 1]] }];
      let dy = 0;
      for (let k = 0; k < 3; k++) {
        z += f.len[k] * K;
        dy -= f.drop * (k + 1) * 0.45;
        y = -0.0060 + dy;
        const r = f.r * K * (1 - 0.16 * (k + 1));
        stn.push({ p: [x + s * i * 0.0004, y, z], rx: r, rz: r * 0.92, b: [[boneIdx, 1]] });
      }
      const last = stn[stn.length - 1];
      stn.push({ p: [last.p[0], last.p[1] - 0.0022, last.p[2] + 0.0055], rx: f.r * K * 0.42, rz: f.r * K * 0.40, b: [[boneIdx, 1]] });
      parts.push({ mat: 'skin', data: sweep(stn, Math.max(6, seg - 4), { capStart: true, capEnd: true }) });
    });
    {
      const stn = [
        { p: [s * 0.0270 * K, -0.0030, 0.006 * K], rx: 0.0125 * K, rz: 0.0110 * K, b: [[boneIdx, 1]] },
        { p: [s * 0.0400 * K, -0.0055, 0.030 * K], rx: 0.0108 * K, rz: 0.0098 * K, b: [[boneIdx, 1]] },
        { p: [s * 0.0455 * K, -0.0080, 0.058 * K], rx: 0.0092 * K, rz: 0.0085 * K, b: [[boneIdx, 1]] },
        { p: [s * 0.0470 * K, -0.0098, 0.072 * K], rx: 0.0042 * K, rz: 0.0040 * K, b: [[boneIdx, 1]] }
      ];
      parts.push({ mat: 'skin', data: sweep(stn, Math.max(6, seg - 4), { capStart: true, capEnd: true }) });
    }
    return parts;
  }

  /* --------------------------------------------------------------------------
     ОДЕЖДА: лацканы
     -------------------------------------------------------------------------- */
  function buildLapels(chestY, chestZ, jacket) {
    const g = new THREE.Group();
    for (const s of [1, -1]) {
      const shape = new THREE.Shape();
      shape.moveTo(s * 0.012, 0.075);
      shape.lineTo(s * 0.070, 0.060);
      shape.lineTo(s * 0.082, 0.014);
      shape.lineTo(s * 0.048, -0.010);
      shape.lineTo(s * 0.024, 0.006);
      shape.lineTo(s * 0.012, -0.050);
      shape.lineTo(s * 0.004, 0.068);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.0055, bevelEnabled: false, curveSegments: 2 });
      /* Лацкан плоский, а грудь круглая: подгибаем полигон по цилиндру, иначе
         из воротника торчат осколки — та самая претензия к прежней фигуре. */
      const pa = geo.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i);
        pa.setZ(i, pa.getZ(i) - (x * x) / 0.60);
      }
      pa.needsUpdate = true;
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, jacket);
      m.position.set(0, chestY, chestZ);
      g.add(m);
    }
    return g;
  }

  return {
    /* внутренности отдаём наружу: на них стоит стенд фигур и тесты */
    faceParams, faceDisp, skullBase, headGeometry, faceTextures, skinMaterial,
    buildEye, buildHair, buildEar, HAIRSTYLES, IRIS, MORPHS, buildMasks,
    hashedAlpha, prng: prng, spline, clamp01, smooth, lerp, mix3,
    HEAD_RES, SKULL, TEX, METRICS, TIER, LOWQ, sg,
    BONE_NAMES, BI, jointsFor, buildSkeleton, sweep, assemble, buildHandParts,
    buildLapels, buildFigure
  };

  /* ==========================================================================
     ЧАСТЬ 7 · СБОРКА

     Здесь всё сходится: скелет, кожа, лицо, глаза, волосы, одежда и один
     animate, который держит человека живым. Контракт userData тот же, что был
     у прежней фигуры, поэтому обе сцены получают новых людей без правок.
     ========================================================================== */
  function buildFigure(color, hatKind, seed, opts) {
    opts = opts || {};
    const rnd = prng((seed | 0) * 2654435761 + 11);
    const female = opts.sex === 'f';
    const age = opts.age === undefined ? clamp01(0.15 + rnd() * 0.65) : opts.age;
    const grp = new THREE.Group();
    const base = new THREE.Color(color);

    /* --- палитра человека --- */
    /* Тон кожи. Лампа висит над столом, лицо почти вертикально — света на нём
       мало, и слишком тёмная кожа превращает лицо в бурое пятно, пока кисти на
       сукне светятся. Нижняя граница поднята, верхняя опущена: диапазон узкий,
       зато лицо читается при любом семени. */
    const skinC = new THREE.Color().setHSL(
      0.052 + rnd() * 0.030, 0.30 + rnd() * 0.15, 0.40 + rnd() * 0.16, SRGB);
    const hairTone = rnd();
    const hairC = hairTone < 0.13
      ? new THREE.Color().setHSL(0.09, 0.05, 0.46 + rnd() * 0.14, SRGB)
      : new THREE.Color().setHSL(0.055 + rnd() * 0.032, 0.22 + rnd() * 0.26,
        0.055 + hairTone * 0.19, SRGB);
    const lipC = skinC.clone().lerp(new THREE.Color(female ? 0xa9484a : 0x9c5148), female ? 0.55 : 0.40);
    const irisHex = IRIS[Math.floor(rnd() * IRIS.length)];

    /* --- метрика посадки --- */
    const edgeZ = (opts.reach === undefined ? METRICS.seatGap : opts.reach);
    const tableY = (opts.tableY === undefined ? METRICS.tableSurfaceY : opts.tableY);
    const tall = 0.982 + rnd() * 0.040;
    const wide = (female ? 0.935 : 1) * (0.965 + rnd() * 0.070);
    const POSE = (opts.pose === undefined ? 0 : opts.pose) % 4;

    const J = jointsFor({ tableY, edgeZ, wide, tall, pose: POSE });
    const rig = buildSkeleton(J);
    const B = rig.bones;

    /* --- материалы --- */
    const tex = faceTextures(skinC.getHex(), hairC.getHex(), lipC.getHex(), seed, female, age);
    const skin = skinMaterial(tex, skinC.getHex());
    /* Свет на сцене поставлен под одну лампу и очень яркий: пятно 34 против
       обычной единицы. MeshPhysicalMaterial с щедрым sheen под таким светом
       выбивает всё в белое — на первом прогоне пиджаки стали кремовыми, а
       рукава неотличимыми от кожи. Поэтому sheen здесь скупой: он нужен, чтобы
       сукно не выглядело пластиком, а не чтобы светиться. */
    const jacket = new THREE.MeshPhysicalMaterial({
      color: base.clone().multiplyScalar(0.94), roughness: 0.90, metalness: 0.02,
      sheen: 0.06, sheenRoughness: 0.9,
      sheenColor: base.clone().lerp(new THREE.Color(0xffffff), 0.25)
    });
    const jacketDark = new THREE.MeshPhysicalMaterial({
      color: base.clone().multiplyScalar(0.48), roughness: 0.90, metalness: 0.02, sheen: 0.08
    });
    /* Сорочка не белая: на сцене со свечой чистый белый становится самым
       ярким пятном кадра и перетягивает взгляд с лица. */
    const shirt = new THREE.MeshPhysicalMaterial({
      color: 0x847d6e, roughness: 0.78, metalness: 0, sheen: 0.10
    });
    const trous = new THREE.MeshPhysicalMaterial({
      color: base.clone().multiplyScalar(0.38), roughness: 0.92, metalness: 0.02
    });
    const tieM = new THREE.MeshPhysicalMaterial({
      color: base.clone().multiplyScalar(0.30), roughness: 0.56, metalness: 0.03, sheen: 0.22
    });
    const shoeM = new THREE.MeshPhysicalMaterial({
      color: 0x191316, roughness: 0.44, metalness: 0.10, clearcoat: 0.4, clearcoatRoughness: 0.4
    });
    const feltM = new THREE.MeshPhysicalMaterial({
      color: base.clone().lerp(new THREE.Color(0x14100f), 0.74), roughness: 0.92
    });
    const MATS = { skin, jacket, jacketDark, shirt, trous, tie: tieM, shoe: shoeM };

    /* ---------------- тело ---------------- */
    const SEG = sg(20, 11);
    const parts = [];
    const w2 = (a, wa, b, wb) => [[a, wa], [b, wb]];

    /* торс: пиджак от таза до основания шеи */
    const hy = J.Hips[1];
    parts.push({
      mat: 'jacket', data: sweep([
        { p: [0, hy - 0.014, -0.192], rx: 0.190 * wide, rz: 0.138, b: [[BI.Hips, 1]], sq: 0.80 },
        { p: [0, hy + 0.060, -0.198], rx: 0.175 * wide, rz: 0.128, b: w2(BI.Hips, 0.6, BI.Spine, 0.4), sq: 0.78 },
        { p: [0, hy + 0.137, -0.194], rx: 0.166 * wide, rz: 0.120, b: w2(BI.Spine, 0.75, BI.Spine1, 0.25), sq: 0.78 },
        { p: [0, hy + 0.221, -0.186], rx: 0.178 * wide, rz: 0.128, b: w2(BI.Spine1, 0.75, BI.Spine, 0.25), sq: 0.80 },
        { p: [0, hy + 0.300, -0.176], rx: 0.200 * wide, rz: 0.139, b: w2(BI.Spine1, 0.5, BI.Spine2, 0.5), sq: 0.82 },
        { p: [0, hy + 0.378, -0.168], rx: 0.218 * wide, rz: 0.139, b: [[BI.Spine2, 1]], sq: 0.84 },
        { p: [0, hy + 0.430, -0.160], rx: 0.207 * wide, rz: 0.126, b: [[BI.Spine2, 1]], sq: 0.86 },
        { p: [0, hy + 0.466, -0.152], rx: 0.132 * wide, rz: 0.095, b: w2(BI.Spine2, 0.6, BI.Neck, 0.4), sq: 0.90 },
        { p: [0, hy + 0.488, -0.146], rx: 0.082 * wide, rz: 0.070, b: [[BI.Neck, 1]], sq: 1 }
      ], SEG, { capStart: true })
    });

    /* шея: снизу держится за Neck, сверху едет с головой — из-за этого
       поворот головы больше не отрывает голову от плеч */
    parts.push({
      mat: 'skin', data: sweep([
        { p: [0, hy + 0.452, -0.146], rx: 0.056, rz: 0.054, b: [[BI.Neck, 1]] },
        { p: [0, hy + 0.492, -0.140], rx: 0.048, rz: 0.048, b: w2(BI.Neck, 0.72, BI.Head, 0.28) },
        { p: [0, hy + 0.528, -0.132], rx: 0.040, rz: 0.040, b: w2(BI.Neck, 0.30, BI.Head, 0.70) },
        { p: [0, hy + 0.560, -0.124], rx: 0.030, rz: 0.031, b: [[BI.Head, 1]] }
      ], sg(18, 10), { capStart: true, capEnd: true })
    });

    /* руки: плечо, локоть, запястье. Дельта — отдельная станция, иначе
       рукав начинается «от шеи» */
    for (const s of [1, -1]) {
      const p = s > 0 ? 'Left' : 'Right';
      const A = J[p + 'Arm'], E = J[p + 'ForeArm'], H = J[p + 'Hand'];
      const bA = BI[p + 'Arm'], bF = BI[p + 'ForeArm'], bH = BI[p + 'Hand'];
      const bS = BI[p + 'Shoulder'];
      const mid = t => [lerp(A[0], E[0], t), lerp(A[1], E[1], t), lerp(A[2], E[2], t)];
      const mid2 = t => [lerp(E[0], H[0], t), lerp(E[1], H[1], t), lerp(E[2], H[2], t)];
      parts.push({
        mat: 'jacket', data: sweep([
          { p: [A[0] * 0.62, A[1] + 0.030, A[2] - 0.004], rx: 0.070, rz: 0.078, b: w2(bS, 0.55, BI.Spine2, 0.45) },
          { p: [A[0] * 0.96, A[1] + 0.014, A[2]], rx: 0.062, rz: 0.070, b: w2(bA, 0.65, bS, 0.35) },
          { p: mid(0.16), rx: 0.056, rz: 0.060, b: [[bA, 1]] },
          { p: mid(0.45), rx: 0.048, rz: 0.052, b: [[bA, 1]] },
          { p: mid(0.78), rx: 0.045, rz: 0.048, b: w2(bA, 0.7, bF, 0.3) },
          { p: mid(1.0), rx: 0.046, rz: 0.048, b: w2(bA, 0.4, bF, 0.6) },
          { p: mid2(0.22), rx: 0.043, rz: 0.045, b: [[bF, 1]] },
          { p: mid2(0.55), rx: 0.038, rz: 0.040, b: [[bF, 1]] },
          { p: mid2(0.86), rx: 0.032, rz: 0.034, b: w2(bF, 0.7, bH, 0.3) }
        ], SEG, { capStart: false })
      });
      /* манжета сорочки видна из рукава */
      parts.push({
        mat: 'shirt', data: sweep([
          { p: mid2(0.84), rx: 0.030, rz: 0.032, b: w2(bF, 0.6, bH, 0.4) },
          { p: mid2(1.0), rx: 0.028, rz: 0.029, b: [[bH, 1]] }
        ], SEG, {})
      });
      /* кисть строится в локальной системе кости запястья */
      buildHandParts(s, bH, sg(12, 8), 0.92).forEach(hp => {
        /* перенос из локальной системы кисти в систему фигуры */
        const d = hp.data;
        const yaw = Math.atan2(H[0] - E[0], H[2] - E[2]) * 0.55;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        for (let i = 0; i < d.pos.length; i += 3) {
          const x = d.pos[i], y = d.pos[i + 1], z = d.pos[i + 2];
          d.pos[i] = H[0] + (x * cy + z * sy);
          d.pos[i + 1] = H[1] + y;
          d.pos[i + 2] = H[2] + (-x * sy + z * cy);
          const nx = d.nor[i], nz = d.nor[i + 2];
          d.nor[i] = nx * cy + nz * sy;
          d.nor[i + 2] = -nx * sy + nz * cy;
        }
        parts.push(hp);
      });
    }

    /* ноги: бедро и голень одной протяжкой, штанина сужается к обуви */
    for (const s of [1, -1]) {
      const p = s > 0 ? 'Left' : 'Right';
      const U = J[p + 'UpLeg'], K = J[p + 'Leg'], F = J[p + 'Foot'];
      const bU = BI[p + 'UpLeg'], bL = BI[p + 'Leg'];
      const mid = t => [lerp(U[0], K[0], t), lerp(U[1], K[1], t), lerp(U[2], K[2], t)];
      const mid2 = t => [lerp(K[0], F[0], t), lerp(K[1], F[1], t), lerp(K[2], F[2], t)];
      parts.push({
        mat: 'trous', data: sweep([
          { p: [U[0], U[1] + 0.010, U[2] - 0.044], rx: 0.100 * wide, rz: 0.104, b: [[BI.Hips, 1]], sq: 0.85 },
          { p: mid(0.14), rx: 0.092 * wide, rz: 0.096, b: w2(bU, 0.6, BI.Hips, 0.4), sq: 0.85 },
          { p: mid(0.48), rx: 0.083, rz: 0.088, b: [[bU, 1]], sq: 0.88 },
          { p: mid(0.84), rx: 0.072, rz: 0.078, b: [[bU, 1]], sq: 0.92 },
          { p: mid(1.0), rx: 0.068, rz: 0.072, b: w2(bU, 0.45, bL, 0.55), sq: 0.95 },
          { p: mid2(0.28), rx: 0.062, rz: 0.064, b: [[bL, 1]] },
          { p: mid2(0.68), rx: 0.052, rz: 0.054, b: [[bL, 1]] },
          { p: mid2(0.96), rx: 0.047, rz: 0.048, b: [[bL, 1]] }
        ], sg(16, 9), { capStart: true, capEnd: true })
      });
      /* обувь */
      parts.push({
        mat: 'shoe', data: sweep([
          { p: [F[0], 0.028, F[2] - 0.052], rx: 0.040, rz: 0.030, b: [[BI[p + 'Foot'], 1]], sq: 0.8 },
          { p: [F[0], 0.046, F[2] - 0.020], rx: 0.048, rz: 0.046, b: [[BI[p + 'Foot'], 1]], sq: 0.75 },
          { p: [F[0], 0.040, F[2] + 0.040], rx: 0.050, rz: 0.040, b: [[BI[p + 'Foot'], 1]], sq: 0.7 },
          { p: [F[0], 0.028, F[2] + 0.092], rx: 0.044, rz: 0.028, b: [[BI[p + 'Foot'], 1]], sq: 0.7 },
          { p: [F[0], 0.017, F[2] + 0.118], rx: 0.030, rz: 0.017, b: [[BI[p + 'Foot'], 1]], sq: 0.8 }
        ], sg(14, 8), { capStart: true, capEnd: true })
      });
    }

    /* сорочка треугольником под лацканами */
    parts.push({
      mat: 'shirt', data: sweep([
        { p: [0, hy + 0.468, -0.074], rx: 0.058, rz: 0.020, b: [[BI.Neck, 1]], sq: 0.7 },
        { p: [0, hy + 0.408, -0.060], rx: 0.046, rz: 0.018, b: [[BI.Spine2, 1]], sq: 0.7 },
        { p: [0, hy + 0.342, -0.056], rx: 0.028, rz: 0.014, b: [[BI.Spine2, 1]], sq: 0.7 }
      ], sg(14, 8), { capStart: true, capEnd: true })
    });

    const geo = assemble(parts, true);
    const matOrder = geo.userData.matOrder.map(k => MATS[k]);
    const body = new THREE.SkinnedMesh(geo, matOrder);
    body.castShadow = true;
    body.receiveShadow = true;
    body.frustumCulled = false;
    body.add(rig.root);
    body.bind(rig.skeleton);
    grp.add(body);

    /* ---------------- голова ---------------- */
    const P = faceParams(rnd, female, age);
    const headGeo = headGeometry(P);
    const head = new THREE.Mesh(headGeo, skin);
    head.castShadow = true;
    head.position.set(0, 0.148 * tall, 0.010);
    /* Голова на 6 % крупнее расчётной: на дистанции стола анатомически
       «правильная» голова читается как маленькая — это известный перекос
       восприятия, и живописцы правят его тем же способом. */
    head.scale.setScalar(1.14);
    head.morphTargetInfluences = new Array(MORPHS.length).fill(0);
    head.morphTargetDictionary = headGeo.userData.morphNames;
    B.Head.add(head);
    const headPivot = B.Head;

    /* глаза: место берём из самой поверхности лица, а не из таблицы */
    const eyes = [];
    for (const s of [1, -1]) {
      const e = buildEye(irisHex);
      const sp = surfacePoint(P, s * P.eyeX, P.eyeY);
      /* Роговица стоит на десятую долю миллиметра впереди щели: яблоко
         выглядывает между валиками век и не «выпучено». */
      e.position.set(sp.x * 0.985, sp.y, sp.z - 0.0122 + 0.0009);
      head.add(e);
      eyes.push(e);
    }
    /* уши */
    for (const s of [1, -1]) {
      const ear = buildEar(s, skin);
      ear.position.set(s * 0.0700, -0.0090, -0.0080);
      ear.rotation.y = s * 0.22;
      head.add(ear);
    }
    /* рот изнутри: тёмная камера, чтобы открытая челюсть не светилась насквозь */
    const mouth = new THREE.Mesh(
      new THREE.SphereGeometry(0.019, sg(14, 8), sg(10, 6)),
      new THREE.MeshBasicMaterial({ color: 0x2a1214 }));
    mouth.position.set(0, P.mouthY - 0.004, 0.066);
    mouth.scale.set(1.15, 0.62, 0.62);
    head.add(mouth);
    /* зубы верхнего ряда — видны только на открытом рте, но без них «яма» */
    const teeth = new THREE.Mesh(
      new THREE.SphereGeometry(0.0135, sg(14, 8), sg(8, 5), 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshPhysicalMaterial({ color: 0xe8e0d2, roughness: 0.28, clearcoat: 0.5 }));
    teeth.position.set(0, P.mouthY + 0.0055, 0.0705);
    teeth.scale.set(1.25, 0.45, 0.55);
    teeth.rotation.x = Math.PI;
    head.add(teeth);

    /* волосы и головной убор */
    const bald = hatKind === 'bald' || (!female && age > 0.86 && rnd() < 0.30);
    const styleId = bald ? 'bald' : (opts.hair || (female
      ? ['wave', 'long', 'bun', 'braid', 'side'][Math.floor(rnd() * 5)]
      : ['short', 'crop', 'side', 'wave'][Math.floor(rnd() * 4)]));
    const covered = hatKind === 'cap' || hatKind === 'fedora';
    const hair = buildHair(styleId, hairC.getHex(), rnd, covered && styleId !== 'long');
    head.add(hair.group);
    /* Подшлемник: тонкая скорлупа по черепу цветом волос. Карточки прядей
       никогда не закрывают кожу без щелей, и на дистанции стола сквозь них
       просвечивает лоб — человек выглядит лысым. Скорлупа это закрывает. */
    if (!bald) {
      const scalpMat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(hairC.getHex()).multiplyScalar(0.85),
        roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide
      });
      const SEGH = sg(28, 14), ROWH = sg(20, 10);
      const pos = [], idx = [];
      const bp2 = { x: 0, y: 0, z: 0 };
      for (let j = 0; j < ROWH; j++) {
        const vr = 0.008 + (j / (ROWH - 1)) * 0.40;
        for (let i = 0; i <= SEGH; i++) {
          const th = (i / SEGH - 0.5) * Math.PI * 2;
          skullBase(vr, th, bp2);
          /* линия роста волос: спереди скорлупа кончается выше */
          const frontness = Math.max(0, Math.cos(th));
          const limit = 0.40 - frontness * 0.30;
          const k = vr > limit ? 0 : 1;
          const g0 = 1.006 * k;
          pos.push(bp2.x * g0, bp2.y * g0, bp2.z * g0);
        }
      }
      for (let j = 0; j < ROWH - 1; j++) {
        for (let i = 0; i < SEGH; i++) {
          const a = j * (SEGH + 1) + i, b = a + 1, c = a + SEGH + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const sg2 = new THREE.BufferGeometry();
      sg2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      sg2.setIndex(idx);
      sg2.computeVertexNormals();
      const scalp = new THREE.Mesh(sg2, scalpMat);
      head.add(scalp);
      hair.mats.push(scalpMat);
    }

    let hat = null;
    if (covered) {
      hat = new THREE.Group();
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(0.077, sg(24, 12), sg(16, 8), 0, Math.PI * 2, 0, Math.PI * 0.55), feltM);
      crown.scale.set(1, hatKind === 'fedora' ? 0.92 : 0.66, 1.04);
      crown.position.y = 0.052;
      hat.add(crown);
      const brim = new THREE.Mesh(
        new THREE.TorusGeometry(0.072, 0.020, sg(10, 6), sg(28, 14)), feltM);
      brim.rotation.x = Math.PI / 2;
      brim.scale.set(1, 1, hatKind === 'fedora' ? 1 : 0.35);
      brim.position.set(0, 0.050, hatKind === 'fedora' ? 0 : 0.020);
      hat.add(brim);
      if (hatKind === 'fedora') {
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0755, 0.0775, 0.020, sg(24, 12), 1, true),
          new THREE.MeshPhysicalMaterial({ color: 0x1b1416, roughness: 0.7 }));
        band.position.y = 0.056;
        hat.add(band);
      }
      hat.position.y = 0.036;
      head.add(hat);
    }

    /* воротник и лацканы: раньше здесь торчали осколки */
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.062, 0.055, 0.046, sg(24, 12), 1, true), shirt);
    collar.material.side = THREE.DoubleSide;
    collar.scale.set(1, 1, 0.92);
    collar.position.set(0, hy + 0.476, -0.144);
    grp.add(collar);
    const lapels = buildLapels(hy + 0.388, -0.072, jacket);
    grp.add(lapels);
    /* галстук */
    const tie = new THREE.Mesh(
      new THREE.BufferGeometry(), tieM);
    {
      const d = sweep([
        { p: [0, hy + 0.458, -0.068], rx: 0.014, rz: 0.007, b: [[0, 1]], sq: 0.7 },
        { p: [0, hy + 0.438, -0.060], rx: 0.019, rz: 0.010, b: [[0, 1]], sq: 0.7 },
        { p: [0, hy + 0.408, -0.054], rx: 0.014, rz: 0.007, b: [[0, 1]], sq: 0.7 },
        { p: [0, hy + 0.322, -0.052], rx: 0.020, rz: 0.008, b: [[0, 1]], sq: 0.7 },
        { p: [0, hy + 0.280, -0.056], rx: 0.010, rz: 0.005, b: [[0, 1]], sq: 0.7 }
      ], sg(12, 7), { capStart: true, capEnd: true });
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.pos), 3));
      g2.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(d.nor), 3));
      g2.setIndex(d.idx);
      tie.geometry = g2;
    }
    if (!female || rnd() < 0.4) grp.add(tie);
    /* пуговицы */
    for (let i = 0; i < 2; i++) {
      const btn = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0062, 0.0062, 0.0022, sg(12, 6)), jacketDark);
      btn.rotation.x = Math.PI / 2;
      btn.position.set(0.006, hy + 0.244 - i * 0.048, -0.052);
      grp.add(btn);
    }

    /* ---------------- жизнь ---------------- */
    const inf = head.morphTargetInfluences;
    const MN = headGeo.userData.morphNames;
    const life = {
      breath: rnd() * 6.283, sway: rnd() * 6.283, idle: rnd() * 6.283,
      blinkIn: 700 + rnd() * 3200, blinkFor: 0,
      lookYaw: 0, lookPitch: 0, talk: 0, hairT: rnd() * 100,
      variant: Math.floor(rnd() * 3), micro: 0, microIn: 1500 + rnd() * 4000,
      smile: 0, brow: 0, vote: 0
    };
    /* Наклон к столу. Всё, что происходит в игре, происходит в центре стола —
       и живые люди туда наклоняются. Поза задаётся до снятия restRot, поэтому
       для анимации она становится «покоем». */
    const lean = 0.085 + rnd() * 0.075;
    B.Spine.rotation.x = lean * 0.45;
    B.Spine1.rotation.x = lean * 0.35;
    B.Spine2.rotation.x = lean * 0.20;
    B.Neck.rotation.x = -lean * 0.80;      // голову держим ровно
    B.Head.rotation.x = -lean * 0.55;

    const restRot = {};
    ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm',
      'LeftForeArm', 'RightForeArm', 'LeftShoulder', 'RightShoulder'].forEach(n => {
        restRot[n] = B[n].rotation.clone();
      });

    function setTalk(open) {
      const v = clamp01(open);
      life.talk = v;
      if (inf) {
        inf[MN.jawOpen] = v * 0.9;
        inf[MN.mouthPucker] = Math.max(0, Math.sin(life.idle * 3) * 0.25) * v;
      }
    }
    function setBlink(k) { if (inf) inf[MN.eyeBlink] = clamp01(k); }
    setBlink(0); setTalk(0);

    grp.userData = {
      /* совместимость с прежним контрактом */
      torso: body, head, headPivot, headBox: head, jaw: head, hat, eyes,
      lips: { userData: {} }, hair, arms: [], seed, female,
      bones: B, skeleton: rig.skeleton, morphs: MN, restJawY: 0,
      lids: eyes, faceParams: P, style: styleId,

      talk: setTalk,
      talkAmt() { return life.talk; },
      blink(closed) { setBlink(closed > 0.5 ? 1 : 0); },
      breathe(k) { B.Spine2.rotation.x = restRot.Spine2.x - k * 0.012; },
      lookAt(yaw, pitch) { life.lookYaw = yaw || 0; life.lookPitch = pitch || 0; },
      /** Поднятая рука на голосовании — самый сильный кадр за столом. */
      raiseHand(k) { life.vote = clamp01(k); },
      express(what, k) {
        if (!inf) return;
        const v = clamp01(k === undefined ? 1 : k);
        if (what === 'smile') { inf[MN.mouthSmile] = v; life.smile = v; }
        else if (what === 'frown') inf[MN.mouthFrown] = v;
        else if (what === 'doubt') { inf[MN.browInnerUp] = v; inf[MN.eyeSquint] = v * 0.5; }
        else if (what === 'anger') { inf[MN.browDown] = v; inf[MN.noseSneer] = v * 0.6; }
      },

      animate(now, dt, st) {
        st = st || {};
        const d = Math.min(60, dt || 16);
        if (st.dead) { setTalk(0); setBlink(0.86); return; }

        /* дыхание: грудь поднимается, плечи следом, ночью реже и глубже */
        life.breath += d * (st.night ? 0.0016 : 0.0025);
        const br = Math.sin(life.breath);
        B.Spine1.rotation.x = restRot.Spine1.x - br * 0.008;
        B.Spine2.rotation.x = restRot.Spine2.x - br * 0.010;
        B.LeftShoulder.rotation.z = restRot.LeftShoulder.z - br * 0.014;
        B.RightShoulder.rotation.z = restRot.RightShoulder.z + br * 0.014;

        /* перенос веса: три варианта, у каждого своя частота — стол не качается в такт */
        life.sway += d * (0.00030 + life.variant * 0.00008);
        const sw = Math.sin(life.sway) * 0.6 + Math.sin(life.sway * 2.3 + 1.1) * 0.4;
        B.Hips.rotation.z = sw * 0.014;
        B.Spine.rotation.z = -sw * 0.008;
        B.Spine.rotation.y = Math.sin(life.sway * 0.7 + 2) * 0.020;

        /* голова: доворот к говорящему, глаза успевают раньше */
        const wantY = life.lookYaw * 0.62 + Math.sin(life.sway * 1.7) * 0.018;
        const wantX = life.lookPitch * 0.6 + Math.sin(life.sway * 2.6 + 0.7) * 0.010 + (st.night ? 0.10 : 0);
        B.Head.rotation.y += (wantY - B.Head.rotation.y) * Math.min(1, d / 380);
        B.Head.rotation.x += (wantX - B.Head.rotation.x) * Math.min(1, d / 460);
        B.Neck.rotation.y += (life.lookYaw * 0.34 - B.Neck.rotation.y) * Math.min(1, d / 620);
        eyes.forEach(e => e.userData.look(
          (life.lookYaw - B.Head.rotation.y - B.Neck.rotation.y) * 1.7, -life.lookPitch * 0.6));

        /* мигание: поток Пуассона, а не метроном */
        if (life.blinkFor > 0) {
          life.blinkFor -= d;
          const k = life.blinkFor > 60 ? 1 : life.blinkFor / 60;
          setBlink(k);
          if (life.blinkFor <= 0) setBlink(0);
        } else {
          life.blinkIn -= d;
          if (life.blinkIn <= 0) {
            life.blinkFor = 110;
            /* экспоненциальные паузы: среднее около 4 с, но бывает и 0,5, и 12 */
            life.blinkIn = 400 - Math.log(1 - Math.random() * 0.999) * 3600;
          }
        }

        /* микровыражения: бровь дёрнулась, уголок рта поехал — по этому мозг
           и отличает человека от манекена */
        life.microIn -= d;
        if (life.microIn <= 0) {
          life.micro = 260 + Math.random() * 420;
          life.microIn = 2600 + Math.random() * 7000;
          life.microKind = Math.floor(Math.random() * 3);
        }
        if (life.micro > 0) {
          life.micro -= d;
          const k = Math.sin(clamp01(1 - life.micro / 500) * Math.PI) * 0.55;
          if (inf) {
            inf[MN.browInnerUp] = life.microKind === 0 ? k : 0;
            inf[MN.eyeSquint] = life.microKind === 1 ? k * 0.7 : 0;
            inf[MN.mouthSmile] = Math.max(life.smile, life.microKind === 2 ? k * 0.5 : 0);
          }
        }

        /* речь: слоги, а не синусоида; жестикуляция кистью под реплику */
        if (st.speaking) {
          const s1 = Math.abs(Math.sin(now * 0.0128));
          const s2 = Math.abs(Math.sin(now * 0.0071 + 1.3));
          setTalk(0.12 + s1 * s2 * 0.88);
          const g = Math.sin(now * 0.0035) * 0.5 + Math.sin(now * 0.0061 + 1) * 0.3;
          B.RightForeArm.rotation.x = restRot.RightForeArm.x - Math.max(0, g) * 0.30;
          B.RightArm.rotation.z = restRot.RightArm.z + Math.max(0, g) * 0.10;
        } else {
          if (life.talk > 0.004) setTalk(life.talk * 0.80);
          B.RightForeArm.rotation.x += (restRot.RightForeArm.x - B.RightForeArm.rotation.x) * 0.08;
          B.RightArm.rotation.z += (restRot.RightArm.z - B.RightArm.rotation.z) * 0.08;
        }

        /* голосование: рука вверх */
        if (life.vote > 0.001) {
          const v = life.vote;
          B.RightArm.rotation.x = restRot.RightArm.x - v * 1.15;
          B.RightForeArm.rotation.x = restRot.RightForeArm.x - v * 0.75;
        }

        /* пальцы и кисти живут: мелкие сдвиги, рассинхронизированные */
        life.idle += d * 0.0011;
        B.LeftHand.rotation.x = Math.sin(life.idle * 1.7) * 0.035;
        B.RightHand.rotation.x = Math.sin(life.idle * 1.3 + 2.1) * 0.030;

        /* волосы догоняют голову */
        if (hair && hair.strands.length) {
          life.hairT += d * 0.001;
          const lag = B.Head.rotation.y * 0.30;
          for (let i = 0; i < hair.strands.length; i++) {
            const s2 = hair.strands[i];
            s2.pivot.rotation.z = s2.base.z + Math.sin(life.hairT * 1.6 + s2.phase) * s2.amp - lag * 0.4;
            s2.pivot.rotation.x = s2.base.x + Math.cos(life.hairT * 1.2 + s2.phase * 1.7) * s2.amp * 0.6;
            s2.pivot.rotation.y = s2.base.y + lag;
          }
        }
      },

      materials: [jacket, jacketDark, skin, shirt, tieM, trous, shoeM, feltM]
        .concat(hair.mats).concat(eyes.length ? eyes[0].userData.mats : []),
      baseColor: base.clone()
    };
    return grp;
  }
}
