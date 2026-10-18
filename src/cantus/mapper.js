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

import {fractals, RATE, PITCH_DOWN, PITCH_UP} from '../fractals.js?v=25';

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
};

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

/** the fractals a pitched part can play on: the library has at least MIN_PERIODS periods for them */
export const pitchedFractals = (points) =>
  fractals.filter((f) => (points?.fractals?.[f.key]?.periods.length ?? 0) >= MIN_PERIODS).map((f) => f.key);

/** settings with every gap filled from DEFAULTS and every value checked; a fractal that cannot play falls back */
export const settingsOf = (settings = {}, points) => {
  const ok = new Set(pitchedFractals(points));
  const v = Math.round(Number(settings.voices));
  const out = {voices: v >= 1 && v <= MAX_VOICES ? v : DEFAULTS.voices, parts: {}};
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
const pick = (lib, view, preferred, midi, prev) => {
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
  let bestCost = Infinity;
  for (const p of periods) {
    const rate = freq * p;
    if (rate < RATE_MIN * (1 - 1e-9) || rate > RATE_MAX * (1 + 1e-9)) continue;
    const periodCost = COST.period * Math.abs(Math.log2(p / preferred));
    for (const c of lib.cycles.get(p)) {
      const dist = prev ? Math.hypot(c.point[0] - prev[0], c.point[1] - prev[1]) / view.span : 0;
      const cost =
        COST.distance * dist +
        periodCost +
        COST.radius * Math.min(COST.radiusCap, (view.span * COST.radiusScale) / c.radius) +
        COST.moved * Math.abs(shift);
      if (cost < bestCost) {
        bestCost = cost;
        best = {c, rate, shift};
      }
    }
  }
  return best;
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

/**
 * timeline: a checked Timeline. settings: {voices, parts: {melody|chords|bass: {fractal, period, mute}, drums: {mute}}}
 * (see DEFAULTS; anything missing or wrong falls back). points: the index from loadPoints(). Returns a ShowPlan with
 * `fractal` (the one on screen) and counts: `moved` notes shifted by octaves, `skipped` melody notes not played
 * because a higher one starts at the same time, `left` notes of each part left out for lack of voices, `stolen` notes
 * cut short to free their voice, `drumsBorrowed` when the drums use the Burning ship's sounds, `drumsOnly` when the
 * song has nothing but drums.
 */
export const planShow = (timeline, settings = {}, points) => {
  const set = settingsOf(settings, points);
  const parts = set.parts;
  const n = set.voices;
  const show = parts.melody.fractal;
  const showF = fractals.find((x) => x.key === show);
  for (const part of PITCHED) {
    const key = parts[part].fractal;
    if (!points?.fractals?.[key]?.periods.length) {
      const f = fractals.find((x) => x.key === key);
      throw new Error(`There are no notes for ${f ? f.name : key}.`);
    }
  }
  const libOf = (part) => points.fractals[parts[part].fractal];
  const viewOf = (part) => fractals.find((x) => x.key === parts[part].fractal).view;
  const centre = [showF.view.cx, showF.view.cy];
  const drums = drumPoints(points, show, centre);

  const presses = [];
  let moved = 0;
  const pitched = (note, part, voice, prev) => {
    const midi = Math.round(note.midi);
    const best = pick(libOf(part), viewOf(part), parts[part].period, midi, prev);
    if (!best) return null;
    if (best.shift) moved++;
    const press = {
      time: note.start,
      voice,
      fractal: parts[part].fractal,
      point: best.c.point,
      z0: best.c.z0,
      rate: best.rate,
      duration: note.duration,
      velocity: note.velocity,
      part,
      period: best.c.period,
      midi,
      releaseS: RELEASE[part],
    };
    if (best.shift) press.moved = best.shift;
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
    prev = press.point;
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
    prevOn[v] = {fractal: press.fractal, point: press.point};
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
      hold(v, {...w.press, time: t, duration: w.until - t, voice: v, group: 0, resumed: true});
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
        const d = drums[kind];
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
        };
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
        press = pitched(note, note.part, voice, p && p.fractal === parts[note.part].fractal ? p.point : null);
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

  return {
    presses,
    camera: [{time: 0, centre, span: showF.view.span, ease: 'cut', duration: 0}],
    morphs: [],
    timeline,
    fractal: show,
    voices: n,
    moved,
    skipped,
    left,
    stolen,
    drumsBorrowed: drums.borrowed && presses.some((p) => p.part === 'drums' && p.fractal !== show),
    drumsOnly: timeline.notes.length > 0 && timeline.notes.every((x) => x.part === 'drums'),
  };
};
