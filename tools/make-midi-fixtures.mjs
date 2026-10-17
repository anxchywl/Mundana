// Writes the small MIDI files the tests read, from code, so every fixture is readable and can be made again:
//   node tools/make-midi-fixtures.mjs
// Each file covers one case of src/cantus/midi.js. Ode to Joy (Beethoven, public domain) and a chromatic scale are
// there to hear and to test the mapper.

import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const DIR = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));

/** a variable-length quantity, 7 bits a byte, high bit set on all but the last */
export const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];
const str = (s) => [...s].map((c) => c.charCodeAt(0));

export const header = (format, tracks, division) => [...str('MThd'), ...be32(6), ...be16(format), ...be16(tracks), ...be16(division)];
/** a track from [delta, ...bytes] events; the end of track is added unless `end` is false */
export const track = (events, {end = true, length} = {}) => {
  const body = events.flatMap(([d, ...bytes]) => [...vlq(d), ...bytes]);
  if (end) body.push(0, 0xff, 0x2f, 0);
  return [...str('MTrk'), ...be32(length ?? body.length), ...body];
};
const name = (s) => [0, 0xff, 0x03, ...vlq(s.length), ...str(s)];
const tempo = (d, us) => [d, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
const sig = (d, num, den) => [d, 0xff, 0x58, 4, num, Math.log2(den), 24, 8];
const on = (d, ch, key, vel = 100) => [d, 0x90 | ch, key, vel];
const off = (d, ch, key) => [d, 0x80 | ch, key, 64];
const cc = (d, ch, n, v) => [d, 0xb0 | ch, n, v];
const program = (d, ch, p) => [d, 0xc0 | ch, p];

/** a melody as [midi, beats] pairs (midi 0 is a rest) on one channel, at `ppq` ticks a beat */
const line = (notes, ch, ppq, vel = 96) => {
  const ev = [];
  let wait = 0;
  for (const [key, beats] of notes) {
    const len = Math.round(beats * ppq);
    if (!key) {
      wait += len;
      continue;
    }
    ev.push(on(wait, ch, key, vel), off(len, ch, key));
    wait = 0;
  }
  return ev;
};

const PPQ = 480;
const files = {};

// format 0: one track, four quarter notes at 120 bpm
files['format0.mid'] = [...header(0, 1, PPQ), ...track([name('Scale'), ...line([[60, 1], [62, 1], [64, 1], [65, 1]], 0, PPQ)])];

// format 1: a conductor track, a lead and a bass
files['format1.mid'] = [
  ...header(1, 3, PPQ),
  ...track([name('Three tracks'), tempo(0, 500000)]),
  ...track([name('Lead'), ...line([[72, 1], [74, 1], [76, 2]], 0, PPQ)]),
  ...track([name('Low part'), program(0, 1, 33), ...line([[36, 2], [43, 2]], 1, PPQ)]),
];

// running status: after the first note on, every event is two data bytes; note offs are note ons at velocity 0
files['running-status.mid'] = [
  ...header(0, 1, PPQ),
  ...track([
    [0, 0x90, 60, 100],
    [PPQ, 60, 0],
    [0, 62, 100],
    [PPQ, 62, 0],
    [0, 0xff, 0x01, 1, 0x41], // a text event cancels running status
    [0, 0x90, 64, 100],
    [PPQ, 64, 0],
  ]),
];

// note on with velocity 0 as note off, written with full status bytes
files['velocity-zero.mid'] = [
  ...header(0, 1, PPQ),
  ...track([on(0, 0, 67), on(PPQ / 2, 0, 67, 0), on(0, 0, 69), on(PPQ * 1.5, 0, 69, 0)]),
];

// tempo change halfway: four quarters at 120 bpm, then four at 60 bpm
files['tempo-change.mid'] = [
  ...header(0, 1, PPQ),
  ...track([tempo(0, 500000), ...line([[60, 1], [62, 1], [64, 1], [65, 1]], 0, PPQ), tempo(0, 1000000), ...line([[67, 1], [69, 1], [71, 1], [72, 1]], 0, PPQ)]),
];

// time signatures
files['three-four.mid'] = [...header(0, 1, PPQ), ...track([sig(0, 3, 4), ...line(Array(9).fill([60, 1]), 0, PPQ)])];
files['six-eight.mid'] = [...header(0, 1, PPQ), ...track([sig(0, 6, 8), ...line(Array(12).fill([60, 0.5]), 0, PPQ)])];

// sustain pedal: down at 0, up at 2 beats (1 s). C is let go at 0.25 s and ends at the pedal; E is let go at 0.25 s
// and struck again at 0.5 s, which ends it there
files['sustain.mid'] = [
  ...header(0, 1, PPQ),
  ...track([
    cc(0, 0, 64, 127),
    on(0, 0, 60),
    on(0, 0, 64),
    off(PPQ / 2, 0, 60),
    off(0, 0, 64),
    on(PPQ / 2, 0, 64),
    off(PPQ / 2, 0, 64),
    cc(PPQ / 2, 0, 64, 0),
    on(PPQ, 0, 67),
    off(PPQ, 0, 67),
  ]),
];

// overlapping identical notes become consecutive: on at 0, on at 1 beat, off at 2 beats, off at 3 beats
files['overlapping.mid'] = [...header(0, 1, PPQ), ...track([on(0, 0, 60), on(PPQ, 0, 60), off(PPQ, 0, 60), off(PPQ, 0, 60)])];

// missing note offs: in track 1 the note runs to its track's end at 3 s, in track 2 it is cut at 8 s of a 20 s track
files['missing-off.mid'] = [
  ...header(1, 2, PPQ),
  ...track([name('Open notes'), on(0, 0, 60), [PPQ * 6, 0xff, 0x01, 1, 0x41]]),
  ...track([on(0, 1, 64), [PPQ * 40, 0xff, 0x01, 1, 0x41]]),
];

// percussion on channel 3 in a track named "Drums", next to a melody
files['drums-channel3.mid'] = [
  ...header(1, 2, PPQ),
  ...track([name('Tune'), ...line([[72, 1], [76, 1], [79, 1], [84, 1]], 0, PPQ)]),
  ...track([name('Drums'), ...line([[36, 0.25], [0, 0.75], [38, 0.25], [0, 0.75], [42, 0.25], [0, 0.75], [36, 0.25], [0, 0.75]], 2, PPQ)]),
];

// SMPTE time: 25 frames a second, 40 ticks a frame, so 1,000 ticks a second
files['smpte.mid'] = [...header(0, 1, ((256 - 25) << 8) | 40), ...track([on(0, 0, 60), off(500, 0, 60), on(0, 0, 62), off(1000, 0, 62)])];

// format 2 is refused
files['format2.mid'] = [...header(2, 1, PPQ), ...track(line([[60, 1]], 0, PPQ))];

// a file cut in the middle of its third note
files['truncated.mid'] = files['format0.mid'].slice(0, files['format0.mid'].length - 13);

// an empty file
files['empty.mid'] = [];

// a track chunk that says it is far longer than the file
files['chunk-too-long.mid'] = [...header(0, 1, PPQ), ...track(line([[60, 1], [62, 1]], 0, PPQ), {length: 0x00ffffff})];

// random bytes, from a fixed seed
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
files['random.mid'] = Array.from({length: 2048}, rand);

// Ode to Joy, the first 16 bars and a held last note (17 bars), 4/4 at 120 bpm, with a bass under it
const E = 64;
const F = 65;
const G = 67;
const D = 62;
const C = 60;
const G3 = 55;
const ode = [
  [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1], [C, 1], [C, 1], [D, 1], [E, 1], [E, 1.5], [D, 0.5], [D, 2],
  [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1], [C, 1], [C, 1], [D, 1], [E, 1], [D, 1.5], [C, 0.5], [C, 2],
  [D, 1], [D, 1], [E, 1], [C, 1], [D, 1], [E, 0.5], [F, 0.5], [E, 1], [C, 1], [D, 1], [E, 0.5], [F, 0.5], [E, 1], [D, 1], [C, 1], [D, 1], [G3, 2],
  [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1], [C, 1], [C, 1], [D, 1], [E, 1], [D, 1.5], [C, 0.5], [C, 4],
];
const bass = [36, 43, 36, 43, 36, 43, 36, 36, 43, 43, 36, 43, 36, 43, 43, 36, 36].map((k) => [k, 4]);
files['ode-to-joy.mid'] = [
  ...header(1, 3, PPQ),
  ...track([name('Ode to Joy'), tempo(0, 500000), sig(0, 4, 4)]),
  ...track([name('Melody'), program(0, 0, 73), ...line(ode, 0, PPQ)]),
  ...track([name('Bass'), program(0, 1, 32), ...line(bass, 1, PPQ, 80)]),
];

// a two-octave chromatic scale, MIDI 48 to 72, half a second a note
files['chromatic.mid'] = [
  ...header(0, 1, PPQ),
  ...track([name('Chromatic scale'), ...line(Array.from({length: 25}, (_, i) => [48 + i, 1]), 0, PPQ)]),
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(DIR, {recursive: true});
  for (const [file, bytes] of Object.entries(files)) writeFileSync(DIR + file, Uint8Array.from(bytes));
  console.log(`${Object.keys(files).length} files in tests/fixtures/`);
}
