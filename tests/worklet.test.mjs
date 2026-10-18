// Timed presses in the worklet host: each starts on its exact sample, releases end notes, clear forgets everything,
// a full ring drops its oldest event and says so once, and the manual messages work as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Host, SR, runHost} from './worklet-host.mjs';
import {onsetIn, pitchOf} from './helpers.mjs';

const P3 = [-0.1124342, -0.6810738]; // a period 3 point of the Mandelbrot set
const press = (at, o = {}) => ({type: 'press', voice: 0, at, fractal: 'mandelbrot', p: P3, rate: 1320, velocity: 1, ...o});

test('20 presses each start within 1 sample of at * sampleRate', (t) => {
  const host = new Host();
  const times = Array.from({length: 20}, (_, k) => 0.05 + k * 0.1 + k * 0.00137);
  const msgs = [];
  for (const t of times) msgs.push(press(t), {type: 'release', voice: 0, at: t + 0.04});
  const {L} = runHost(host, 2.2, msgs.map((m) => [0, m]));
  let worst = 0;
  times.forEach((time) => {
    const want = Math.round(time * SR);
    const got = onsetIn(L, want - 400, want + 400);
    worst = Math.max(worst, Math.abs(got - want));
  });
  t.diagnostic(`worst onset ${worst} samples from at * sampleRate`);
  assert.ok(worst <= 1, `worst onset ${worst} samples off`);
});

test('a press whose sample is already past starts on the first sample of the block', () => {
  const host = new Host();
  // the message arrives before block 10 (sample 1,280) but asks for sample 100
  const {L} = runHost(host, 0.1, [[1280 / SR, press(100 / SR)]]);
  assert.equal(onsetIn(L, 1, L.length), 1280);
});

test('a release ends the note, and the note sounds its pitch until then', () => {
  const host = new Host();
  const {L, R} = runHost(host, 1, [[0, press(0.1)], [0, {type: 'release', voice: 0, at: 0.6}]]);
  const hz = pitchOf([L.subarray(0.2 * SR, 0.5 * SR), R.subarray(0.2 * SR, 0.5 * SR)], SR, {minHz: 100, maxHz: 2000});
  assert.ok(Math.abs(hz / 440 - 1) < 0.01, `${hz} Hz`);
  assert.equal(host.voice.on, false);
});

test('clear forgets pending events and lets the voice go within 15 ms', () => {
  const host = new Host();
  const {L} = runHost(host, 1, [[0, press(0.1)], [0, press(0.7)], [0.3, {type: 'clear'}]]);
  // the clear arrives before the block at 0.3 s; 15 ms later the voice is off and only the high-pass tail is left
  const quiet = Math.ceil(0.3 * SR / 128) * 128 + 0.016 * SR;
  assert.equal(onsetIn(L, quiet, L.length), -1, 'the press at 0.7 s was forgotten');
});

test('a full ring drops its oldest event and says so once', () => {
  const host = new Host();
  for (let k = 0; k < 300; k++) host.port.onmessage({data: press(10 + k * 0.01)});
  assert.equal(host.rings[0].size, 256);
  assert.deepEqual(host.sent, [{type: 'overflow'}]);
  host.port.onmessage({data: {type: 'clear'}});
  assert.equal(host.rings[0].size, 0);
});

test('events sent out of order still play in order', () => {
  const host = new Host();
  const {L} = runHost(host, 0.5, [[0, {type: 'release', voice: 0, at: 0.3}], [0, press(0.2)], [0, press(0.1)]]);
  assert.equal(onsetIn(L, 1, L.length), Math.round(0.1 * SR));
  assert.equal(host.voice.on, false);
});

test('bad timed messages are ignored', () => {
  const host = new Host();
  for (const m of [press(NaN), press(0.1, {fractal: 'nothing'}), press(0.1, {voice: 3}), press(0.1, {p: [1]}), press(0.1, {rate: 'x'}), {type: 'release', at: null}]) {
    host.port.onmessage({data: m});
  }
  assert.equal(host.rings[0].size, 0);
});
