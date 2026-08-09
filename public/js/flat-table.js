/* =============================================================================
   flat-table.js — ядро плоской сцены: писаный задник вертепа.

   Зачем это отдельный файл. Плоский вид нужен двум страницам сразу, и они
   управляют им по-разному: партия с ботами ведёт сцену императивно («сейчас
   ночь», «этот умер», «переверни карту» — и ждёт, пока анимация доиграет), а
   сетевая партия просто присылает состояние целиком и ждёт, что сцена сама
   догонит. Общее у них одно — картинка. Она и живёт здесь: раскладка стола,
   рисование, попадание курсором, проекция места в экранные координаты.
   Смысл партии сюда не попадает: ядро не знает ни правил, ни ролей сверх
   того, что ему показали.

   Почему это не «3D без 3D». В провинциальном театре глубокую выгородку
   ставили не всегда: чаще вешали писаный задник и выставляли перед ним
   плоские фигуры на подставках — вертеп. Плоский вид сделан именно таким:
   краска по извёстке, дощатый пол, картонные фигуры со следом кисти. Это
   отдельная декорация того же спектакля, а не аварийный чертёж.

   Ни одной картинки, ни одного шрифта извне: всё рисуется кистью по canvas.
   ============================================================================= */
(function (global) {
  'use strict';

  /* Краски ровно те же, что в theatre.css. Canvas не умеет читать
     переменные CSS на каждый штрих, поэтому значения продублированы здесь —
     и меняются только вместе с дизайн-системой. */
  var C = {
    void_: '#050405',
    ink: '#0a0809',
    ink2: '#12100f',
    ink3: '#1b1715',
    board: '#241d19',
    velvet: '#3a1620',
    tallow: '#e2b478',
    tallowDim: '#b98a52',
    ember: '#c4563a',
    verdigris: '#7ba295',
    bruise: '#6b4a63',
    bone: '#f1ece1',
    plaster: '#ddd5c7',
    plasterDim: '#b2a99c',
    plasterFaint: '#8d857a',
    baize: '#2f5f48',
    baizeNight: '#24455c',
    chalk: 'rgba(241,236,225,.62)'
  };

  /* Пальто фигур — те же пыльные тона, что у объёмных моделей: стол должен
     выглядеть компанией людей, а не набором карандашей. */
  var COATS = [
    '#6a4b52', '#4c5a63', '#6b5f45', '#543f4d', '#455448',
    '#74544a', '#3f4a5c', '#5f5340', '#6d4a45', '#4a4f5b',
    '#5b4a3f', '#50575f', '#654a58', '#455049', '#6b5b4d',
    '#3f4752', '#5d4f4a', '#4e4457', '#59604f', '#6a5449'
  ];

  var ROLE_VIS = {
    mafia: { ru: 'Мафия', color: C.ember },
    don: { ru: 'Дон', color: C.ember },
    doctor: { ru: 'Доктор', color: C.verdigris },
    sheriff: { ru: 'Шериф', color: C.tallow },
    civilian: { ru: 'Мирный', color: C.plaster }
  };

  var SANS = '"Golos Text", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var DISPLAY = '"Bitter", "Noto Serif", Georgia, serif';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Мелкое случайное отклонение, одинаковое от кадра к кадру: рука дрожит
     всегда одинаково, иначе задник дёргается на каждой перерисовке. */
  function seeded(seed) {
    var s = (seed * 2654435761) % 4294967296;
    return function () {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  function shade(hex, k) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '#caa96b'));
    if (!m) return hex;
    var c = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].map(function (v) {
      return Math.round(clamp(k < 0 ? v * (1 + k) : v + (255 - v) * k, 0, 255));
    });
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }
  function rgba(hex, a) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex));
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  /* =========================================================================
     Ядро
     ========================================================================= */
  global.createFlatTable = function createFlatTable(container, opts) {
    opts = opts || {};

    var canvas = document.createElement('canvas');
    canvas.className = 'flat-table';
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d', { alpha: false });

    var W = 0, H = 0, DPR = 1;
    var born = (global.performance || Date).now();
    var calm = false;
    try {
      calm = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { calm = false; }

    /* Состояние сцены. Адаптеры правят его напрямую — это их работа,
       а ядро только рисует то, что в нём лежит. */
    var st = {
      seats: [],
      night: 0,          /* 0 — день, 1 — ночь: свет, краски, поза */
      bright: 1,         /* приглушённый свет — отдельная воля игрока */
      glow: 0,           /* красный отсвет: мафия совещается */
      plan: 0,           /* 0 — вполоборота, 1 — план стола сверху */
      deal: 1,           /* раздача карт: 0 — колода в центре, 1 — карты разобраны */
      victim: null,      /* id намеченной жертвы */
      arrows: [],        /* [{ from, to, k }] — меловые линии голосования */
      shakeUntil: 0,
      shakeK: 0,
      pickable: true,
      /* Таблички имён рисует либо сама сцена, либо HTML-слой над ней.
         Двух подписей на одну фигуру быть не должно: в сетевой партии
         подписи — это кнопки выбора цели, и они живут в DOM. */
      plates: true
    };

    var byId = new Map();
    var geo = { cx: 0, cy: 0, rx: 0, ry: 0, scale: 1 };

    /* --------------------------------------------------------------------- */
    /* размеры и раскладка                                                    */
    /* --------------------------------------------------------------------- */
    /* Сколько места по краям занимает интерфейс поверх сцены. На широком
       экране страницы с ботами слева висит карта роли, справа — протокол, и
       без этой поправки два места из восьми оказывались прямо под панелями.
       Считаем по живой геометрии: панель закрыли — место вернулось. */
    function avoidInsets() {
      var res = { left: 0, right: 0, bottom: 0 };
      var list = opts.avoid || [];
      if (!list.length) return res;
      var box = container.getBoundingClientRect();
      if (!box.width || !box.height) return res;
      for (var i = 0; i < list.length; i++) {
        var el = typeof list[i] === 'string' ? document.querySelector(list[i]) : list[i];
        /* offsetParent у элементов с position:fixed всегда пуст, поэтому
           видимость проверяем по вычисленному стилю и по размеру. */
        if (!el || el.hidden) continue;
        var cs = global.getComputedStyle ? global.getComputedStyle(el) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0)) continue;
        var r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;

        /* Широкая полоса внизу — это док действий: он отнимает высоту, а не
           ширину, и без этой поправки табличка ближнего места уезжала под
           кнопки. Узкая панель у края отнимает ширину. */
        if (r.width > box.width * 0.6 && r.top > box.top + box.height * 0.55) {
          res.bottom = Math.max(res.bottom, box.bottom - r.top);
          continue;
        }
        /* Боковая панель мешает, только если заслоняет заметную часть высоты. */
        var vOverlap = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
        if (vOverlap < box.height * 0.22) continue;
        var midX = box.left + box.width / 2;
        if (r.right <= midX) res.left = Math.max(res.left, r.right - box.left);
        else if (r.left >= midX) res.right = Math.max(res.right, box.right - r.left);
      }
      res.left = clamp(res.left, 0, box.width * 0.32);
      res.right = clamp(res.right, 0, box.width * 0.32);
      res.bottom = clamp(res.bottom, 0, box.height * 0.3);
      return res;
    }

    function measure() {
      var cap = opts.pixelCap || 2;
      DPR = Math.min(global.devicePixelRatio || 1, cap);
      W = Math.max(120, container.clientWidth || global.innerWidth || 320);
      H = Math.max(120, container.clientHeight || global.innerHeight || 480);
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      layout();
    }

    function layout() {
      var n = st.seats.length;

      /* Поля несимметричные, и это главное решение всей раскладки. Сверху
         достаточно места на лампу, снизу нужно вдвое больше: там стоят самые
         крупные фигуры, и под каждой — её табличка. Симметричные поля
         обрезали ближний край стола ровно там, где сидит сам игрок. */
      var padX = clamp(W * 0.11, 52, 132);
      var padTop = clamp(H * 0.15, 46, 130);
      var padBottom = clamp(H * 0.21, 78, 200);
      var av = avoidInsets();
      geo.avoid = av;
      var padL = Math.max(padX, av.left + 14);
      var padR = Math.max(padX, av.right + 14);
      padBottom = Math.max(padBottom, av.bottom + 16);

      geo.cx = (padL + (W - padR)) / 2;
      geo.cy = padTop + (H - padTop - padBottom) / 2;
      geo.rx = Math.max(52, (W - padL - padR) / 2);
      geo.ry = Math.max(40, (H - padTop - padBottom) / 2);
      /* Овал не растягиваем сильнее, чем 1.9:1 — дальше стол читается
         коридором, а крайние места уезжают к самым краям кадра. */
      if (geo.rx > geo.ry * 1.9) geo.rx = geo.ry * 1.9;
      geo.scale = clamp(Math.min(W, H) / 620, 0.6, 1.4);
      /* «План» распрямляет овал: сплюснутость и есть весь взгляд вполоборота. */
      /* Стол заметно меньше круга мест: за столом должны читаться люди, а не
         зелёное поле. Раньше сукно занимало полкадра и съедало всю сцену. */
      geo.trx = geo.rx * 0.56;
      geo.try_ = geo.ry * lerp(0.50, 0.68, st.plan);
      /* Стол не бывает глубже, чем шире: на узком экране высокого кадра
         сукно превращалось в вертикальное озеро, чего в комнате не бывает. */
      var maxDepth = geo.trx * lerp(0.78, 0.95, st.plan);
      if (geo.try_ > maxDepth) geo.try_ = maxDepth;

      st.behind = [];
      st.front = [];
      if (!n) return;

      for (var i = 0; i < n; i++) {
        var s = st.seats[i];
        /* Своё место — внизу по центру: игрок должен узнавать себя мгновенно. */
        var a = (i / n) * Math.PI * 2 + Math.PI / 2;
        s.a = a;
        s.behind = Math.sin(a) < -0.02;

        /* Дальняя половина стола садится вплотную к сукну и заходит за его
           кромку: сначала рисуем этих, потом стол — и они выходят из-за
           стола, а не висят над ним. Ближняя половина сидит просторно,
           перед столом, и перекрывает его сама.

           Посадку считаем от размеров стола, а не от высоты кадра: иначе на
           узком экране дальний ряд отрывался от сукна и садился в воздух. */
        var vr = s.behind
          ? geo.try_ * lerp(0.90, 0.94, st.plan)
          : Math.min(geo.ry, geo.try_ * lerp(3.0, 1.9, st.plan));
        var hx = s.behind ? 0.92 : 1;
        s.x = geo.cx + Math.cos(a) * geo.rx * hx;
        s.y = geo.cy + Math.sin(a) * vr;

        /* Дальние фигуры мельче ближних: одна честная подсказка глубины,
           большего плоскому заднику не нужно. */
        s.depth = (Math.sin(a) + 1) / 2;
        var room = Math.min(geo.rx * 1.05, geo.ry * 1.5);
        /* На узком экране фигуры уменьшаем: иначе дальний ряд слипается в
           одну кляксу — соседи стоят плотнее, чем ширина плеч. */
        var narrow = clamp(W / 620, 0.7, 1);
        s.r = clamp(room / (n * 0.44), 13, 38) * narrow *
          lerp(0.88, 1.08, s.depth) * lerp(1, 0.9, st.plan);
      }
      var sortY = function (p, q) { return p.y - q.y; };
      st.behind = st.seats.filter(function (s) { return s.behind; }).sort(sortY);
      st.front = st.seats.filter(function (s) { return !s.behind; }).sort(sortY);
    }

    function setSeats(list) {
      st.seats = (list || []).map(function (p, i) {
        var rnd = seeded(i + 7);
        return {
          id: p.id === undefined ? i : p.id,
          idx: i,
          seat: p.seat === undefined ? i + 1 : p.seat,
          name: p.name || '—',
          you: !!(p.you || p.isHuman),
          coat: p.color || COATS[i % COATS.length],
          /* Головы за столом не должны быть одинаковыми: четыре силуэта
             вперемешку дают компанию людей, а не строй болванчиков. */
          hat: p.hat || ['cap', 'hair', 'kerchief', 'hair', 'bald', 'cap', 'hair'][i % 7],
          sex: i % 3 === 1 ? 'f' : 'm',
          alive: true,
          revealed: null,
          armed: null,
          speaking: false,
          target: false,
          picked: false,
          offline: false,
          ready: false,
          votes: 0,
          dead: null,
          pulse: 0,
          lean: rnd() * 0.5 - 0.25,   /* лёгкий наклон корпуса: живой стол не строй */
          wobble: rnd(),
          breath: rnd() * Math.PI * 2,
          x: 0, y: 0, a: 0, r: 20, depth: 0.5
        };
      });
      byId = new Map();
      st.seats.forEach(function (s) { byId.set(s.id, s); });
      st.arrows = [];
      st.victim = null;
      layout();
    }

    function seat(id) {
      if (byId.has(id)) return byId.get(id);
      if (typeof id === 'number' && st.seats[id]) return st.seats[id];
      return null;
    }

    /* --------------------------------------------------------------------- */
    /* задник: извёстка, лампа, пол                                           */
    /* --------------------------------------------------------------------- */
    function paintWall(now) {
      var dim = st.bright ? 1 : 0.74;
      var night = st.night;

      /* Основа — плоская краска, а не «модный градиент»: два-три тона,
         положенные широкой кистью. */
      var top = night > 0.5 ? '#101725' : (st.bright ? '#211a16' : '#171311');
      var bottom = night > 0.5 ? '#05070d' : '#0a0809';
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, top);
      g.addColorStop(0.62, night > 0.5 ? '#0a0e18' : '#100c0b');
      g.addColorStop(1, bottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      /* Потёки по извёстке. Кистью, а не заливкой прямоугольника: у мазка
         мягкий низ и рваные края, и он не даёт той вертикальной полосы с
         бритвенным краем, по которой сразу видно машинную работу. */
      var rnd = seeded(3);
      ctx.save();
      for (var i = 0; i < 13; i++) {
        var x = rnd() * W;
        var w = 8 + rnd() * 30;
        var h = H * (0.28 + rnd() * 0.62);
        var light = rnd() > 0.5;
        var g2 = ctx.createLinearGradient(x, 0, x, h);
        var a = 0.03 + rnd() * 0.045;
        g2.addColorStop(0, rgba(light ? C.bone : C.void_, a));
        g2.addColorStop(0.7, rgba(light ? C.bone : C.void_, a * 0.5));
        g2.addColorStop(1, rgba(light ? C.bone : C.void_, 0));
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + w, 0);
        ctx.quadraticCurveTo(x + w * 0.7, h * 0.7, x + w * 0.45, h);
        ctx.quadraticCurveTo(x + w * 0.2, h * 0.72, x, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      /* Пол: дощатый настил в одну точку схода. Точка стоит над столом, за
         задником, — тогда доски расходятся к рампе, как в настоящей коробке
         сцены. Рисуем только от линии пола вниз: выше идёт стена. */
      var floorY = geo.cy - geo.ry * 0.18;
      var vanishY = geo.cy - geo.ry * 1.9;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, floorY, W, H - floorY);
      ctx.clip();
      ctx.fillStyle = night > 0.5 ? '#0b0d13' : C.ink2;
      ctx.fillRect(0, floorY, W, H - floorY);
      ctx.strokeStyle = rgba(C.board, 0.9);
      ctx.lineWidth = 1;
      var planks = 11;
      for (var k = 0; k <= planks; k++) {
        /* Доски у краёв кадра шире, у центра уже: так и выглядит настил,
           уходящий вглубь. */
        var t = (k / planks) * 2 - 1;
        var xBottom = geo.cx + Math.sign(t) * Math.pow(Math.abs(t), 0.78) * W * 0.72;
        ctx.globalAlpha = 0.42;
        ctx.beginPath();
        ctx.moveTo(geo.cx + t * W * 0.06, vanishY);
        ctx.lineTo(xBottom, H);
        ctx.stroke();
      }
      /* Плинтус. Не сплошная линия через весь кадр — она разрезала сцену
         пополам ровно за столом; светлеет только у краёв, где стена и пол
         действительно встречаются на виду. */
      ctx.globalAlpha = 1;
      var skirt = ctx.createLinearGradient(0, 0, W, 0);
      skirt.addColorStop(0, rgba(C.bone, 0.09));
      skirt.addColorStop(0.4, rgba(C.bone, 0));
      skirt.addColorStop(0.6, rgba(C.bone, 0));
      skirt.addColorStop(1, rgba(C.bone, 0.09));
      ctx.strokeStyle = skirt;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, floorY);
      ctx.lineTo(W, floorY);
      ctx.stroke();
      ctx.restore();

      /* Свет сальной свечи: одно тёплое пятно сверху, с медленным дыханием.
         В спокойном режиме дыхание выключено. */
      var flick = calm ? 1 : 0.94 + Math.sin(now / 430) * 0.045 + Math.sin(now / 137) * 0.015;
      var lampY = geo.cy - geo.ry * 0.84;
      var pool = ctx.createRadialGradient(geo.cx, lampY, 4, geo.cx, geo.cy, Math.max(geo.rx, geo.ry) * 1.85);
      var lampA = lerp(0.26, 0.09, night) * dim * flick;
      pool.addColorStop(0, rgba(C.tallow, lampA));
      pool.addColorStop(0.45, rgba(C.tallow, lampA * 0.38));
      pool.addColorStop(1, rgba(C.tallow, 0));
      ctx.fillStyle = pool;
      ctx.fillRect(0, 0, W, H);

      /* Луна в окне: только ночью, только слева — чтобы ночь читалась
         не «выключенным светом», а другим светом. */
      if (night > 0.02) {
        var moon = ctx.createRadialGradient(W * 0.08, H * 0.1, 2, W * 0.08, H * 0.1, Math.max(W, H) * 0.7);
        moon.addColorStop(0, 'rgba(120,150,210,' + (0.16 * night).toFixed(3) + ')');
        moon.addColorStop(1, 'rgba(120,150,210,0)');
        ctx.fillStyle = moon;
        ctx.fillRect(0, 0, W, H);
      }

      /* Уголёк: мафия совещается — стены отдают кирпичом. */
      if (st.glow > 0.01) {
        var em = ctx.createRadialGradient(geo.cx, geo.cy, 8, geo.cx, geo.cy, Math.max(W, H) * 0.62);
        em.addColorStop(0, rgba(C.ember, 0.20 * st.glow));
        em.addColorStop(1, rgba(C.ember, 0));
        ctx.fillStyle = em;
        ctx.fillRect(0, 0, W, H);
      }

      /* Тёмные углы зала. */
      var vig = ctx.createRadialGradient(geo.cx, geo.cy * 0.9, Math.min(W, H) * 0.28, geo.cx, geo.cy, Math.max(W, H) * 0.78);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,.62)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, W, H);

      /* Лампа над столом — жестяной колпак на шнуре. */
      paintLamp(lampY, flick);
    }

    /* Лампа — единственный источник света в комнате, поэтому она обязана быть
       видна: жестяной колпак на шнуре, светлая кромка снизу и конус света до
       сукна. Раньше колпак был выкрашен в цвет доски и терялся в стене. */
    function paintLamp(lampY, flick) {
      var w = clamp(geo.rx * 0.26, 30, 96);
      var h = w * 0.44;
      var dim = (st.bright ? 1 : 0.72) * flick;
      var lit = lerp(1, 0.32, st.night) * dim;

      ctx.save();
      ctx.translate(geo.cx, 0);

      /* Конус света: от кромки колпака к столу. Мягкий, но с видимыми краями —
         в дыму провинциального театра свет всегда со краями. */
      var cone = ctx.createLinearGradient(0, lampY, 0, geo.cy + geo.try_);
      cone.addColorStop(0, rgba(C.tallow, 0.16 * lit));
      cone.addColorStop(1, rgba(C.tallow, 0));
      ctx.beginPath();
      ctx.moveTo(-w * 0.46, lampY + h * 0.42);
      ctx.lineTo(w * 0.46, lampY + h * 0.42);
      ctx.lineTo(geo.trx * 0.92, geo.cy + geo.try_ * 0.2);
      ctx.lineTo(-geo.trx * 0.92, geo.cy + geo.try_ * 0.2);
      ctx.closePath();
      ctx.fillStyle = cone;
      ctx.fill();

      /* шнур */
      ctx.strokeStyle = rgba(C.bone, 0.2);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, lampY - h * 0.5);
      ctx.stroke();

      /* колпак: трапеция, писаная широкой кистью */
      ctx.beginPath();
      ctx.moveTo(-w / 2, lampY + h * 0.42);
      ctx.lineTo(w / 2, lampY + h * 0.42);
      ctx.lineTo(w * 0.19, lampY - h * 0.5);
      ctx.lineTo(-w * 0.19, lampY - h * 0.5);
      ctx.closePath();
      ctx.fillStyle = shade(C.board, 0.16);
      ctx.fill();
      ctx.strokeStyle = rgba(C.void_, 0.75);
      ctx.lineWidth = 1.2;
      ctx.stroke();

      /* Раскалённая кромка снизу: жесть у лампы всегда светлее самой лампы. */
      ctx.beginPath();
      ctx.moveTo(-w / 2, lampY + h * 0.42);
      ctx.lineTo(w / 2, lampY + h * 0.42);
      ctx.strokeStyle = rgba(C.tallow, 0.55 * lit + 0.12);
      ctx.lineWidth = 2;
      ctx.stroke();

      /* нить накала */
      ctx.beginPath();
      ctx.arc(0, lampY + h * 0.5, Math.max(2.4, w * 0.075), 0, Math.PI * 2);
      ctx.fillStyle = rgba(C.tallow, 0.5 + 0.45 * lit);
      ctx.fill();
      ctx.restore();
    }

    /* --------------------------------------------------------------------- */
    /* стол                                                                   */
    /* --------------------------------------------------------------------- */
    /* Овал, обведённый от руки: восемь точек с фиксированным отклонением.
       Машинно-ровный эллипс сразу выдаёт, что задник рисовал не человек. */
    function handEllipse(rx, ry, seed) {
      var rnd = seeded(seed);
      var pts = [];
      var steps = 26;
      for (var i = 0; i < steps; i++) {
        var a = (i / steps) * Math.PI * 2;
        var k = 1 + (rnd() - 0.5) * 0.022;
        pts.push([Math.cos(a) * rx * k, Math.sin(a) * ry * k]);
      }
      ctx.beginPath();
      ctx.moveTo((pts[0][0] + pts[steps - 1][0]) / 2, (pts[0][1] + pts[steps - 1][1]) / 2);
      for (var j = 0; j < steps; j++) {
        var p = pts[j], q = pts[(j + 1) % steps];
        ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      ctx.closePath();
    }

    function paintTable(now) {
      var trx = geo.trx, tryy = geo.try_;
      ctx.save();
      ctx.translate(geo.cx, geo.cy);

      /* тень на полу */
      ctx.save();
      ctx.translate(0, tryy * 0.14);
      handEllipse(trx * 1.05, tryy * 1.05, 11);
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fill();
      ctx.restore();

      /* деревянный борт */
      handEllipse(trx, tryy, 12);
      ctx.fillStyle = shade(C.board, 0.02);
      ctx.fill();
      ctx.strokeStyle = rgba(C.void_, 0.75);
      ctx.lineWidth = Math.max(1.5, geo.scale * 2);
      ctx.stroke();

      /* Сукно: пыльное, приглушённое. Яркая зелень читалась бы покерным
         столом, а здесь трактир, где сукно не меняли тридцать лет. */
      var base = st.night > 0.5 ? C.baizeNight : C.baize;
      handEllipse(trx * 0.9, tryy * 0.86, 13);
      ctx.fillStyle = shade(base, st.bright ? -0.26 : -0.38);
      ctx.fill();

      var sheen = ctx.createRadialGradient(0, -tryy * 0.38, 4, 0, 0, Math.max(trx, tryy) * 1.1);
      sheen.addColorStop(0, rgba(C.tallow, lerp(0.17, 0.05, st.night)));
      sheen.addColorStop(1, rgba(C.tallow, 0));
      ctx.fillStyle = sheen;
      ctx.fill();

      /* Мазки кисти по сукну: три дуги, чтобы поверхность не была пластиковой. */
      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.strokeStyle = C.bone;
      ctx.lineWidth = Math.max(2, geo.scale * 5);
      ctx.lineCap = 'round';
      for (var i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, tryy * (0.1 * i - 0.1), trx * (0.5 + i * 0.13), tryy * (0.42 + i * 0.12), 0, Math.PI * 1.06, Math.PI * 1.9);
        ctx.stroke();
      }
      ctx.restore();

      paintProps(trx, tryy, now);

      /* Колода в центре, пока карты не разобраны. */
      if (st.deal < 0.999) {
        var cw = 13 * geo.scale, ch = 18 * geo.scale;
        var away = st.deal;
        ctx.save();
        ctx.globalAlpha = 1 - away;
        for (var k = 0; k < 5; k++) {
          ctx.save();
          ctx.rotate((k - 2) * 0.055);
          ctx.translate(0, -k * 1.3 - away * 12);
          roundRect(-cw / 2, -ch / 2, cw, ch, 2.5);
          ctx.fillStyle = C.velvet;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    /* Реквизит на сукне. Он здесь не для красоты: пустой овал не даёт глазу
       масштаба, и стол выглядел лужей. Стакан рядом с фигурой сразу говорит,
       какого размера люди за столом и что вечер идёт давно.
       Система координат — уже сдвинутая в центр стола. */
    function paintProps(trx, tryy, now) {
      /* Реквизит масштабируем от самого стола, а не от кадра: на большом
         экране крошечная свеча не давала глазу никакой мерки. */
      var k = clamp(geo.trx / 190, 0.7, 2.2);
      var dark = st.night > 0.5;

      /* Свеча в жестяном блюдце: слева от центра, чуть в глубину. */
      var cx = -trx * 0.34, cy = -tryy * 0.12;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.ellipse(0, 2 * k, 9 * k, 3.2 * k, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(C.board, 0.22);
      ctx.fill();
      ctx.fillStyle = '#e8e0cd';
      ctx.fillRect(-2.2 * k, -13 * k, 4.4 * k, 14 * k);
      /* Пламя дышит вместе с лампой; в спокойном режиме стоит ровно. */
      var fl = calm ? 1 : 0.85 + Math.sin(now / 190) * 0.15;
      ctx.beginPath();
      ctx.ellipse(0, -15.5 * k, 2.1 * k, 4.2 * k * fl, 0, 0, Math.PI * 2);
      ctx.fillStyle = rgba(C.tallow, 0.92);
      ctx.fill();
      var halo = ctx.createRadialGradient(0, -15 * k, 1, 0, -15 * k, 26 * k);
      halo.addColorStop(0, rgba(C.tallow, 0.3));
      halo.addColorStop(1, rgba(C.tallow, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, -15 * k, 26 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      /* Стакан в подстаканнике справа. */
      ctx.save();
      ctx.translate(trx * 0.30, -tryy * 0.04);
      ctx.beginPath();
      ctx.ellipse(0, 1.5 * k, 7 * k, 2.6 * k, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-4.6 * k, -11 * k);
      ctx.lineTo(4.6 * k, -11 * k);
      ctx.lineTo(3.6 * k, 1 * k);
      ctx.lineTo(-3.6 * k, 1 * k);
      ctx.closePath();
      ctx.fillStyle = dark ? 'rgba(190,205,220,.16)' : 'rgba(240,225,195,.22)';
      ctx.fill();
      ctx.strokeStyle = rgba(C.bone, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
      /* чай на две трети */
      ctx.beginPath();
      ctx.moveTo(-4.1 * k, -5 * k);
      ctx.lineTo(4.1 * k, -5 * k);
      ctx.lineTo(3.6 * k, 0.6 * k);
      ctx.lineTo(-3.6 * k, 0.6 * k);
      ctx.closePath();
      ctx.fillStyle = dark ? 'rgba(90,70,55,.55)' : 'rgba(150,95,52,.55)';
      ctx.fill();
      ctx.restore();

      /* Сброшенные карты: три штуки веером, положение фиксировано семенем. */
      var rnd = seeded(41);
      ctx.save();
      ctx.translate(trx * 0.06, tryy * 0.34);
      for (var i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((rnd() - 0.5) * 1.5);
        ctx.translate((rnd() - 0.5) * 12 * k, (rnd() - 0.5) * 6 * k);
        roundRect(-6 * k, -8.5 * k, 12 * k, 17 * k, 1.6);
        ctx.fillStyle = i === 2 ? '#e7dfd0' : C.velvet;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* --------------------------------------------------------------------- */
    /* фигуры                                                                 */
    /* --------------------------------------------------------------------- */
    function paintSeat(s, now) {
      var r = s.r;
      var dead = !s.alive;
      var fall = s.dead ? clamp((now - s.dead.t0) / 900, 0, 1) : (dead ? 1 : 0);
      var ease = 1 - Math.pow(1 - fall, 3);
      var breathe = calm ? 0 : Math.sin(s.breath + now * (st.night > 0.5 ? 0.0011 : 0.0017)) * 0.012;

      /* Приглушение по глубине и по ночи: дальние и ночные фигуры уходят
         в тон стены, а не остаются вырезкой из другого спектакля. */
      var fade = lerp(0.72, 1, s.depth) * lerp(1, 0.78, st.night);

      ctx.save();
      ctx.translate(s.x, s.y);

      /* Меловое кольцо цели — под подставкой, чтобы не спорить с фигурой.
         Тихое: доступных целей за ночь бывает шесть, и шесть ярких колец
         превращают стол в новогоднюю гирлянду. Громким остаётся только
         выбранный. */
      if (s.target && !dead && !s.picked) {
        var pulse = calm ? 0.5 : 0.5 + Math.sin(now / 300) * 0.3;
        ctx.save();
        ctx.strokeStyle = rgba(C.tallow, 0.16 + pulse * 0.12);
        ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.ellipse(0, r * 1.06, r * 1.36, r * 0.46, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (s.picked) {
        ctx.save();
        ctx.strokeStyle = rgba(C.tallow, 0.9);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(0, r * 1.06, r * 1.42, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      /* Говорящий: тёплое пятно за фигурой — как если бы к нему повернули
         свечу. Никаких цветных ореолов вокруг всего силуэта. */
      if (s.speaking && !dead) {
        var halo = ctx.createRadialGradient(0, -r * 0.3, 2, 0, -r * 0.3, r * 2.8);
        halo.addColorStop(0, rgba(C.tallow, 0.34));
        halo.addColorStop(0.55, rgba(C.tallow, 0.12));
        halo.addColorStop(1, rgba(C.tallow, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(0, -r * 0.3, r * 2.8, 0, Math.PI * 2);
        ctx.fill();
        /* Подставка говорящего подсвечена: на столе из двадцати человек
           пятно за фигурой теряется, а светлая дощечка — нет. */
        ctx.beginPath();
        ctx.ellipse(0, r * 1.1, r * 0.98, r * 0.27, 0, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(C.tallow, 0.7);
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      /* Жертва ночи: кирпичная обводка. */
      if (st.victim !== null && s.id === st.victim && !dead) {
        ctx.save();
        ctx.strokeStyle = rgba(C.ember, 0.85);
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.ellipse(0, r * 1.06, r * 1.5, r * 0.56, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      /* Подставка: фигура вертепа стоит на дощечке. */
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.ellipse(0, r * 1.1, r * 0.92, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(C.board, dead ? -0.3 : 0.04);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      /* Фигура. Это вырезанная из картона кукла на подставке: плечи со
         скатом, короткая шея, голова отдельным силуэтом, руки лежат на
         столе. Раньше голова сливалась с корпусом, и место читалось каплей.
         Мёртвый валится на сторону — поворот идёт вокруг подставки. */
      ctx.save();
      ctx.globalAlpha = fade * (dead ? 0.72 : 1);
      ctx.translate(0, r * 1.05);
      ctx.rotate((s.dead ? (s.seat % 2 ? 1 : -1) : 1) * ease * 0.5);
      ctx.translate(0, -r * 1.05 + ease * r * 0.3);
      ctx.rotate(s.lean * 0.05 + (s.speaking ? Math.sin(now / 300) * 0.012 : 0));
      if (s.speaking && !dead) ctx.translate(0, -r * 0.05);
      ctx.scale(1, (1 + breathe) * (1 - st.night * 0.035));

      var coat = dead ? shade(s.coat, -0.55) : shade(s.coat, st.night > 0.5 ? -0.34 : 0);
      var skin = dead ? '#6a6067' : (st.night > 0.5 ? '#8e7d6c' : '#d2ac8a');
      var jr = seeded(s.idx + 21);
      var bw = r * 1.16;

      /* Корпус: от подставки вверх, с покатыми плечами. */
      ctx.beginPath();
      ctx.moveTo(-bw, r * 1.02);
      ctx.lineTo(-bw * (0.94 + jr() * 0.05), r * 0.1);
      ctx.quadraticCurveTo(-bw * 0.82, -r * 0.28, -bw * 0.42, -r * 0.42);
      ctx.lineTo(bw * 0.42, -r * 0.42);
      ctx.quadraticCurveTo(bw * 0.82, -r * 0.28, bw * (0.94 + jr() * 0.05), r * 0.1);
      ctx.lineTo(bw, r * 1.02);
      ctx.closePath();
      ctx.fillStyle = coat;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* Свет лампы падает сверху: кромка плеч светлее сукна пальто. */
      ctx.save();
      ctx.clip();
      var lit = ctx.createLinearGradient(0, -r * 0.5, 0, r * 0.8);
      lit.addColorStop(0, rgba(C.tallow, lerp(0.20, 0.06, st.night)));
      lit.addColorStop(1, rgba(C.tallow, 0));
      ctx.fillStyle = lit;
      ctx.fillRect(-bw, -r, bw * 2, r * 2.2);
      /* Отворот пальто: две встречные линии от воротника вниз. */
      ctx.strokeStyle = 'rgba(0,0,0,.30)';
      ctx.lineWidth = Math.max(1, r * 0.055);
      ctx.beginPath();
      ctx.moveTo(-r * 0.26, -r * 0.38);
      ctx.lineTo(-r * 0.05, r * 0.34);
      ctx.moveTo(r * 0.26, -r * 0.38);
      ctx.lineTo(r * 0.05, r * 0.34);
      ctx.stroke();
      ctx.restore();

      /* Шея: короткая, но без неё голова снова прилипнет к плечам. */
      var neckTop = -r * 0.56 + st.night * r * 0.07;
      ctx.beginPath();
      ctx.rect(-r * 0.17, neckTop, r * 0.34, r * 0.24);
      ctx.fillStyle = shade(skin, -0.22);
      ctx.fill();

      /* Голова. Ночью опускается к столу — город спит. */
      var hy = neckTop - r * 0.44 + ease * r * 0.2;
      ctx.beginPath();
      ctx.ellipse(0, hy, r * 0.46, r * 0.54, s.lean * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = skin;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* Головной убор плоской краской: картуз с полями или шапка волос. */
      if (s.hat === 'cap') {
        ctx.beginPath();
        ctx.ellipse(0, hy - r * 0.16, r * 0.5, r * 0.36, 0, Math.PI, Math.PI * 2);
        ctx.fillStyle = shade(s.coat, -0.45);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-r * 0.12, hy - r * 0.12, r * 0.66, r * 0.1, 0, Math.PI * 0.96, Math.PI * 2.04);
        ctx.fillStyle = shade(s.coat, -0.6);
        ctx.fill();
      } else if (s.hat === 'kerchief') {
        /* Платок: закрывает голову целиком и завязан под подбородком. */
        ctx.beginPath();
        ctx.ellipse(0, hy - r * 0.04, r * 0.52, r * 0.52, 0, Math.PI * 0.86, Math.PI * 2.14);
        ctx.fillStyle = shade(s.coat, 0.28);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-r * 0.3, hy + r * 0.34);
        ctx.quadraticCurveTo(0, hy + r * 0.62, r * 0.3, hy + r * 0.34);
        ctx.quadraticCurveTo(0, hy + r * 0.44, -r * 0.3, hy + r * 0.34);
        ctx.closePath();
        ctx.fillStyle = shade(s.coat, 0.18);
        ctx.fill();
      } else if (s.hat === 'bald') {
        /* Лысина: только венчик волос над ушами — и голова сразу другая. */
        ctx.beginPath();
        ctx.ellipse(0, hy + r * 0.04, r * 0.5, r * 0.44, 0, Math.PI * 1.24, Math.PI * 1.76);
        ctx.strokeStyle = '#33271f';
        ctx.lineWidth = Math.max(1.4, r * 0.13);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(0, hy - r * 0.08, r * 0.5, r * 0.46, 0, Math.PI * 1.02, Math.PI * 1.98);
        ctx.fillStyle = s.sex === 'f' ? '#3b2a25' : '#2b211c';
        ctx.fill();
        if (s.sex === 'f') {
          /* Прядь у виска: женский силуэт иначе не отличить от мужского. */
          ctx.beginPath();
          ctx.moveTo(-r * 0.46, hy - r * 0.12);
          ctx.quadraticCurveTo(-r * 0.56, hy + r * 0.3, -r * 0.34, hy + r * 0.46);
          ctx.quadraticCurveTo(-r * 0.3, hy + r * 0.1, -r * 0.34, hy - r * 0.1);
          ctx.closePath();
          ctx.fillStyle = '#3b2a25';
          ctx.fill();
        }
      }

      /* Лицо. Ночью его не видно вовсе, у мёртвых — тоже. */
      if (!dead && st.night < 0.55) {
        var faceA = 1 - st.night / 0.55;
        ctx.save();
        ctx.globalAlpha *= faceA;
        ctx.fillStyle = 'rgba(24,16,13,.78)';
        var eo = r * 0.17, ey = hy + r * 0.04;
        [-1, 1].forEach(function (side) {
          ctx.beginPath();
          ctx.ellipse(side * eo, ey, r * 0.055, r * 0.07, 0, 0, Math.PI * 2);
          ctx.fill();
        });
        /* Говорит — рот открывается; молчит — одна тонкая черта. */
        if (s.speaking) {
          var m = 0.35 + Math.abs(Math.sin(now * 0.013)) * 0.65;
          ctx.beginPath();
          ctx.ellipse(0, hy + r * 0.27, r * 0.11, r * 0.04 + r * 0.07 * m, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(24,16,13,.5)';
          ctx.lineWidth = Math.max(1, r * 0.05);
          ctx.beginPath();
          ctx.moveTo(-r * 0.1, hy + r * 0.27);
          ctx.lineTo(r * 0.1, hy + r * 0.27);
          ctx.stroke();
        }
        ctx.restore();
      }

      /* Мёртвый: меловой крест. Рисуем внутри того же поворота, что и корпус,
         иначе крест остаётся висеть там, где человек сидел, а тело лежит
         рядом — так и было в первой версии задника. */
      if (dead && fall > 0.35) {
        ctx.save();
        ctx.globalAlpha = clamp((fall - 0.35) / 0.5, 0, 1) * 0.9;
        ctx.strokeStyle = C.chalk;
        ctx.lineWidth = Math.max(1.6, r * 0.12);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-r * 0.44, hy - r * 0.42); ctx.lineTo(r * 0.44, hy + r * 0.42);
        ctx.moveTo(r * 0.44, hy - r * 0.42); ctx.lineTo(-r * 0.44, hy + r * 0.42);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      /* Ваше место: подставка выкрашена тёплым и подчёркнута. Дуга под
         фигурой читалась случайной улыбкой и ни на что не указывала. */
      if (s.you) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(0, r * 1.1, r * 0.94, r * 0.25, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgba(C.tallow, 0.30);
        ctx.fill();
        ctx.strokeStyle = rgba(C.tallow, 0.85);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    }

    /* Табличка имени: писаная карточка на дощечке. Всегда внутри кадра. */
    function paintPlate(s, now, dead, fade) {
      var r = s.r;
      var pw = clamp(r * 5.0, 76, 168);
      var ph = clamp(r * 1.42, 21, 32);
      var px = clamp(s.x - pw / 2, 4, Math.max(4, W - pw - 4));
      /* Нижняя граница — не край кадра, а верх дока действий: подпись ближнего
         места иначе уезжала под кнопки и обрезалась ровно там, где написано
         «вы». Отступы интерфейса посчитаны в раскладке. */
      var floorLimit = Math.max(40, H - (geo.avoid ? geo.avoid.bottom : 0) - ph - 6);
      /* Дальние места подписываем над головой: под ними лежит сукно, и
         табличка уезжала прямо на стол. Ближние — под подставкой. */
      var py = clamp(s.behind ? s.y - r * 2.5 - ph : s.y + r * 1.42, 4, floorLimit);

      ctx.save();
      ctx.globalAlpha = dead ? 0.6 : fade;
      roundRect(px, py, pw, ph, 3);
      ctx.fillStyle = 'rgba(10,8,9,.86)';
      ctx.fill();
      ctx.strokeStyle = s.you ? rgba(C.tallow, 0.8) : rgba(C.bone, 0.13);
      ctx.lineWidth = 1;
      ctx.stroke();

      /* Номер места слева, в наборном шрифте афиши. */
      var numW = ph * 0.86;
      ctx.fillStyle = rgba(C.tallow, dead ? 0.4 : 0.85);
      ctx.font = '600 ' + Math.round(ph * 0.5) + 'px ' + DISPLAY;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.seat), px + numW / 2, py + ph / 2 + 0.5);

      ctx.strokeStyle = rgba(C.bone, 0.1);
      ctx.beginPath();
      ctx.moveTo(px + numW, py + 3);
      ctx.lineTo(px + numW, py + ph - 3);
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = dead ? C.plasterFaint : (s.you ? C.bone : C.plaster);
      var label = fitText(s.name, pw - numW - 10, Math.min(14, ph * 0.46), 8.5, 500, SANS);
      ctx.fillText(label, px + numW + 5, py + ph / 2 + 0.5);

      /* Голоса за казнь — засечки мелом справа: считаются глазом, без цифр. */
      if (s.votes > 0) {
        ctx.strokeStyle = C.chalk;
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        var vx = px + pw - 4;
        for (var i = 0; i < Math.min(s.votes, 6); i++) {
          ctx.beginPath();
          ctx.moveTo(vx - i * 4, py + ph - 4);
          ctx.lineTo(vx - i * 4 + 2, py + 4);
          ctx.stroke();
        }
      }
      ctx.restore();

      /* Раскрытая роль: карточка под табличкой. */
      if (s.revealed && ROLE_VIS[s.revealed]) {
        var meta = ROLE_VIS[s.revealed];
        var cw = clamp(r * 4.4, 64, 148), chh = clamp(r * 1.2, 17, 26);
        var cx = clamp(s.x - cw / 2, 4, Math.max(4, W - cw - 4));
        var cy = clamp(s.behind ? py - chh - 3 : py + ph + 3, 4,
          Math.max(4, H - (geo.avoid ? geo.avoid.bottom : 0) - chh - 4));
        ctx.save();
        roundRect(cx, cy, cw, chh, 2);
        ctx.fillStyle = 'rgba(241,236,225,.93)';
        ctx.fill();
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = shade(meta.color, -0.45);
        ctx.font = '700 ' + Math.round(Math.min(12, chh * 0.55)) + 'px ' + SANS;
        ctx.fillText(meta.ru.toUpperCase(), cx + cw / 2, cy + chh / 2 + 0.5);
        ctx.restore();
      }

      /* Служебные пометки: без связи, готов. Рисуем точкой у номера. */
      if (s.offline || s.ready) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(px + 3.5, py + 3.5, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = s.offline ? C.bruise : C.verdigris;
        ctx.fill();
        ctx.restore();
      }
    }

    /* Кегль подбирается так, чтобы длинное имя не вылезло за карточку. */
    function fitText(text, maxW, startPx, minPx, weight, fam) {
      var px = startPx;
      ctx.font = weight + ' ' + px + 'px ' + fam;
      while (px > minPx && ctx.measureText(text).width > maxW) {
        px -= 0.5;
        ctx.font = weight + ' ' + px + 'px ' + fam;
      }
      var out = text;
      if (ctx.measureText(out).width > maxW) {
        while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1);
        out += '…';
      }
      return out;
    }

    /* --------------------------------------------------------------------- */
    /* меловые линии голосования                                              */
    /* --------------------------------------------------------------------- */
    function paintArrows() {
      if (!st.arrows.length) return;
      ctx.save();
      ctx.lineCap = 'round';
      st.arrows.forEach(function (ar) {
        var a = seat(ar.from), b = seat(ar.to);
        if (!a || !b) return;
        /* Линия идёт от плеча к плечу и заметно выгибается вверх: прямая
           через весь кадр читалась случайной царапиной по заднику. */
        var x1 = a.x, y1 = a.y - a.r * 0.5, x2 = b.x, y2 = b.y - b.r * 0.9;
        var span = Math.hypot(x2 - x1, y2 - y1);
        var mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - span * 0.26;
        var t = clamp(ar.k, 0, 1);
        var ex = lerp(lerp(x1, mx, t), lerp(mx, x2, t), t);
        var ey = lerp(lerp(y1, my, t), lerp(my, y2, t), t);
        ctx.strokeStyle = rgba(C.bone, 0.42 + 0.2 * t);
        ctx.lineWidth = 2.4;
        ctx.setLineDash([9, 6]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(lerp(x1, mx, t), lerp(y1, my, t), ex, ey);
        ctx.stroke();
        ctx.setLineDash([]);
        if (t > 0.85) {
          var ang = Math.atan2(y2 - my, x2 - mx);
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - Math.cos(ang - 0.44) * 13, y2 - Math.sin(ang - 0.44) * 13);
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - Math.cos(ang + 0.44) * 13, y2 - Math.sin(ang + 0.44) * 13);
          ctx.stroke();
        }
      });
      ctx.restore();
    }

    /* --------------------------------------------------------------------- */
    /* кадр                                                                   */
    /* --------------------------------------------------------------------- */
    function draw(now) {
      if (!ctx || !W) return;
      now = now === undefined ? (global.performance || Date).now() : now;

      var shake = 0;
      if (now < st.shakeUntil) {
        var left = (st.shakeUntil - now) / 380;
        shake = Math.sin(now / 21) * 3.4 * left * (st.shakeK || 1);
      }

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.save();
      if (shake) ctx.translate(shake, shake * 0.35);
      paintWall(now);
      /* Порядок и есть вся глубина плоской сцены: дальние — стол — ближние. */
      var behind = st.behind || [], front = st.front || [];
      for (var i = 0; i < behind.length; i++) paintSeat(behind[i], now);
      paintTable(now);
      paintArrows();
      for (var j = 0; j < front.length; j++) paintSeat(front[j], now);
      /* Таблички — последним слоем: имя дальнего места не должно уходить под
         стол только потому, что человек сидит с той стороны. */
      if (st.plates) {
        for (var k = 0; k < st.seats.length; k++) {
          var s = st.seats[k];
          paintPlate(s, now, !s.alive, lerp(0.72, 1, s.depth));
        }
      }
      ctx.restore();
    }

    /* --------------------------------------------------------------------- */
    /* попадание курсором и проекция                                          */
    /* --------------------------------------------------------------------- */
    function hitTest(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      var x = clientX - rect.left, y = clientY - rect.top;
      var best = null, bestD = Infinity;
      for (var i = 0; i < st.seats.length; i++) {
        var s = st.seats[i];
        /* Целимся по фигуре целиком, включая табличку: на телефоне попасть
           в голову размером с ноготь невозможно. */
        var dx = (x - s.x) / (s.r * 1.5);
        var dy = (y - (s.y - s.r * 0.3)) / (s.r * 2.1);
        var d = dx * dx + dy * dy;
        if (d < 1 && d < bestD) { bestD = d; best = s; }
      }
      return best;
    }

    function project(id, yOff) {
      var s = seat(id);
      if (!s) return null;
      /* yOff приходит из объёмной сцены в её метрах (1.62 — над головой).
         Переводим в пропорцию радиуса фигуры, чтобы подписи в обоих режимах
         висели на одной высоте относительно человека. */
      var lift = yOff === undefined ? 1 : clamp(yOff / 1.62, 0.2, 2.4);
      return {
        x: s.x,
        y: s.y - s.r * 2.0 * lift,
        visible: true,
        depth: 1 - s.depth
      };
    }

    /* --------------------------------------------------------------------- */
    /* события мыши и пальца                                                  */
    /* --------------------------------------------------------------------- */
    var press = null;
    function onDown(e) {
      press = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
    }
    function onMove(e) {
      if (press && press.id === e.pointerId) {
        press.moved += Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y);
        press.x = e.clientX; press.y = e.clientY;
      }
      if (!opts.onHover) return;
      var s = hitTest(e.clientX, e.clientY);
      canvas.style.cursor = (s && st.pickable && s.target) ? 'pointer' : '';
      opts.onHover(s ? s.id : null);
    }
    function onUp(e) {
      var wasPress = press && press.id === e.pointerId && press.moved < 8;
      press = null;
      if (!wasPress || !opts.onPick || !st.pickable) return;
      var s = hitTest(e.clientX, e.clientY);
      if (s) opts.onPick(s.id);
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', function () { press = null; });

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(container);
    global.addEventListener('resize', measure, { passive: true });
    measure();

    global.__flatTableProbe = function () {
      return {
        night: +st.night.toFixed(3), plan: +st.plan.toFixed(3), glow: +st.glow.toFixed(3),
        bright: st.bright, plates: st.plates, seats: st.seats.length,
        dead: st.seats.filter(function (s) { return !s.alive; }).length,
        targets: st.seats.filter(function (s) { return s.target; }).length,
        speaking: st.seats.filter(function (s) { return s.speaking; }).length,
        w: W, h: H, r: st.seats.length ? +st.seats[0].r.toFixed(1) : 0
      };
    };

    return {
      canvas: canvas,
      state: st,
      seats: function () { return st.seats; },
      seat: seat,
      setSeats: setSeats,
      layout: layout,
      resize: measure,
      draw: draw,
      hitTest: hitTest,
      project: project,
      calm: function () { return calm; },
      shake: function (k) {
        st.shakeUntil = (global.performance || Date).now() + 380;
        st.shakeK = k || 1;
      },
      dispose: function () {
        if (ro) ro.disconnect();
        global.removeEventListener('resize', measure);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        ctx = null;
      }
    };
  };

  global.FlatTablePalette = C;
  global.FlatTableCoats = COATS;

  /* Крючок для стенда: сцену нельзя проверить снимком, если непонятно, какое
     у неё состояние. Отдаём только числа, ничего секретного здесь нет. */
  global.__flatTableProbe = null;
})(window);
