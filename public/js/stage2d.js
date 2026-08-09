/* =============================================================================
   stage2d.js — плоская сцена сетевой партии.

   Это второй исполнитель того же контракта, что и stage3d.js: сетевой клиент
   не должен знать, какая декорация стоит на сцене. Он вызывает setSeats,
   присылает состояние в sync и спрашивает project для подписей — а что там,
   выгородка в глубину или писаный задник, решает игрок кнопкой.

       const stage = await mountFlatStage(container, { onPick(id){} });
       stage.setSeats([{ id, name, seat, you }]);
       stage.sync({ phase, players, speakerId, targets });

   Рисование живёт в flat-table.js. Здесь — только перевод состояния партии в
   состояние сцены и собственный кадровый цикл.
   ============================================================================= */

const FADE_MS = 900;          /* смена света день↔ночь: медленнее интерфейса, быстрее фразы */

export async function mountFlatStage(container, opts) {
  opts = opts || {};

  /* Ядро подключаем как обычный скрипт: оно нужно и странице с ботами,
     которая работает без модулей. Если тег ещё не встал — ждём его. */
  if (typeof window.createFlatTable !== 'function') {
    await loadScript('/js/flat-table.js');
  }

  const core = window.createFlatTable(container, {
    onPick: opts.onPick,
    pixelCap: 2,
    /* Панели интерфейса висят поверх сцены: карта роли слева, док действий
       снизу. Сцена обязана о них знать, иначе крайние места окажутся под
       панелью, а подпись ближнего — под кнопками. */
    avoid: ['#rolePane', '#actionDock', '#phaseband', '.phaseband']
  });

  /* Подписи в сетевой партии — это кнопки в DOM над сценой. */
  core.state.plates = false;

  let phase = 'prologue';
  let nightWant = 0;
  let speakerId = null;
  let alive = true;
  let raf = 0;
  let last = 0;

  function setPhase(p) {
    if (!p || p === phase) return;
    phase = p;
    nightWant = p === 'night' ? 1 : 0;
    /* Голосование — жёсткий верхний свет: сцена светлеет и теряет тёплый
       разлив. Отдельного тумблера для этого не нужно, хватает яркости. */
    core.state.bright = p === 'night' ? 1 : 1;
  }

  function setSpeaker(id) {
    speakerId = id || null;
    core.seats().forEach(s => { s.speaking = s.id === speakerId && s.alive; });
  }

  function setTargets(ids) {
    const set = new Set(ids || []);
    core.seats().forEach(s => { s.target = set.has(s.id); });
  }

  function setDead(id) {
    const s = core.seat(id);
    if (!s || !s.alive) return;
    s.alive = false;
    s.speaking = false;
    s.dead = { t0: performance.now() };
    core.shake(0.5);
  }

  function setSeats(list) {
    core.setSeats((list || []).map(p => ({
      id: p.id, name: p.name, seat: p.seat, you: p.you
    })));
    setSpeaker(speakerId);
  }

  /** Принять вид партии целиком — ровно то же, что делает объёмная сцена. */
  function sync(g) {
    if (!g) return;
    if (g.players) {
      g.players.forEach(p => {
        const s = core.seat(p.id);
        if (!s) return;
        if (!p.alive) setDead(p.id);
        s.offline = !!p.offline;
        s.ready = !!p.ready;
        /* Роль показываем только тогда, когда её раскрыл сервер: сцена
           никогда не додумывает то, чего ей не сказали. */
        if (p.role) s.revealed = p.role;
      });
    }
    if (g.phase) setPhase(g.phase);
    if ('speakerId' in g) setSpeaker(g.speakerId);
    if (g.targets) setTargets(g.targets);
    if (g.mafiaGlow !== undefined) core.state.glow = g.mafiaGlow ? 1 : 0;
  }

  /* ------------------------------------------------------------------ */
  /* кадр                                                               */
  /* ------------------------------------------------------------------ */
  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    /* Скрытая вкладка не рисует: телефон в кармане не должен греться. */
    if (document.hidden) return;
    const dt = last ? Math.min(80, now - last) : 16;
    last = now;

    const st = core.state;
    if (Math.abs(st.night - nightWant) > 0.001) {
      const step = dt / FADE_MS;
      st.night += Math.sign(nightWant - st.night) * Math.min(step, Math.abs(nightWant - st.night));
      /* Ночью стол сдвигается ближе к плану: свет сверху, лиц не видно. */
      st.plan = st.night * 0.18;
      core.layout();
    }
    /* Красный отсвет гаснет плавно: резкое переключение читается как сбой. */
    core.draw(now);
  }
  raf = requestAnimationFrame(frame);

  return {
    mode: '2d',
    setSeats, sync, setPhase, setSpeaker, setTargets, setDead,
    project: core.project,
    resize: core.resize,
    shake(k) { core.shake(k ? k * 12 : 1); },
    seatCount() { return core.seats().length; },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      core.dispose();
    }
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-src="' + src + '"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('flat-table-failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('flat-table-failed'));
    document.head.appendChild(s);
  });
}

export default mountFlatStage;
