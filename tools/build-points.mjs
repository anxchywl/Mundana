// Builds the point library Cantus plays songs from: for every fractal, stable points for each period from 2 to 16
// (a cycle of period p is heard at rate / p, so each period is a note), a few chaos points and a few escapes.
// Run: node tools/build-points.mjs. It writes src/cantus/points.json and prints what it found and how long it took.
// Every fractal is searched at its default slider value, Julia off, inside its starting view. A cycle point is kept
// only if, played at 440 x period steps a second, it measures 440 Hz within 1 percent: some cycles repeat almost
// exactly halfway round and are heard an octave up, and those would play the wrong note.
import {fractals, orbitOf, analyse, paramOf} from '../src/fractals.js';
import {Voice} from '../src/voice.js';
import {pitchOf, renderVoice} from '../tests/helpers.mjs';
import {Worker, isMainThread, parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const PERIODS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const CANDIDATES = 60000;
const PER_PERIOD = 6;
const CHAOS = 6;
const ESCAPES = 12;
const SR = 48000;
const RATE = 4400;
const OUT = new URL('../src/cantus/points.json', import.meta.url);

/** sha1 of the voice and the formulas, first 12 hex; the ?v= numbers are left out so a version bump alone does not count */
export const engineHash = () => {
  const h = createHash('sha1');
  for (const file of ['../src/voice.js', '../src/fractals.js']) {
    h.update(readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\?v=\d+/g, ''));
  }
  return h.digest('hex').slice(0, 12);
};

const sig7 = (v) => +v.toPrecision(7);
const sig3 = (v) => +v.toPrecision(3);

/** render `seconds` at `rate` steps a second, sustain on; returns L and R from 50 ms on */
export const listen = (i, k, point, z0, rate = RATE, seconds = 0.5) => {
  const v = new Voice(SR);
  v.message({type: 'fractal', index: i, param: k});
  v.message({type: 'sustain', on: true});
  v.message({type: 'rate', value: rate});
  v.start(point, z0 ? {z0} : undefined);
  const {L, R} = renderVoice(v, seconds, SR);
  const skip = SR * 0.05;
  return [L.subarray(skip), R.subarray(skip)];
};

/** how far off 440 Hz the point sounds at 440 x period steps a second, as a fraction */
export const tuningError = (i, k, point, z0, period) => {
  const hz = pitchOf(listen(i, k, point, z0, 440 * period, 0.25), SR, {minHz: 100, maxHz: 2000});
  return Math.abs(hz / 440 - 1);
};

const levelOf = ([L, R]) => {
  let s = 0;
  for (let j = 0; j < L.length; j++) s += L[j] * L[j] + R[j] * R[j];
  return Math.sqrt(s / (2 * L.length));
};

/** the amplitude of both channels at `hz`, by a direct DFT under a Hann window */
const amplitudeAt = ([L, R], n, hz) => {
  const w = (2 * Math.PI * hz) / SR;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  let c = 1;
  let s = 0;
  let lr = 0;
  let li = 0;
  let rr = 0;
  let ri = 0;
  for (let j = 0; j < n; j++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (n - 1));
    lr += L[j] * win * c;
    li += L[j] * win * s;
    rr += R[j] * win * c;
    ri += R[j] * win * s;
    const t = c * cw - s * sw;
    s = s * cw + c * sw;
    c = t;
  }
  return Math.sqrt(lr * lr + li * li + rr * rr + ri * ri);
};

/** spectral centroid of the first 16 harmonics of rate / period, in harmonic numbers (1 is a pure tone) */
const harmonicCentroid = (sig, period) => {
  const f0 = RATE / period;
  let num = 0;
  let den = 0;
  for (let h = 1; h <= 16 && h * f0 < SR / 2; h++) {
    const a = amplitudeAt(sig, sig[0].length, h * f0);
    num += h * a;
    den += a;
  }
  return den > 0 ? num / den : 0;
};

/** spectral centroid over 0 to 8 kHz from a 4,096 point DFT, in Hz */
const noiseCentroid = (sig) => {
  const n = 4096;
  let num = 0;
  let den = 0;
  for (let b = 1; (b * SR) / n <= 8000; b++) {
    const a = amplitudeAt(sig, n, (b * SR) / n);
    num += ((b * SR) / n) * a;
    den += a;
  }
  return den > 0 ? num / den : 0;
};

/** search one fractal; returns its library entry and how long it took */
export const buildOne = (i) => {
  const t0 = performance.now();
  const f = fractals[i];
  const k = paramOf(f, {});
  const {cx, cy, span} = f.view;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const kind = (x, y) => {
    const {z0, c} = orbitOf(f, [x, y], null);
    return analyse(f, z0, c, k);
  };
  const far = (list, x, y, d) => list.every((q) => Math.hypot(q[0] - x, q[1] - y) >= d);
  const minR = span * 5e-4;
  /** the largest radius at which all 8 neighbours still pass `same`, or 0 when it is below span * 0.0005 */
  const stability = (x, y, same) => {
    const ok = (r) => {
      for (let j = 0; j < 8; j++) {
        const a = (j * Math.PI) / 4;
        if (!same(kind(x + r * Math.cos(a), y + r * Math.sin(a)))) return false;
      }
      return true;
    };
    if (!ok(minR)) return 0;
    let lo = minR;
    let hi = span * 0.05;
    if (ok(hi)) return hi;
    for (let j = 0; j < 10; j++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  const cycles = new Map(PERIODS.map((p) => [p, []]));
  const chaos = [];
  const crisp = [];
  const dull = [];
  const spread = span * 0.03;
  const escSpread = span * 0.08;
  let tried = 0;
  let offPitch = 0;
  const out = [0, 0];
  const full = () =>
    chaos.length >= CHAOS && crisp.length >= ESCAPES && [...cycles.values()].every((l) => l.length >= PER_PERIOD);
  for (; tried < CANDIDATES && !full(); tried++) {
    // rounded as they will be stored, so everything measured here is what the library holds
    const x = sig7(cx + (rnd() - 0.5) * span);
    const y = sig7(cy + (rnd() - 0.5) * span);
    const r = kind(x, y);
    if (r.kind === 'escape') {
      if (r.steps >= 3 && r.steps <= 40) {
        if (crisp.length < ESCAPES && far(crisp, x, y, escSpread)) crisp.push([x, y, r.steps]);
      } else if (dull.length < ESCAPES && far(dull, x, y, escSpread)) dull.push([x, y, r.steps]);
    } else if (r.kind === 'cycle') {
      const list = cycles.get(r.period);
      if (!list || list.length >= PER_PERIOD || !far(list, x, y, spread)) continue;
      const radius = stability(x, y, (q) => q.kind === 'cycle' && q.period === r.period);
      if (!radius) continue;
      // 6,000 steps on from where the orbit starts, so a note starts on its cycle
      let [a, b] = orbitOf(f, [x, y], null).z0;
      for (let j = 0; j < 6000; j++) {
        f.step(a, b, x, y, out, k);
        [a, b] = out;
      }
      const z0 = [sig7(a), sig7(b)];
      if (!(tuningError(i, k, [x, y], z0, r.period) < 0.01)) {
        offPitch++;
        continue;
      }
      list.push([r.period, x, y, radius, z0]);
    } else {
      if (chaos.length >= CHAOS || !far(chaos, x, y, spread)) continue;
      const radius = stability(x, y, (q) => q.kind === 'chaos');
      if (radius) chaos.push([x, y, radius]);
    }
  }
  // crisp escapes first; slower or instant ones only fill the gaps
  const escape = crisp.slice();
  for (const e of dull) if (escape.length < ESCAPES && far(escape, e[0], e[1], escSpread)) escape.push(e);

  const entry = {param: k, cycles: [], chaos: [], escape: []};
  for (const list of cycles.values()) {
    for (const [period, x, y, radius, z0] of list) {
      const sig = listen(i, k, [x, y], z0);
      entry.cycles.push([period, x, y, z0[0], z0[1], sig7(radius), sig3(levelOf(sig)), sig3(harmonicCentroid(sig, period))]);
    }
  }
  for (const [x, y, radius] of chaos) {
    const sig = listen(i, k, [x, y], null);
    entry.chaos.push([x, y, sig7(radius), sig3(levelOf(sig)), sig3(noiseCentroid(sig))]);
  }
  for (const [x, y, steps] of escape) entry.escape.push([x, y, steps]);
  return {entry, tried, offPitch, ms: performance.now() - t0};
};

const main = async () => {
  const t0 = performance.now();
  const jobs = fractals.map((_, i) => i);
  const results = new Array(fractals.length);
  const threads = Math.max(1, Math.min(availableParallelism() - 1, fractals.length));
  await Promise.all(
    Array.from({length: threads}, () => new Promise((resolve, reject) => {
      const w = new Worker(fileURLToPath(import.meta.url));
      const next = () => {
        if (!jobs.length) {
          w.terminate().then(resolve);
          return;
        }
        w.postMessage(jobs.shift());
      };
      w.on('message', ({i, result}) => {
        results[i] = result;
        process.stderr.write(`${fractals[i].key}: ${(result.ms / 1000).toFixed(1)} s, ${result.tried} candidates, ${result.offPitch} off pitch\n`);
        next();
      });
      w.on('error', reject);
      next();
    })),
  );
  const lib = {v: 1, engine: engineHash(), fractals: {}};
  fractals.forEach((f, i) => (lib.fractals[f.key] = results[i].entry));
  const json = JSON.stringify(lib);
  mkdirSync(new URL('.', OUT), {recursive: true});
  writeFileSync(OUT, json);

  const rows = fractals.map((f, i) => {
    const e = results[i].entry;
    const count = (p) => e.cycles.filter((c) => c[0] === p).length;
    const missing = PERIODS.filter((p) => !count(p));
    return `| ${f.key} | ${PERIODS.map(count).join(' ')} | ${missing.length ? missing.join(', ') : 'none'} | ${results[i].offPitch} | ${e.chaos.length} | ${e.escape.length} |`;
  });
  console.log(`| fractal | points per period ${PERIODS[0]} to ${PERIODS[PERIODS.length - 1]} | missing periods | rejected off pitch | chaos | escape |`);
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  console.log(`\nengine ${lib.engine}, ${(json.length / 1024).toFixed(1)} KB (${json.length} bytes), ${threads} threads, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
};

if (!isMainThread) {
  parentPort.on('message', (i) => parentPort.postMessage({i, result: buildOne(i)}));
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
