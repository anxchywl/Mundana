// The MIDI parser, one fixture per case (written by tools/make-midi-fixtures.mjs), and part assignment.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMidi, assignParts, setTrackPart, MAX_BYTES} from '../src/cantus/midi.js';

const load = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const parse = (name) => parseMidi(load(name), name);

/** notes as [midi, start, duration], compared within 1 ms */
const expectNotes = (t, want) => {
  const got = t.notes.map((n) => [n.midi, n.start, n.duration]);
  assert.equal(got.length, want.length, JSON.stringify(got));
  want.forEach(([midi, start, duration], i) => {
    assert.equal(got[i][0], midi, `note ${i} pitch`);
    assert.ok(Math.abs(got[i][1] - start) < 0.001, `note ${i} starts at ${got[i][1]}, wanted ${start}`);
    assert.ok(Math.abs(got[i][2] - duration) < 0.001, `note ${i} lasts ${got[i][2]}, wanted ${duration}`);
  });
};

test('format 0: four quarter notes at 120 bpm', () => {
  const t = parse('format0.mid');
  expectNotes(t, [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 0.5], [65, 1.5, 0.5]]);
  assert.equal(t.title, 'Scale');
  assert.equal(t.tempo.bpm, 120);
  assert.equal(t.duration, 2);
  for (const n of t.notes) {
    assert.equal(n.confidence, 1);
    assert.equal(n.source, 'midi');
    assert.ok(Math.abs(n.velocity - 96 / 127) < 1e-9);
  }
});

test('format 1 with 3 tracks: a conductor, a lead and a bass', () => {
  const t = parse('format1.mid');
  expectNotes(t, [[36, 0, 1], [72, 0, 0.5], [74, 0.5, 0.5], [43, 1, 1], [76, 1, 1]]);
  assert.equal(t.title, 'Three tracks');
  assert.deepEqual(t.tracks.map((k) => [k.name, k.part, k.notes]), [['Lead', 'melody', 3], ['Low part', 'bass', 2]]);
});

test('running status, cancelled by a meta event', () => {
  expectNotes(parse('running-status.mid'), [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 0.5]]);
});

test('note on with velocity 0 is a note off', () => {
  expectNotes(parse('velocity-zero.mid'), [[67, 0, 0.25], [69, 0.25, 0.75]]);
});

test('a tempo change halfway', () => {
  const t = parse('tempo-change.mid');
  expectNotes(t, [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 0.5], [65, 1.5, 0.5], [67, 2, 1], [69, 3, 1], [71, 4, 1], [72, 5, 1]]);
  // 60 bpm holds for 4 s, 120 bpm for 2 s
  assert.equal(t.tempo.bpm, 60);
  assert.deepEqual(t.tempo.beats.slice(0, 7), [0, 0.5, 1, 1.5, 2, 3, 4]);
});

test('3/4: bars every three quarter notes', () => {
  const t = parse('three-four.mid');
  assert.deepEqual(t.bars, [0, 1.5, 3]);
  assert.equal(t.tempo.beats[1], 0.5);
});

test('6/8: the beat is an eighth, bars every six', () => {
  const t = parse('six-eight.mid');
  assert.deepEqual(t.bars, [0, 1.5]);
  assert.equal(t.tempo.beats[1], 0.25);
  assert.equal(t.notes.length, 12);
});

test('the sustain pedal holds a released note until it comes up, or until the key is struck again', () => {
  expectNotes(parse('sustain.mid'), [[60, 0, 1], [64, 0, 0.5], [64, 0.5, 0.5], [67, 1.5, 0.5]]);
});

test('overlapping identical notes become consecutive', () => {
  expectNotes(parse('overlapping.mid'), [[60, 0, 0.5], [60, 0.5, 0.5]]);
});

test('a note with no note off ends at its track end, and after 8 s at most', () => {
  expectNotes(parse('missing-off.mid'), [[60, 0, 3], [64, 0, 8]]);
});

test('percussion on channel 3 in a track named Drums is drums, marked as guessed', () => {
  const t = parse('drums-channel3.mid');
  assert.deepEqual(t.tracks.map((k) => [k.name, k.part, k.guessed]), [['Tune', 'melody', false], ['Drums', 'drums', true]]);
  const drums = t.notes.filter((n) => n.part === 'drums');
  assert.deepEqual(drums.map((n) => n.drum), ['kick', 'snare', 'hat', 'kick']);
  expectNotes({notes: drums}, [[36, 0, 0.125], [38, 0.5, 0.125], [42, 1, 0.125], [36, 1.5, 0.125]]);
});

test('SMPTE division: 25 frames of 40 ticks a second', () => {
  expectNotes(parse('smpte.mid'), [[60, 0, 0.5], [62, 0.5, 1]]);
});

test('format 2 is refused', () => {
  assert.throws(() => parse('format2.mid'), {message: 'This MIDI type is not supported.'});
});

test('a truncated file keeps the notes before the cut', () => {
  expectNotes(parse('truncated.mid'), [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 0.5]]);
});

test('an empty file and random bytes are not MIDI files', () => {
  assert.throws(() => parse('empty.mid'), {message: 'This is not a MIDI file.'});
  assert.throws(() => parse('random.mid'), {message: 'This is not a MIDI file.'});
});

test('a chunk length past the end of the file is read up to the end', () => {
  const t = parse('chunk-too-long.mid');
  expectNotes(t, [[60, 0, 0.5], [62, 0.5, 0.5]]);
  assert.equal(t.title, 'chunk-too-long');
});

test('files over 4 MB are refused before reading', () => {
  assert.throws(() => parseMidi(new ArrayBuffer(MAX_BYTES + 1)), {message: 'MIDI files can be up to 4 MB.'});
});

test('every prefix of every fixture either parses or fails with a short message', () => {
  for (const name of ['format1.mid', 'sustain.mid', 'ode-to-joy.mid', 'smpte.mid']) {
    const all = new Uint8Array(load(name));
    for (let n = 0; n <= all.length; n++) {
      try {
        parseMidi(all.slice(0, n).buffer, name);
      } catch (e) {
        assert.ok(e.message.length < 60 && !/undefined|null|NaN/.test(e.message), e.message);
      }
    }
  }
});

test('Ode to Joy: melody and bass, 17 bars of 4/4', () => {
  const t = parse('ode-to-joy.mid');
  assert.deepEqual(t.tracks.map((k) => [k.name, k.part]), [['Melody', 'melody'], ['Bass', 'bass']]);
  assert.equal(t.duration, 34);
  assert.equal(t.bars.length, 17);
  assert.equal(t.dropped, 0);
});

test('changing a track part rewrites its notes', () => {
  const t = parse('format1.mid');
  const u = setTrackPart(t, 1, 'drums');
  assert.ok(u.notes.filter((n) => n.track === 1).every((n) => n.part === 'drums' && ['kick', 'other'].includes(n.drum)));
  assert.equal(u.tracks[1].part, 'drums');
  const back = setTrackPart(u, 1, 'bass');
  assert.ok(back.notes.filter((n) => n.track === 1).every((n) => n.part === 'bass' && !('drum' in n)));
  assert.equal(t.tracks[1].part, 'bass', 'the original is unchanged');
});

test('part assignment follows the rules in order', () => {
  const notes = (midis, len = 0.5, step = 0.5) => midis.map((midi, i) => ({midi, start: i * step, duration: len}));
  const parts = assignParts([
    {name: 'Piano', channel: 0, program: 0, notes: notes([60, 64, 67], 2, 0)}, // a chord: overlaps, so chords
    {name: 'Strings', channel: 1, program: 48, notes: notes([72, 74, 76])}, // highest alone: melody
    {name: 'Low', channel: 2, program: 0, notes: notes([40, 43])}, // below 52: bass
    {name: 'Kit', channel: 9, program: 0, notes: notes([36, 38])}, // channel 10: drums
    {name: 'Synth', channel: 3, program: 33, notes: notes([80, 82])}, // program 33: bass, however high
  ]);
  assert.deepEqual(parts.map((p) => p.part), ['chords', 'melody', 'bass', 'drums', 'bass']);
  // a track named for the tune wins over a higher one
  const named = assignParts([
    {name: 'Vocal', channel: 0, program: 0, notes: notes([60, 62])},
    {name: 'Flute', channel: 1, program: 73, notes: notes([84, 86])},
  ]);
  assert.deepEqual(named.map((p) => p.part), ['melody', 'chords']);
  // only chords: the highest becomes the melody
  const chords = assignParts([
    {name: 'A', channel: 0, program: 0, notes: notes([60, 64, 67], 2, 0)},
    {name: 'B', channel: 1, program: 0, notes: notes([72, 76, 79], 2, 0)},
  ]);
  assert.deepEqual(chords.map((p) => p.part), ['chords', 'melody']);
});
