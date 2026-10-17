// Timed starts: z0, velocity, rate, offset and releaseS on Voice.start.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fractals, orbitOf, paramOf, clampRate} from '../src/fractals.js';
import {Voice} from '../src/voice.js';
import {renderVoice, pitchOf, rms} from './helpers.mjs';

const SR = 48000;
const index = (key) => fractals.findIndex((f) => f.key === key);

const voiceOn = (key, sustain = true) => {
  const v = new Voice(SR);
  const i = index(key);
  v.message({type: 'fractal', index: i, param: paramOf(fractals[i], {})});
  v.message({type: 'sustain', on: sustain});
  return v;
};

/** the point an orbit reaches after `n` steps: on its cycle, for a point inside a bulb */
const settle = (key, point, n = 6000) => {
  const f = fractals[index(key)];
  const k = paramOf(f, {});
  const {z0, c} = orbitOf(f, point, null);
  const out = [0, 0];
  let [x, y] = z0;
  for (let i = 0; i < n; i++) {
    f.step(x, y, c[0], c[1], out, k);
    [x, y] = out;
  }
  return [x, y];
};

const cycles = [
  ['mandelbrot', [-0.9524126, -0.1977292], 2],
  ['mandelbrot', [-0.1124342, -0.6810738], 3],
  ['mandelbrot', [0.2720617, 0.5404032], 4],
  ['mandelbrot', [-0.4983976, -0.5676508], 5],
];

for (const [key, point, period] of cycles) {
  for (const hz of [440, 330]) {
    test(`z0 on the cycle: period ${period} at ${hz} Hz is in tune within the first 50 ms`, () => {
      const v = voiceOn(key);
      v.start(point, {z0: settle(key, point), rate: hz * period});
      const {L, R} = renderVoice(v, 0.05, SR);
      const got = pitchOf([L, R], SR, {minHz: 100, maxHz: 2000});
      assert.ok(Math.abs(got / hz - 1) < 0.01, `measured ${got.toFixed(2)} Hz, wanted ${hz}`);
    });
  }
}

test('without opts, start and the point message behave as before', () => {
  const a = voiceOn('mandelbrot');
  const b = voiceOn('mandelbrot');
  a.start([-0.1124342, -0.6810738]);
  b.message({type: 'point', p: [-0.1124342, -0.6810738]});
  const x = renderVoice(a, 0.2, SR);
  const y = renderVoice(b, 0.2, SR);
  assert.deepEqual(x.L, y.L);
  assert.deepEqual(x.R, y.R);
  assert.equal(a.velocityGain, 1);
  assert.equal(a.releaseS, 0.015);
});

test('the point message passes opts through', () => {
  const v = voiceOn('mandelbrot');
  v.message({type: 'point', p: [-0.1124342, -0.6810738], opts: {rate: 1320, velocity: 0.5}});
  assert.equal(v.rate, 1320);
  assert.equal(v.velocityGain, 10 ** (-15 / 20));
});

test('velocity: 1 is full level, 0 is silence, 0.5 is about 15 dB down', () => {
  const level = (velocity) => {
    const v = voiceOn('mandelbrot');
    v.start([-0.1124342, -0.6810738], {velocity});
    const {L, R} = renderVoice(v, 0.5, SR);
    return rms([L.subarray(SR * 0.1), R.subarray(SR * 0.1)]);
  };
  const full = level(1);
  const half = level(0.5);
  assert.equal(level(0), 0);
  assert.ok(full > 0.05, `full level ${full}`);
  const db = 20 * Math.log10(half / full);
  // the soft saturator bends this a little, so allow 2 dB either way
  assert.ok(Math.abs(db + 15) < 2, `velocity 0.5 measured ${db.toFixed(2)} dB`);
  const v = voiceOn('mandelbrot');
  v.start([0, 0], {velocity: 7});
  assert.equal(v.velocityGain, 1);
});

test('rate in opts is clamped like the rate message', () => {
  const v = voiceOn('mandelbrot');
  v.start([0, 0], {rate: 1e6});
  assert.equal(v.rate, clampRate(1e6));
  v.start([0, 0], {rate: 10});
  assert.equal(v.rate, clampRate(10));
});

test('offset starts the envelope as if that much time had passed', () => {
  const v = voiceOn('mandelbrot', false);
  v.start([-0.1124342, -0.6810738], {offset: 0.6});
  assert.equal(v.attack, 1);
  assert.ok(Math.abs(v.decay - Math.exp(-1)) < 1e-12);
  // with sustain on there is no fade to skip, only the attack
  const s = voiceOn('mandelbrot', true);
  s.start([-0.1124342, -0.6810738], {offset: 0.002});
  assert.equal(s.decay, 1);
  assert.ok(Math.abs(s.attack - 0.5) < 1e-12);
  // and a fading note started late matches one that has been playing that long, give or take a block
  const late = voiceOn('mandelbrot', false);
  late.start([-0.1124342, -0.6810738]);
  renderVoice(late, 0.6, SR);
  assert.ok(Math.abs(late.decay / v.decay - 1) < 1e-6, `${late.decay} vs ${v.decay}`);
});

test('releaseS sets how long the note takes to stop', () => {
  const v = voiceOn('mandelbrot');
  v.start([-0.1124342, -0.6810738], {releaseS: 0.1});
  renderVoice(v, 0.1, SR);
  v.stop();
  renderVoice(v, 0.09, SR);
  assert.equal(v.on, true);
  renderVoice(v, 0.02, SR);
  assert.equal(v.on, false);
  // and it stays for later notes on the same voice
  v.start([-0.1124342, -0.6810738]);
  assert.equal(v.releaseS, 0.1);
});
