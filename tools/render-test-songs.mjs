// Test audio for the audio transcription, with its truth: three public domain melodies with bass, chords and a drum
// loop, written as code, and the MIDI fixtures, rendered by a simple additive synth at 22,050 Hz. Each song comes as
// the melody alone, the melody with the bass, and the full mix. tests/transcription.test.mjs scores analyseAudio
// against the truth kept here. Run it to write the audio as WAV files:
//   node tools/render-test-songs.mjs <folder> [--long 240]
// (--long writes one more song of that many seconds, for timing a long analysis in the browser).

import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMidi} from '../src/cantus/midi.js';

export const SR = 22050;

// the levels of the mix, fixed before any analysis ran: a lead on top, as in most mixes
export const LEVEL = {melody: 0.25, bass: 0.28, chord: 0.06, kick: 0.45, snare: 0.22, hat: 0.08};
export const QUALITIES = {maj: [0, 4, 7], min: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus2: [0, 2, 7], sus4: [0, 5, 7]};

const NAMES = {C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11};
/** 'C4' is 60 */
const midiOf = (s) => {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(s);
  return NAMES[m[1]] + 12 * (Number(m[2]) + 1);
};
/** 'Am' -> {root 9, quality 'min'}; 'G7', 'Dm7', 'Cmaj7', 'Gsus4', 'F' */
const chordOf = (s) => {
  const m = /^([A-G][#b]?)(maj7|m7|m|7|sus2|sus4)?$/.exec(s);
  const q = {undefined: 'maj', m: 'min', 7: '7', m7: 'm7', maj7: 'maj7', sus2: 'sus2', sus4: 'sus4'}[m[2]];
  return {root: NAMES[m[1]], quality: q};
};

/**
 * A song from a melody line [[note, beats], ...] (null is a rest) and chords [[name, beats], ...], at `bpm` in 4/4,
 * moved by `shift` semitones. The bass plays each chord's root (and its fifth on the third beat of a whole bar
 * chord); the drums play kick on 1 and 3, snare on 2 and 4, a hat on every eighth.
 */
const makeSong = ({title, bpm, shift = 0, melody, chords, extraKick = false}) => {
  const beat = 60 / bpm;
  const song = {title, bpm, melody: [], bass: [], chords: [], drums: [], beats: []};
  let t = 0;
  for (const [name, beats] of melody) {
    if (name) song.melody.push({start: t * beat, duration: beats * beat * 0.9, midi: midiOf(name) + shift});
    t += beats;
  }
  const total = t;
  t = 0;
  for (const [name, beats] of chords) {
    const c = chordOf(name);
    const root = (c.root + shift + 12) % 12;
    song.chords.push({start: t * beat, end: (t + beats) * beat, root, quality: c.quality});
    const bassRoot = 40 + ((root - 4 + 12) % 12); // E2 to D#3
    const fifth = bassRoot + 7 > 52 ? bassRoot - 5 : bassRoot + 7;
    for (let b = 0; b < beats; b += 2) {
      const pitch = beats === 4 && b === 2 ? fifth : bassRoot;
      song.bass.push({start: (t + b) * beat, duration: Math.min(2, beats - b) * beat * 0.9, midi: pitch});
    }
    t += beats;
  }
  if (Math.abs(t - total) > 1e-9) throw new Error(`${title}: chords last ${t} beats, the melody ${total}`);
  for (let b = 0; b < total; b++) {
    song.beats.push(b * beat);
    const inBar = b % 4;
    song.drums.push({start: b * beat, drum: inBar === 0 || inBar === 2 ? 'kick' : 'snare'});
    if (extraKick && inBar === 1) song.drums.push({start: (b + 0.5) * beat, drum: 'kick'});
    song.drums.push({start: b * beat, drum: 'hat'}, {start: (b + 0.5) * beat, drum: 'hat'});
  }
  song.drums.sort((a, b) => a.start - b.start);
  song.duration = total * beat + 1;
  return song;
};

// Ode to Joy (Beethoven, 1824), in D major
const odeA = [['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1], ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1]];
const odeB = [
  ['D4', 1], ['D4', 1], ['E4', 1], ['C4', 1], ['D4', 1], ['E4', 0.5], ['F4', 0.5], ['E4', 1], ['C4', 1],
  ['D4', 1], ['E4', 0.5], ['F4', 0.5], ['E4', 1], ['D4', 1], ['C4', 1], ['D4', 1], ['G3', 2],
];
const odeEnd1 = [['E4', 1.5], ['D4', 0.5], ['D4', 2]];
const odeEnd2 = [['D4', 1.5], ['C4', 0.5], ['C4', 2]];
const ode = makeSong({
  title: 'Ode to Joy',
  bpm: 112,
  shift: 2,
  melody: [...odeA, ...odeEnd1, ...odeA, ...odeEnd2, ...odeB, ...odeA, ...odeEnd2, ...odeB, ...odeA, ...odeEnd2],
  chords: [
    ['C', 4], ['G', 4], ['C', 4], ['G', 4],
    ['C', 4], ['G', 4], ['C', 4], ['G7', 2], ['C', 2],
    ['G', 4], ['G7', 2], ['C', 2], ['G7', 2], ['Am', 2], ['Dm7', 2], ['Gsus4', 2],
    ['Cmaj7', 4], ['G', 4], ['Am', 4], ['G7', 2], ['C', 2],
    ['G', 4], ['G7', 2], ['C', 2], ['G7', 2], ['Am', 2], ['Dm7', 2], ['G', 2],
    ['C', 4], ['Gsus2', 2], ['G', 2], ['Am', 4], ['G7', 2], ['C', 2],
  ],
});

// Twinkle, Twinkle, Little Star (a French tune of the 1760s), in G major
const twA = [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2]];
const twB = [['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2]];
const twChordsA = [['C', 4], ['F', 2], ['C', 2], ['Dm7', 2], ['Am', 2], ['G7', 2], ['C', 2]];
const twChordsB = [['C', 2], ['Fmaj7', 2], ['Am', 2], ['G', 2], ['Em', 2], ['F', 2], ['Dm', 2], ['G', 2]];
const twinkle = makeSong({
  title: 'Twinkle, Twinkle',
  bpm: 96,
  shift: 7,
  melody: [...twA, ...twB, ...twB, ...twA, ...twA, ...twB, ...twB, ...twA],
  chords: [...twChordsA, ...twChordsB, ...twChordsA, ...twChordsA, ...twChordsB, ...twChordsA],
});

// Frere Jacques (a French round of the 1700s), in F major, faster, with eighth notes
const fj = [
  ['F4', 1], ['G4', 1], ['A4', 1], ['F4', 1], ['F4', 1], ['G4', 1], ['A4', 1], ['F4', 1],
  ['A4', 1], ['Bb4', 1], ['C5', 2], ['A4', 1], ['Bb4', 1], ['C5', 2],
  ['C5', 0.5], ['D5', 0.5], ['C5', 0.5], ['Bb4', 0.5], ['A4', 1], ['F4', 1],
  ['C5', 0.5], ['D5', 0.5], ['C5', 0.5], ['Bb4', 0.5], ['A4', 1], ['F4', 1],
  ['F4', 1], ['C4', 1], ['F4', 2], ['F4', 1], ['C4', 1], ['F4', 2],
];
const fjChords = [['F', 4], ['Dm7', 4], ['Bbmaj7', 4], ['Csus4', 2], ['C7', 2], ['F', 4], ['Am', 4], ['Bb', 2], ['C7', 2], ['Fsus2', 2], ['F', 2]];
const frere = makeSong({title: 'Frere Jacques', bpm: 132, melody: [...fj, ...fj, ...fj], chords: [...fjChords, ...fjChords, ...fjChords], extraKick: true});

export const SONGS = [ode, twinkle, frere];

/** a song as long as `seconds`: Ode to Joy again and again, with its truth */
export const longSong = (seconds) => {
  const beat = 60 / ode.bpm;
  const len = ode.beats.length * beat;
  const reps = Math.ceil(seconds / len);
  const out = {title: `Ode to Joy, ${reps} times`, bpm: ode.bpm, melody: [], bass: [], chords: [], drums: [], beats: []};
  for (let r = 0; r < reps; r++) {
    const off = r * len;
    for (const k of ['melody', 'bass', 'drums']) out[k].push(...ode[k].map((n) => ({...n, start: n.start + off})));
    out.chords.push(...ode.chords.map((c) => ({...c, start: c.start + off, end: c.end + off})));
    out.beats.push(...ode.beats.map((b) => b + off));
  }
  out.duration = Math.min(seconds, reps * len + 1);
  for (const k of ['melody', 'bass', 'drums']) out[k] = out[k].filter((n) => n.start < out.duration - 0.5);
  out.beats = out.beats.filter((b) => b < out.duration - 0.5);
  return out;
};

// ---------- the synth ----------

/** a deterministic noise source */
const noise = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** attack, decay to sustain, hold, release; seconds */
const envelope = (t, dur, {a, d, s, r}) => {
  if (t < 0) return 0;
  let v = t < a ? t / a : t < a + d ? 1 - ((1 - s) * (t - a)) / d : s;
  if (t > dur) v *= Math.max(0, 1 - (t - dur) / r);
  return v;
};

/** add harmonics 1..count of f with amplitudes amp(h), under an envelope, into out */
const addTone = (out, start, dur, f, count, amp, env, level, phase0 = 0) => {
  const i0 = Math.max(0, Math.round(start * SR));
  const i1 = Math.min(out.length, Math.round((start + dur + env.r) * SR));
  for (let h = 1; h <= count; h++) {
    if (h * f >= SR / 2) break;
    const a = amp(h) * level;
    const w = (2 * Math.PI * h * f) / SR;
    for (let i = i0; i < i1; i++) out[i] += a * envelope((i - i0) / SR, dur, env) * Math.sin(w * (i - i0) + phase0 * h);
  }
};

const MELODY_ENV = {a: 0.008, d: 0.08, s: 0.7, r: 0.04};
const BASS_ENV = {a: 0.005, d: 0.1, s: 0.8, r: 0.03};
const CHORD_ENV = {a: 0.015, d: 0.1, s: 0.8, r: 0.08};

const saw = (h) => 1 / h;
const sinePlus = (h) => [1, 0.5, 0.25][h - 1] || 0;

const addDrum = (out, start, drum, rnd) => {
  const i0 = Math.round(start * SR);
  if (drum === 'kick') {
    // a sine that drops from 150 to 50 Hz
    let ph = 0;
    for (let i = 0; i < 0.25 * SR && i0 + i < out.length; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / SR;
      out[i0 + i] += LEVEL.kick * Math.exp(-t / 0.08) * Math.sin(ph);
    }
  } else if (drum === 'snare') {
    // a burst of noise, with a little body at 190 Hz
    for (let i = 0; i < 0.2 * SR && i0 + i < out.length; i++) {
      const t = i / SR;
      out[i0 + i] += LEVEL.snare * Math.exp(-t / 0.05) * (0.8 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * t));
    }
  } else {
    // a short burst of high noise: white noise minus its own average over 4 samples
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < 0.06 * SR && i0 + i < out.length; i++) {
      const t = i / SR;
      const x = rnd();
      const hp = x - (x + a + b + c) / 4;
      c = b;
      b = a;
      a = x;
      out[i0 + i] += LEVEL.hat * 2 * Math.exp(-t / 0.015) * hp;
    }
  }
};

/** the song rendered as `mix`: 'melody', 'melody+bass' or 'full'; mono Float32Array at 22,050 Hz, peak 0.9 */
export const renderSong = (song, mix = 'full') => {
  const out = new Float64Array(Math.ceil(song.duration * SR));
  for (const n of song.melody) addTone(out, n.start, n.duration, hz(n.midi), 8, saw, MELODY_ENV, LEVEL.melody);
  if (mix !== 'melody') for (const n of song.bass) addTone(out, n.start, n.duration, hz(n.midi), 3, sinePlus, BASS_ENV, LEVEL.bass);
  if (mix === 'full') {
    for (const c of song.chords) {
      const root = 48 + c.root;
      for (const iv of QUALITIES[c.quality]) {
        // three saws, detuned by 0 and 7 cents either side
        for (const cents of [-7, 0, 7]) addTone(out, c.start, (c.end - c.start) * 0.95, hz(root + iv + cents / 100), 8, saw, CHORD_ENV, LEVEL.chord / 3, cents);
      }
    }
    const rnd = noise(7);
    for (const d of song.drums) addDrum(out, d.start, d.drum, rnd);
  }
  let peak = 1e-9;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  return Float32Array.from(out, (v) => (v * 0.9) / peak);
};

/** a MIDI fixture as a song: its parts become the synth's parts, its beats the truth */
export const midiSong = (path) => {
  const b = readFileSync(path);
  const t = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path);
  const pick = (part) => t.notes.filter((n) => n.part === part).map((n) => ({start: n.start, duration: n.duration, midi: Math.round(n.midi)}));
  return {
    title: t.title,
    bpm: t.tempo.bpm,
    melody: pick('melody'),
    bass: pick('bass'),
    chords: [],
    drums: t.notes.filter((n) => n.part === 'drums').map((n) => ({start: n.start, drum: n.drum})),
    beats: t.tempo.beats,
    duration: t.duration + 1,
    chordNotes: pick('chords'),
  };
};

/** a 16-bit mono WAV file of samples at 22,050 Hz */
export const wav = (x) => {
  const d = new DataView(new ArrayBuffer(44 + x.length * 2));
  const str = (o, s) => [...s].forEach((ch, i) => d.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  d.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVEfmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, SR, true);
  d.setUint32(28, SR * 2, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, 'data');
  d.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Uint8Array(d.buffer);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.log('usage: node tools/render-test-songs.mjs <folder> [--long seconds]');
    process.exit(1);
  }
  mkdirSync(dir, {recursive: true});
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const song of SONGS) {
    for (const mix of ['melody', 'melody+bass', 'full']) {
      const file = join(dir, `${slug(song.title)}-${mix.replace('+', '-')}.wav`);
      writeFileSync(file, wav(renderSong(song, mix)));
      console.log(file);
    }
  }
  const i = process.argv.indexOf('--long');
  if (i > 0) {
    const s = longSong(Number(process.argv[i + 1]) || 240);
    const file = join(dir, `long-${Math.round(s.duration)}s.wav`);
    writeFileSync(file, wav(renderSong(s, 'full')));
    console.log(file);
  }
}
