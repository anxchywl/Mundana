// How well analyseAudio hears songs whose notes are known: three songs written as code and the MIDI fixtures, rendered
// by the simple synth in tools/render-test-songs.mjs as the melody alone, the melody with the bass, and the full mix.
// Scores after mir_eval: notes match at the same semitone with onsets within 50 ms; beats within 70 ms; chords by the
// share of beats with the right root (and quality). Synthetic audio is far easier than a real recording.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SONGS, renderSong, midiSong} from '../tools/render-test-songs.mjs';
import {analyseAudio, SR} from '../src/cantus/analyse.js';
import {noteScore, beatScore, chordScore, drumScore} from './score.mjs';

const TARGET = {melodyAlone: 0.85, melodyMix: 0.6, bassMix: 0.6, chordRoot: 0.6, beats: 0.8};
const f3 = (x) => x.toFixed(3);
const part = (t, p) => t.notes.filter((n) => n.part === p);

/** the analysis of a song in one mix, with its scores; prints one line */
const score = (song, mix) => {
  const x = renderSong(song, mix);
  const t0 = performance.now();
  const {timeline, info} = analyseAudio(x, SR);
  const ms = performance.now() - t0;
  const r = {
    melody: noteScore(part(timeline, 'melody'), song.melody),
    bass: noteScore(part(timeline, 'bass'), song.bass),
    beats: beatScore(timeline.tempo.beats, song.beats),
    chords: song.chords.length ? chordScore(info.chords, song.chords, song.beats) : null,
    drums: Object.fromEntries(['kick', 'snare', 'hat'].map((d) => [d, drumScore(part(timeline, 'drums'), song.drums, d).f])),
    bpm: info.bpm,
  };
  const line = [
    `${song.title}, ${mix}:`,
    `melody F ${f3(r.melody.f)} (P ${f3(r.melody.precision)} R ${f3(r.melody.recall)}, ${r.melody.est} found, ${r.melody.ref} true)`,
    mix !== 'melody' ? `bass F ${f3(r.bass.f)} (P ${f3(r.bass.precision)} R ${f3(r.bass.recall)})` : '',
    `beats F ${f3(r.beats.f)}, ${r.bpm.toFixed(1)} bpm`,
    r.chords && mix === 'full' ? `chord root ${f3(r.chords.root)}, root and quality ${f3(r.chords.both)}` : '',
    mix === 'full' ? `drums F kick ${f3(r.drums.kick)} snare ${f3(r.drums.snare)} hat ${f3(r.drums.hat)}` : '',
    `${(x.length / SR).toFixed(1)} s analysed in ${ms.toFixed(0)} ms`,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(line);
  return r;
};

for (const song of SONGS) {
  test(`${song.title}: melody alone, with the bass, and the full mix`, () => {
    const alone = score(song, 'melody');
    const duo = score(song, 'melody+bass');
    const full = score(song, 'full');
    assert.ok(alone.melody.f >= TARGET.melodyAlone, `melody alone F ${alone.melody.f}`);
    assert.ok(full.melody.f >= TARGET.melodyMix, `melody in the full mix F ${full.melody.f}`);
    assert.ok(full.bass.f >= TARGET.bassMix, `bass in the full mix F ${full.bass.f}`);
    assert.ok(full.chords.root >= TARGET.chordRoot, `chord roots ${full.chords.root}`);
    for (const r of [alone, duo, full]) assert.ok(r.beats.f >= TARGET.beats, `beats F ${r.beats.f}`);
    assert.ok(duo.bass.f >= TARGET.bassMix);
  });
}

test('MIDI fixtures rendered: Ode to Joy and the chromatic scale alone, the band in full', () => {
  const fixture = (name) => midiSong(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  for (const name of ['ode-to-joy.mid', 'chromatic.mid']) {
    const r = score(fixture(name), 'melody');
    assert.ok(r.melody.f >= TARGET.melodyAlone, `${name}: melody F ${r.melody.f}`);
  }
  // the band (160 bpm, a melody in sixteenths) has no chord truth in this form: its numbers are reported only
  score(fixture('band.mid'), 'full');
});
