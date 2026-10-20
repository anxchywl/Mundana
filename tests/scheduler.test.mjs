// The look-ahead scheduler and transport, on a fake AudioContext clock and a fake timer.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Transport, HORIZON, HORIZON_LATE, START_DELAY} from '../src/cantus/scheduler.js';

/** a plan of one-voice presses, each [time, duration] */
const planOf = (notes, duration) => ({
  presses: notes.map(([time, d], i) => ({time, duration: d, voice: 0, fractal: 'mandelbrot', point: [i, 0], z0: [0, 0], rate: 1000, velocity: 1, part: 'melody'})),
  timeline: {duration},
});

/** a clock the test moves by hand; wake() runs the timer as a browser would, every 25 ms */
const rig = (plan, {latency = 0} = {}) => {
  const ctx = {currentTime: 0, outputLatency: latency};
  const sent = [];
  let wall = 0;
  let tick = null;
  const ended = [];
  const tr = new Transport({
    ctx,
    send: (m) => sent.push({...m, sentAt: ctx.currentTime}),
    plan,
    onEnd: () => ended.push(ctx.currentTime),
    timer: {set: (f) => ((tick = f), 1), clear: () => (tick = null)},
    wallNow: () => wall,
  });
  const run = (seconds, step = 0.025) => {
    for (let t = 0; t < seconds - 1e-9; t += step) {
      ctx.currentTime += step;
      wall += step * 1000;
      tick?.();
    }
  };
  return {ctx, sent, tr, run, ended, late: (ms) => (wall += ms)};
};

const presses = (sent) => sent.filter((m) => m.type === 'press');

test('every note is sent ahead of its time, at its exact context time', () => {
  const notes = Array.from({length: 40}, (_, i) => [i * 0.25, 0.2]);
  const {sent, tr, run} = rig(planOf(notes, 10));
  tr.play();
  run(11);
  const p = presses(sent);
  assert.equal(p.length, 40);
  p.forEach((m, i) => {
    assert.ok(Math.abs(m.at - (START_DELAY + i * 0.25)) < 1e-9);
    assert.ok(m.at > m.sentAt, 'sent before it plays');
    assert.ok(m.at - m.sentAt <= HORIZON + START_DELAY + 1e-9, 'not sent far ahead');
  });
  assert.equal(sent.filter((m) => m.type === 'release').length, 40);
  assert.equal(tr.state, 'stopped', 'the song ended by itself');
});

test('a wake more than 50 ms late raises the horizon to 0.3 s', () => {
  const {tr, run, late} = rig(planOf([[0, 1]], 30));
  tr.play();
  run(1);
  assert.equal(tr.horizon, HORIZON);
  late(80);
  run(0.05);
  assert.equal(tr.horizon, HORIZON_LATE);
});

test('pause clears, keeps the song time, and play resumes there 50 ms ahead', () => {
  const {ctx, sent, tr, run} = rig(planOf([[0, 0.5], [1, 3], [5, 0.5]], 6));
  tr.play();
  run(2);
  tr.pause();
  assert.equal(sent.at(-1).type, 'clear');
  const t = tr.now();
  assert.ok(Math.abs(t - (2 - START_DELAY)) < 0.03, `paused at ${t}`);
  run(1);
  sent.length = 0;
  tr.play();
  // the held note (1 to 4 s) is pressed again with its offset, at the new anchor
  const [held] = presses(sent);
  assert.ok(Math.abs(held.at - (ctx.currentTime + START_DELAY)) < 1e-9);
  assert.ok(Math.abs(held.offset - (t - 1)) < 1e-9);
});

test('seek presses the note sounding at the new time, with its offset', () => {
  const {ctx, sent, tr, run} = rig(planOf([[0, 0.5], [1, 3], [5, 0.5]], 6));
  tr.play();
  run(0.3);
  sent.length = 0;
  tr.seek(2.5);
  assert.equal(sent[0].type, 'clear');
  const [held] = presses(sent);
  assert.equal(held.p[0], 1);
  assert.ok(Math.abs(held.offset - 1.5) < 1e-9);
  run(0.2);
  assert.ok(Math.abs(tr.now() - 2.5 - (ctx.currentTime - held.at)) < 0.03);
});

test('a loop wraps inside the look-ahead: the loop start is sent before the loop end plays, ten times', () => {
  // four bars of 4/4 at 120 bpm: 8 s, quarter notes
  const notes = Array.from({length: 48}, (_, i) => [i * 0.5, 0.45]);
  const {sent, tr, run} = rig(planOf(notes, 24));
  tr.setLoop(4, 12);
  tr.play();
  run(8 * 10 + 1);
  const wraps = sent.filter((m, i) => m.type === 'press' && m.p[0] === 8 && i > 0);
  assert.ok(wraps.length >= 10, `${wraps.length} wraps`);
  for (const w of wraps) assert.ok(w.at > w.sentAt, 'the first note of the loop is sent before it plays');
  // between two wraps there are exactly 16 presses, 0.5 s apart: no gap and no double
  const p = presses(sent);
  for (let i = 1; i < p.length; i++) assert.ok(Math.abs(p[i].at - p[i - 1].at - 0.5) < 1e-9, `gap at ${p[i].at}`);
  assert.ok(tr.now() >= 4 && tr.now() < 12);
  assert.ok(tr.minLead > 0);
});

test('now() follows the speakers: output latency is taken off', () => {
  const {tr, run} = rig(planOf([[0, 10]], 10), {latency: 0.04});
  tr.play();
  run(1);
  assert.ok(Math.abs(tr.now() - (1 - START_DELAY - 0.04)) < 1e-9);
});

test('stop clears and goes back to the start', () => {
  const {sent, tr, run} = rig(planOf([[0, 1]], 2));
  tr.play();
  run(0.5);
  tr.stop();
  assert.equal(sent.at(-1).type, 'clear');
  assert.equal(tr.now(), 0);
  assert.equal(tr.state, 'stopped');
});

test('a new plan while playing takes over at the next wake, where the sent messages end', () => {
  const a = planOf([[0, 4], [5, 1]], 8);
  const b = planOf([[0, 4], [2, 3], [6, 1]], 8);
  b.presses.forEach((p) => (p.fractal = 'multibrot'));
  const {sent, tr, run, ctx} = rig(a);
  tr.play();
  run(1);
  const sentTo = tr.sentTo;
  const before = sent.length;
  tr.setPlan(b);
  assert.equal(tr.plan, a, 'not before the next wake');
  run(0.025);
  assert.equal(tr.plan, b);
  const at = tr.ctxOf(tr.anchors[tr.anchors.length - 1], sentTo);
  const after = sent.slice(before);
  // every voice released at the change, then the new plan's sounding note pressed again from where it is
  assert.deepEqual(after.slice(0, 1).map((m) => [m.type, m.at]), [['release', at]]);
  assert.equal(after[1].type, 'press');
  assert.equal(after[1].at, at);
  assert.equal(after[1].fractal, 'multibrot');
  assert.ok(Math.abs(after[1].offset - sentTo) < 1e-9);
  assert.ok(at > ctx.currentTime, 'never in the past');
  run(8);
  const later = presses(sent.slice(before));
  assert.ok(later.every((m) => m.fractal === 'multibrot'), 'nothing of the old plan after the change');
  assert.deepEqual(later.slice(1).map((m) => +(m.at - START_DELAY).toFixed(6)), [2, 6]);
});

test('a new plan while paused or stopped is taken at once', () => {
  const {tr, run} = rig(planOf([[0, 1]], 10));
  tr.play();
  run(3);
  tr.pause();
  const pos = tr.pos;
  tr.setPlan(planOf([[0, 1]], 2));
  assert.equal(tr.duration, 2);
  assert.ok(tr.pos <= 2 && pos > 2);
  tr.stop();
  tr.setPlan(planOf([[1, 1]], 5));
  assert.equal(tr.presses[0].time, 1);
});

test('before the first anchor the picture is just before the start, the song time stays there; anchors are announced', () => {
  const anchors = [];
  const ctx = {currentTime: 1, outputLatency: 0};
  let wall = 1000;
  const tr = new Transport({ctx, send: () => {}, plan: planOf([[0, 0.5], [5, 0.5]], 10), onAnchor: (a) => anchors.push({...a}), timer: {set: () => 1, clear: () => {}}, wallNow: () => wall});
  tr.play();
  assert.deepEqual(anchors, [{ctx: 1 + START_DELAY, song: 0}]);
  // the picture at this moment: before the song starts, so a note at 0 is not drawn yet
  assert.ok(Math.abs(tr.songAtWall(wall) + START_DELAY) < 1e-9);
  assert.equal(tr.now(), 0);
  tr.seek(5);
  assert.deepEqual(anchors[1], {ctx: 1 + START_DELAY, song: 5});
  assert.ok(tr.songAtWall(wall) < 5 && tr.songAtWall(wall) > 4.9);
  assert.equal(tr.now(), 5);
  ctx.currentTime += 0.2;
  wall += 200;
  assert.ok(Math.abs(tr.songAtWall(wall) - 5.15) < 1e-9);
});
