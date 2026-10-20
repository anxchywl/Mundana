// The mapper: every note gets a point and a rate that play it, voices are shared and stolen by the rules, a 4 minute
// song of every part plans in under 100 ms, and notes rendered through the worklet host are in tune.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexPoints} from '../src/cantus/points.js';
import {planShow, pitchedFractals, drumPoints, settingsOf, RATE_MIN, RATE_MAX, RELEASE, DRUM, SOUND} from '../src/cantus/mapper.js';
import {parseMidi} from '../src/cantus/midi.js';
import {validateTimeline} from '../src/cantus/timeline.js';
import {Host, SR, runHost} from './worklet-host.mjs';
import {pitchOf} from './helpers.mjs';

const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const song = (notes, duration) => validateTimeline({notes, tempo: {bpm: 120, beats: []}, sections: [], duration, title: 't'});
const note = (start, midi, o = {}) => ({start, duration: 0.25, midi, velocity: 0.8, part: 'melody', confidence: 1, source: 'midi', ...o});

test('every press plays its note: rate / period is the note, inside the rate limits', () => {
  const plan = planShow(fixture('ode-to-joy.mid'), {}, points);
  assert.equal(plan.presses.length, 62 + 17);
  for (const p of plan.presses) {
    assert.ok(p.rate >= RATE_MIN - 1e-6 && p.rate <= RATE_MAX + 1e-6);
    const want = 440 * 2 ** ((p.midi + 12 * (p.moved || 0) - 69) / 12);
    assert.ok(Math.abs(p.rate / p.period / want - 1) < 1e-9);
    assert.ok(points.fractals[p.fractal].periods.includes(p.period));
    assert.equal(p.fractal, p.part === 'melody' ? 'mandelbrot' : 'multibrot');
    assert.equal(p.voice === 0, p.part === 'melody');
    assert.equal(p.releaseS, RELEASE[p.part]);
  }
  assert.equal(plan.fractal, 'mandelbrot');
  assert.deepEqual(plan.layout, [{start: 0, end: plan.timeline.duration, fractal: 'mandelbrot'}]);
  assert.deepEqual(plan.morphs, [], 'one fractal: no morphs');
});

test('the melody plays one note at a time on voice 0, the other parts on the other voices', () => {
  const t = song([note(0, 60), note(0, 64), note(0, 40, {part: 'bass'}), note(0.1, 67)], 1);
  const plan = planShow(t, {}, points);
  assert.deepEqual(plan.presses.filter((p) => p.part === 'melody').map((p) => p.midi), [64, 67]);
  assert.equal(plan.skipped, 1);
  assert.ok(Math.abs(plan.presses[0].duration - 0.1) < 1e-12, 'a note ends where the next begins');
  const bass = plan.presses.find((p) => p.part === 'bass');
  assert.equal(bass.voice, 1);
  assert.equal(bass.fractal, 'multibrot');
});

test('settings: unknown or unplayable values fall back, and only fractals with 4 periods or more are offered', () => {
  const keys = pitchedFractals(points);
  assert.ok(keys.includes('mandelbrot') && keys.includes('multibrot'));
  assert.ok(!keys.includes('chirikov') && !keys.includes('heart') && !keys.includes('gingerbread'));
  for (const k of keys) assert.ok(points.fractals[k].periods.length >= 4);
  const s = settingsOf({voices: 9, parts: {melody: {fractal: 'chirikov', period: 40}, bass: {fractal: 'tricorn', period: 5, mute: true}}}, points);
  assert.equal(s.voices, 4);
  assert.deepEqual(s.parts.melody, {fractal: 'mandelbrot', period: 6, mute: false});
  assert.deepEqual(s.parts.bass, {fractal: 'tricorn', period: 5, mute: true});
  assert.deepEqual(s.parts.chords, {fractal: 'mandelbrot', period: 4, mute: false});
  assert.deepEqual(s.parts.drums, {mute: false});
});

/** no voice ever plays two notes at once: each press starts after the last one on its voice has ended */
const noOverlap = (plan) => {
  const last = [];
  for (const p of plan.presses) {
    const q = last[p.voice];
    if (q) assert.ok(p.time >= q.time + q.duration - 1e-9, `voice ${p.voice} at ${p.time}`);
    last[p.voice] = p;
  }
};

test('a chord larger than the voices keeps root, top, third, seventh, and counts the rest', () => {
  // C E G B D F held 2 s, with nothing else playing; 4 voices leave 3 for the chord
  const chord = [48, 52, 55, 59, 62, 65].map((m) => note(0, m, {part: 'chords', duration: 2}));
  const plan = planShow(song(chord, 2), {voices: 4}, points);
  assert.deepEqual(plan.presses.map((p) => p.midi).sort((a, b) => a - b), [48, 52, 65]);
  assert.equal(plan.left.chords, 3);
  const six = planShow(song(chord, 2), {voices: 6}, points);
  assert.deepEqual(six.presses.map((p) => p.midi).sort((a, b) => a - b), [48, 52, 55, 59, 65]);
  assert.equal(six.left.chords, 1);
  assert.deepEqual(new Set(six.presses.map((p) => p.voice)), new Set([1, 2, 3, 4, 5]));
});

test('stealing: the quietest note goes, never the melody, and a chord tone takes a bass note last', () => {
  const t = song([
    note(0, 72, {duration: 3}),
    note(0, 36, {part: 'bass', duration: 3, velocity: 0.2}),
    note(0, 60, {part: 'chords', duration: 3, velocity: 0.5}),
    note(0, 64, {part: 'chords', duration: 3, velocity: 0.9}),
    note(1, 67, {part: 'chords', duration: 1, velocity: 0.9}),
  ], 3);
  const plan = planShow(t, {voices: 4}, points);
  noOverlap(plan);
  const at1 = plan.presses.find((p) => p.time === 1);
  // the bass is quietest, but the chord tone takes the quieter chord voice instead
  const victim = plan.presses.find((p) => p.midi === 60 && p.time === 0);
  assert.equal(at1.voice, victim.voice);
  assert.equal(victim.duration, 1, 'the stolen note ends at the steal');
  assert.equal(plan.stolen, 1);
  assert.equal(plan.presses.find((p) => p.part === 'melody').duration, 3, 'the melody is never stolen');
  // the stolen note comes back when its voice is free again, for the rest of its length
  const back = plan.presses.find((p) => p.midi === 60 && p.time > 0);
  assert.ok(back && Math.abs(back.time - (2 + RELEASE.chords)) < 1e-9 && Math.abs(back.time + back.duration - 3) < 1e-9);
  // a drum hit takes the quietest of all, the bass
  const d = planShow(song([...t.notes.slice(0, 4), note(1, 38, {part: 'drums', drum: 'snare', velocity: 1})], 3), {voices: 4}, points);
  assert.equal(d.presses.find((p) => p.part === 'drums').voice, d.presses.find((p) => p.part === 'bass').voice);
});

test('drums: kick on an escape, the others on chaos by brightness, borrowed from the Burning ship when needed', () => {
  const lib = points.fractals.mandelbrot;
  const dp = drumPoints(points, 'mandelbrot', [-0.5, 0]);
  assert.equal(dp.borrowed, false);
  const kick = lib.escape.find((e) => e.point === dp.kick.point);
  assert.ok(kick.steps >= 3 && kick.steps <= 40);
  const bright = lib.chaos.map((c) => c.bright).sort((a, b) => a - b);
  const of = (p) => lib.chaos.find((c) => c.point === p.point).bright;
  assert.equal(of(dp.hat), bright[bright.length - 1]);
  assert.equal(of(dp.other), bright[0]);
  const third = bright.length / 3;
  const rank = bright.indexOf(of(dp.snare));
  assert.ok(rank >= Math.floor(third) && rank < Math.ceil(2 * third), `snare is ${rank} of ${bright.length}`);
  // the Multibrot has no chaos: its snares and hats come from the Burning ship
  const mb = drumPoints(points, 'multibrot', [0, 0]);
  assert.equal(mb.borrowed, true);
  assert.equal(mb.hat.fractal, 'burning-ship');
  assert.equal(mb.kick.fractal, 'multibrot');
  const kit = song(['kick', 'snare', 'hat', 'other'].map((d, i) => note(i * 0.5, 36, {part: 'drums', drum: d, velocity: 0.5})), 2);
  const plan = planShow(kit, {parts: {melody: {fractal: 'multibrot'}}}, points);
  assert.equal(plan.drumsOnly, true);
  assert.equal(plan.drumsBorrowed, true);
  for (const p of plan.presses) {
    assert.equal(p.rate, DRUM[p.drum].rate);
    assert.equal(p.duration, DRUM[p.drum].duration);
    assert.equal(p.velocity, 0.5);
  }
});

test('muted parts take no voices', () => {
  const t = fixture('band.mid');
  const plan = planShow(t, {parts: {drums: {mute: true}, chords: {mute: true}}}, points);
  assert.deepEqual([...new Set(plan.presses.map((p) => p.part))].sort(), ['bass', 'melody']);
  const none = planShow(t, {parts: {melody: {mute: true}, bass: {mute: true}}}, points);
  assert.ok(!none.presses.some((p) => p.part === 'melody' || p.part === 'bass'));
});

test('the band: no voice plays two notes at once, the melody keeps voice 0, dropped chord tones are counted', (t) => {
  for (const voices of [4, 5, 6]) {
    const plan = planShow(fixture('band.mid'), {voices}, points);
    noOverlap(plan);
    const melody = plan.presses.filter((p) => p.part === 'melody');
    assert.equal(melody.length, 64);
    assert.ok(melody.every((p) => p.voice === 0));
    assert.ok(plan.presses.every((p) => p.voice < voices && (p.part === 'melody') === (p.voice === 0)));
    assert.equal(plan.presses.filter((p) => p.part === 'drums').length + plan.left.drums, 48);
    t.diagnostic(`${voices} voices: left out ${JSON.stringify(plan.left)}, stolen ${plan.stolen}, presses ${plan.presses.length}`);
  }
});

test('notes out of reach move by whole octaves and are marked', () => {
  const plan = planShow(song([note(0, 0), note(0.5, 127), note(1, 69)], 2), {}, points);
  const [lo, hi, a] = plan.presses;
  assert.ok(lo.moved > 0 && hi.moved < 0 && a.moved === undefined);
  assert.equal(plan.moved, 2);
});

/** a 4 minute song of every part at 120 bpm: a melody in eighths, a bass in quarters, a four-note chord every bar, a
 * drum loop of kick, snare and hats in eighths; 6,600 notes */
const bigSong = () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const notes = [];
  for (let i = 0; i < 1920; i++) notes.push(note(i * 0.125, 60 + Math.floor(rnd() * 24), {duration: 0.12}));
  for (let i = 0; i < 480; i++) notes.push(note(i * 0.5, 36 + Math.floor(rnd() * 12), {part: 'bass', duration: 0.45}));
  for (let b = 0; b < 120; b++) {
    const root = 48 + Math.floor(rnd() * 12);
    for (const k of [0, 4, 7, 11]) notes.push(note(b * 2, root + k, {part: 'chords', duration: 2}));
  }
  for (let i = 0; i < 1920; i++) {
    notes.push(note(i * 0.125, 42, {part: 'drums', drum: 'hat', duration: 0.05, velocity: 0.5}));
    if (i % 4 === 0) notes.push(note(i * 0.125, i % 8 ? 38 : 36, {part: 'drums', drum: i % 8 ? 'snare' : 'kick', duration: 0.1}));
  }
  return song(notes.sort((a, b) => a.start - b.start || a.midi - b.midi), 240);
};

test('planning a 4 minute song of every part takes under 100 ms (median of 5 runs)', (t) => {
  const timeline = bigSong();
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    planShow(timeline, {voices: 6}, points);
    times.push(performance.now() - t0);
  }
  t.diagnostic(`${timeline.notes.length.toLocaleString('en')} notes: first run ${times[0].toFixed(2)} ms, others ${times.slice(1).map((x) => x.toFixed(2)).join(', ')} ms`);
  // the first run is cold, and the other test files run at the same time; it alone may take longer
  assert.ok(times.slice().sort((a, b) => a - b)[2] < 100, 'median under 100 ms');
  assert.ok(times[0] < 200, 'first run under 200 ms');
});

test('a two-octave chromatic scale, rendered through the worklet, is in tune within 1 percent', (t) => {
  const plan = planShow(fixture('chromatic.mid'), {}, points);
  assert.equal(plan.presses.length, 25);
  const host = new Host();
  const msgs = [];
  for (const p of plan.presses) {
    msgs.push({type: 'press', voice: 0, at: p.time, fractal: p.fractal, p: p.point, z0: p.z0, rate: p.rate, velocity: p.velocity});
    msgs.push({type: 'release', voice: 0, at: p.time + p.duration});
  }
  const {L, R} = runHost(host, plan.timeline.duration, msgs.map((m) => [0, m]));
  let worst = {err: 0};
  for (const p of plan.presses) {
    const want = 440 * 2 ** ((p.midi + 12 * (p.moved || 0) - 69) / 12);
    // the middle 80 percent of the note
    const a = Math.round((p.time + p.duration * 0.1) * SR);
    const b = Math.round((p.time + p.duration * 0.9) * SR);
    const hz = pitchOf([L.subarray(a, b), R.subarray(a, b)], SR, {minHz: 60, maxHz: 2000});
    const err = Math.abs(hz / want - 1);
    if (!(err <= worst.err)) worst = {err, midi: p.midi, period: p.period, hz, want};
  }
  t.diagnostic(`worst ${(worst.err * 100).toFixed(3)} % (midi ${worst.midi}, period ${worst.period}: ${worst.hz?.toFixed(2)} Hz for ${worst.want?.toFixed(2)})`);
  assert.ok(worst.err < 0.01);
});

test('a song of nothing but drums plays as drums', () => {
  const plan = planShow(fixture('drums-only.mid'), {}, points);
  assert.equal(plan.drumsOnly, true);
  assert.ok(plan.presses.length > 0 && plan.presses.every((p) => p.part === 'drums' && p.voice > 0));
});

test('each part sounds as SOUND says; a chord shares its gain among the tones sounding', () => {
  const t = song(
    [note(0, 72), note(0, 60, {part: 'chords'}), note(0, 64, {part: 'chords'}), note(0, 67, {part: 'chords'}), note(1, 60, {part: 'chords', duration: 0.5}), note(0, 40, {part: 'bass'})],
    2,
  );
  const plan = planShow(t, {voices: 6}, points);
  for (const p of plan.presses) {
    for (const k of ['attackS', 'drive', 'tone']) assert.equal(p[k], SOUND[p.part][k]);
    if (p.part !== 'chords') assert.equal(p.gain, SOUND[p.part].gain);
  }
  const chords = plan.presses.filter((p) => p.part === 'chords');
  assert.deepEqual(chords.map((p) => p.gain), [SOUND.chords.gain / 3, SOUND.chords.gain / 3, SOUND.chords.gain / 3, SOUND.chords.gain]);
  assert.ok(SOUND.melody.gain === 1 && Object.values(SOUND).every((s) => s.gain <= 1));
});
