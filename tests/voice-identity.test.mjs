// The voice moved from src/synth-worklet.js into src/voice.js. This renders the same presses through the worklet as
// it was at commit d8be385 and through the new code, and asks for every sample to be the same.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fractals, paramOf} from '../src/fractals.js';
import {Voice, Master} from '../src/voice.js';

const BASE = 'd8be385';
const SR = 48000;
const BLOCK = 128;
const repo = fileURLToPath(new URL('..', import.meta.url));

// the audio worklet globals, just enough for the processor to run in Node
const registered = [];
globalThis.sampleRate = SR;
globalThis.currentFrame = 0;
globalThis.registerProcessor = (name, cls) => registered.push({name, cls});
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.sent = [];
    this.port = {onmessage: null, postMessage: (m) => this.sent.push(m)};
  }
};

const loadWorklet = async (url) => {
  const before = registered.length;
  await import(url);
  assert.equal(registered.length, before + 1);
  const {name, cls} = registered[registered.length - 1];
  assert.equal(name, 'orbit-synth');
  return cls;
};

// the old worklet and the fractals it imported, both exactly as they were at the base commit
const dir = mkdtempSync(join(tmpdir(), 'mundana-old-'));
for (const file of ['synth-worklet.js', 'fractals.js']) {
  writeFileSync(join(dir, file), execFileSync('git', ['show', `${BASE}:src/${file}`], {cwd: repo}));
}
const OldWorklet = await loadWorklet(pathToFileURL(join(dir, 'synth-worklet.js')).href);
const NewWorklet = await loadWorklet(new URL('../src/synth-worklet.js', import.meta.url).href);
rmSync(dir, {recursive: true, force: true});

const index = (key) => fractals.findIndex((f) => f.key === key);

/** run a list of [time in seconds, message] through a processor for `seconds`; returns {L, R, sent} */
const runWorklet = (Cls, events, seconds) => {
  const proc = new Cls();
  const n = seconds * SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  let e = 0;
  for (let i = 0; i < n; i += BLOCK) {
    while (e < events.length && events[e][0] * SR <= i) proc.port.onmessage({data: events[e++][1]});
    globalThis.currentFrame = i;
    assert.equal(proc.process([], [[bl, br]]), true);
    L.set(bl, i);
    R.set(br, i);
  }
  return {L, R, sent: proc.sent};
};

/** the same through a bare Voice and the master path */
const runVoice = (events, seconds) => {
  const v = new Voice(SR);
  const master = new Master(SR);
  const sent = [];
  v.onEscape = () => sent.push({type: 'escaped'});
  const n = seconds * SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const mixL = new Float64Array(BLOCK);
  const mixR = new Float64Array(BLOCK);
  let e = 0;
  for (let i = 0; i < n; i += BLOCK) {
    while (e < events.length && events[e][0] * SR <= i) v.message(events[e++][1]);
    mixL.fill(0);
    mixR.fill(0);
    v.render(mixL, mixR, 0, BLOCK);
    master.render(mixL, mixR, L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK), BLOCK, 1, v.broke);
  }
  return {L, R, sent};
};

const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

const same = (a, b) => {
  assert.equal(maxDiff(a.L, b.L), 0);
  assert.equal(maxDiff(a.R, b.R), 0);
  assert.deepEqual(a.sent, b.sent);
};

const presses = [
  ['mandelbrot', [-0.9524126, -0.1977292], 'period 2'],
  ['mandelbrot', [-0.1124342, -0.6810738], 'period 3'],
  ['burning-ship', [-0.9957607, -0.3993815], 'chaos'],
  ['mandelbrot', [0.5, 0.5], 'escape'],
];

const setup = (key, sustain, rate) => {
  const f = fractals[index(key)];
  return [
    [0, {type: 'fractal', index: index(key), param: paramOf(f, {})}],
    [0, {type: 'julia', c: null}],
    [0, {type: 'sustain', on: sustain}],
    [0, {type: 'rate', value: rate}],
  ];
};

for (const [key, point, what] of presses) {
  for (const sustain of [true, false]) {
    for (const rate of [550, 4400, 17600]) {
      test(`${key} ${what}, sustain ${sustain ? 'on' : 'off'}, rate ${rate}: bit for bit the same`, () => {
        const events = [...setup(key, sustain, rate), [0, {type: 'point', p: point}]];
        const old = runWorklet(OldWorklet, events, 2);
        let loud = 0;
        for (let i = 0; i < old.L.length; i++) loud = Math.max(loud, Math.abs(old.L[i]), Math.abs(old.R[i]));
        // every press makes some sound, even the escape (its click)
        assert.ok(loud > 1e-4, `old worklet was silent (${loud})`);
        same(runWorklet(NewWorklet, events, 2), old);
        same(runVoice(events, 2), old);
        if (what === 'escape') assert.deepEqual(old.sent, [{type: 'escaped'}]);
      });
    }
  }
}

test('a whole session of messages: glide, stop, param, julia, bad input', () => {
  const m = index('mandelbrot');
  const multi = index('multibrot');
  const events = [
    ...setup('mandelbrot', false, 4400),
    [0, {type: 'point', p: [-0.9524126, -0.1977292]}],
    [0.3, {type: 'point', p: [-0.1124342, -0.6810738]}],
    [0.5, {type: 'rate', value: 1e9}],
    [0.6, {type: 'stop'}],
    [0.7, {type: 'fractal', index: multi, param: 3}],
    [0.7, {type: 'point', p: [0.1187507, 0.8433059]}],
    [0.9, {type: 'param', value: 3.2}],
    [1.0, {type: 'fractal', index: m, param: 0}],
    [1.0, {type: 'julia', c: [-0.8, 0.156]}],
    [1.0, {type: 'point', p: [0.1, 0.2]}],
    [1.2, {type: 'point', p: [NaN, 0]}],
    [1.2, null],
    [1.2, {type: 'fractal', index: 99}],
    [1.3, {type: 'sustain', on: true}],
    [1.3, {type: 'rate', value: 600}],
    [1.5, {type: 'point', p: [3, 3]}],
  ];
  const old = runWorklet(OldWorklet, events, 2);
  same(runWorklet(NewWorklet, events, 2), old);
  same(runVoice(events, 2), old);
});

test('with the pool set to 6 voices and the others spoken to but silent, voice 0 is still bit for bit the same', () => {
  const events = [
    [0, {type: 'voices', n: 6}],
    [0, {type: 'stop', voice: 3}],
    [0, {type: 'sustain', on: true, voice: 5}],
    [0, {type: 'clear'}],
    ...setup('mandelbrot', false, 4400),
    [0, {type: 'point', p: [-0.9524126, -0.1977292]}],
    [0.3, {type: 'point', p: [-0.1124342, -0.6810738]}],
    [0.6, {type: 'stop'}],
    [0.7, {type: 'fractal', index: index('burning-ship'), param: paramOf(fractals[index('burning-ship')], {})}],
    [0.7, {type: 'point', p: [-0.9957607, -0.3993815]}],
    [1.4, {type: 'point', p: [3, 3]}],
  ];
  const old = runWorklet(OldWorklet, events.filter(([, m]) => m.voice === undefined && m.type !== 'clear' && m.type !== 'voices'), 2);
  same(runWorklet(NewWorklet, events, 2), old);
});
