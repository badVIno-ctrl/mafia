/* =========================================================================
   VoiceChat — голосовой чат комнаты на WebRTC.

   Топология — «каждый с каждым» (mesh). Для стола на 6–20 человек это
   правильный выбор: нет сервера-микшера, а значит нет и лишней задержки —
   звук идёт напрямую от браузера к браузеру. Сервер участвует только в
   знакомстве: пересылает offer/answer/candidate через уже существующий
   SSE-канал (см. /api/rooms/signal).

   Кто кому звонит, решается по идентификаторам: звонит тот, чей id меньше.
   Без этого правила два браузера одновременно шлют offer друг другу и
   соединение «схлопывается» (классический glare).

   Уровень звука каждого участника считается локально по его же потоку —
   поэтому «кто сейчас говорит» видно без единого запроса к серверу.
   ========================================================================= */
(function (w) {
  'use strict';

  /* Куда обращаться за своим внешним адресом. По умолчанию — никуда: игра
     должна работать в закрытом контуре без единого обращения наружу, и в
     локальной сети прямые адреса находятся сами.

     Через интернет прямые адреса за NAT не находятся, поэтому сервер отдаёт
     свои STUN/TURN в /api/ice (из переменных окружения). Список подставляется
     до включения микрофона — см. VoiceChat.useIce. */
  var RTC_CFG = {
    iceServers: [],
    iceCandidatePoolSize: 2
  };

  function createVoiceChat(opts) {
    opts = opts || {};
    var selfId = opts.selfId;
    var peers = new Map();       // id -> { pc, audio, stream, analyser, state }
    var known = new Set();       // кто отозвался и готов говорить
    var local = { stream: null, ctx: null, analyser: null, data: null, muted: false };
    var running = false;
    var levelTimer = null;

    function log() { if (opts.debug) console.log.apply(console, ['[voice]'].concat([].slice.call(arguments))); }
    function fail(e) { if (opts.onError) opts.onError(e); }

    function send(to, kind, data) {
      return opts.signal(to, kind, data);
    }

    /* -------------------- измерение громкости -------------------- */
    function ensureCtx() {
      if (local.ctx) return local.ctx;
      var AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return null;
      local.ctx = new AC();
      return local.ctx;
    }

    function meter(stream) {
      var ctx = ensureCtx();
      if (!ctx) return null;
      try {
        var src = ctx.createMediaStreamSource(stream);
        var an = ctx.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0.75;
        src.connect(an);
        return { an: an, buf: new Uint8Array(an.frequencyBinCount) };
      } catch (e) { return null; }
    }

    function levelOf(m) {
      if (!m) return 0;
      m.an.getByteFrequencyData(m.buf);
      var sum = 0;
      for (var i = 2; i < 40; i++) sum += m.buf[i];      // голосовой диапазон
      return Math.min(1, (sum / 38) / 90);
    }

    function startLevels() {
      stopLevels();
      levelTimer = setInterval(function () {
        if (!opts.onLevel) return;
        var lv = local.muted ? 0 : levelOf(local.analyser);
        opts.onLevel(selfId, lv);
        peers.forEach(function (p, id) { opts.onLevel(id, levelOf(p.analyser)); });
      }, 140);
    }
    function stopLevels() { if (levelTimer) clearInterval(levelTimer); levelTimer = null; }

    /* -------------------- соединения -------------------- */
    function makePc(id) {
      var pc = new RTCPeerConnection(RTC_CFG);
      var entry = { pc: pc, audio: null, stream: null, analyser: null, state: 'new' };
      peers.set(id, entry);

      if (local.stream) local.stream.getTracks().forEach(function (t) { pc.addTrack(t, local.stream); });

      pc.onicecandidate = function (e) {
        if (e.candidate) send(id, 'ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      };
      pc.ontrack = function (e) {
        var stream = e.streams[0];
        entry.stream = stream;
        if (!entry.audio) {
          /* Аудио живёт в скрытом элементе: без него Safari не проигрывает поток. */
          var a = document.createElement('audio');
          a.autoplay = true;
          a.playsInline = true;
          a.style.display = 'none';
          document.body.appendChild(a);
          entry.audio = a;
        }
        entry.audio.srcObject = stream;
        var p = entry.audio.play();
        if (p && p.catch) p.catch(function () { /* до первого касания экрана браузер может отказать */ });
        entry.analyser = meter(stream);
        setState(id, 'talking');
      };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'connected') setState(id, 'talking');
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') setState(id, 'lost');
      };
      return entry;
    }

    function setState(id, st) {
      var e = peers.get(id);
      if (e) e.state = st;
      if (opts.onState) opts.onState(id, st);
    }

    async function callPeer(id) {
      var e = peers.get(id) || makePc(id);
      try {
        var offer = await e.pc.createOffer({ offerToReceiveAudio: true });
        await e.pc.setLocalDescription(offer);
        send(id, 'offer', { sdp: e.pc.localDescription.sdp, type: e.pc.localDescription.type });
        setState(id, 'calling');
      } catch (err) { fail(err); }
    }

    function drop(id) {
      var e = peers.get(id);
      if (!e) return;
      try { e.pc.close(); } catch (err) { }
      if (e.audio && e.audio.parentNode) e.audio.parentNode.removeChild(e.audio);
      peers.delete(id);
      known.delete(id);
      if (opts.onState) opts.onState(id, 'off');
    }

    /* -------------------- публичное -------------------- */
    var api = {
      get running() { return running; },
      get muted() { return local.muted; },
      peerIds: function () { return [].concat.apply([], [Array.from(peers.keys())]); },
      stateOf: function (id) { var e = peers.get(id); return e ? e.state : 'off'; },

      async start() {
        if (running) return true;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Браузер не даёт доступ к микрофону');
        local.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
        local.analyser = meter(local.stream);
        local.muted = false;
        running = true;
        startLevels();
        /* Здороваемся со всеми: кто отзовётся — с тем и соединяемся. */
        (opts.getPeers() || []).forEach(function (id) { if (id !== selfId) send(id, 'hello', null); });
        return true;
      },

      stop() {
        running = false;
        stopLevels();
        (opts.getPeers() || []).forEach(function (id) { if (id !== selfId) send(id, 'bye', null); });
        Array.from(peers.keys()).forEach(drop);
        if (local.stream) local.stream.getTracks().forEach(function (t) { t.stop(); });
        local.stream = null; local.analyser = null;
        if (opts.onLevel) opts.onLevel(selfId, 0);
      },

      /* Подставить сервера ICE, полученные от площадки. Действует на все
         соединения, которые будут созданы после вызова. */
      useIce(list) {
        if (Array.isArray(list) && list.length) RTC_CFG.iceServers = list;
        return RTC_CFG.iceServers;
      },

      /* Привести соединения к разрешённому кругу собеседников.

         Это и есть исполнение фаз на стороне звука: наступила ночь — город
         теряет право слышать друг друга, и все линии, кроме мафиозных,
         рвутся. Кладём трубку сами, не дожидаясь, пока сервер откажет в
         следующей записке: иначе уже открытый канал продолжал бы жить. */
      reconcile(allowed) {
        var ok = Object.create(null);
        (allowed || []).forEach(function (id) { ok[id] = true; });
        Array.from(peers.keys()).forEach(function (id) { if (!ok[id]) drop(id); });
        Array.from(known).forEach(function (id) { if (!ok[id]) known.delete(id); });
        if (!running) return;
        Object.keys(ok).forEach(function (id) {
          if (id !== selfId && !peers.has(id)) send(id, 'hello', null);
        });
      },

      setMuted(on) {
        local.muted = !!on;
        if (local.stream) local.stream.getAudioTracks().forEach(function (t) { t.enabled = !local.muted; });
        return local.muted;
      },

      /** Записка от другого игрока (пришла через SSE). */
      async handleSignal(pkt) {
        if (!pkt || !pkt.from || pkt.from === selfId) return;
        var id = pkt.from;

        if (pkt.kind === 'bye') return drop(id);

        if (pkt.kind === 'hello') {
          known.add(id);
          if (!running) return;                     // микрофон выключен — молчим
          send(id, 'hello-ack', null);
          /* Звонит тот, чей id меньше: иначе оба пошлют offer одновременно. */
          if (selfId < id && !peers.has(id)) await callPeer(id);
          return;
        }
        if (pkt.kind === 'hello-ack') {
          known.add(id);
          if (running && selfId < id && !peers.has(id)) await callPeer(id);
          return;
        }
        if (!running) return;

        if (pkt.kind === 'offer') {
          var e = peers.get(id) || makePc(id);
          try {
            await e.pc.setRemoteDescription(new RTCSessionDescription(pkt.data));
            var answer = await e.pc.createAnswer();
            await e.pc.setLocalDescription(answer);
            send(id, 'answer', { sdp: e.pc.localDescription.sdp, type: e.pc.localDescription.type });
          } catch (err) { fail(err); }
          return;
        }
        if (pkt.kind === 'answer') {
          var e2 = peers.get(id);
          if (!e2) return;
          try { await e2.pc.setRemoteDescription(new RTCSessionDescription(pkt.data)); }
          catch (err) { fail(err); }
          return;
        }
        if (pkt.kind === 'ice') {
          var e3 = peers.get(id);
          if (!e3 || !pkt.data) return;
          try { await e3.pc.addIceCandidate(new RTCIceCandidate(pkt.data)); }
          catch (err) { /* кандидат мог опоздать — это нормально */ }
        }
      },

      /** Кто-то вышел из комнаты. */
      forget(id) { drop(id); }
    };

    return api;
  }

  w.createVoiceChat = createVoiceChat;
})(window);
