// From a Timeline to a ShowPlan: every note gets a point of the point library whose cycle, stepped at the right rate,
// plays that note. In this phase only the melody plays, on voice 0, on one fractal, with the camera still.
//
// A cycle of period p stepped `rate` times a second sounds at rate / p Hz, so a note of f Hz can be played by any
// period p with rate = f * p inside the rate limits. Among the points that can play it, the mapper picks the one with
// the lowest cost: close to the last note's point (the drawn orbits move little), near the part's preferred period,
// stable, and not moved by octaves.

import {fractals, RATE, PITCH_DOWN, PITCH_UP} from '../fractals.js?v=24';

export const RATE_MIN = RATE * 2 ** (-PITCH_DOWN / 12);
export const RATE_MAX = RATE * 2 ** (PITCH_UP / 12);

/** every weight of the cost, in one place */
export const COST = {
  distance: 1.0, // per view span between this note's point and the last one of the same voice
  period: 0.5, // per octave between the period and the part's preferred period
  radius: 0.3, // for a point that keeps its period only very close by
  radiusScale: 0.002, // a radius of this many view spans or more costs nothing
  radiusCap: 4,
  moved: 0.2, // per octave a note had to move
};

export const DEFAULTS = {
  fractal: 'mandelbrot',
  preferredPeriod: {melody: 6, bass: 4, chords: 6, drums: 4},
};

const SAME_TIME = 0.001; // notes starting this close together count as one chord

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * timeline: a checked Timeline. settings: {fractal, preferredPeriod} (see DEFAULTS). points: the index from
 * loadPoints(). Returns a ShowPlan, plus counts: `moved` notes shifted by octaves, `skipped` melody notes not played
 * because a higher one starts at the same time (one voice plays one note at a time).
 */
export const planShow = (timeline, settings = {}, points) => {
  const key = settings.fractal || DEFAULTS.fractal;
  const f = fractals.find((x) => x.key === key);
  const lib = points?.fractals?.[key];
  if (!f || !lib || !lib.periods.length) throw new Error(`There are no notes for ${f ? f.name : key}.`);
  const preferred = {...DEFAULTS.preferredPeriod, ...settings.preferredPeriod};
  const view = f.view;
  const periods = lib.periods;
  const pMin = periods[0];
  const pMax = periods[periods.length - 1];

  // one voice: of the melody notes that start together the highest is played, the others are skipped
  const melody = timeline.notes.filter((n) => n.part === 'melody');
  const notes = [];
  let skipped = 0;
  for (let i = 0; i < melody.length; i++) {
    const n = melody[i];
    const next = melody[i + 1];
    if (next && next.start - n.start < SAME_TIME) {
      skipped++;
      continue;
    }
    notes.push(n);
  }

  const presses = [];
  let moved = 0;
  let prev = null;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const midi = Math.round(n.midi);
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
    if (shift) moved++;
    let best = null;
    let bestCost = Infinity;
    for (const p of periods) {
      const rate = freq * p;
      if (rate < RATE_MIN * (1 - 1e-9) || rate > RATE_MAX * (1 + 1e-9)) continue;
      const periodCost = COST.period * Math.abs(Math.log2(p / preferred[n.part]));
      for (const c of lib.cycles.get(p)) {
        const dist = prev ? Math.hypot(c.point[0] - prev[0], c.point[1] - prev[1]) / view.span : 0;
        const cost =
          COST.distance * dist +
          periodCost +
          COST.radius * Math.min(COST.radiusCap, (view.span * COST.radiusScale) / c.radius) +
          COST.moved * Math.abs(shift);
        if (cost < bestCost) {
          bestCost = cost;
          best = {c, rate};
        }
      }
    }
    if (!best) continue;
    // one voice: a note ends where the next one starts
    const until = i + 1 < notes.length ? notes[i + 1].start : Infinity;
    const press = {
      time: n.start,
      voice: 0,
      fractal: key,
      point: best.c.point,
      z0: best.c.z0,
      rate: best.rate,
      duration: Math.min(n.duration, until - n.start),
      velocity: n.velocity,
      part: n.part,
      period: best.c.period,
      midi,
    };
    if (shift) press.moved = shift;
    presses.push(press);
    prev = best.c.point;
  }

  return {
    presses,
    camera: [{time: 0, centre: [view.cx, view.cy], span: view.span, ease: 'cut', duration: 0}],
    morphs: [],
    timeline,
    moved,
    skipped,
  };
};
