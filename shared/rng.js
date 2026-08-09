/* =============================================================================
   rng.js — свой генератор случайных чисел с семенем.

   Зачем он нужен. Math.random() нельзя ни повторить, ни объяснить. Из-за этого
   у партии нет двух важных свойств:

     • Разбор. Игрок говорит «нам выпало три чёрных подряд на одних и тех же
       местах» — и проверить это невозможно: партия не воспроизводится.
     • Устойчивые измерения. Симулятор баланса на десять тысяч партий каждый
       раз даёт немного другие числа, и понять, стало ли лучше от правки, можно
       только по крупным сдвигам.

   Здесь xorshift32: четыре строки, целиком повторяемый, распределение для
   игровых нужд более чем достаточное. Криптографии от него не требуется —
   секреты партии живут не в случайных числах, а в том, что сервер не отдаёт
   клиенту чужие роли.

   Работает и в Node (require), и в браузере (<script src>).
   ============================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MafiaRng = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /** Строка или число → 32-битное семя. Одинаковый вход даёт одинаковое семя. */
  function seedFrom(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return (Math.floor(value) >>> 0) || 1;
    }
    const s = String(value === undefined || value === null ? '' : value);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h >>> 0) || 1;
  }

  /** Случайное семя для новой партии: короткая читаемая строка. */
  function freshSeed() {
    const n = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    return n.toString(36);
  }

  /**
   * Генератор с семенем.
   * @param {string|number} seed
   */
  function createRng(seed) {
    let state = seedFrom(seed);

    /** Следующее число в [0, 1). */
    function next() {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    }

    const rng = {
      seed: String(seed),
      next: next,
      /** Целое в [0, n). */
      int(n) { return Math.floor(next() * n); },
      /** Случайный элемент. Пустой массив даёт undefined — как и Math.random-версия. */
      pick(list) { return list && list.length ? list[Math.floor(next() * list.length)] : undefined; },
      /** Вероятность p. */
      chance(p) { return next() < p; },
      /** Перемешивание Фишера—Йетса. Исходный массив не меняется. */
      shuffle(list) {
        const out = (list || []).slice();
        for (let i = out.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = out[i]; out[i] = out[j]; out[j] = t;
        }
        return out;
      },
      /** Отдельный поток от того же семени: полезно, чтобы один расход чисел не сдвигал другой. */
      fork(tag) { return createRng(rng.seed + ':' + tag); }
    };
    return rng;
  }

  return { createRng, seedFrom, freshSeed };
});
