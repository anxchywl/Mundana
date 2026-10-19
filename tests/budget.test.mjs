// The picture during a show: the frame budget lowers and raises the picture's detail by the 95th percentile of frame
// times, and the transport tells the song time at the moment a frame will be on screen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameBudget, BUDGET} from '../src/cantus/show.js';
import {Transport} from '../src/cantus/scheduler.js';

test('the frame budget lowers after a 2 s window over target, and raises after 5 s under it', () => {
  const b = new FrameBudget(BUDGET.laptop);
  let now = 0;
  const run = (ms, seconds) => {
    const out = [];
    for (const end = now + seconds * 1000; now < end; ) {
      now += ms;
      const way = b.step(now, ms);
      if (way) out.push([way, Math.round(now)]);
    }
    return out;
  };
  // 60 fps: nothing to do for 5 s, then a raise (there may be nothing left to raise; the show decides)
  assert.deepEqual(run(16.7, 4.9), []);
  // every frame 33 ms: lowered once the window is full, then once per window
  const slow = run(33.4, 6.1);
  assert.ok(slow.length >= 2 && slow.every(([w]) => w === 'lower'));
  assert.ok(slow[1][1] - slow[0][1] >= 2000);
  // 5 % slow frames are tolerated, 10 % are not
  const mixed = (share, seconds) => {
    const out = [];
    for (let i = 0, end = now + seconds * 1000; now < end; i++) {
      const ms = i % Math.round(1 / share) === 0 ? 33.4 : 16.7;
      now += ms;
      const way = b.step(now, ms);
      if (way) out.push(way);
    }
    return out;
  };
  b.reset(now);
  assert.ok(!mixed(0.04, 3).includes('lower'));
  b.reset(now);
  assert.ok(mixed(0.1, 3).includes('lower'));
  // after 5 s under target (plus the first full window) it raises
  b.reset(now);
  const back = run(16.7, 7.5);
  assert.deepEqual(back.map(([w]) => w), ['raise']);
});

test('songAtWall: the song time at a wall time, from the output timestamp, or the latency when there is none', () => {
  let wall = 1000;
  const ctx = {currentTime: 10, outputLatency: 0.04, getOutputTimestamp: () => ({contextTime: 9.96, performanceTime: 1000})};
  const plan = {presses: [], timeline: {duration: 60}};
  const tr = new Transport({ctx, send: () => {}, plan, timer: {set: () => 1, clear: () => {}}, wallNow: () => wall});
  tr.play(); // anchored at ctx 10.05 = song 0
  ctx.currentTime = 12;
  ctx.getOutputTimestamp = () => ({contextTime: 11.96, performanceTime: 3000});
  wall = 3000;
  assert.ok(Math.abs(tr.songAtWall(3000) - 1.91) < 1e-9);
  assert.ok(Math.abs(tr.songAtWall(3016.7) - 1.9267) < 1e-9, 'a frame ahead');
  assert.ok(Math.abs(tr.songAtWall(3000) - tr.now()) < 1e-9);
  ctx.getOutputTimestamp = () => ({contextTime: 0, performanceTime: 0});
  assert.ok(Math.abs(tr.songAtWall(3010) - (12 - 0.04 + 0.01 - 10.05)) < 1e-9);
  tr.pause();
  assert.equal(tr.songAtWall(9999), tr.pos);
});
