// The real FFT against a direct DFT, and its inverse.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealFFT, hann} from '../src/cantus/fft.js';

const random = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

const dft = (x) => {
  const n = x.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < n; j++) {
      const t = (-2 * Math.PI * ((j * k) % n)) / n;
      a += x[j] * Math.cos(t);
      b += x[j] * Math.sin(t);
    }
    re[k] = a;
    im[k] = b;
  }
  return {re, im};
};

test('forward matches a direct DFT to 1e-9, sizes 4 to 2,048', () => {
  const rnd = random(3);
  for (const n of [4, 8, 16, 64, 256, 1024, 2048]) {
    const x = Float64Array.from({length: n}, rnd);
    const f = new RealFFT(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    f.forward(x, re, im);
    const d = dft(x);
    let worst = 0;
    for (let k = 0; k <= n / 2; k++) worst = Math.max(worst, Math.abs(re[k] - d.re[k]), Math.abs(im[k] - d.im[k]));
    assert.ok(worst < 1e-9, `n ${n}: worst ${worst}`);
  }
});

test('inverse gives the samples back to 1e-12', () => {
  const rnd = random(11);
  for (const n of [4, 32, 2048, 4096]) {
    const x = Float64Array.from({length: n}, rnd);
    const f = new RealFFT(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    const y = new Float64Array(n);
    f.forward(x, re, im);
    f.inverse(re, im, y);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    assert.ok(worst < 1e-12, `n ${n}: worst ${worst}`);
  }
});

test('a sine lands in its bin; sizes that are not powers of two are refused', () => {
  const n = 1024;
  const x = Float64Array.from({length: n}, (_, i) => Math.sin((2 * Math.PI * 37 * i) / n));
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  new RealFFT(n).forward(x, re, im);
  assert.ok(Math.abs(im[37] + n / 2) < 1e-9);
  assert.ok(Math.hypot(re[36], im[36]) < 1e-9);
  assert.throws(() => new RealFFT(1000));
});

test('a periodic Hann window at a hop of an eighth adds up to 4', () => {
  const n = 2048;
  const w = hann(n);
  for (let i = 0; i < 256; i++) {
    let s = 0;
    for (let k = 0; k < 8; k++) s += w[(i + k * 256) % n];
    assert.ok(Math.abs(s - 4) < 1e-12);
  }
});
