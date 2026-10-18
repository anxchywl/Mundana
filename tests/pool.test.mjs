// The voice pool in the worklet host: voices mix through one master path without passing 1.0, silent voices cost
// nothing, a release never ends a note pressed on the same sample, and a planned song of every part plays in tune.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Host, SR, runHost} from './worklet-host.mjs';
import {pitchOf, rms, onsetIn} from './helpers.mjs';
import {indexPoints} from '../src/cantus/points.js';
import {planShow} from '../src/cantus/mapper.js';
import {parseMidi} from '../src/cantus/midi.js';
import {validateTimeline} from '../src/cantus/timeline.js';
import {Transport} from '../src/cantus/scheduler.js';

const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const P3 = [-0.1124342, -0.6810738]; // a period 3 point of the Mandelbrot set
const press = (voice, at, o = {}) => ({type: 'press', voice, at, fractal: 'mandelbrot', p: P3, rate: 1320, velocity: 1, ...o});

/** the timed messages of a plan, as the scheduler sends them when it plays from the start */
const messagesOf = (plan, keep = () => true) => {
  const out = [];
  for (const p of plan.presses) {
    if (!keep(p)) continue;
    out.push([0, {type: 'press', voice: p.voice, at: p.time, fractal: p.fractal, p: p.point, z0: p.z0, rate: p.rate, velocity: p.velocity, releaseS: p.releaseS}]);
    out.push([0, {type: 'release', voice: p.voice, at: p.time + p.duration}]);
  }
  return out;
};

const peakOf = (L, R) => {
  let peak = 0;
  let nan = 0;
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan++;
    else peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return {peak, nan};
};

test('voices sum through a gain of 1 / sqrt(n), eased over 20 ms', () => {
  const one = new Host();
  const a = runHost(one, 0.5, [[0, press(1, 0.1)]]);
  const two = new Host();
  const b = runHost(two, 0.5, [[0, press(1, 0.1)], [0, press(2, 0.1)]]);
  // the same note twice, in phase: twice the signal, times 1 / sqrt(2) once the gain has settled
  const from = Math.round(0.3 * SR);
  const ratio = rms(b.L.subarray(from)) / rms(a.L.subarray(from));
  assert.ok(Math.abs(ratio - Math.SQRT2) < 0.01, `ratio ${ratio}`);
  assert.ok(Math.abs(two.master.gain - Math.SQRT1_2) < 1e-6);
});

test('six loud voices never pass 1.0, and no NaN', () => {
  const host = new Host();
  host.port.onmessage({data: {type: 'voices', n: 6}});
  const pts = [[-0.9524126, -0.1977292], P3, [0.2720617, 0.5404032], [-0.4983976, -0.5676508], [-1.31, 0.02], [-0.12, 0.75]];
  const msgs = pts.map((p, v) => [0, press(v, 0.01 * v, {p, rate: 900 + 300 * v})]);
  const {L, R} = runHost(host, 1, msgs);
  const {peak, nan} = peakOf(L, R);
  assert.equal(nan, 0);
  assert.ok(peak <= 1, `peak ${peak}`);
  assert.ok(peak > 0.5, `peak ${peak}: the test should be loud`);
});

test('a voice that is not sounding is skipped: render is never called for it', () => {
  const host = new Host();
  const calls = new Array(6).fill(0);
  host.voices.forEach((v, i) => {
    const render = v.render.bind(v);
    v.render = (...a) => (calls[i]++, render(...a));
  });
  runHost(host, 0.2, [[0, press(2, 0.05)], [0, {type: 'release', voice: 2, at: 0.1}]]);
  assert.deepEqual(calls.map((c, i) => (i === 2 ? c > 0 : c)), [0, 0, true, 0, 0, 0]);
  // once released, voice 2 stops costing anything too
  assert.equal(host.voices[2].on, false);
  const before = calls[2];
  runHost(host, 0.1);
  assert.equal(calls[2], before);
});

test('a release and a press on the same sample: the release goes first, whatever order they arrive in', () => {
  const host = new Host();
  runHost(host, 0.3, [[0, press(1, 0.05)], [0, press(1, 0.1)], [0, {type: 'release', voice: 1, at: 0.1}]]);
  assert.equal(host.voices[1].on, true, 'the note pressed at 0.1 s still sounds');
});

test('voices: presses past the count are refused, and a lower count lets those voices go', () => {
  const host = new Host();
  assert.equal(host.count, 4);
  host.port.onmessage({data: press(4, 0.1)});
  assert.equal(host.rings[4].size, 0);
  host.port.onmessage({data: {type: 'voices', n: 6}});
  host.port.onmessage({data: press(5, 0.01)});
  runHost(host, 0.05);
  assert.equal(host.voices[5].on, true);
  host.port.onmessage({data: {type: 'voices', n: 4}});
  runHost(host, 0.1);
  assert.equal(host.voices[5].on, false);
  for (const n of [0, 7, 2.5, '6']) host.port.onmessage({data: {type: 'voices', n}});
  assert.equal(host.count, 4);
});

test('manual messages without a voice still go to voice 0, and a song note on another voice leaves it alone', () => {
  const host = new Host();
  host.port.onmessage({data: {type: 'sustain', on: true}});
  host.port.onmessage({data: {type: 'point', p: P3}});
  host.port.onmessage({data: press(1, 0)});
  runHost(host, 0.1);
  assert.equal(host.voices[0].on, true);
  assert.equal(host.voices[0].fading, false);
  assert.equal(host.voices[1].on, true);
  host.port.onmessage({data: {type: 'stop'}});
  runHost(host, 0.1);
  assert.equal(host.voices[0].on, false);
  assert.equal(host.voices[1].on, true);
});

test('the band on 6 voices: no sample above 1.0, no NaN, every pitched note in tune when its voice plays alone', (t) => {
  const plan = planShow(fixture('band.mid'), {voices: 6}, points);
  const seconds = plan.timeline.duration + 0.3;
  const host = new Host();
  host.port.onmessage({data: {type: 'voices', n: 6}});
  const {L, R} = runHost(host, seconds, messagesOf(plan));
  const {peak, nan} = peakOf(L, R);
  let over = 0;
  for (let i = 0; i < L.length; i++) over += (Math.abs(L[i]) > 0.9) + (Math.abs(R[i]) > 0.9);
  t.diagnostic(`all voices: peak ${peak.toFixed(6)}, NaN ${nan}, ${over} of ${2 * L.length} samples above 0.9 (bent by the limit)`);
  assert.equal(nan, 0);
  assert.ok(peak <= 1);
  let worst = {err: 0};
  let measured = 0;
  let short = 0;
  for (let v = 0; v < 6; v++) {
    const solo = new Host();
    solo.port.onmessage({data: {type: 'voices', n: 6}});
    const out = runHost(solo, seconds, messagesOf(plan, (p) => p.voice === v));
    for (const p of plan.presses) {
      if (p.voice !== v || p.part === 'drums') continue;
      const want = 440 * 2 ** ((p.midi + 12 * (p.moved || 0) - 69) / 12);
      // the middle 80 percent of the note, if that holds 4 cycles or more
      const a = Math.round((p.time + p.duration * 0.1) * SR);
      const b = Math.round((p.time + p.duration * 0.9) * SR);
      if (b - a < (4 * SR) / want) {
        short++;
        continue;
      }
      const hz = pitchOf([out.L.subarray(a, b), out.R.subarray(a, b)], SR, {minHz: 40, maxHz: 4000});
      const err = Math.abs(hz / want - 1);
      measured++;
      if (!(err <= worst.err)) worst = {err, part: p.part, midi: p.midi, hz, want, time: p.time};
    }
  }
  t.diagnostic(`${measured} pitched notes measured, ${short} too short; worst ${(worst.err * 100).toFixed(4)} % (${worst.part} midi ${worst.midi} at ${worst.time?.toFixed(3)} s: ${worst.hz?.toFixed(2)} Hz for ${worst.want?.toFixed(2)})`);
  assert.ok(worst.err < 0.01);
});

test('seek into a held chord: every note of it sounds after the seek', () => {
  const note = (midi) => ({start: 0, duration: 4, midi, velocity: 0.7, part: 'chords', confidence: 1, source: 'midi'});
  const timeline = validateTimeline({notes: [48, 52, 55, 59].map(note), tempo: {bpm: 120, beats: []}, sections: [], duration: 4, title: 't'});
  const plan = planShow(timeline, {voices: 6}, points);
  assert.equal(plan.presses.length, 4);
  // a fake context clock that the host follows, 128 samples at a time
  const ctx = {currentTime: 0, outputLatency: 0};
  const sent = [];
  const tr = new Transport({ctx, send: (m) => sent.push(m), plan, timer: {set: () => 1, clear: () => {}}, wallNow: () => ctx.currentTime * 1000});
  tr.seek(2);
  tr.play();
  const pressed = sent.filter((m) => m.type === 'press');
  assert.deepEqual(pressed.map((m) => m.voice).sort(), plan.presses.map((p) => p.voice).sort());
  for (const m of pressed) assert.ok(Math.abs(m.offset - 2) < 1e-9);
  // each voice alone, from the seek on, plays its note
  for (const p of plan.presses) {
    const solo = new Host();
    solo.port.onmessage({data: {type: 'voices', n: 6}});
    const msgs = sent.filter((m) => m.voice === p.voice).map((m) => [0, m]);
    const out = runHost(solo, 0.5, msgs);
    const from = Math.round(0.15 * SR);
    const hz = pitchOf([out.L.subarray(from), out.R.subarray(from)], SR, {minHz: 40, maxHz: 2000});
    const want = 440 * 2 ** ((p.midi - 69) / 12);
    assert.ok(Math.abs(hz / want - 1) < 0.01, `midi ${p.midi}: ${hz} Hz`);
    assert.ok(onsetIn(out.L, 1, out.L.length) >= Math.round(0.05 * SR) - 1, 'starts at the anchor, 50 ms after the seek');
  }
});
