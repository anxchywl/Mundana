// The Timeline: validation and its bounds, merging short notes, bars and beat helpers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateTimeline, mergeShort, barsFrom, timeToBeat, beatToTime} from '../src/cantus/timeline.js';

const note = (o) => ({start: 0, duration: 0.5, midi: 60, velocity: 0.8, part: 'melody', confidence: 1, source: 'midi', ...o});
const song = (o) => ({notes: [note()], tempo: {bpm: 120, beats: [0, 0.5]}, sections: [], duration: 1, title: 'A song', ...o});

test('a good timeline comes back clean and sorted', () => {
  const t = validateTimeline(song({notes: [note({start: 0.5, midi: 62}), note({start: 0, midi: 64}), note({start: 0, midi: 60}), note({part: 'drums', drum: 'nonsense'})], extra: 1}));
  assert.deepEqual(t.notes.map((n) => [n.start, n.midi]), [[0, 60], [0, 60], [0, 64], [0.5, 62]]);
  assert.equal(t.notes.find((n) => n.part === 'drums').drum, 'other');
  assert.equal(t.extra, undefined);
  assert.deepEqual(t.sections, [{start: 0, end: 1, label: 'Song'}]);
});

test('bounds are enforced with short messages', () => {
  const bad = [
    song({duration: 0}),
    song({duration: 601}),
    song({notes: Array.from({length: 20001}, () => note())}),
    song({notes: [note({start: 2})]}),
    song({notes: [note({duration: 0.039})]}),
    song({notes: [note({midi: 128})]}),
    song({notes: [note({velocity: 1.5})]}),
    song({notes: [note({confidence: -0.1})]}),
    song({notes: [note({part: 'lead'})]}),
    song({notes: [note({source: 'file'})]}),
    song({sections: Array.from({length: 65}, () => ({start: 0, end: 1, label: 'x'}))}),
    null,
  ];
  for (const t of bad) assert.throws(() => validateTimeline(t), (e) => e.message.length < 60);
});

test('titles lose control characters and stop at 120 characters', () => {
  assert.equal(validateTimeline(song({title: 'a\u0000b\n c'})).title, 'a b c');
  assert.equal(validateTimeline(song({title: 'x'.repeat(500)})).title.length, 120);
});

test('a short note joins the next note of the same pitch, or is dropped', () => {
  const {notes, dropped, joined} = mergeShort([
    note({start: 0, duration: 0.02, midi: 60}),
    note({start: 0.03, duration: 0.5, midi: 60}), // 10 ms after: joined, now starts at 0
    note({start: 1, duration: 0.02, midi: 62}),
    note({start: 1.05, duration: 0.5, midi: 62}), // 30 ms after: too far, the short one is dropped
    note({start: 2, duration: 0.02, midi: 64}),
    note({start: 2.01, duration: 0.5, midi: 65}), // another pitch: dropped
    note({start: 3, duration: 0.01, midi: 67}),
    note({start: 3.015, duration: 0.01, midi: 67}),
    note({start: 3.03, duration: 0.3, midi: 67}), // a chain of two short ones joins
  ]);
  assert.equal(dropped, 2);
  assert.equal(joined, 3);
  assert.deepEqual(notes.map((n) => [n.start, +n.duration.toFixed(3), n.midi]), [[0, 0.53, 60], [1.05, 0.5, 62], [2.01, 0.5, 65], [3, 0.33, 67]]);
});

test('bars from beats and time signatures', () => {
  const beats = Array.from({length: 13}, (_, i) => i * 0.5);
  assert.deepEqual(barsFrom(beats), [0, 2, 4, 6]);
  assert.deepEqual(barsFrom(beats, [{time: 0, numerator: 3}]), [0, 1.5, 3, 4.5, 6]);
  // two bars of 4, then 2/4
  assert.deepEqual(barsFrom(beats, [{time: 0, numerator: 4}, {time: 4, numerator: 2}]), [0, 2, 4, 5, 6]);
});

test('time and beat convert both ways, linear between beats', () => {
  const beats = [0, 0.5, 1, 2, 3];
  assert.equal(timeToBeat(0.25, beats), 0.5);
  assert.equal(timeToBeat(1.5, beats), 2.5);
  assert.equal(timeToBeat(4, beats), 5);
  for (const b of [0, 0.3, 1.7, 2.5, 3.9]) assert.ok(Math.abs(timeToBeat(beatToTime(b, beats), beats) - b) < 1e-12);
});
