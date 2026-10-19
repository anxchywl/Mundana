// The editor's edits: move, stretch, transpose, delete, a new part, undo and redo, and the bounds. No edit can make an
// invalid timeline, and the undo history of a 20,000 note song stays small.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import {applyEdit, clampEdit, History, snap, firstFrom, MAX_STEPS} from '../src/cantus/editor.js';
import {validateTimeline, MIN_NOTE, MAX_SECONDS, DRUMS} from '../src/cantus/timeline.js';
import {parseMidi} from '../src/cantus/midi.js';
import {indexPoints} from '../src/cantus/points.js';
import {planShow} from '../src/cantus/mapper.js';

const note = (start, midi, o = {}) => ({start, duration: 0.5, midi, velocity: 0.8, part: 'melody', confidence: 1, source: 'midi', ...o});
const song = (notes, duration = 10) => validateTimeline({notes, tempo: {bpm: 120, beats: Array.from({length: 20}, (_, i) => i * 0.5)}, sections: [], duration, title: 't'});
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const idOf = (t, midi) => t.notes.find((n) => n.midi === midi).id;
/** the timeline is valid: checking it again changes nothing, and the ids are unique */
const valid = (t) => {
  const again = validateTimeline(t);
  assert.equal(again.notes.length, t.notes.length);
  assert.deepEqual(again.notes, t.notes.map((n) => ({...n})));
  assert.equal(new Set(t.notes.map((n) => n.id)).size, t.notes.length);
  for (let i = 1; i < t.notes.length; i++) assert.ok(t.notes[i - 1].start <= t.notes[i].start);
};

test('every note gets a unique id; ids that clash or are missing are numbered on', () => {
  const t = validateTimeline({notes: [note(1, 60, {id: 5}), note(0, 62, {id: 5}), note(2, 64), note(3, 65, {id: -1})], tempo: {}, sections: [], duration: 5, title: 't'});
  const ids = t.notes.map((n) => n.id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(t.notes.find((n) => n.midi === 60).id, 5, 'the first holder keeps its id');
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 0));
  const midi = fixture('ode-to-joy.mid');
  assert.equal(new Set(midi.notes.map((n) => n.id)).size, midi.notes.length);
});

test('move: time and pitch together, ids and other notes unchanged', () => {
  const t = song([note(0, 60), note(1, 62), note(2, 64)]);
  const id = idOf(t, 62);
  const u = applyEdit(t, {type: 'move', ids: [id], dt: 2.25, dmidi: 3});
  valid(u);
  const m = u.notes.find((n) => n.id === id);
  assert.equal(m.start, 3.25);
  assert.equal(m.midi, 65);
  assert.equal(u.notes[0], t.notes[0], 'a note the edit does not touch is the same object');
  assert.deepEqual(u.notes.map((n) => n.midi), [60, 64, 65], 'sorted again');
  assert.equal(t.notes[1].start, 1, 'the old timeline is not changed');
});

test('stretch: longer and shorter, and a note stops at 40 ms', () => {
  const t = song([note(0, 60), note(1, 62, {duration: 1})]);
  const id = idOf(t, 62);
  assert.equal(applyEdit(t, {type: 'stretch', ids: [id], dd: 0.75}).notes[1].duration, 1.75);
  const short = applyEdit(t, {type: 'stretch', ids: [id], dd: -5});
  valid(short);
  assert.equal(short.notes[1].duration, MIN_NOTE);
  // two notes: each stops at 40 ms on its own
  const both = applyEdit(t, {type: 'stretch', ids: t.notes.map((n) => n.id), dd: -0.7});
  assert.deepEqual(both.notes.map((n) => n.duration), [MIN_NOTE, 0.30000000000000004]);
});

test('transpose: a phrase up an octave, and the top note stops the group at 127', () => {
  const t = song([note(0, 60), note(1, 64), note(2, 120)]);
  const ids = t.notes.map((n) => n.id);
  assert.deepEqual(applyEdit(t, {type: 'transpose', ids: ids.slice(0, 2), dmidi: 12}).notes.map((n) => n.midi), [72, 76, 120]);
  const top = applyEdit(t, {type: 'transpose', ids, dmidi: 12});
  valid(top);
  assert.deepEqual(top.notes.map((n) => n.midi), [67, 71, 127]);
  const low = applyEdit(t, {type: 'transpose', ids, dmidi: -100});
  assert.deepEqual(low.notes.map((n) => n.midi), [0, 4, 60]);
  // a fractional pitch (from audio) keeps its fraction and stays inside 0..127
  const f = song([note(0, 126.6, {source: 'audio', confidence: 0.5})]);
  const g = applyEdit(f, {type: 'transpose', ids: [f.notes[0].id], dmidi: 1});
  assert.equal(g, f, 'one more semitone would pass 127: nothing changes');
  assert.ok(Math.abs(applyEdit(f, {type: 'transpose', ids: [f.notes[0].id], dmidi: -2}).notes[0].midi - 124.6) < 1e-9);
});

test('delete: the notes go, track counts follow', () => {
  const t = fixture('ode-to-joy.mid');
  const melody = t.notes.filter((n) => n.part === 'melody').slice(0, 3).map((n) => n.id);
  const u = applyEdit(t, {type: 'delete', ids: melody});
  valid(u);
  assert.equal(u.notes.length, t.notes.length - 3);
  assert.ok(!u.notes.some((n) => melody.includes(n.id)));
  const track = t.notes.find((n) => n.id === melody[0]).track;
  assert.equal(u.tracks[track].notes, t.tracks[track].notes - 3);
});

test('a new part: a chord tone to bass, a note to drums gets other, back again loses its drum', () => {
  const t = song([note(0, 60, {part: 'chords'}), note(0, 64, {part: 'chords'}), note(0, 67, {part: 'chords'})]);
  const bass = applyEdit(t, {type: 'part', ids: [idOf(t, 60)], part: 'bass'});
  valid(bass);
  assert.deepEqual(bass.notes.map((n) => n.part), ['bass', 'chords', 'chords']);
  const drums = applyEdit(t, {type: 'part', ids: [idOf(t, 64)], part: 'drums'});
  assert.equal(drums.notes.find((n) => n.midi === 64).drum, 'other');
  const back = applyEdit(drums, {type: 'part', ids: [idOf(t, 64)], part: 'melody'});
  assert.equal(back.notes.find((n) => n.midi === 64).drum, undefined);
  assert.equal(applyEdit(t, {type: 'part', ids: [idOf(t, 60)], part: 'chords'}), t, 'the same part: no change');
  assert.equal(applyEdit(t, {type: 'part', ids: [idOf(t, 60)], part: 'lead'}), t, 'an unknown part: no change');
  // a drum row moves with a drag in the drum lane, and stops at the last row
  const d = song([note(0, 36, {part: 'drums', drum: 'kick'}), note(1, 42, {part: 'drums', drum: 'hat'})]);
  const down = applyEdit(d, {type: 'move', ids: d.notes.map((n) => n.id), drow: 5});
  assert.deepEqual(down.notes.map((n) => n.drum), ['snare', 'other']);
  assert.deepEqual(down.notes.map((n) => n.midi), [36, 42], 'a drum note keeps its key');
});

test('bounds: start never below 0, a group stops together, the song grows to hold a note', () => {
  const t = song([note(0.5, 60), note(2, 62)], 4);
  const ids = t.notes.map((n) => n.id);
  const left = applyEdit(t, {type: 'move', ids, dt: -3});
  assert.deepEqual(left.notes.map((n) => n.start), [0, 1.5]);
  const right = applyEdit(t, {type: 'move', ids: [ids[1]], dt: 10});
  valid(right);
  assert.equal(right.duration, 12.5, 'the song is as long as its last note');
  const far = applyEdit(t, {type: 'move', ids, dt: 1e6});
  valid(far);
  assert.equal(far.notes[1].start + far.notes[1].duration, MAX_SECONDS, 'stops at 10 minutes');
  assert.equal(far.duration, MAX_SECONDS);
  assert.equal(applyEdit(t, {type: 'move', ids: [999], dt: 1}), t, 'unknown ids change nothing');
  assert.equal(applyEdit(t, {type: 'move', ids, dt: 0}), t);
  assert.equal(clampEdit(t, {type: 'move', ids, dt: -3}).dt, -0.5);
});

test('no edit can make an invalid timeline (2,000 random edits, each checked)', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let t = fixture('band.mid');
  const types = ['move', 'stretch', 'transpose', 'delete', 'part'];
  for (let i = 0; i < 2000; i++) {
    const ids = t.notes.filter(() => rnd() < 0.05).map((n) => n.id);
    if (rnd() < 0.05) ids.push(1e9, -3, 'x');
    const type = pick(types);
    const big = () => (rnd() - 0.5) * (rnd() < 0.2 ? 2000 : 20);
    const e = {type, ids, dt: big(), dmidi: big() * 5, drow: big(), dd: big(), part: pick(['melody', 'bass', 'chords', 'drums']), drum: pick([...DRUMS, 'cowbell'])};
    if (type === 'delete' && t.notes.length < 40) continue;
    t = applyEdit(t, e);
    if (i % 50 === 0) valid(t);
    for (const n of t.notes) {
      assert.ok(n.start >= 0 && n.start <= t.duration && n.duration >= MIN_NOTE && n.midi >= 0 && n.midi <= 127);
    }
  }
  valid(t);
  // and the result still plans
  const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
  assert.ok(planShow(t, {}, points).presses.length > 0);
});

test('undo and redo: 100 steps, a new edit clears redo', () => {
  const t = song([note(0, 60), note(1, 62)]);
  const h = new History(t);
  const id = idOf(t, 60);
  for (let i = 0; i < 120; i++) h.apply({type: 'move', ids: [id], dt: 0.01});
  assert.equal(h.past.length, MAX_STEPS);
  let u = h.timeline;
  assert.ok(Math.abs(u.notes.find((n) => n.id === id).start - 1.2) < 1e-9);
  for (let i = 0; i < 100; i++) u = h.undo();
  assert.equal(h.undo(), null, 'no more than 100 back');
  assert.ok(Math.abs(u.notes.find((n) => n.id === id).start - 0.2) < 1e-9);
  assert.ok(h.redo());
  assert.equal(h.future.length, 99);
  h.apply({type: 'delete', ids: [id]});
  assert.equal(h.future.length, 0);
  assert.equal(h.redo(), null);
  assert.equal(h.apply({type: 'move', ids: [id], dt: 1}), null, 'an edit of nothing is not a step');
  const back = h.undo();
  assert.equal(back.notes.length, 2);
});

// the garbage collector, to measure the heap; no flag needed on the command line
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

test('undo memory: 100 edits of a 20,000 note song', () => {
  const notes = Array.from({length: 20000}, (_, i) => note((i * 0.029) % 590, 36 + (i % 60), {part: ['melody', 'bass', 'chords', 'drums'][i % 4], drum: 'hat'}));
  const t = validateTimeline({notes, tempo: {bpm: 120, beats: []}, sections: [], duration: 600, title: 'big'});
  const run = (count) => {
    gc();
    const before = process.memoryUsage().heapUsed;
    const h = new History(t);
    const ids = t.notes.map((n) => n.id);
    for (let i = 0; i < 100; i++) h.apply({type: 'transpose', ids: ids.slice((i * 97) % (20000 - count), ((i * 97) % (20000 - count)) + count), dmidi: i % 2 ? 1 : -1});
    gc();
    const mb = (process.memoryUsage().heapUsed - before) / 1e6;
    return {mb, steps: h.past.length, h};
  };
  const small = run(16);
  const all = run(19999);
  console.log(`undo memory, 100 edits of 16 notes: ${small.mb.toFixed(1)} MB, ${small.steps} steps; of all notes: ${all.mb.toFixed(1)} MB, ${all.steps} steps kept`);
  assert.equal(small.steps, 100);
  assert.ok(small.mb < 50 && all.mb < 50);
});

test('snap and search helpers', () => {
  const beats = [0, 0.5, 1, 1.5];
  assert.equal(snap(0.26, beats), 0.25);
  assert.equal(snap(0.53, beats), 0.53125);
  assert.equal(snap(10.01, beats), 10, 'past the last beat, the last beat length goes on');
  const ns = [{start: 0}, {start: 1}, {start: 1}, {start: 3}];
  assert.equal(firstFrom(ns, 1), 1);
  assert.equal(firstFrom(ns, 2), 3);
  assert.equal(firstFrom(ns, 9), 4);
});
