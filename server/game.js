/* =========================================================================
   Серверный движок сетевой партии.
   Вся секретная информация живёт только здесь: клиент получает
   урезанную картинку через viewFor(userId).
   ========================================================================= */
'use strict';
const C = require('../shared/game-config.js');
const ROLE = C.ROLE;

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
const now = () => Date.now();

class Game {
  /**
   * @param {Array<{id:string,name:string}>} members
   * @param {string} scenarioId
   */
  constructor(members, scenarioId, opts) {
    opts = opts || {};
    const n = members.length;
    /* Видят ли выбывшие ночной шёпот мафии. По умолчанию нет: за одним столом
       в одной комнате выбывший, читающий переписку мафии, знает весь расклад,
       а живым остаётся верить, что он промолчит. Хозяин может включить —
       осознанно, для своей компании. */
    this.deadSeeAll = !!opts.deadSeeAll;
    this.timing = C.timing(n);
    this.scenario = C.scenarioById(scenarioId) || pick(C.scenariosFor(n)) || C.SCENARIOS[0];
    this.composition = C.composition(n);

    const roles = shuffle(C.rolePool(n));
    this.players = members.map((m, i) => ({
      id: m.id,
      name: m.name,
      seat: i + 1,
      role: roles[i],
      alive: true,
      deathDay: null,
      deathCause: null
    }));

    this.day = 0;
    this.phase = 'prologue';        // prologue | night | morning | day | vote | runoff | over
    this.deadline = now() + 12000;
    this.finished = false;
    this.winner = null;
    this.log = [];                  // публичный протокол
    this.chat = [];                 // { channel:'town'|'mafia'|'ghost', from, name, text, ts }
    this.nightActions = { kill: {}, heal: {}, check: {} };
    this.lastHealed = {};           // doctorId -> targetId прошлой ночи
    this.checkResults = {};         // sheriffId -> [{targetId, name, isMafia, day}]
    this.votes = {};                // voterId -> targetId | 'skip'
    this.runoffOf = null;           // список id для переголосовки
    this.omenStep = 0;
    /* Кто сейчас без связи. Такие игроки не должны держать фазу: раньше
       один закрытый ноутбук растягивал ночь на полный таймаут, и это
       читалось как «лаги». */
    this.offline = new Set();
    /* Кто встал и ушёл. Место за столом остаётся (движок не умеет убирать
       игрока посреди партии, и это правильно: состав ролей уже роздан), но
       ходов от него никто не ждёт, а вернуться он может в любой момент. */
    this.left = new Set();

    this.pushLog('story', this.scenario.prologue);
    this.pushLog('sys', 'Состав стола: ' + C.compositionLabel(n) + '.');
  }

  /* ------------------------------ утилиты ------------------------------ */
  pushLog(kind, text) {
    this.log.push({ kind, text, day: this.day, ts: now() });
    if (this.log.length > 400) this.log.shift();
  }
  p(id) { return this.players.find(x => x.id === id) || null; }
  alive() { return this.players.filter(x => x.alive); }
  aliveMafia() { return this.alive().filter(x => this.isMafia(x.id)); }
  aliveTown() { return this.alive().filter(x => !this.isMafia(x.id)); }
  isMafia(id) { const p = this.p(id); return !!p && (p.role === ROLE.MAFIA || p.role === ROLE.DON); }
  nameOf(id) { const p = this.p(id); return p ? p.name : '?'; }
  secondsLeft() { return Math.max(0, Math.ceil((this.deadline - now()) / 1000)); }

  /* ------------------------------ чат ------------------------------ */
  /* Кого назвали в реплике: имя в любом падеже или номер места («№3», «3-й»). */
  mentionsIn(text) {
    const low = ' ' + String(text || '').toLowerCase().replace(/\u0451/g, '\u0435')
      .replace(/[^0-9a-z\u0430-\u044f\s\u2116#-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const out = [];
    for (const pl of this.players) {
      const nm = String(pl.name || '').toLowerCase().replace(/\u0451/g, '\u0435');
      if (!nm) continue;
      const stem = nm.length > 4 ? nm.slice(0, nm.length - 1) : nm;
      const bySeat = new RegExp('(^|[\\s\\u2116#])' + pl.seat + '(-\u0439|-\u0433\u043e|[\\s,.!?:;]|$)').test(low);
      if (low.indexOf(' ' + stem) >= 0 || bySeat) out.push({ id: pl.id, seat: pl.seat, name: pl.name });
    }
    return out;
  }

  say(userId, text, channel) {
    const p = this.p(userId);
    if (!p) return { error: 'Вы не за столом' };
    text = String(text || '').slice(0, 400).trim();
    if (!text) return { error: 'Пустое сообщение' };

    const t = now();

    let ch = channel || 'town';
    if (!p.alive) ch = 'ghost';
    else if (ch === 'mafia' && !(this.isMafia(userId) && this.phase === 'night')) return { error: 'Ночной чат сейчас недоступен' };
    else if (ch === 'town' && !(this.phase === 'prologue' || this.phase === 'day' || this.phase === 'vote' || this.phase === 'runoff' || this.phase === 'morning' || this.phase === 'over')) {
      return { error: 'Город спит — говорить нельзя' };
    }

    /* антифлуд общего стола: шёпот мафии и голоса за чертой не ограничены */
    if (ch === 'town') {
      if (p.lastSayAt && t - p.lastSayAt < 900) return { error: 'Не так быстро — дайте столу вставить слово' };
      if (p.lastSayText === text && t - (p.lastSayTextAt || 0) < 15000) return { error: 'Вы уже это сказали' };
      p.lastSayAt = t;
      p.lastSayText = text;
      p.lastSayTextAt = t;
    }

    const mentions = this.mentionsIn(text).filter(m => m.id !== userId);
    this.chat.push({
      channel: ch, from: userId, name: p.name, seat: p.seat, text, ts: t, day: this.day,
      mentions: mentions.map(m => m.id),
      mentionNames: mentions.map(m => m.name)
    });
    if (this.chat.length > 500) this.chat.shift();

    /* обращение по имени попадает в протокол — его видят все, кто читает канал */
    if (ch === 'town' && mentions.length) {
      this.pushLog('talk', p.name + ' обращается к: ' + mentions.map(m => m.name).join(', '));
    }
    return { ok: true, mentions: mentions.map(m => m.id) };
  }

  /* ------------------------------ действия ------------------------------ */
  action(userId, type, targetId) {
    const me = this.p(userId);
    if (!me || !me.alive) return { error: 'Действие недоступно' };
    const t = targetId ? this.p(targetId) : null;

    if (type === 'kill') {
      if (this.phase !== 'night' || !this.isMafia(userId)) return { error: 'Не сейчас' };
      if (!t || !t.alive || this.isMafia(targetId)) return { error: 'Неверная цель' };
      this.nightActions.kill[userId] = targetId;
      return { ok: true };
    }
    if (type === 'heal') {
      if (this.phase !== 'night' || me.role !== ROLE.DOCTOR) return { error: 'Не сейчас' };
      if (!t || !t.alive) return { error: 'Неверная цель' };
      if (this.lastHealed[userId] === targetId) return { error: 'Этого же человека две ночи подряд лечить нельзя' };
      this.nightActions.heal[userId] = targetId;
      return { ok: true };
    }
    if (type === 'check') {
      if (this.phase !== 'night' || me.role !== ROLE.SHERIFF) return { error: 'Не сейчас' };
      if (!t || !t.alive || targetId === userId) return { error: 'Неверная цель' };
      this.nightActions.check[userId] = targetId;
      return { ok: true };
    }
    if (type === 'vote') {
      if (this.phase !== 'vote' && this.phase !== 'runoff') return { error: 'Голосование ещё не идёт' };
      if (targetId !== 'skip') {
        if (!t || !t.alive) return { error: 'Неверная цель' };
        if (this.runoffOf && this.runoffOf.indexOf(targetId) < 0) return { error: 'Этого игрока нет в переголосовке' };
      }
      this.votes[userId] = targetId;
      return { ok: true };
    }
    if (type === 'ready') {           // «я готов дальше» в дневной фазе
      if (this.phase !== 'day') return { error: 'Не сейчас' };
      this.ready = this.ready || {};
      this.ready[userId] = true;
      return { ok: true };
    }
    return { error: 'Неизвестное действие' };
  }

  /* ------------------------------ такт ------------------------------ */
  /** Вызывается сервером раз в секунду. Возвращает true, если состояние изменилось. */
  tick() {
    if (this.finished) return false;
    const expired = now() >= this.deadline;
    let changed = false;

    if (this.phase === 'prologue') {
      if (expired) { this.startNight(); changed = true; }
    } else if (this.phase === 'night') {
      if (expired || this.allNightActionsIn()) { this.resolveNight(); changed = true; }
    } else if (this.phase === 'morning') {
      if (expired) { this.startDay(); changed = true; }
    } else if (this.phase === 'day') {
      const waiting = this.waiting();
      const ready = this.ready || {};
      const allReady = waiting.length > 0 && waiting.every(p => ready[p.id]);
      if (expired || allReady) { this.startVote(); changed = true; }
    } else if (this.phase === 'vote' || this.phase === 'runoff') {
      const waiting = this.waiting();
      const allVoted = waiting.length > 0 && waiting.every(p => this.votes[p.id] !== undefined);
      if (expired || allVoted) { this.resolveVote(); changed = true; }
    }
    return changed;
  }

  /** Обновить список отключившихся. Возвращает true, если состав изменился. */
  setOffline(ids) {
    const next = new Set(ids || []);
    let changed = next.size !== this.offline.size;
    if (!changed) for (const id of next) if (!this.offline.has(id)) { changed = true; break; }
    if (!changed) return false;
    /* пишем в протокол только про живых: выбывшим связь уже не нужна */
    for (const id of next) {
      if (!this.offline.has(id)) {
        const p = this.p(id);
        if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' потерял связь — его хода ждать не будем.');
      }
    }
    for (const id of this.offline) {
      if (!next.has(id)) {
        const p = this.p(id);
        if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' снова на связи.');
      }
    }
    this.offline = next;
    return true;
  }

  /** Живые, от которых имеет смысл ждать хода. */
  waiting() { return this.alive().filter(p => !this.offline.has(p.id)); }

  /** Игрок встал из-за стола. Возвращает true, если состав ожидающих изменился. */
  markLeft(id) {
    const p = this.p(id);
    if (!p || this.left.has(id)) return false;
    this.left.add(id);
    if (p.alive && !this.finished) this.pushLog('sys', p.name + ' вышел из-за стола. Место остаётся за ним.');
    return true;
  }

  /** Игрок вернулся на своё место. */
  markBack(id) {
    if (!this.left.has(id)) return false;
    this.left.delete(id);
    const p = this.p(id);
    if (p && p.alive && !this.finished) this.pushLog('sys', p.name + ' вернулся за стол.');
    return true;
  }

  allNightActionsIn() {
    const on = p => !this.offline.has(p.id);
    const mafiaAlive = this.aliveMafia().filter(on);
    const docs = this.alive().filter(p => p.role === ROLE.DOCTOR && on(p));
    const shs = this.alive().filter(p => p.role === ROLE.SHERIFF && on(p));
    /* Если у стола вообще никого нет на связи, ночь всё равно закроется
       по таймауту — здесь мы только не даём ей закрыться раньше времени. */
    if (!mafiaAlive.length && !docs.length && !shs.length) return false;
    return mafiaAlive.every(p => this.nightActions.kill[p.id])
      && docs.every(p => this.nightActions.heal[p.id])
      && shs.every(p => this.nightActions.check[p.id]);
  }

  /* ------------------------------ фазы ------------------------------ */
  startNight() {
    this.day += 1;
    this.phase = 'night';
    this.nightActions = { kill: {}, heal: {}, check: {} };
    this.ready = {};
    this.deadline = now() + this.timing.night * 1000;
    this.pushLog('night', 'Ночь ' + this.day + '. ' + this.scenario.nightFlavor);
  }

  resolveNight() {
    // 1. жертва мафии: большинство голосов, при ничье решает голос дона
    const tally = {};
    Object.entries(this.nightActions.kill).forEach(([mid, tid]) => {
      if (this.p(tid) && this.p(tid).alive) tally[tid] = (tally[tid] || 0) + 1;
    });
    let victim = null;
    const entries = Object.entries(tally);
    if (entries.length) {
      const max = Math.max(...entries.map(e => e[1]));
      const top = entries.filter(e => e[1] === max).map(e => e[0]);
      if (top.length === 1) victim = top[0];
      else {
        const don = this.aliveMafia().find(p => p.role === ROLE.DON);
        const donPick = don ? this.nightActions.kill[don.id] : null;
        victim = (donPick && top.indexOf(donPick) >= 0) ? donPick : pick(top);
      }
    } else if (this.aliveMafia().length) {
      const targets = this.alive().filter(p => !this.isMafia(p.id));
      if (targets.length) victim = pick(targets).id;   // мафия промолчала — удар вслепую
    }

    // 2. лечение
    const healed = new Set(Object.values(this.nightActions.heal));
    this.lastHealed = Object.assign({}, this.nightActions.heal);

    // 3. проверки шерифа
    Object.entries(this.nightActions.check).forEach(([sid, tid]) => {
      const t = this.p(tid);
      if (!t) return;
      (this.checkResults[sid] = this.checkResults[sid] || []).push({
        targetId: tid, name: t.name, seat: t.seat, isMafia: this.isMafia(tid), day: this.day
      });
    });

    // 4. итог
    this.phase = 'morning';
    this.deadline = now() + this.timing.reveal * 1000;
    this.votes = {};
    this.runoffOf = null;

    if (victim && healed.has(victim)) {
      this.pushLog('morning', 'Утро ' + this.day + '. Этой ночью все выжили — врач успел вовремя.');
    } else if (victim) {
      this.kill(victim, 'night');
      this.pushLog('morning', 'Утро ' + this.day + '. ' + this.nameOf(victim) + ' не дожил' + '(а) до рассвета. Роль: ' +
        C.ROLE_INFO[this.p(victim).role].ru + '. ' + this.scenario.deathFlavor);
    } else {
      this.pushLog('morning', 'Утро ' + this.day + '. Ночь прошла тихо.');
    }

    if (!this.checkWin()) {
      this.omenStep++;
      if (this.scenario.dayFlavor && this.omenStep % 2 === 0) this.pushLog('story', this.scenario.dayFlavor);
    }
  }

  startDay() {
    if (this.finished) return;
    this.phase = 'day';
    this.ready = {};
    this.deadline = now() + this.timing.day * 1000;
    this.pushLog('sys', 'День ' + this.day + '. Обсуждение: ' + Math.round(this.timing.day / 60 * 10) / 10 + ' мин.');
  }

  startVote(candidates) {
    if (this.finished) return;
    this.votes = {};
    if (candidates && candidates.length) {
      this.phase = 'runoff';
      this.runoffOf = candidates;
      this.pushLog('vote', 'Переголосовка между: ' + candidates.map(id => this.nameOf(id)).join(', ') + '.');
    } else {
      this.phase = 'vote';
      this.runoffOf = null;
      this.pushLog('vote', 'Город голосует.');
    }
    this.deadline = now() + this.timing.vote * 1000;
  }

  resolveVote() {
    const tally = {};
    Object.entries(this.votes).forEach(([voter, target]) => {
      const v = this.p(voter);
      if (!v || !v.alive || target === 'skip') return;
      tally[target] = (tally[target] || 0) + 1;
    });
    const entries = Object.entries(tally);
    const wasRunoff = this.phase === 'runoff';

    if (!entries.length) {
      this.pushLog('vote', 'Город никого не выбрал. Казни не будет.');
      return this.afterVote();
    }
    const max = Math.max(...entries.map(e => e[1]));
    const top = entries.filter(e => e[1] === max).map(e => e[0]);

    this.pushLog('vote', 'Итог голосования: ' +
      entries.sort((a, b) => b[1] - a[1]).map(e => this.nameOf(e[0]) + ' — ' + e[1]).join(', ') + '.');

    if (top.length > 1) {
      if (wasRunoff) {
        this.pushLog('vote', 'Снова ничья. Сегодня никого не казнят.');
        return this.afterVote();
      }
      return this.startVote(top);
    }

    const idx = top[0];
    this.kill(idx, 'vote');
    this.pushLog('execution', 'Город казнил ' + this.nameOf(idx) + '. Роль: ' + C.ROLE_INFO[this.p(idx).role].ru + '.');
    this.afterVote();
  }

  afterVote() {
    if (this.checkWin()) return;
    this.startNight();
  }

  kill(id, cause) {
    const p = this.p(id);
    if (!p || !p.alive) return;
    p.alive = false;
    p.deathDay = this.day;
    p.deathCause = cause;
  }

  checkWin() {
    const m = this.aliveMafia().length;
    const t = this.aliveTown().length;
    if (m === 0) return this.finish('town');
    if (m >= t) return this.finish('mafia');
    return false;
  }

  finish(winner) {
    this.finished = true;
    this.winner = winner;
    this.phase = 'over';
    this.deadline = now();
    /* В протокол пишем причину числами: игрок должен понять, почему
       партия закончилась именно сейчас, а не разгадывать метафору. */
    const mafiaAlive = this.alive().filter(p => this.isMafia(p.id)).length;
    const townAlive = this.alive().length - mafiaAlive;
    const mafiaTotal = this.players.filter(p => this.isMafia(p.id)).length;
    this.pushLog('end', winner === 'town'
      ? 'Город победил: вся мафия (' + mafiaTotal + ') выбыла из игры.'
      : 'Мафия победила: её осталось ' + mafiaAlive + ', мирных — ' + townAlive +
        '. Город больше не может её переголосовать.');
    this.pushLog('story', winner === 'town' ? this.scenario.finaleTown : this.scenario.finaleMafia);
    return true;
  }

  /* ------------------------------ вид для игрока ------------------------------ */
  viewFor(userId) {
    const me = this.p(userId);
    const isSpectator = !me;
    const revealAll = this.finished;
    const iAmMafia = me ? this.isMafia(userId) : false;

    const players = this.players.map(p => {
      const showRole = revealAll || !p.alive || (iAmMafia && this.isMafia(p.id)) || (me && p.id === me.id);
      return {
        id: p.id, name: p.name, seat: p.seat, alive: p.alive,
        deathDay: p.deathDay, deathCause: p.deathCause,
        role: showRole ? p.role : null,
        roleRu: showRole ? C.ROLE_INFO[p.role].ru : null,
        roleGlyph: showRole ? C.ROLE_INFO[p.role].glyph : null,
        voted: (this.phase === 'vote' || this.phase === 'runoff') && this.votes[p.id] !== undefined,
        ready: this.phase === 'day' && !!(this.ready && this.ready[p.id]),
        offline: this.offline.has(p.id),
        left: this.left.has(p.id)
      };
    });

    const channels = ['town'];
    if (me && !me.alive) channels.push('ghost');
    if (me && me.alive && iAmMafia) channels.push('mafia');
    if (me && !me.alive && this.deadSeeAll) channels.push('mafia');

    /* Кто что читает. Три правила, и каждое из них — про то, чтобы знание не
       утекало из партии:
         общий чат  — всем, включая наблюдателя;
         шёпот мафии — живой мафии, а выбывшим только если хозяин разрешил;
         чат выбывших — самим выбывшим. Наблюдателю он не положен: там роли
           уже раскрыты, и один зритель за спиной ломает партию целиком. */
    const chat = this.chat.filter(m => {
      if (m.channel === 'town') return true;
      if (m.channel === 'mafia') {
        return revealAll || (me && iAmMafia && me.alive) || (me && !me.alive && this.deadSeeAll);
      }
      if (m.channel === 'ghost') return revealAll || (me && !me.alive);
      return false;
    });

    const view = {
      phase: this.phase,
      day: this.day,
      secondsLeft: this.secondsLeft(),
      phaseSeconds: this.phaseSeconds(),
      finished: this.finished,
      winner: this.winner,
      scenario: {
        id: this.scenario.id, title: this.scenario.title, place: this.scenario.place,
        rule: this.scenario.rule, prologue: this.scenario.prologue,
        /* Чем закончилась история. Отдаём только после конца партии:
           до этого оба текста — спойлер. */
        finaleTown: revealAll ? this.scenario.finaleTown : null,
        finaleMafia: revealAll ? this.scenario.finaleMafia : null
      },
      composition: this.composition,
      compositionLabel: C.compositionLabel(this.players.length),
      players,
      log: this.log.slice(-120),
      chat: chat.slice(-120),
      channels,
      aliveCount: this.alive().length,
      you: null
    };

    if (me) {
      const info = C.ROLE_INFO[me.role];
      view.you = {
        id: me.id, name: me.name, seat: me.seat, alive: me.alive,
        role: me.role, roleRu: info.ru, roleGlyph: info.glyph, roleDesc: info.desc,
        team: info.team,
        partners: iAmMafia ? this.players.filter(p => this.isMafia(p.id) && p.id !== me.id)
          .map(p => ({ id: p.id, name: p.name, seat: p.seat, role: p.role, alive: p.alive })) : [],
        checks: me.role === ROLE.SHERIFF ? (this.checkResults[me.id] || []) : [],
        myKill: this.nightActions.kill[me.id] || null,
        myHeal: this.nightActions.heal[me.id] || null,
        myCheck: this.nightActions.check[me.id] || null,
        healBlocked: this.lastHealed[me.id] || null,
        myVote: this.votes[me.id] !== undefined ? this.votes[me.id] : null,
        ready: !!(this.ready && this.ready[me.id]),
        canAct: this.canAct(me)
      };
      if (this.phase === 'night' && iAmMafia) {
        view.mafiaVotes = Object.entries(this.nightActions.kill)
          .map(([mid, tid]) => ({ from: this.nameOf(mid), to: this.nameOf(tid) }));
      }
    }
    if (this.runoffOf) view.runoffOf = this.runoffOf;
    return view;
  }

  phaseSeconds() {
    if (this.phase === 'night') return this.timing.night;
    if (this.phase === 'day') return this.timing.day;
    if (this.phase === 'vote' || this.phase === 'runoff') return this.timing.vote;
    if (this.phase === 'morning') return this.timing.reveal;
    return 12;
  }

  canAct(me) {
    if (!me.alive || this.finished) return null;
    if (this.phase === 'night') {
      if (this.isMafia(me.id)) return 'kill';
      if (me.role === ROLE.DOCTOR) return 'heal';
      if (me.role === ROLE.SHERIFF) return 'check';
      return null;
    }
    if (this.phase === 'vote' || this.phase === 'runoff') return 'vote';
    if (this.phase === 'day') return 'talk';
    return null;
  }
}

module.exports = { Game, shuffle, pick };
