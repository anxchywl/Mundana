// Song links: every fixture and test song goes there and back unchanged; hostile links are all turned away.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {encodeSong, decodeSong, toBase64url, fromBase64url, payloadOf, PREFIX, MAX_HASH, DAMAGED, NEWER} from '../src/cantus/share.js';
import {parseMidi} from '../src/cantus/midi.js';
import {settingsOf, DEFAULTS} from '../src/cantus/mapper.js';
import {indexPoints} from '../src/cantus/points.js';
import {analyseAudio, SR} from '../src/cantus/analyse.js';
import {SONGS, renderSong, longSong} from '../tools/render-test-songs.mjs';

const points = indexPoints(JSON.parse(readFileSync(new URL('../src/cantus/points.json', import.meta.url), 'utf8')));
const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const lengths = [];

/** the same song: times within 1 ms, midi within 0.01, the same parts, drums, sections and settings */
const same = (a, b, sa, sb) => {
  assert.equal(b.title, a.title);
  assert.ok(Math.abs(b.duration - a.duration) <= 0.001);
  assert.equal(b.notes.length, a.notes.length);
  a.notes.forEach((n, i) => {
    const m = b.notes[i];
    assert.ok(Math.abs(m.start - n.start) <= 0.001, `note ${i} start`);
    assert.ok(Math.abs(m.duration - n.duration) <= 0.001, `note ${i} length`);
    assert.ok(Math.abs(m.midi - n.midi) <= 0.01, `note ${i} pitch`);
    // a measured pitch comes back within 0.01 (or 0.49 from its key, where it was rounded there)
    if (n.midiMeasured !== undefined && Math.abs(n.midiMeasured - n.midi) < 0.495) assert.ok(Math.abs((m.midiMeasured ?? m.midi) - n.midiMeasured) <= 0.01);
    assert.ok(Math.abs(m.velocity - n.velocity) <= 0.5 / 127 + 1e-9);
    assert.ok(Math.abs(m.confidence - n.confidence) <= 0.005 + 1e-9);
    assert.equal(m.part, n.part);
    assert.equal(m.drum, n.drum);
    assert.equal(m.source, n.source);
  });
  assert.equal(b.tempo.beats.length, a.tempo.beats.length);
  a.tempo.beats.forEach((t, i) => assert.ok(Math.abs(b.tempo.beats[i] - t) <= 0.001, `beat ${i}`));
  assert.equal(b.bars.length, a.bars.length);
  a.bars.forEach((t, i) => assert.ok(Math.abs(b.bars[i] - t) <= 0.001));
  assert.deepEqual(b.sections.map((s) => s.label), a.sections.map((s) => s.label));
  a.sections.forEach((s, i) => assert.ok(Math.abs(b.sections[i].start - s.start) <= 0.001 && Math.abs(b.sections[i].end - s.end) <= 0.001));
  assert.equal(b.tempo.estimated, a.tempo.estimated);
  assert.deepEqual(settingsOf(sb, points), settingsOf(sa, points));
};

const roundTrip = async (name, t, settings) => {
  const hash = await encodeSong(t, settings);
  assert.ok(hash.startsWith(PREFIX));
  lengths.push(`${name}: ${hash.length.toLocaleString('en')} characters, ${t.notes.length.toLocaleString('en')} notes`);
  const back = await decodeSong(`#${hash}`);
  same(t, back.timeline, settings, back.settings);
  return hash;
};

const settingsA = settingsOf(DEFAULTS, points);
const settingsB = settingsOf(
  {voices: 6, layout: 'bars', every: 12, setList: ['lambda', 'mandelbrot', 'burning-ship'], parts: {melody: {fractal: 'multibrot', period: 5, mute: false}, chords: {fractal: 'mandelbrot', period: 3, mute: true}, bass: {fractal: 'inverted', period: 4}, drums: {mute: true}}},
  points,
);

test('every MIDI fixture goes there and back, with default and with other settings', async () => {
  for (const name of readdirSync(new URL('./fixtures/', import.meta.url)).filter((f) => f.endsWith('.mid')).sort()) {
    let t;
    try {
      t = fixture(name);
    } catch {
      continue; // a fixture that is meant to fail to parse
    }
    await roundTrip(name, t, settingsA);
    const s = {...settingsB, layout: name === 'sections.mid' ? 'sections' : 'bars'};
    await roundTrip(`${name} (other settings)`, t, settingsOf(s, points));
  }
});

test('the test songs heard from audio go there and back, measured pitch and estimated tempo too', async () => {
  for (const song of SONGS) {
    const {timeline} = analyseAudio(renderSong(song, 'full'), SR);
    const t = {...timeline, title: song.title};
    assert.ok(t.notes.every((n) => n.source === 'audio'));
    await roundTrip(`${song.title} (from audio)`, t, settingsA);
  }
  // a 4 minute song
  const long = analyseAudio(renderSong(longSong(240), 'full'), SR).timeline;
  await roundTrip('4 minute song (from audio)', {...long, title: 'Long'}, settingsA);
  console.log(lengths.join('\n'));
});

test('beats evenly spaced travel as [first, period]; delta encoding of starts was measured', async () => {
  const t = fixture('ode-to-joy.mid');
  const p = payloadOf(t, settingsA);
  assert.equal(p.beats.length, 2);
  assert.equal(fixture('tempo-change.mid').tempo.beats.length > 2 && payloadOf(fixture('tempo-change.mid'), settingsA).beats.length > 2, true);
  // starts as steps: 79 notes of Ode to Joy, each step 0 or more and adding up to the last start
  assert.ok(p.n.every((n) => n[0] >= 0));
  assert.equal(p.n.reduce((s, n) => s + n[0], 0), Math.round(t.notes[t.notes.length - 1].start * 1000));
});

// ---------- hostile links ----------

const deflate = async (text) => {
  const s = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
};
const link = async (obj) => `#${PREFIX}${toBase64url(await deflate(typeof obj === 'string' ? obj : JSON.stringify(obj)))}`;
const rejects = async (hash, message = DAMAGED) => {
  await assert.rejects(decodeSong(hash), (e) => e.message === message, `${String(hash).slice(0, 60)} should say ${message}`);
};

test('hostile links are turned away whole, with one message', async () => {
  const good = payloadOf(fixture('format0.mid'), settingsA);
  const goodLink = await link(good);
  assert.equal((await decodeSong(goodLink)).timeline.notes.length, 4);
  const edit = (fn) => {
    const p = structuredClone(good);
    fn(p);
    return p;
  };
  // over length, checked before anything else
  await rejects(`#${PREFIX}${'A'.repeat(MAX_HASH)}`);
  // prefixes
  await rejects('#cantus=2.abc', NEWER);
  await rejects('#cantus=17.abc', NEWER);
  await rejects('#cantus=0.abc');
  await rejects('#cantus=x.abc');
  await rejects('#cantus1.abc');
  await rejects(goodLink.replace('cantus=1.', 'Cantus=1.'));
  // bad base64
  await rejects(`#${PREFIX}abc$def`);
  await rejects(`#${PREFIX}abcde`);
  await rejects(`#${PREFIX}ab+/`);
  await rejects(`#${PREFIX}%41%41`);
  // not deflate, and deflate that is cut short
  await rejects(`#${PREFIX}${toBase64url(new TextEncoder().encode('{"v":1}'))}`);
  await rejects(goodLink.slice(0, goodLink.length - 6));
  // a deflate bomb: about 1 KB that expands past 512 KB
  const bomb = await deflate(`{"v":1,"t":"${'a'.repeat(600000)}"}`);
  assert.ok(bomb.length < 1200, `bomb ${bomb.length} bytes`);
  await rejects(`#${PREFIX}${toBase64url(bomb)}`);
  // invalid JSON
  await rejects(await link('{"v":1,'));
  await rejects(await link('not json'));
  await rejects(await link('[1,2,3]'));
  await rejects(await link('null'));
  // extra keys, missing keys, prototype pollution
  await rejects(await link(edit((p) => (p.extra = 1))));
  await rejects(await link(edit((p) => (p.s.extra = 1))));
  await rejects(await link(edit((p) => delete p.n)));
  await rejects(await link(edit((p) => (p.s.parts.drums = [0, 1]))));
  await rejects(await link(JSON.stringify(good).replace('{"v":1,', '{"v":1,"__proto__":{"polluted":true},')));
  await rejects(await link(JSON.stringify(good).replace('"layout":', '"constructor":{"prototype":{"x":1}},"layout":')));
  assert.equal({}.polluted, undefined);
  // wrong types, NaN and Infinity as strings
  await rejects(await link(edit((p) => (p.d = '2'))));
  await rejects(await link(edit((p) => (p.d = 'NaN'))));
  await rejects(await link(edit((p) => (p.bpm = 'Infinity'))));
  await rejects(await link(JSON.stringify(good).replace('"bpm":120', '"bpm":1e999')));
  await rejects(await link(edit((p) => (p.n[0][0] = '0'))));
  await rejects(await link(edit((p) => (p.n[0][0] = 0.5))));
  await rejects(await link(edit((p) => (p.t = 5))));
  await rejects(await link(edit((p) => (p.s.voices = '4'))));
  await rejects(await link(edit((p) => (p.v = 2))));
  // huge arrays
  await rejects(await link(edit((p) => (p.n = Array.from({length: 20001}, () => [0, 100, 6000, 100, 0, -1, 100])))));
  await rejects(await link(edit((p) => (p.bars = Array.from({length: 5001}, (_, i) => i)))));
  await rejects(await link(edit((p) => (p.sec = Array.from({length: 65}, () => [0, 1, 'A'])))));
  await rejects(await link(edit((p) => (p.s.list = Array(65).fill('mandelbrot')))));
  await rejects(await link(edit((p) => (p.n[0] = [0, 100, 6000, 100, 0, -1, 100, 7]))));
  // numbers out of range
  for (const fn of [
    (p) => (p.n[0][0] = 600001),
    (p) => (p.n[1][0] = 599999) && (p.n[2][0] = 2),
    (p) => (p.n[1][0] = -1),
    (p) => (p.n[0][2] = 12701),
    (p) => (p.n[0][3] = 128),
    (p) => (p.n[0][4] = 4),
    (p) => (p.n[0][5] = 4),
    (p) => (p.n[0][6] = 101),
    (p) => (p.n[0][1] = 10),
    (p) => (p.d = 601),
    (p) => (p.d = 0),
    (p) => (p.s.voices = 7),
    (p) => (p.s.voices = 3),
    (p) => (p.s.speed = 2),
    (p) => (p.s.every = 33),
    (p) => (p.s.parts.melody[1] = 17),
    (p) => (p.s.layout = 'bars'),
  ]) {
    await rejects(await link(edit(fn)));
  }
  // unknown fractal keys
  await rejects(await link(edit((p) => (p.s.list[0] = 'nonsense'))));
  await rejects(await link(edit((p) => (p.s.parts.bass[0] = 'toString'))));
  // a title with HTML stays text: the link is fine, the title comes back exactly as characters
  const html = '<img src=x onerror=alert(1)>';
  const t = (await decodeSong(await link(edit((p) => (p.t = html))))).timeline;
  assert.equal(t.title, html);
  // the good link still opens after all of that
  assert.equal((await decodeSong(goodLink)).timeline.notes.length, 4);
});

test('base64url: there and back for every length, and nothing else accepted', () => {
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({length: n}, (_, i) => (i * 37 + n) & 255);
    assert.deepEqual([...fromBase64url(toBase64url(b))], [...b]);
  }
  assert.throws(() => fromBase64url('a'));
  assert.throws(() => fromBase64url('ab=='));
});
