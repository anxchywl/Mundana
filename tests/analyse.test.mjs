// Each step of the audio analysis on its own, on signals whose answer is known.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  spectrum,
  chromaFrames,
  onsetPeaks,
  onsetEnvelope,
  tempoOf,
  beatTrack,
  butterworth,
  yinTrack,
  framesToNotes,
  separateLines,
  chordsOf,
  chordSpans,
  chordNotes,
  downbeatPhase,
  drumHits,
  sectionsOf,
  movingMedian,
  analyseAudio,
  SR,
  ONSET,
} from '../src/cantus/analyse.js';
import {validateTimeline} from '../src/cantus/timeline.js';

const sine = (hz, seconds, amp = 0.5, sr = SR) => Float32Array.from({length: Math.round(seconds * sr)}, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
/** a sawtooth of 8 harmonics */
const saw = (hz, seconds, amp = 0.3, sr = SR) =>
  Float32Array.from({length: Math.round(seconds * sr)}, (_, i) => {
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * h * hz * i) / sr) / h;
    return amp * v;
  });
const rms = (x, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
/** short noisy clicks at the given times, into x */
const clicks = (x, times, amp = 0.5, sr = SR) => {
  for (const t of times) {
    const i = Math.round(t * sr);
    for (let j = 0; j < 200 && i + j < x.length; j++) x[i + j] += amp * Math.exp(-j / 40) * (j % 2 ? 1 : -1);
  }
  return x;
};

test('moving median: a running median of 5 over a step and a spike', () => {
  const m = movingMedian([0, 0, 9, 0, 0, 1, 1, 1, 1, 1], 2);
  // windows: [0 0 0 0 9] [0 0 0 9 0] [0 0 9 0 0] [0 9 0 0 1] [9 0 0 1 1] ...
  assert.deepEqual([...m], [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test('spectrum: a steady tone stays in the harmonic part, clicks go to the percussive part', () => {
  const x = sine(440, 4, 0.4);
  const clean = Float32Array.from(x);
  clicks(x, [1, 2, 3], 0.8);
  const s = spectrum(x, SR);
  // inside the song, away from the ends: the harmonic part is the tone, the clicks mostly gone
  let err = 0;
  for (let i = SR / 2; i < 3.5 * SR; i++) err += (s.harm[i] - clean[i]) ** 2;
  const relative = Math.sqrt(err / (3 * SR)) / rms(clean);
  assert.ok(relative < 0.1, `harmonic part off the tone by ${relative}`);
  // and with no clicks the tone comes back almost exactly: the window sum is divided out
  const t = spectrum(clean, SR);
  let e2 = 0;
  for (let i = SR / 2; i < 3.5 * SR; i++) e2 += (t.harm[i] - clean[i]) ** 2;
  assert.ok(Math.sqrt(e2 / (3 * SR)) / rms(clean) < 0.01);
  // percussive flux peaks at the clicks (the tone's own start and end at 0 and 4 s are onsets too)
  const on = onsetPeaks(s.percFlux, s.fps).filter((o) => o.time > 0.5 && o.time < 3.5);
  assert.equal(on.length, 3);
  on.forEach((o, i) => assert.ok(Math.abs(o.time - (i + 1)) < 0.012, `onset at ${o.time}`));
});

test('onsets: a click train is found, each within 12 ms after the 15 ms correction, none twice', () => {
  const truth = [];
  for (let t = 0.3; t < 9.5; t += 0.4321) truth.push(t);
  const s = spectrum(clicks(new Float32Array(SR * 10), truth), SR);
  const on = onsetPeaks(s.fullFlux, s.fps);
  assert.equal(on.length, truth.length);
  on.forEach((o, i) => assert.ok(Math.abs(o.time - truth[i]) < 0.012, `${o.time} for ${truth[i]}`));
  assert.equal(ONSET.lag, 0.015);
});

test('tempo and beats: clicks at 100 and at 150 bpm', () => {
  for (const bpm of [100, 150]) {
    const beat = 60 / bpm;
    const truth = [];
    for (let t = 0.5; t < 19.5; t += beat) truth.push(t);
    const s = spectrum(clicks(new Float32Array(SR * 20), truth), SR);
    const env = onsetEnvelope(s.fullFlux, s.fps);
    const tempo = tempoOf(env, s.fps);
    assert.ok(Math.abs(tempo.bpm / bpm - 1) < 0.02, `found ${tempo.bpm} for ${bpm}`);
    const beats = beatTrack(env, tempo.period).map((f) => f / s.fps + ONSET.lag);
    let hit = 0;
    for (const t of truth) if (beats.some((b) => Math.abs(b - t) < 0.03)) hit++;
    assert.ok(hit >= truth.length - 1, `${hit} of ${truth.length} beats within 30 ms`);
  }
});

test('butterworth: -3 dB at the cut, low pass and high pass', () => {
  const level = (hz, high) => {
    const y = butterworth(sine(hz, 1, 0.5), SR, 250, high);
    return 20 * Math.log10(rms(y, SR / 2) / rms(sine(hz, 1, 0.5), SR / 2));
  };
  assert.ok(Math.abs(level(250, false) + 3.01) < 0.3);
  assert.ok(Math.abs(level(250, true) + 3.01) < 0.3);
  assert.ok(level(1000, false) < -45, 'two octaves above, about 48 dB down');
  assert.ok(level(62.5, true) < -45);
  assert.ok(Math.abs(level(60, false)) < 0.1 && Math.abs(level(1000, true)) < 0.1);
});

test('YIN: sines and saws within 0.1 semitone, silence has no pitch', () => {
  for (const hz of [82.4, 196, 440, 1046.5]) {
    for (const x of [sine(hz, 1), saw(hz, 1)]) {
      const t = yinTrack(x, SR, {window: 1024, hop: 220, lo: 80, hi: 2000});
      const k = 50;
      assert.ok(Math.abs(12 * Math.log2(t.hz[k] / hz)) < 0.1, `${t.hz[k]} for ${hz}`);
      assert.ok(t.conf[k] > 0.9);
    }
  }
  const quiet = yinTrack(new Float32Array(SR), SR, {window: 1024, hop: 220, lo: 80, hi: 2000});
  assert.ok(quiet.conf.every((c) => c === 0));
  // the bass path: low passed, decimated by 4
  const low = butterworth(saw(55, 1), SR, 250);
  const dec = Float32Array.from({length: low.length / 4}, (_, i) => low[i * 4]);
  const b = yinTrack(dec, SR / 4, {window: 256, hop: 55, lo: 40, hi: 1000});
  assert.ok(Math.abs(12 * Math.log2(b.hz[50] / 55)) < 0.1, `bass ${b.hz[50]}`);
});

test('frames to notes: pitch runs become notes, an onset with a rise splits a repeated note', () => {
  const hop = 220;
  const K = 300;
  const hz = new Float32Array(K);
  const conf = new Float32Array(K);
  const level = new Float32Array(K);
  // A4 for frames 10 to 109, then the same A4 struck again at frame 110 (level dips and rises), B4 from 200 to 259
  for (let k = 10; k < 260; k++) {
    if (k >= 160 && k < 200) continue;
    hz[k] = k < 200 ? 440 : 493.88;
    conf[k] = 0.9;
    level[k] = k >= 105 && k < 110 ? 0.05 : 0.2;
  }
  hz[50] = 880; // one frame an octave off: the median filter removes it
  const dt = hop / SR;
  const notes = framesToNotes({hz, conf, rms: level, hop, sr: SR}, {lo: 80, hi: 1400, part: 'melody', onsets: [{time: 110 * dt}]});
  assert.deepEqual(
    notes.map((n) => n.midi),
    [69, 69, 71],
  );
  assert.ok(Math.abs(notes[1].start - 110 * dt) < 1e-9);
  assert.equal(notes[0].source, 'audio');
  assert.ok(Math.abs(notes[0].midiMeasured - 69) < 0.01);
  assert.ok(notes.every((n) => n.confidence > 0.89 && n.confidence < 0.91));
  // a note whose pitch shows late starts at the onset before it, if no note was sounding there
  const late = framesToNotes({hz, conf, rms: level, hop, sr: SR}, {lo: 80, hi: 1400, part: 'melody', onsets: [{time: 190 * dt}, {time: 110 * dt}].sort((a, b) => a.time - b.time)});
  assert.ok(Math.abs(late[2].start - 190 * dt) < 1e-9);
  // frames in a skipped span neither add to a note nor end it
  const skipped = framesToNotes({hz, conf, rms: level, hop, sr: SR}, {lo: 80, hi: 1400, part: 'bass', skip: [[60 * dt, 70 * dt]]});
  assert.equal(skipped[0].midi, 69);
  assert.ok(skipped[0].duration > 90 * dt);
});

test('melody and bass doubling each other: octaves go from the melody, unison from whichever has no line of its own', () => {
  const m = [
    {start: 0, duration: 1, midi: 67},
    {start: 1, duration: 1, midi: 64},
    {start: 2, duration: 1, midi: 60},
    {start: 3, duration: 1, midi: 71},
  ];
  const b = [
    {start: 0, duration: 1, midi: 55},
    {start: 1, duration: 1, midi: 48},
    {start: 2, duration: 1, midi: 60},
    {start: 3, duration: 1, midi: 47},
  ];
  // a bass line of its own: an octave above it goes, two octaves too, and the unison the melody track held
  let r = separateLines(m, b);
  assert.deepEqual(r.melody.map((n) => n.midi), [64]);
  assert.equal(r.bass.length, 4);
  // a solo whose low notes the bass track heard too: those bass notes go, the melody keeps them
  r = separateLines(m, [{start: 2, duration: 1, midi: 60}, {start: 3, duration: 1, midi: 71}]);
  assert.deepEqual(r.melody.map((n) => n.midi), [67, 64, 60, 71]);
  assert.equal(r.bass.length, 0);
});

test('chords: chroma of a C major chord, templates and Viterbi, voiced as notes', () => {
  // two beats of C major, two of A minor, two of G7, as saws; beats every half second
  const parts = [
    [48, 52, 55],
    [45, 48, 52],
    [43, 47, 50, 53],
  ];
  const x = new Float32Array(SR * 3);
  parts.forEach((tones, c) => {
    for (const m of tones) {
      const tone = saw(440 * 2 ** ((m - 69) / 12), 1, 0.1);
      for (let i = 0; i < tone.length; i++) x[c * SR + i] += tone[i];
    }
  });
  const s = spectrum(x, SR);
  const chroma = chromaFrames(s.harm, SR, s.F);
  const beatFrames = [0, 0.5, 1, 1.5, 2, 2.5].map((t) => Math.round(t * s.fps));
  const {beats, energies} = chordsOf(chroma, s.energy, beatFrames, s.F);
  const names = beats.map((b) => `${b.root}${b.quality}`);
  assert.deepEqual(names, ['0maj', '0maj', '9min', '9min', '77', '77']);
  const spans = chordSpans(beats, energies, [0, 0.5, 1, 1.5, 2, 2.5], 3);
  assert.equal(spans.length, 3);
  const notes = chordNotes(spans);
  // root in MIDI 48 to 59, the other tones above it within the octave
  assert.deepEqual(
    notes.filter((n) => n.start === 2).map((n) => n.midi),
    [55, 59, 62, 65],
  );
  assert.ok(notes.every((n) => n.part === 'chords' && n.source === 'audio' && n.confidence >= 0 && n.confidence <= 1));
  // the bass note under a beat decides between two close templates: C E G A is C major with an A, or A minor seventh
  const amb = new Float32Array(40 * 12);
  for (let f = 0; f < 40; f++) [0, 4, 7, 9].forEach((p) => (amb[f * 12 + p] = p === 9 ? 0.6 : 1));
  const flat = new Float32Array(40).fill(1);
  const ten = [0, 10, 20, 30];
  assert.equal(chordsOf(amb, flat, ten, 40, () => 9).beats[0].root, 9);
  assert.equal(chordsOf(amb, flat, ten, 40, () => 0).beats[0].root, 0);
});

test('downbeats: the phase with the low hits and the chord changes', () => {
  const low = [1, 0, 0, 0, 5, 0, 1, 0, 5, 0, 0, 0, 5, 0, 1, 0];
  const changes = low.map((_, i) => i % 4 === 0 && i > 0);
  assert.equal(downbeatPhase(low, changes), 0);
  assert.equal(downbeatPhase(low.slice(2), changes.slice(2)), 2);
});

test('drums: a kick, a snare and a hat loop, classified by band; a note starting is no drum', () => {
  const x = new Float32Array(SR * 8);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const truth = [];
  for (let b = 0; b < 16; b++) {
    const t = 0.25 + b * 0.45;
    const i0 = Math.round(t * SR);
    const kind = ['kick', 'hat', 'snare', 'hat'][b % 4];
    truth.push(kind);
    let ph = 0;
    for (let j = 0; j < 0.2 * SR && i0 + j < x.length; j++) {
      const tt = j / SR;
      if (kind === 'kick') {
        ph += (2 * Math.PI * (50 + 100 * Math.exp(-tt / 0.03))) / SR;
        x[i0 + j] += 0.6 * Math.exp(-tt / 0.08) * Math.sin(ph);
      } else if (kind === 'snare') x[i0 + j] += 0.4 * Math.exp(-tt / 0.05) * rnd();
      else x[i0 + j] += 0.2 * Math.exp(-tt / 0.015) * rnd();
    }
  }
  // the hats were white noise above: what is left of them above 5,000 Hz is a hat
  const hatOnly = butterworth(x, SR, 5000, true);
  for (let b = 0; b < 16; b++) {
    if (truth[b] !== 'hat') continue;
    const i0 = Math.round((0.25 + b * 0.45) * SR);
    for (let j = 0; j < 0.2 * SR; j++) x[i0 + j] = hatOnly[i0 + j];
  }
  const s = spectrum(x, SR);
  const hits = drumHits(onsetPeaks(s.percFlux, s.fps), s);
  assert.deepEqual(
    hits.map((h) => h.drum),
    truth,
  );
  // saw notes with no drums: their onsets are not drums
  const notes = new Float32Array(SR * 4);
  [220, 330, 262, 392].forEach((hz, n) => {
    const tone = saw(hz, 0.8, 0.3);
    for (let i = 0; i < tone.length; i++) notes[n * SR + i] += tone[i] * Math.min(1, i / 100);
  });
  const t = spectrum(notes, SR);
  assert.equal(drumHits(onsetPeaks(t.percFlux, t.fps), t).length, 0);
});

test('sections: a novelty peak between two different halves, none in a song that never changes', () => {
  const a = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0.2]);
  const b = Float64Array.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0.4]);
  const two = [...Array(48).fill(a), ...Array(48).fill(b)];
  assert.deepEqual(sectionsOf(two, 32), [48]);
  assert.deepEqual(sectionsOf(Array(96).fill(a), 32), []);
});

test('the whole analysis: a valid timeline, every note from audio, tempo estimated, progress to 1', () => {
  // four bars of a C major arpeggio at 120 bpm over a click on every beat
  const x = new Float32Array(SR * 9);
  for (let b = 0; b < 16; b++) {
    const tone = saw(440 * 2 ** (([60, 64, 67, 72][b % 4] - 69) / 12), 0.45, 0.2);
    const i0 = Math.round((0.5 + b * 0.5) * SR);
    for (let i = 0; i < tone.length; i++) x[i0 + i] += tone[i] * Math.min(1, i / 100, (tone.length - i) / 200);
  }
  const seen = [];
  const {timeline, info} = analyseAudio(x, SR, (stage, fraction) => seen.push([stage, fraction]));
  assert.deepEqual(validateTimeline(timeline).notes.length, timeline.notes.length);
  assert.ok(timeline.notes.every((n) => n.source === 'audio'));
  assert.equal(timeline.tempo.estimated, true);
  const melody = timeline.notes.filter((n) => n.part === 'melody');
  assert.equal(melody.length, 16);
  melody.forEach((n, b) => {
    assert.equal(n.midi, [60, 64, 67, 72][b % 4]);
    assert.ok(Math.abs(n.start - (0.5 + b * 0.5)) < 0.05);
  });
  assert.equal(seen[seen.length - 1][1], 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] >= seen[i - 1][1] - 1e-9, 'progress never goes back');
  assert.ok(info.times.spectrum > 0 && info.bytes > x.byteLength);
  assert.throws(() => analyseAudio(new Float32Array(0), SR));
});
