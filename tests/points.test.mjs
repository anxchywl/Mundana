// The point library: it matches the current voice and formulas, it is small, it loads, and every cycle point plays
// the note it promises.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fractals} from '../src/fractals.js';
import {Voice} from '../src/voice.js';
import {engineHash, PERIODS} from '../tools/build-points.mjs';
import {indexPoints, loadPoints, periodsOf} from '../src/cantus/points.js';
import {pitchOf, renderVoice} from './helpers.mjs';

const FILE = new URL('../src/cantus/points.json', import.meta.url);
const text = readFileSync(FILE, 'utf8');
const lib = JSON.parse(text);
const SR = 48000;

test('the library was built from the current voice and formulas', () => {
  assert.equal(lib.engine, engineHash(), 'src/voice.js or src/fractals.js changed: run node tools/build-points.mjs');
});

test('the library is under 300 KB', () => {
  assert.ok(Buffer.byteLength(text) < 300 * 1024, `${Buffer.byteLength(text)} bytes`);
});

test('every fractal is there, with periods 2 to 16 only', () => {
  const index = indexPoints(lib);
  assert.deepEqual(Object.keys(index.fractals), fractals.map((f) => f.key));
  for (const e of Object.values(index.fractals)) for (const p of e.periods) assert.ok(PERIODS.includes(p));
});

test('bad libraries are refused', () => {
  assert.throws(() => indexPoints({...lib, v: 2}));
  assert.throws(() => indexPoints(null));
  const bad = structuredClone(lib);
  bad.fractals.mandelbrot.cycles[0][3] = 'x';
  assert.throws(() => indexPoints(bad));
  bad.fractals.mandelbrot.cycles[0] = [2, 0, 0];
  assert.throws(() => indexPoints(bad));
});

test('loadPoints fetches once and indexes by period', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /points\.json\?v=\d+$/);
    return {ok: true, status: 200, headers: {get: () => String(text.length)}, text: async () => text};
  };
  assert.deepEqual(periodsOf('mandelbrot'), []);
  const [a, b] = await Promise.all([loadPoints(), loadPoints()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.deepEqual(periodsOf('mandelbrot'), a.fractals.mandelbrot.periods);
  assert.ok(periodsOf('mandelbrot').length > 0);
  assert.deepEqual(periodsOf('nothing'), []);
});

test('every cycle point plays 440 Hz within 1 percent at rate 440 x period', (t) => {
  const t0 = performance.now();
  let worst = {err: 0};
  let count = 0;
  for (const [key, e] of Object.entries(lib.fractals)) {
    const i = fractals.findIndex((f) => f.key === key);
    for (const [period, x, y, zx, zy] of e.cycles) {
      const v = new Voice(SR);
      v.message({type: 'fractal', index: i, param: e.param});
      v.message({type: 'sustain', on: true});
      v.start([x, y], {z0: [zx, zy], rate: 440 * period});
      const {L, R} = renderVoice(v, 0.25, SR);
      const skip = SR * 0.05;
      const hz = pitchOf([L.subarray(skip), R.subarray(skip)], SR, {minHz: 100, maxHz: 2000});
      const err = Math.abs(hz / 440 - 1);
      if (!(err <= worst.err)) worst = {err, key, period, point: [x, y], hz};
      count++;
    }
  }
  t.diagnostic(`${count} points in ${((performance.now() - t0) / 1000).toFixed(1)} s, worst ${(worst.err * 100).toFixed(3)} % (${worst.key} period ${worst.period} at ${worst.point}: ${worst.hz?.toFixed(2)} Hz)`);
  assert.ok(worst.err < 0.01, `worst ${worst.key} period ${worst.period} at ${worst.point}: ${worst.hz} Hz`);
});
