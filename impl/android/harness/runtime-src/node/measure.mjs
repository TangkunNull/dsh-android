// Measurement bus: the only honest answer to "how big is this element?"
// JS has no layout engine, so rects are produced elsewhere (Yoga in CI, Flutter
// on device) and pushed in. Everything that reads geometry goes through here so
// there is exactly one place to debug when a plugin says "width is 0".
export function createMeasurementBus({ width = 390, height = 844 } = {}) {
  let rects = new Map();
  let generation = 0;
  const subs = new Set();
  const stats = { provides: 0, hits: 0, misses: 0 };

  const bus = {
    viewport: { width, height, dpr: 3 },

    /** Replace the rect table. Keys are IR node ids ('n12') or element mids. */
    provide(next) {
      rects = next instanceof Map ? next : new Map(Object.entries(next || {}));
      generation += 1;
      stats.provides += 1;
      for (const fn of [...subs]) {
        try { fn(generation); } catch { /* a broken observer must not stop layout */ }
      }
    },

    rect(key) {
      const r = key ? rects.get(key) : null;
      if (r) { stats.hits += 1; return r; }
      stats.misses += 1;
      return null;
    },

    has(key) { return rects.has(key); },
    get generation() { return generation; },
    get size() { return rects.size; },
    stats,

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    reset() { rects = new Map(); generation += 1; subs.clear(); stats.provides = 0; stats.hits = 0; stats.misses = 0; },
  };
  return bus;
}

// One window per process, so one active bus: IR nodes need geometry methods and
// they are created by a host config that has no access to the bus instance.
let active = null;
export const setActiveBus = (bus) => { active = bus; return bus; };
export const getActiveBus = () => active;

export const ZERO_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });

/** Normalise the many shapes a layout pass may report into a DOMRect. */
export function toDomRect(r) {
  if (!r) return { ...ZERO_RECT };
  const width = Number(r.width ?? r.w ?? 0);
  const height = Number(r.height ?? r.h ?? 0);
  const x = Number(r.x ?? r.left ?? 0);
  const y = Number(r.y ?? r.top ?? 0);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
}
