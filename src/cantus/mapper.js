// From a Timeline to a ShowPlan: every note gets a point of the point library whose cycle, stepped at the right rate,
// plays that note, and a voice to play it on. The melody has voice 0 to itself; bass, chords and drums share the
// others. Voices are given out here, not on the audio thread, so a plan is the same every time and a seek can press
// again exactly the notes that were sounding.
//
// A cycle of period p stepped `rate` times a second sounds at rate / p Hz, so a note of f Hz can be played by any
// period p with rate = f * p inside the rate limits. Among the points that can play it, the mapper picks the one with
// the lowest cost: close to the last note's point on the same voice (the drawn orbits move little), near the part's
// preferred period, stable, and not moved by octaves. Drums are not notes but sounds: a kick is an orbit that escapes
// (a click), the others are chaos (noise), brighter or darker.
//
// The plan also holds the picture, as a function of song time: which fractal is on screen (one for the whole song, one
// per section from a set list, or a new one every few bars), the morphs between them, which land on downbeats, and
// camera keyframes that frame the notes phrase by phrase. The notes are planned twice: the second time each note
// prefers points inside the framing of its moment, so a fast passage stays in one framing instead of chasing every
// note. cameraAt and morphAt read the picture back at any song time, so pause, seek and loop are right at once.

import {fractals, RATE, PITCH_DOWN, PITCH_UP} from '../fractals.js?v=30';

export const RATE_MIN = RATE * 2 ** (-PITCH_DOWN / 12);
export const RATE_MAX = RATE * 2 ** (PITCH_UP / 12);
export const MAX_VOICES = 6;
export const MIN_PERIODS = 4; // a fractal plays a pitched part only if the library has this many periods for it
export const DRUM_FALLBACK = 'burning-ship'; // where drums find their sounds on a fractal that has none

/** every weight of the cost, in one place */
export const COST = {
  distance: 1.0, // per view span between this note's point and the last one of the same voice
  period: 0.5, // per octave between the period and the part's preferred period
  radius: 0.3, // for a point that keeps its period only very close by
  radiusScale: 0.002, // a radius of this many view spans or more costs nothing
  radiusCap: 4,
  moved: 0.2, // per octave a note had to move
  camera: 0.5, // per half span a point lies outside the framing of its moment (second pass only)
};

/** the camera and the morphs */
export const CAMERA = {
  hold: 1.5, // seconds each framing is held at least
  glide: 0.8, // a move takes at most this long
  glideShare: 0.4, // and at most this share of its window
  margin: 1.4, // the span is this many times the larger side of the notes' box
  minSpan: 0.15, // and between these shares of the fractal's starting span
  maxSpan: 1.2,
  stayMove: 0.1, // a new framing closer than this share of the span to the last one, and
  staySpan: 0.15, // a span within this share of it, keeps the last one
  morph: 1.7, // a morph takes this long, or one bar if that is shorter
};
// the same zoom limits as the page (main.js): float32 runs out of digits below MIN_SPAN
export const MIN_SPAN = 6e-5;
export const MAX_SPAN = 60;

/** which fractal is on screen: one for the song, one per section, or a new one every few bars */
export const LAYOUTS = ['one', 'sections', 'bars'];
export const SET_LIST = ['mandelbrot', 'multibrot', 'burning-ship', 'lambda', 'inverted'];
export const MAX_SET = 16;
export const EVERY = {min: 4, max: 32, value: 8};

/** how long each part's notes take to die away after they end, in seconds */
export const RELEASE = {melody: 0.04, chords: 0.08, bass: 0.03, drums: 0.015};

/** each drum: its rate in steps a second and how long it sounds, whatever the file says */
export const DRUM = {
  kick: {rate: 2200, duration: 0.15},
  snare: {rate: 8800, duration: 0.12},
  hat: {rate: 17600, duration: 0.05},
  other: {rate: 4400, duration: 0.1},
};

export const DEFAULTS = {
  voices: 4,
  layout: 'one',
  every: EVERY.value,
  setList: SET_LIST,
  parts: {
    melody: {fractal: 'mandelbrot', period: 6, mute: false},
    chords: {fractal: 'mandelbrot', period: 4, mute: false},
    bass: {fractal: 'multibrot', period: 3, mute: false},
    drums: {mute: false},
  },
};

const PITCHED = ['melody', 'chords', 'bass'];
const SAME_TIME = 0.001; // notes starting this close together count as one chord
const MIN_LEFT = 0.1; // a note that lost its voice comes back on a free one if this much of it is left

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// the page's ease (main.js): it leaves and lands softly
const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const byKey = new Map(fractals.map((f) => [f.key, f]));

/** the fractals a pitched part can play on: the library has at least MIN_PERIODS periods for them */
export const pitchedFractals = (points) =>
  fractals.filter((f) => (points?.fractals?.[f.key]?.periods.length ?? 0) >= MIN_PERIODS).map((f) => f.key);

/** settings with every gap filled from DEFAULTS and every value checked; a fractal that cannot play falls back */
export const settingsOf = (settings = {}, points) => {
  const ok = new Set(pitchedFractals(points));
  const v = Math.round(Number(settings.voices));
  const every = Math.round(Number(settings.every));
  let setList = (Array.isArray(settings.setList) ? settings.setList : []).filter((k) => ok.has(k)).slice(0, MAX_SET);
  if (!setList.length) setList = SET_LIST.filter((k) => ok.has(k) || !points);
  const out = {
    voices: v >= 1 && v <= MAX_VOICES ? v : DEFAULTS.voices,
    layout: LAYOUTS.includes(settings.layout) ? settings.layout : DEFAULTS.layout,
    every: every >= EVERY.min && every <= EVERY.max ? every : EVERY.value,
    setList,
    parts: {},
  };
  for (const part of Object.keys(DEFAULTS.parts)) {
    const d = DEFAULTS.parts[part];
    const s = settings.parts?.[part] || {};
    const o = {mute: s.mute === true};
    if (part !== 'drums') {
      o.fractal = ok.has(s.fractal) ? s.fractal : d.fractal;
      const p = Math.round(Number(s.period));
      o.period = p >= 2 && p <= 16 ? p : d.period;
    }
    out.parts[part] = o;
  }
  return out;
};

/**
 * The best point to play a note on: {c, rate, shift}, or null if the fractal has no period that can play it even
 * after moving it by octaves. `prev` is the last point of the same voice on the same fractal, or null.
 */
const pick = (lib, view, preferred, midi, prev, frame) => {
  const periods = lib.periods;
  const pMin = periods[0];
  const pMax = periods[periods.length - 1];
  let shift = 0;
  let freq = hz(midi);
  // a note no period can reach moves by whole octaves toward the range
  while (freq * pMax < RATE_MIN * (1 - 1e-9) && shift < 11) {
    freq *= 2;
    shift++;
  }
  while (freq * pMin > RATE_MAX * (1 + 1e-9) && shift > -11) {
    freq /= 2;
    shift--;
  }
  let best = null;
  let bestRate = 0;
  let bestCost = Infinity;
  for (const p of periods) {
    const rate = freq * p;
    if (rate < RATE_MIN * (1 - 1e-9) || rate > RATE_MAX * (1 + 1e-9)) continue;
    const periodCost = COST.period * Math.abs(Math.log2(p / preferred));
    for (const c of lib.cycles.get(p)) {
      // Math.sqrt rather than Math.hypot: this loop runs for every candidate of every note, twice
      const dx = prev ? c.point[0] - prev[0] : 0;
      const dy = prev ? c.point[1] - prev[1] : 0;
      const dist = Math.sqrt(dx * dx + dy * dy) / view.span;
      let cost =
        COST.distance * dist +
        periodCost +
        COST.radius * Math.min(COST.radiusCap, (view.span * COST.radiusScale) / c.radius) +
        COST.moved * Math.abs(shift);
      if (frame) {
        const fx = c.point[0] - frame.centre[0];
        const fy = c.point[1] - frame.centre[1];
        const out = Math.sqrt(fx * fx + fy * fy) / (frame.span / 2) - 1;
        if (out > 0) cost += COST.camera * out;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
        bestRate = rate;
      }
    }
  }
  return best ? {c: best, rate: bestRate, shift} : null;
};

/**
 * The point of each drum on fractal `key`, seen around `centre`: the kick is the escape nearest the centre that
 * leaves in 3 to 40 steps, the hat the brightest chaos point, the other drums the darkest, the snare one from the
 * middle third by brightness. A fractal with no chaos or no such escape borrows them from the Burning ship
 * (the point nearest the centre); `borrowed` then says so.
 */
export const drumPoints = (points, key, centre) => {
  const near = (list) => {
    let best = null;
    let d = Infinity;
    for (const e of list) {
      const x = Math.hypot(e.point[0] - centre[0], e.point[1] - centre[1]);
      if (x < d) {
        d = x;
        best = e;
      }
    }
    return best;
  };
  const crisp = (lib) => lib.escape.filter((e) => e.steps >= 3 && e.steps <= 40);
  const own = points.fractals[key];
  const spare = points.fractals[DRUM_FALLBACK];
  const out = {borrowed: false};
  if (own && crisp(own).length) out.kick = {fractal: key, point: near(crisp(own)).point};
  else if (spare && crisp(spare).length) {
    out.kick = {fractal: DRUM_FALLBACK, point: near(crisp(spare)).point};
    out.borrowed = true;
  }
  if (own && own.chaos.length) {
    const byBright = own.chaos.slice().sort((a, b) => a.bright - b.bright);
    out.hat = {fractal: key, point: byBright[byBright.length - 1].point};
    out.other = {fractal: key, point: byBright[0].point};
    out.snare = {fractal: key, point: byBright[Math.floor(byBright.length / 2)].point};
  } else if (spare && spare.chaos.length) {
    const p = {fractal: DRUM_FALLBACK, point: near(spare.chaos).point};
    out.hat = out.snare = out.other = p;
    out.borrowed = true;
  }
  return out;
};

/** a chord's tones in the order they keep their voice: root (the lowest), top, third, seventh, then the rest */
const chordOrder = (tones) => {
  const up = tones.slice().sort((a, b) => a.midi - b.midi);
  const root = up[0];
  const out = [root];
  const take = (n) => {
    if (n && !out.includes(n)) out.push(n);
  };
  take(up[up.length - 1]);
  const interval = (n) => (((Math.round(n.midi) - Math.round(root.midi)) % 12) + 12) % 12;
  take(up.find((n) => n !== root && (interval(n) === 3 || interval(n) === 4)));
  take(up.find((n) => n !== root && (interval(n) === 10 || interval(n) === 11)));
  for (const n of up) take(n);
  return out;
};

/** the downbeats of a song to place changes and camera windows on: its bars, else its beats, else every half second */
const gridOf = (timeline) => {
  if (timeline.bars?.length >= 2) return timeline.bars;
  if (timeline.tempo?.beats?.length >= 2) return timeline.tempo.beats;
  const out = [];
  for (let t = 0; t < timeline.duration && out.length < 20000; t += 0.5) out.push(t);
  return out;
};

/** the index of the last element of a sorted list whose `key` is <= v, or -1 */
const lastAtOrBefore = (list, v, key) => {
  let lo = 0;
  let hi = list.length - 1;
  let r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) <= v) {
      r = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return r;
};

/** how long a morph into a change at T takes: 1.7 s, or the bar before T if that is shorter */
const morphLength = (grid, T) => {
  const i = lastAtOrBefore(grid, T - 1e-9, (x) => x);
  const bar = i >= 0 ? T - grid[i] : CAMERA.morph;
  return Math.min(CAMERA.morph, bar > 0 ? bar : CAMERA.morph);
};

/**
 * Which fractal is on screen when: [{start, end, fractal}], every change on a downbeat. A change closer than the hold
 * plus a morph to the one before, or closer than the hold to the end, is left out, so every fractal is on screen long
 * enough to frame its notes.
 */
export const layoutOf = (timeline, set) => {
  const end = timeline.duration;
  const first = set.layout === 'one' ? set.parts.melody.fractal : set.setList[0];
  if (set.layout === 'one') return [{start: 0, end, fractal: first}];
  const grid = gridOf(timeline);
  const changes = [];
  if (set.layout === 'sections') {
    timeline.sections.forEach((s, i) => {
      if (i === 0) return;
      // a section that does not start on a downbeat changes on the nearest one
      let best = 0;
      for (let k = 1; k < grid.length; k++) if (Math.abs(grid[k] - s.start) < Math.abs(grid[best] - s.start)) best = k;
      changes.push({time: grid[best], fractal: set.setList[i % set.setList.length]});
    });
  } else {
    for (let k = set.every, j = 1; k < grid.length; k += set.every, j++) changes.push({time: grid[k], fractal: set.setList[j % set.setList.length]});
  }
  const out = [{start: 0, end, fractal: first}];
  for (const c of changes) {
    const last = out[out.length - 1];
    if (c.fractal === last.fractal || c.time - last.start < CAMERA.hold + CAMERA.morph || end - c.time < CAMERA.hold) continue;
    last.end = c.time;
    out.push({start: c.time, end, fractal: c.fractal});
  }
  return out;
};

/**
 * Camera windows: from each downbeat, bars are joined until the window lasts 1.5 s or more; a window never crosses a
 * fractal change. The last window before a change also ends where the morph begins, at least 1.5 s after its start.
 */
const windowsOf = (timeline, layout, morphs) => {
  const grid = gridOf(timeline);
  const out = [];
  layout.forEach((seg, si) => {
    const starts = [seg.start];
    for (const g of grid) if (g > seg.start + 1e-9 && g < seg.end - 1e-9) starts.push(g);
    const mine = [];
    let i = 0;
    while (i < starts.length) {
      const from = starts[i];
      let j = i + 1;
      while (j < starts.length && starts[j] - from < CAMERA.hold) j++;
      mine.push({start: from, end: j < starts.length ? starts[j] : seg.end, fractal: seg.fractal, seg: si});
      i = j;
    }
    // a short last window joins the one before; so does one that would end within the hold of the next morph
    const next = morphs.find((m) => Math.abs(m.time + m.duration - seg.end) < 1e-9);
    const until = next ? next.time : seg.end;
    while (mine.length > 1 && (seg.end - mine[mine.length - 1].start < CAMERA.hold || until - mine[mine.length - 1].start < CAMERA.hold)) {
      const w = mine.pop();
      mine[mine.length - 1].end = w.end;
    }
    out.push(...mine);
  });
  return out;
};

/** the framing of the notes sounding in a window, {centre, span}, or null when nothing sounds in it. Notes that start
 * while the camera glides into the next window count too, so the glide never leaves one behind. */
const framingOf = (w, presses, longest, ahead) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const until = w.end + ahead;
  const from = lastAtOrBefore(presses, until - 1e-12, (p) => p.time);
  for (let k = from; k >= 0 && presses[k].time > w.start - longest - 1e-9; k--) {
    const p = presses[k];
    if (p.time + p.duration <= w.start || p.time >= until) continue;
    x0 = Math.min(x0, p.point[0]);
    x1 = Math.max(x1, p.point[0]);
    y0 = Math.min(y0, p.point[1]);
    y1 = Math.max(y1, p.point[1]);
  }
  if (x0 === Infinity) return null;
  const view = byKey.get(w.fractal).view;
  let span = CAMERA.margin * Math.max(x1 - x0, y1 - y0);
  span = Math.min(view.span * CAMERA.maxSpan, Math.max(view.span * CAMERA.minSpan, span));
  span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
  return {centre: [(x0 + x1) / 2, (y0 + y1) / 2], span};
};

/** how long the camera takes to glide into a window */
const glideOf = (w) => Math.min(CAMERA.glide, CAMERA.glideShare * (w.end - w.start));

/** each window's framing, a window with nothing sounding keeping the one before (the first: the starting view) */
const framingsOf = (windows, presses) => {
  const longest = presses.reduce((m, p) => Math.max(m, p.duration), 0);
  let prev = null;
  return windows.map((w, i) => {
    const next = windows[i + 1];
    const ahead = next && next.seg === w.seg ? glideOf(next) : 0;
    const f = framingOf(w, presses, longest, ahead);
    if (f) prev = f;
    else if (!prev) {
      const v = byKey.get(w.fractal).view;
      prev = {centre: [v.cx, v.cy], span: v.span};
    }
    return {...prev, empty: !f};
  });
};

/**
 * timeline: a checked Timeline. settings: {voices, layout, every, setList, parts: {melody|chords|bass: {fractal,
 * period, mute}, drums: {mute}}} (see DEFAULTS; anything missing or wrong falls back). points: the index from
 * loadPoints(). opts: {reducedMotion} (cuts instead of glides and morphs). Returns a ShowPlan with `fractal` (the one
 * on screen first), `layout` ([{start, end, fractal}]) and counts: `moved` notes shifted by octaves, `skipped` melody
 * notes not played because a higher one starts at the same time, `left` notes of each part left out for lack of
 * voices, `stolen` notes cut short to free their voice, `drumsBorrowed` when the drums use the Burning ship's sounds,
 * `drumsOnly` when the song has nothing but drums. A press made from a note with an `id` carries it as `id`.
 */
export const planShow = (timeline, settings = {}, points, opts = {}) => {
  const set = settingsOf(settings, points);
  const parts = set.parts;
  const reduced = !!opts.reducedMotion;
  const used = set.layout === 'one' ? PITCHED.map((part) => parts[part].fractal) : set.setList;
  for (const key of used) {
    if (!points?.fractals?.[key]?.periods.length) {
      const f = byKey.get(key);
      throw new Error(`There are no notes for ${f ? f.name : key}.`);
    }
  }
  const layout = layoutOf(timeline, set);
  const at = (t) => layout[Math.max(0, lastAtOrBefore(layout, t, (s) => s.start))].fractal;
  const grid = gridOf(timeline);
  const morphs = [];
  for (let i = 1; i < layout.length && !reduced; i++) {
    const T = layout[i].start;
    const d = morphLength(grid, T);
    morphs.push({time: T - d, from: layout[i - 1].fractal, to: layout[i].fractal, duration: d});
  }
  const windows = windowsOf(timeline, layout, morphs);

  // first without the camera, then the points again with the framings that plan gives
  const result = assign(timeline, set, points, at);
  repick(result.made, set, points, at, windows, framingsOf(windows, result.presses));
  const presses = result.presses;

  // the camera: each window's framing, held while it barely moves; a change of fractal glides with its morph
  const final = framingsOf(windows, presses);
  const camera = [];
  final.forEach((f, i) => {
    const w = windows[i];
    if (i === 0) {
      camera.push({time: 0, centre: f.centre, span: f.span, ease: 'cut', duration: 0});
      return;
    }
    const last = camera[camera.length - 1];
    const still = Math.hypot(f.centre[0] - last.centre[0], f.centre[1] - last.centre[1]) < CAMERA.stayMove * last.span && Math.abs(f.span / last.span - 1) < CAMERA.staySpan;
    if (f.empty || still) return;
    const change = w.start === layout[w.seg].start && w.seg > 0;
    const morph = change ? morphs.find((m) => Math.abs(m.time + m.duration - w.start) < 1e-9) : null;
    if (reduced) camera.push({time: w.start, centre: f.centre, span: f.span, ease: 'cut', duration: 0});
    else if (morph) camera.push({time: morph.time, centre: f.centre, span: f.span, ease: 'glide', duration: morph.duration});
    else camera.push({time: w.start, centre: f.centre, span: f.span, ease: 'glide', duration: glideOf(w)});
  });

  return {
    presses,
    camera,
    morphs,
    timeline,
    fractal: layout[0].fractal,
    layout,
    voices: set.voices,
    moved: result.moved,
    skipped: result.skipped,
    left: result.left,
    stolen: result.stolen,
    drumsBorrowed: presses.some((p) => p.part === 'drums' && p.fractal !== at(p.time)),
    drumsOnly: timeline.notes.length > 0 && timeline.notes.every((x) => x.part === 'drums'),
  };
};

/**
 * How a pass picks points: `screenAt(t)` is the fractal on screen at song time t; with a set list every pitched note
 * plays on it, with one fractal each part keeps its own. With `windows` and `frames`, notes prefer points inside the
 * framing of their window, and the drums take the sounds nearest its centre.
 */
const picker = (set, points, screenAt, windows, frames) => {
  const parts = set.parts;
  const one = set.layout === 'one';
  const fractalOf = (part, t) => (one ? parts[part].fractal : screenAt(t));
  const frameAt = (t) => {
    if (!windows) return null;
    const i = lastAtOrBefore(windows, t, (w) => w.start);
    return i >= 0 ? frames[i] : null;
  };
  // the drums of each fractal, seen around its starting view's centre, or around each window's framing
  const drumCache = new Map(); // by window, or by fractal in the first pass
  const drumsAt = (t) => {
    const key = screenAt(t);
    const i = windows ? lastAtOrBefore(windows, t, (w) => w.start) : -1;
    const id = i >= 0 ? i : key;
    let d = drumCache.get(id);
    if (!d) {
      const v = byKey.get(key).view;
      d = drumPoints(points, key, i >= 0 ? frames[i].centre : [v.cx, v.cy]);
      drumCache.set(id, d);
    }
    return d;
  };
  /** the best point for a note, after the press `prev` on the same voice (or null); see pick */
  const best = (note, part, prev) => {
    const key = fractalOf(part, note.start);
    const b = pick(points.fractals[key], byKey.get(key).view, parts[part].period, Math.round(note.midi), prev && prev.fractal === key ? prev.point : null, frameAt(note.start));
    if (b) b.key = key;
    return b;
  };
  return {best, drumsAt};
};

/**
 * The second pass: the points of the first pass are picked again with the camera's framings, in the order they were
 * first picked, each after the same press as before. Which notes play, and on which voice, never depends on the
 * point a note gets, so only the points change; it gives the same plan as planning everything again.
 */
const repick = (made, set, points, screenAt, windows, frames) => {
  const {best, drumsAt} = picker(set, points, screenAt, windows, frames);
  for (const p of made) {
    const src = p.src;
    delete p.src;
    let from = src.from;
    if (src.drum) {
      const d = drumsAt(p.time)[src.drum];
      p.fractal = d.fractal;
      p.point = d.point;
      continue;
    }
    if (!from) {
      const b = best(src.note, p.part, src.prev);
      from = {fractal: b.key, point: b.c.point, z0: b.c.z0, rate: b.rate, period: b.c.period};
    }
    p.fractal = from.fractal;
    p.point = from.point;
    p.z0 = from.z0;
    p.rate = from.rate;
    p.period = from.period;
  }
};

/** One planning pass: every note gets a point and a voice. Every press made, in the order it was made, is in `made`,
 * with `src`: how its point was picked, for repick. */
const assign = (timeline, set, points, screenAt) => {
  const parts = set.parts;
  const n = set.voices;
  const {best, drumsAt} = picker(set, points, screenAt, null, null);
  const presses = [];
  const made = [];
  let moved = 0;
  const pitched = (note, part, voice, prev) => {
    const b = best(note, part, prev);
    if (!b) return null;
    if (b.shift) moved++;
    const press = {
      time: note.start,
      voice,
      fractal: b.key,
      point: b.c.point,
      z0: b.c.z0,
      rate: b.rate,
      duration: note.duration,
      velocity: note.velocity,
      part,
      period: b.c.period,
      midi: Math.round(note.midi),
      releaseS: RELEASE[part],
      src: {note, prev},
    };
    if (b.shift) press.moved = b.shift;
    if (note.id !== undefined) press.id = note.id;
    made.push(press);
    return press;
  };

  // the melody, on voice 0: of the notes that start together the highest is played, the others are skipped
  const melody = parts.melody.mute ? [] : timeline.notes.filter((x) => x.part === 'melody');
  const tune = [];
  let skipped = 0;
  for (let i = 0; i < melody.length; i++) {
    const next = melody[i + 1];
    if (next && next.start - melody[i].start < SAME_TIME) skipped++;
    else tune.push(melody[i]);
  }
  let prev = null;
  for (let i = 0; i < tune.length; i++) {
    const press = pitched(tune[i], 'melody', 0, prev);
    if (!press) continue;
    // one voice: a note ends where the next one starts
    const until = i + 1 < tune.length ? tune[i + 1].start : Infinity;
    press.duration = Math.min(press.duration, until - press.time);
    presses.push(press);
    prev = press;
  }

  // bass, chords and drums share voices 1 to n - 1, in note start order
  const left = {bass: 0, chords: 0, drums: 0};
  let stolen = 0;
  const others = timeline.notes.filter((x) => x.part !== 'melody' && !parts[x.part].mute);
  const holding = new Array(n).fill(null); // the last press of each voice
  const prevOn = new Array(n).fill(null);
  const freeAt = (v) => (holding[v] ? holding[v].time + holding[v].duration + holding[v].releaseS : -Infinity);
  // pitched notes without a voice, in the order they keep one: {press, until, since}
  let waiting = [];
  const hold = (v, press) => {
    holding[v] = press;
    prevOn[v] = press;
    presses.push(press);
  };
  /** a waiting note takes the first voice that comes free before `limit`, while enough of it is left */
  const resume = (limit) => {
    for (;;) {
      waiting = waiting.filter((w) => {
        if (w.until - w.since >= MIN_LEFT) return true;
        if (!w.sounded) left[w.press.part]++;
        return false;
      });
      if (!waiting.length) return;
      let v = -1;
      for (let k = 1; k < n; k++) if (v < 0 || freeAt(k) < freeAt(v)) v = k;
      if (v < 0) return;
      const at = Math.max(freeAt(v), waiting[0].since);
      const k = waiting.findIndex((w) => w.until - Math.max(at, w.since) >= MIN_LEFT);
      if (at >= limit || k < 0) {
        // what cannot come back before the limit waits on, from there
        for (const w of waiting) w.since = Math.max(w.since, Math.min(limit, at));
        if (at >= limit) return;
        continue;
      }
      const w = waiting.splice(k, 1)[0];
      const t = Math.max(at, w.since);
      const back = {...w.press, time: t, duration: w.until - t, voice: v, group: 0, resumed: true, src: {from: w.press}};
      made.push(back);
      hold(v, back);
    }
  };
  const rank = {bass: 0, drums: 1, chords: 2};
  let group = 0;
  for (let i = 0; i < others.length; ) {
    // one group: the notes that start together; bass first, then drums, then the chord in the order it keeps tones
    const t0 = others[i].start;
    resume(t0);
    let j = i;
    while (j < others.length && others[j].start - t0 < SAME_TIME) j++;
    const now = others.slice(i, j);
    i = j;
    group++;
    const seen = new Set();
    const chord = [];
    const rest = [];
    for (const x of now) {
      // the same note twice in one part (two tracks doubling it) plays once
      const id = `${x.part} ${x.part === 'drums' ? x.drum : Math.round(x.midi)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      (x.part === 'chords' ? chord : rest).push(x);
    }
    rest.sort((a, b) => rank[a.part] - rank[b.part] || a.midi - b.midi);
    const newWaiting = [];
    const queue = [...rest, ...(chord.length ? chordOrder(chord) : [])];
    for (let q = 0; q < queue.length; q++) {
      const note = queue[q];
      const t = note.start;
      let press;
      if (note.part === 'drums') {
        const kind = DRUM[note.drum] ? note.drum : 'other';
        const d = drumsAt(t)[kind];
        if (!d) {
          left.drums++;
          continue;
        }
        press = {
          time: t,
          voice: 0,
          fractal: d.fractal,
          point: d.point,
          rate: DRUM[kind].rate,
          duration: DRUM[kind].duration,
          velocity: note.velocity,
          part: 'drums',
          drum: kind,
          releaseS: RELEASE.drums,
          src: {drum: kind},
        };
        if (note.id !== undefined) press.id = note.id;
        made.push(press);
      }
      // a free voice: its last note and its release are over; one that last played this part first, then the lowest
      let voice = -1;
      for (let v = 1; v < n; v++) {
        if (freeAt(v) > t) continue;
        if (voice < 0 || (holding[v]?.part === note.part && holding[voice]?.part !== note.part)) voice = v;
      }
      if (voice < 0) {
        // none free: steal from an older note, one already ending first, then the quietest, then the earliest; a
        // chord tone takes a bass note only when nothing else can be taken
        let best = -1;
        const better = (a, b) => {
          const ha = holding[a];
          const hb = holding[b];
          const endedA = ha.time + ha.duration <= t;
          const endedB = hb.time + hb.duration <= t;
          if (endedA !== endedB) return endedA;
          if (note.part === 'chords' && (ha.part === 'bass') !== (hb.part === 'bass')) return hb.part === 'bass';
          if (ha.velocity !== hb.velocity) return ha.velocity < hb.velocity;
          return ha.time < hb.time;
        };
        for (let v = 1; v < n; v++) {
          if (holding[v].group === group) continue;
          if (best < 0 || better(v, best)) best = v;
        }
        if (best >= 0) {
          const h = holding[best];
          if (h.time + h.duration > t) {
            // the stolen note ends where the new one starts (the scheduler sends its release then), and waits to
            // come back on the next voice that is free
            const until = h.time + h.duration;
            h.duration = t - h.time;
            stolen++;
            if (h.part !== 'drums') newWaiting.push({press: h, until, since: t, sounded: true});
          }
          voice = best;
        }
      }
      if (note.part !== 'drums') {
        const p = voice > 0 ? prevOn[voice] : null;
        press = pitched(note, note.part, voice, p);
        if (!press) continue;
        press.order = q;
        if (voice < 0) {
          newWaiting.push({press, until: t + press.duration, since: t, sounded: false});
          continue;
        }
      } else if (voice < 0) {
        left.drums++;
        continue;
      }
      press.voice = voice;
      press.group = group;
      hold(voice, press);
    }
    // waiting notes come back bass first, then by their place in their chord (root, top, third, seventh, the rest)
    waiting.push(...newWaiting);
    waiting.sort((a, b) => rank[a.press.part] - rank[b.press.part] || a.press.order - b.press.order || a.since - b.since);
  }
  resume(Infinity);
  for (const p of presses) {
    delete p.group;
    delete p.order;
    if (p.duration <= 0) p.duration = 0;
  }
  presses.sort((a, b) => a.time - b.time || a.voice - b.voice);

  return {presses, made, moved, skipped, left, stolen};
};

/** the view at song time t, {cx, cy, span}: the keyframe in force, or the glide into it (the centre moves in a
 * straight line, the span evenly in log space, both eased). Pure: the same plan and time give the same view. */
export const cameraAt = (plan, t) => {
  const cam = plan.camera;
  const i = Math.max(0, lastAtOrBefore(cam, t, (k) => k.time));
  const k = cam[i];
  if (i > 0 && k.ease === 'glide' && k.duration > 0 && t < k.time + k.duration) {
    const a = cam[i - 1];
    const e = easeInOut(Math.max(0, (t - k.time) / k.duration));
    return {
      cx: a.centre[0] + (k.centre[0] - a.centre[0]) * e,
      cy: a.centre[1] + (k.centre[1] - a.centre[1]) * e,
      span: Math.exp(Math.log(a.span) + (Math.log(k.span) - Math.log(a.span)) * e),
    };
  }
  return {cx: k.centre[0], cy: k.centre[1], span: k.span};
};

/** the morph under way at song time t, {from, to, e} with e eased from 0 to 1, or null. Pure. */
export const morphAt = (plan, t) => {
  const i = lastAtOrBefore(plan.morphs, t, (m) => m.time);
  if (i < 0) return null;
  const m = plan.morphs[i];
  if (t >= m.time + m.duration) return null;
  return {from: m.from, to: m.to, e: easeInOut((t - m.time) / m.duration)};
};

/** the fractal whose notes play at song time t (during a morph, still the one it leaves). Pure. */
export const fractalAt = (plan, t) => {
  const l = plan.layout;
  return l[Math.max(0, lastAtOrBefore(l, t, (s) => s.start))].fractal;
};
