// The single voice mapper: every melody note gets a point and a rate that play it, a 4 minute song plans in under
// 50 ms, and a two-octave chromatic scale rendered through the worklet host is in tune.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexPoints} from '../src/cantus/points.js';
import {planShow, RATE_MIN, RATE_MAX} from '../src/cantus/mapper.js';
import {parseMidi} from '../src/cantus/midi.js';
import {validateTimeline} from '../src/cantus/timeline.js';
import {Host, SR, runHost} from './worklet-host.mjs';
import {pitchOf} from './helpers.mjs';

const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const song = (notes, duration) => validateTimeline({notes, tempo: {bpm: 120, beats: []}, sections: [], duration, title: 't'});
const note = (start, midi, o = {}) => ({start, duration: 0.25, midi, velocity: 0.8, part: 'melody', confidence: 1, source: 'midi', ...o});

test('every press plays its note: rate / period is the note, inside the rate limits', () => {
  const plan = planShow(fixture('ode-to-joy.mid'), {}, points);
  assert.equal(plan.presses.length, 62);
  for (const p of plan.presses) {
    assert.ok(p.rate >= RATE_MIN - 1e-6 && p.rate <= RATE_MAX + 1e-6);
    const want = 440 * 2 ** ((p.midi + 12 * (p.moved || 0) - 69) / 12);
    assert.ok(Math.abs(p.rate / p.period / want - 1) < 1e-9);
    assert.ok(points.fractals.mandelbrot.periods.includes(p.period));
    assert.equal(p.fractal, 'mandelbrot');
    assert.equal(p.voice, 0);
  }
  assert.equal(plan.camera.length, 1);
  assert.deepEqual(plan.morphs, []);
});

test('only the melody plays, one note at a time', () => {
  const t = song([note(0, 60), note(0, 64), note(0, 40, {part: 'bass'}), note(0.1, 67)], 1);
  const plan = planShow(t, {}, points);
  assert.deepEqual(plan.presses.map((p) => p.midi), [64, 67]);
  assert.equal(plan.skipped, 1);
  assert.ok(Math.abs(plan.presses[0].duration - 0.1) < 1e-12, 'a note ends where the next begins');
});

test('notes out of reach move by whole octaves and are marked', () => {
  const plan = planShow(song([note(0, 0), note(0.5, 127), note(1, 69)], 2), {}, points);
  const [lo, hi, a] = plan.presses;
  assert.ok(lo.moved > 0 && hi.moved < 0 && a.moved === undefined);
  assert.equal(plan.moved, 2);
});

test('planning a 4 minute song takes under 50 ms', (t) => {
  // eight notes a second for 240 s, a wandering line over three octaves
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const notes = Array.from({length: 1920}, (_, i) => note(i * 0.125, 48 + Math.floor(rnd() * 36), {duration: 0.12}));
  const timeline = song(notes, 240);
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    planShow(timeline, {}, points);
    times.push(performance.now() - t0);
  }
  t.diagnostic(`1,920 notes: first run ${times[0].toFixed(2)} ms, others ${times.slice(1).map((x) => x.toFixed(2)).join(', ')} ms`);
  assert.ok(Math.max(...times) < 50);
});

test('a two-octave chromatic scale, rendered through the worklet, is in tune within 1 percent', (t) => {
  const plan = planShow(fixture('chromatic.mid'), {}, points);
  assert.equal(plan.presses.length, 25);
  const host = new Host();
  const msgs = [];
  for (const p of plan.presses) {
    msgs.push({type: 'press', voice: 0, at: p.time, fractal: p.fractal, p: p.point, z0: p.z0, rate: p.rate, velocity: p.velocity});
    msgs.push({type: 'release', voice: 0, at: p.time + p.duration});
  }
  const {L, R} = runHost(host, plan.timeline.duration, msgs.map((m) => [0, m]));
  let worst = {err: 0};
  for (const p of plan.presses) {
    const want = 440 * 2 ** ((p.midi + 12 * (p.moved || 0) - 69) / 12);
    // the middle 80 percent of the note
    const a = Math.round((p.time + p.duration * 0.1) * SR);
    const b = Math.round((p.time + p.duration * 0.9) * SR);
    const hz = pitchOf([L.subarray(a, b), R.subarray(a, b)], SR, {minHz: 60, maxHz: 2000});
    const err = Math.abs(hz / want - 1);
    if (!(err <= worst.err)) worst = {err, midi: p.midi, period: p.period, hz, want};
  }
  t.diagnostic(`worst ${(worst.err * 100).toFixed(3)} % (midi ${worst.midi}, period ${worst.period}: ${worst.hz?.toFixed(2)} Hz for ${worst.want?.toFixed(2)})`);
  assert.ok(worst.err < 0.01);
});
