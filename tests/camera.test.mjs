// The picture of a show: which fractal is on screen, the morphs between them, and the camera. cameraAt and morphAt are
// pure functions of song time; every framing is held 1.5 s or more; morphs land on their downbeat; the notes stay on
// screen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexPoints} from '../src/cantus/points.js';
import {planShow, cameraAt, morphAt, fractalAt, settingsOf, pitchedFractals, CAMERA, COST, SET_LIST, EVERY} from '../src/cantus/mapper.js';
import {parseMidi} from '../src/cantus/midi.js';

const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const SONGS = ['sections.mid', 'ode-to-joy.mid', 'band.mid', 'chromatic.mid'];
const LAYOUTS = [{layout: 'one'}, {layout: 'sections'}, {layout: 'bars', every: 4}, {layout: 'bars', every: 8}];

test('every framing is held at least 1.5 s: each pair of keyframes, every song, layout and motion setting', () => {
  let pairs = 0;
  for (const name of SONGS) {
    const t = fixture(name);
    for (const s of LAYOUTS) {
      for (const reducedMotion of [false, true]) {
        const plan = planShow(t, s, points, {reducedMotion});
        assert.equal(plan.camera[0].time, 0);
        for (let i = 1; i < plan.camera.length; i++) {
          const gap = plan.camera[i].time - plan.camera[i - 1].time;
          assert.ok(gap >= CAMERA.hold - 1e-9, `${name} ${s.layout}: keyframes ${i - 1} and ${i} are ${gap.toFixed(3)} s apart`);
          pairs++;
        }
        for (const k of plan.camera) {
          assert.ok(k.ease === 'cut' || k.ease === 'glide');
          if (reducedMotion) assert.equal(k.ease, 'cut');
          if (k.ease === 'glide') assert.ok(k.duration > 0 && k.duration <= CAMERA.morph + 1e-9);
        }
      }
    }
  }
  assert.ok(pairs > 50, `${pairs} pairs checked`);
});

test('a glide moves the centre in a straight line and the span evenly in log space', () => {
  const plan = {
    camera: [
      {time: 0, centre: [0, 0], span: 1, ease: 'cut', duration: 0},
      {time: 2, centre: [1, -2], span: 4, ease: 'glide', duration: 0.8},
    ],
  };
  assert.deepEqual(cameraAt(plan, 1), {cx: 0, cy: 0, span: 1});
  assert.deepEqual(cameraAt(plan, 2), {cx: 0, cy: 0, span: 1});
  // halfway through the glide the ease is at one half: the centre is halfway, the span the geometric mean
  const mid = cameraAt(plan, 2.4);
  assert.ok(Math.abs(mid.cx - 0.5) < 1e-12 && Math.abs(mid.cy + 1) < 1e-12);
  assert.ok(Math.abs(mid.span - 2) < 1e-12, `span ${mid.span}`);
  // log space: at every point the span is 4 to the power of the eased position
  for (let t = 2; t <= 2.8; t += 0.05) {
    const v = cameraAt(plan, t);
    const e = (v.cx - 0) / 1;
    assert.ok(Math.abs(Math.log(v.span) / Math.log(4) - e) < 1e-12);
  }
  assert.deepEqual(cameraAt(plan, 2.8), {cx: 1, cy: -2, span: 4});
  assert.deepEqual(cameraAt(plan, 99), {cx: 1, cy: -2, span: 4});
  // a cut jumps at its time
  const cut = {camera: [plan.camera[0], {...plan.camera[1], ease: 'cut', duration: 0}]};
  assert.deepEqual(cameraAt(cut, 1.999), {cx: 0, cy: 0, span: 1});
  assert.deepEqual(cameraAt(cut, 2), {cx: 1, cy: -2, span: 4});
});

test('cameraAt, morphAt and fractalAt are pure: the same answer every time, and the plan is not touched', () => {
  const plan = planShow(fixture('sections.mid'), {layout: 'sections'}, points);
  const before = JSON.stringify(plan);
  const times = Array.from({length: 400}, (_, i) => (i * 61) / 400);
  const a = times.map((t) => [cameraAt(plan, t), morphAt(plan, t), fractalAt(plan, t)]);
  // asked again in a shuffled order, as a seek would
  const b = times
    .map((t, i) => [t, i])
    .sort((x, y) => ((x[1] * 7919) % 400) - ((y[1] * 7919) % 400))
    .map(([t, i]) => [i, [cameraAt(plan, t), morphAt(plan, t), fractalAt(plan, t)]]);
  for (const [i, v] of b) assert.deepEqual(v, a[i]);
  assert.equal(JSON.stringify(plan), before);
});

test('a morph ends exactly on its downbeat, and notes before it play the old fractal, notes from it the new one', () => {
  const t = fixture('sections.mid');
  for (const s of [{layout: 'sections'}, {layout: 'bars', every: 4}]) {
    const plan = planShow(t, s, points);
    assert.ok(plan.morphs.length >= 3);
    for (const m of plan.morphs) {
      const T = m.time + m.duration;
      const bar = t.bars.reduce((best, b) => (Math.abs(b - T) < Math.abs(best - T) ? b : best));
      assert.ok(Math.abs(T - bar) < 0.001, `morph lands at ${T}, the downbeat is ${bar}`);
      const barBefore = t.bars.filter((b) => b < T - 1e-9).pop();
      assert.ok(Math.abs(m.duration - Math.min(CAMERA.morph, T - barBefore)) < 1e-9);
      assert.equal(morphAt(plan, m.time - 0.001), null);
      assert.ok(morphAt(plan, m.time).e < 1e-9);
      assert.ok(Math.abs(morphAt(plan, T - 0.0005).e - 1) < 1e-6);
      assert.equal(morphAt(plan, T), null);
      assert.equal(fractalAt(plan, T - 0.0005), m.from);
      assert.equal(fractalAt(plan, T), m.to);
      // the camera lands on the new framing at the downbeat too
      const k = plan.camera.find((c) => Math.abs(c.time + c.duration - T) < 1e-9);
      if (k) assert.deepEqual(cameraAt(plan, T), {cx: k.centre[0], cy: k.centre[1], span: k.span});
    }
    // a note that comes back on a free voice keeps the point it started with, so only first presses are checked
    for (const p of plan.presses) {
      if (p.part !== 'drums' && !p.resumed) assert.equal(p.fractal, fractalAt(plan, p.time), `${p.part} at ${p.time}`);
    }
  }
});

test('reduced motion: no morphs, the fractal and the camera cut on the downbeat', () => {
  const plan = planShow(fixture('sections.mid'), {layout: 'sections'}, points, {reducedMotion: true});
  assert.deepEqual(plan.morphs, []);
  assert.equal(plan.layout.length, 4);
  for (const k of plan.camera) assert.equal(k.ease, 'cut');
  for (const seg of plan.layout.slice(1)) assert.equal(morphAt(plan, seg.start - 0.01), null);
});

test('set lists: a fractal per section from the list, or a new one every N bars, only fractals that can play', () => {
  const t = fixture('sections.mid');
  const sec = planShow(t, {layout: 'sections'}, points);
  assert.deepEqual(sec.layout.map((s) => [s.fractal, s.start]), [['mandelbrot', 0], ['multibrot', 16], ['burning-ship', 32], ['lambda', 48]]);
  const mine = planShow(t, {layout: 'sections', setList: ['inverted', 'mandelbrot']}, points);
  assert.deepEqual(mine.layout.map((s) => s.fractal), ['inverted', 'mandelbrot', 'inverted', 'mandelbrot']);
  // the same fractal twice in a row is no change
  const same = planShow(t, {layout: 'sections', setList: ['lambda', 'lambda', 'tricorn', 'tricorn']}, points);
  assert.deepEqual(same.layout.map((s) => s.fractal), ['lambda', 'tricorn']);
  assert.equal(same.morphs.length, 1);
  const bars = planShow(t, {layout: 'bars', every: 4}, points);
  // every 4 bars: 8 s at 120 bpm, then 6.4 s at 150 bpm from 48 s
  assert.deepEqual(bars.layout.map((s) => +s.start.toFixed(6)), [0, 8, 16, 24, 32, 40, 48, 54.4]);
  assert.deepEqual(bars.layout.slice(0, 6).map((s) => s.fractal), [...SET_LIST, SET_LIST[0]]);
  for (const k of SET_LIST) assert.ok(pitchedFractals(points).includes(k));
  const s = settingsOf({layout: 'spiral', every: 99, setList: ['chirikov', 'tricorn', 'nothing']}, points);
  assert.equal(s.layout, 'one');
  assert.equal(s.every, EVERY.value);
  assert.deepEqual(s.setList, ['tricorn']);
  assert.deepEqual(settingsOf({}, points).setList, SET_LIST);
  // with one fractal the parts keep their own fractals; with a set list every pitched note plays the one on screen
  const one = planShow(t, {}, points);
  assert.ok(one.presses.some((p) => p.part === 'bass' && p.fractal === 'multibrot'));
});

/** the share of each press's sounding time, outside morphs, when its point is on a W x H screen */
const inView = (plan, W, H, dt = 0.005) => {
  const M = Math.min(W, H);
  let worst = 1;
  let all = 0;
  let inside = 0;
  let presses = 0;
  for (const p of plan.presses) {
    let a = 0;
    let b = 0;
    for (let t = p.time; t < p.time + p.duration; t += dt) {
      if (morphAt(plan, t)) continue;
      const v = cameraAt(plan, t);
      const sx = W / 2 + ((p.point[0] - v.cx) / v.span) * M;
      const sy = H / 2 + ((p.point[1] - v.cy) / v.span) * M;
      a++;
      if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) b++;
    }
    if (!a) continue;
    presses++;
    all += a;
    inside += b;
    worst = Math.min(worst, b / a);
  }
  return {worst, share: inside / all, presses};
};

test('every pressed point is on screen for at least 90 percent of its length, outside morphs', (t) => {
  const song = fixture('sections.mid');
  for (const s of LAYOUTS) {
    const plan = planShow(song, {...s, voices: 6}, points);
    for (const [W, H] of [[1280, 800], [390, 844], [1920, 1080], [360, 640]]) {
      const r = inView(plan, W, H);
      t.diagnostic(`${s.layout}${s.every ? ' ' + s.every : ''} ${W}x${H}: ${r.presses} presses, share ${(r.share * 100).toFixed(2)} %, worst press ${(r.worst * 100).toFixed(1)} %`);
      assert.ok(r.worst >= 0.9, `${s.layout} at ${W}x${H}: a press is on screen ${(r.worst * 100).toFixed(1)} % of its length`);
    }
  }
});

test('the second pass keeps notes inside the framing of their moment', (t) => {
  const song = fixture('sections.mid');
  const outside = () => {
    const plan = planShow(song, {layout: 'sections'}, points);
    let n = 0;
    for (const p of plan.presses) {
      const v = cameraAt(plan, p.time + p.duration / 2);
      if (Math.hypot(p.point[0] - v.cx, p.point[1] - v.cy) > v.span / 2) n++;
    }
    return {n, keyframes: plan.camera.length, of: plan.presses.length};
  };
  const saved = COST.camera;
  try {
    COST.camera = 0;
    const off = outside();
    COST.camera = saved;
    const on = outside();
    t.diagnostic(`presses outside the framing's circle at their middle: ${off.n} of ${off.of} without the camera cost (${off.keyframes} keyframes), ${on.n} of ${on.of} with it (${on.keyframes} keyframes)`);
    assert.ok(on.n <= off.n);
  } finally {
    COST.camera = saved;
  }
});

test('planning a 4 minute song with a set list and a camera stays under 100 ms', (t) => {
  // the sections song four times over: 243 s
  const one = fixture('sections.mid');
  const notes = [];
  const bars = [];
  for (let k = 0; k < 4; k++) {
    for (const n of one.notes) notes.push({...n, start: n.start + k * one.duration});
    for (const b of one.bars) bars.push(b + k * one.duration);
  }
  const long = {...one, notes, bars, duration: one.duration * 4, sections: [0, 1, 2, 3].flatMap((k) => one.sections.map((s) => ({...s, start: s.start + k * one.duration, end: s.end + k * one.duration})))};
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    planShow(long, {layout: 'sections', voices: 6}, points);
    times.push(performance.now() - t0);
  }
  t.diagnostic(`${notes.length.toLocaleString('en')} notes, 16 sections: ${times.map((x) => x.toFixed(1)).join(', ')} ms`);
  assert.ok(Math.max(...times) < 100);
});
