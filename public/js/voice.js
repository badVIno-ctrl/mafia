/* =========================================================================
   Voice — озвучивание партии разными голосами.

   Устройство простое: в браузере есть один синтезатор речи и набор системных
   голосов. Голосов обычно меньше, чем людей за столом, поэтому характер
   персонажа складывается из трёх вещей: какой системный голос ему достался,
   насколько высоко он говорит (pitch) и насколько быстро (rate). Комбинации
   раздаются детерминированно по номеру места, поэтому Гриша с места №3
   звучит одинаково всю партию, а не меняет голос от реплики к реплике.

   Отдельно стоит голос ведущего: он объявляет фазы, говорит ровнее и ниже
   остальных и имеет право перебить любую реплику.

   Наружу отдаётся событие onSpeak(id) — им сцена открывает рот фигуре.
   ========================================================================= */
(function (w) {
  'use strict';

  var synth = w.speechSynthesis || null;
  var KEY = 'mafia.voice.on';

  /* Характеры голосов: сдвиг высоты и темпа относительно нейтрального.
     Порядок подобран так, чтобы соседи по столу звучали по-разному. */
  var TIMBRES = [
    { pitch: 0.82, rate: 0.94 },   // низкий, медленный — «тяжёлый» человек
    { pitch: 1.22, rate: 1.06 },   // высокий, торопливый
    { pitch: 0.95, rate: 1.00 },   // нейтральный
    { pitch: 1.08, rate: 0.90 },   // высоковатый, тянет слова
    { pitch: 0.74, rate: 1.04 },   // очень низкий, быстрый
    { pitch: 1.34, rate: 0.96 },   // самый высокий
    { pitch: 0.88, rate: 1.12 },   // хрипловатый скороговоркой
    { pitch: 1.14, rate: 1.16 },
    { pitch: 0.79, rate: 0.88 },
    { pitch: 1.02, rate: 1.09 }
  ];

  var Voice = {
    enabled: false,
    ready: false,
    voices: [],
    ruVoices: [],
    byId: {},          // id игрока -> { voice, pitch, rate }
    queue: [],
    current: null,
    lastLine: null,
    _speakCbs: [],

    available: function () { return !!synth && typeof w.SpeechSynthesisUtterance === 'function'; },

    /* Системные голоса приходят асинхронно: в Chrome список пуст до события. */
    init: function () {
      if (!Voice.available()) return false;
      function load() {
        Voice.voices = synth.getVoices() || [];
        Voice.ruVoices = Voice.voices.filter(function (v) { return /^ru/i.test(v.lang || ''); });
        Voice.ready = Voice.voices.length > 0;
      }
      load();
      if (!Voice.ready && 'onvoiceschanged' in synth) synth.onvoiceschanged = load;
      try { Voice.enabled = localStorage.getItem(KEY) === '1'; } catch (e) { /* приватный режим */ }
      return true;
    },

    setEnabled: function (on) {
      Voice.enabled = !!on;
      try { localStorage.setItem(KEY, Voice.enabled ? '1' : '0'); } catch (e) { }
      if (!Voice.enabled) Voice.stop();
      return Voice.enabled;
    },

    onSpeak: function (cb) { Voice._speakCbs.push(cb); },
    _emit: function (id) { Voice._speakCbs.forEach(function (cb) { try { cb(id); } catch (e) { } }); },

    /** Раздать голоса столу. Вызывать один раз на партию. */
    assign: function (players) {
      Voice.byId = {};
      (players || []).forEach(function (p, i) {
        var seat = p.seat || (i + 1);
        var t = TIMBRES[(seat - 1) % TIMBRES.length];
        /* Системные голоса тоже раздаём по кругу — так тембры не повторяются
           у соседей, даже если голосов всего два. */
        var pool = Voice.ruVoices.length ? Voice.ruVoices : Voice.voices;
        var v = pool.length ? pool[(seat - 1) % pool.length] : null;
        Voice.byId[p.id] = {
          voice: v,
          pitch: t.pitch + ((seat * 7) % 5) * 0.012,
          rate: t.rate + ((seat * 11) % 5) * 0.008,
          name: p.name
        };
      });
    },

    /**
     * say(text, opts)
     * opts.from     — id игрока (его тембр и подсветка рта)
     * opts.narrator — говорит ведущий
     * opts.urgent   — перебить текущую реплику
     */
    say: function (text, opts) {
      opts = opts || {};
      if (!Voice.enabled || !Voice.available()) return false;
      text = String(text == null ? '' : text).trim();
      if (!text) return false;
      /* Обращения вида «№3» синтезатор читает как «номер три» невнятно —
         заменяем на слова, чтобы речь оставалась человеческой. */
      text = text.replace(/№\s*(\d+)/g, 'номер $1').slice(0, 400);

      Voice.lastLine = { text: text, opts: opts };
      var item = { text: text, from: opts.from || null, narrator: !!opts.narrator, onend: opts.onend };
      if (opts.urgent) {
        Voice.queue.length = 0;
        Voice.stop(true);
        Voice.queue.push(item);
      } else {
        if (Voice.queue.length > 6) Voice.queue.shift();   // не копим гору реплик
        Voice.queue.push(item);
      }
      Voice._pump();
      return true;
    },

    repeat: function () {
      if (!Voice.lastLine) return false;
      var l = Voice.lastLine;
      return Voice.say(l.text, Object.assign({}, l.opts, { urgent: true }));
    },

    stop: function (keepQueue) {
      if (!keepQueue) Voice.queue.length = 0;
      Voice.current = null;
      try { synth.cancel(); } catch (e) { }
      Voice._emit(null);
    },

    _pump: function () {
      if (!Voice.enabled || Voice.current || !Voice.queue.length) return;
      var item = Voice.queue.shift();
      var u = new w.SpeechSynthesisUtterance(item.text);
      var prof = item.narrator
        ? { voice: (Voice.ruVoices[0] || Voice.voices[0] || null), pitch: 0.7, rate: 0.92 }
        : (Voice.byId[item.from] || { voice: Voice.ruVoices[0] || Voice.voices[0] || null, pitch: 1, rate: 1 });
      if (prof.voice) u.voice = prof.voice;
      u.lang = (prof.voice && prof.voice.lang) || 'ru-RU';
      u.pitch = Math.max(0, Math.min(2, prof.pitch));
      u.rate = Math.max(0.1, Math.min(2, prof.rate));
      u.volume = 1;
      Voice.current = u;
      u.onstart = function () { Voice._emit(item.from || null); };
      u.onend = u.onerror = function () {
        Voice.current = null;
        Voice._emit(null);
        if (item.onend) try { item.onend(); } catch (e) { }
        Voice._pump();
      };
      try { synth.speak(u); } catch (e) { Voice.current = null; }
    }
  };

  Voice.init();
  w.Voice = Voice;
})(window);
