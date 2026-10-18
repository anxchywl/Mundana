// Sections: found where the time signature or the tempo changes, and where the music changes; at least 8 bars, at
// most 16, labelled with letters that repeat when a section comes back.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMidi} from '../src/cantus/midi.js';
import {findSections, SECTION} from '../src/cantus/timeline.js';
import {header, track} from '../tools/make-midi-fixtures.mjs';

const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name);
};
const bytes = (arr) => Uint8Array.from(arr).buffer;
const PPQ = 480;
const note = (start, midi, duration = 0.5, part = 'melody') => ({start, duration, midi, velocity: 0.8, part});

test('a song in sections: A, B, A again, and C after the tempo change', () => {
  const t = fixture('sections.mid');
  const got = t.sections.map((s) => [s.label, +s.start.toFixed(3), +s.end.toFixed(3)]);
  assert.deepEqual(got, [['A', 0, 16], ['B', 16, 32], ['A', 32, 48], ['C', 48, +t.duration.toFixed(3)]]);
});

test('a song too short for two sections of 8 bars is one section', () => {
  assert.deepEqual(fixture('band.mid').sections.map((s) => s.label), ['A']);
  const one = fixture('band.mid').sections[0];
  assert.equal(one.start, 0);
  assert.equal(one.end, 6);
});

/** 16 bars of one note on every beat at 120 bpm (4/4, 2 s a bar), with the tempo changed by `factor` or the time
 * signature changed to 3/4 where bar 9 starts */
const steady = ({factor = 1, signature = false}) => {
  const ev = [[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]];
  let wait = 0;
  for (let beat = 0; beat < 64; beat++) {
    if (beat === 32) {
      const us = Math.round(500000 / factor);
      if (factor !== 1) ev.push([wait, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255]);
      if (signature) ev.push([factor !== 1 ? 0 : wait, 0xff, 0x58, 4, 3, 2, 24, 8]);
      if (factor !== 1 || signature) wait = 0;
    }
    ev.push([wait, 0x90, 60, 90], [PPQ - 10, 0x80, 60, 0]);
    wait = 10;
  }
  return bytes([...header(0, 1, PPQ), ...track(ev)]);
};

test('a tempo change of more than 8 percent starts a section, a smaller one does not', () => {
  // the same note all along, so only the tempo can split it
  const fast = parseMidi(steady({factor: 1.1}));
  assert.equal(fast.sections.length, 2);
  assert.ok(Math.abs(fast.sections[1].start - 16) < 1e-9, `starts at ${fast.sections[1].start}`);
  assert.equal(parseMidi(steady({factor: 1.06})).sections.length, 1);
  assert.equal(parseMidi(steady({factor: 1})).sections.length, 1);
});

test('a time signature change starts a section', () => {
  const t = parseMidi(steady({signature: true}));
  assert.equal(t.sections.length, 2);
  assert.ok(Math.abs(t.sections[1].start - 16) < 1e-9);
  assert.equal(t.sections[0].label, t.sections[1].label, 'the same notes, so the same letter');
});

test('sections are at least 8 bars, at most 16, on bar lines, and a returning key takes its letter again', () => {
  // 200 bars of 1 s; the key moves every 8 bars through 25 keys, then the first key comes back
  const bars = Array.from({length: 208}, (_, i) => i);
  const notes = [];
  for (let b = 0; b < 208; b++) {
    const key = Math.floor(b / 8) % 26 === 25 ? 0 : (Math.floor(b / 8) * 5) % 12;
    for (const k of [0, 4, 7]) notes.push(note(b, 60 + key + k, 1));
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const s = findSections(notes, bars, {duration: 208});
  assert.equal(s.length, SECTION.max);
  for (const x of s) {
    assert.ok(x.end - x.start >= SECTION.minBars - 1e-9, `${x.start} to ${x.end}`);
    assert.equal(x.start, Math.round(x.start), 'on a bar line');
  }
  assert.equal(s[0].start, 0);
  assert.equal(s[s.length - 1].end, 208);
  for (let i = 1; i < s.length; i++) assert.equal(s[i].start, s[i - 1].end);
  // C major and the same C major later share a letter
  const k = findSections(
    [...[0, 4, 7].flatMap((d) => Array.from({length: 8}, (_, b) => note(b, 60 + d, 1))), ...[1, 5, 8].flatMap((d) => Array.from({length: 8}, (_, b) => note(8 + b, 60 + d, 1))), ...[0, 4, 7].flatMap((d) => Array.from({length: 8}, (_, b) => note(16 + b, 60 + d, 1)))].sort((a, b) => a.start - b.start),
    Array.from({length: 24}, (_, i) => i),
    {duration: 24},
  );
  assert.deepEqual(k.map((x) => x.label), ['A', 'B', 'A']);
});

test('the density of notes counts: the same notes, twice as busy, start a new section', () => {
  const notes = [];
  for (let b = 0; b < 16; b++) {
    const per = b < 8 ? 2 : 6;
    for (let q = 0; q < per; q++) notes.push(note(b + q / per, 60 + (q % 3) * 4, 1 / per));
  }
  const s = findSections(notes, Array.from({length: 16}, (_, i) => i), {duration: 16});
  assert.deepEqual(s.map((x) => x.start), [0, 8]);
});
