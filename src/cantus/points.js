// The point library: stable points of every fractal, found offline by tools/build-points.mjs and loaded once, when a
// song first needs them.
//
// Per fractal, at its default slider value:
//   cycles: {period, point: [x, y], z0: [x, y], radius, level, bright}, z0 a start on the cycle so the note is in tune
//           from its first sample, radius how far the point can move and keep its period, level the RMS of the voice
//           at 4,400 steps a second, bright the spectral centroid of its first 16 harmonics in harmonic numbers
//   chaos:  {point, radius, level, bright}, bright here in Hz
//   escape: {point, steps}, steps the number of steps before the orbit leaves

const URL_ = new URL('./points.json?v=27', import.meta.url);
const MAX_BYTES = 1 << 20; // the library is about 100 KB; anything far bigger is not ours

const allFinite = (row, n) => Array.isArray(row) && row.length === n && row.every(Number.isFinite);

/** check the parsed library and index it; throws on anything unexpected */
export const indexPoints = (lib) => {
  if (!lib || typeof lib !== 'object' || lib.v !== 1 || typeof lib.engine !== 'string') {
    throw new Error('Unknown point library version');
  }
  if (!lib.fractals || typeof lib.fractals !== 'object') throw new Error('The point library has no fractals');
  const index = {engine: lib.engine, fractals: {}};
  for (const [key, e] of Object.entries(lib.fractals)) {
    if (!e || !Number.isFinite(e.param)) throw new Error(`Bad entry for ${key}`);
    for (const [name, n] of [['cycles', 8], ['chaos', 5], ['escape', 3]]) {
      if (!Array.isArray(e[name]) || !e[name].every((row) => allFinite(row, n))) {
        throw new Error(`Bad ${name} for ${key}`);
      }
    }
    const byPeriod = new Map();
    for (const [period, x, y, zx, zy, radius, level, bright] of e.cycles) {
      if (!byPeriod.has(period)) byPeriod.set(period, []);
      byPeriod.get(period).push({period, point: [x, y], z0: [zx, zy], radius, level, bright});
    }
    index.fractals[key] = {
      param: e.param,
      cycles: byPeriod,
      periods: [...byPeriod.keys()].sort((a, b) => a - b),
      chaos: e.chaos.map(([x, y, radius, level, bright]) => ({point: [x, y], radius, level, bright})),
      escape: e.escape.map(([x, y, steps]) => ({point: [x, y], steps})),
    };
  }
  return index;
};

let loading = null;
let loaded = null;

/** fetch and index the library once; later calls share the same promise. A failed load can be tried again. */
export const loadPoints = () => {
  if (!loading) {
    loading = (async () => {
      const res = await fetch(URL_);
      if (!res.ok) throw new Error(`The point library did not load (${res.status})`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('The point library is too large');
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('The point library is too large');
      loaded = indexPoints(JSON.parse(text));
      return loaded;
    })();
    loading.catch(() => (loading = null));
  }
  return loading;
};

/** the periods a fractal has points for, smallest first; empty until loadPoints() has finished */
export const periodsOf = (key) => (loaded?.fractals[key]?.periods ?? []).slice();
