// Standard MIDI Files, read by hand: the notes of every track, the tempo map and the time signatures, turned into a
// Timeline (src/cantus/timeline.js). A file is untrusted input, so every read is bounded by its chunk and by the
// buffer, and every count is capped.

import {validateTimeline, mergeShort, barsFrom, findSections, cleanTitle, MAX_BEATS, MAX_NOTES} from './timeline.js?v=31';

export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_TRACKS = 256;
export const MAX_EVENTS = 1000000;
const HOLD_CAP = 8; // a note that never ends stops at its track's end, and after 8 s at most
const DEFAULT_TEMPO = 500000; // microseconds a quarter note, 120 bpm
const TEMPO_SPLIT = 0.08; // a tempo change of more than 8 percent starts a new section

// General MIDI percussion keys, by the drum that plays them
const KICK = new Set([35, 36]);
const SNARE = new Set([37, 38, 39, 40]);
const HAT = new Set([42, 44, 46, 49, 51, 52, 53, 55, 57, 59]);
export const drumOf = (key) => (KICK.has(key) ? 'kick' : SNARE.has(key) ? 'snare' : HAT.has(key) ? 'hat' : 'other');

const ascii = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];

const text = (bytes) => {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
};

/** thrown inside a track when its bytes stop making sense; the track keeps what was read before */
class Damaged extends Error {}

/** read one track chunk into a short list of the events Cantus uses; counts every event against the cap */
const readTrack = (b, pos, end, counter) => {
  const events = [];
  let name = '';
  let tick = 0;
  let status = 0;
  let damaged = false;
  const need = (n) => {
    if (pos + n > end) throw new Damaged();
  };
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      need(1);
      const c = b[pos++];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Damaged();
  };
  try {
    while (pos < end) {
      if (++counter.n > MAX_EVENTS) throw new Error('This MIDI file has too many events.');
      tick += vlq();
      need(1);
      let s = b[pos];
      if (s & 0x80) pos++;
      else if (status) s = status; // running status: a data byte where a status byte belongs reuses the last one
      else throw new Damaged();
      if (s === 0xff) {
        status = 0;
        need(1);
        const type = b[pos++];
        const len = vlq();
        need(len);
        const at = pos;
        pos += len;
        if (type === 0x2f) break;
        if (type === 0x03 && !name) name = text(b.subarray(at, at + Math.min(len, 400)));
        else if (type === 0x51 && len >= 3) {
          const us = (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
          if (us > 0) events.push({tick, type: 'tempo', us});
        } else if (type === 0x58 && len >= 2) {
          events.push({tick, type: 'sig', num: Math.max(1, b[at]), den: 2 ** Math.min(6, b[at + 1])});
        }
      } else if (s === 0xf0 || s === 0xf7) {
        status = 0;
        const len = vlq();
        need(len);
        pos += len;
      } else if (s >= 0xf0) {
        // system common and real time messages do not belong in a file
        throw new Damaged();
      } else {
        status = s;
        const kind = s & 0xf0;
        const ch = s & 0x0f;
        const two = kind !== 0xc0 && kind !== 0xd0;
        need(two ? 2 : 1);
        const a = b[pos++] & 0x7f;
        const v = two ? b[pos++] & 0x7f : 0;
        if (kind === 0x90 && v > 0) events.push({tick, type: 'on', ch, key: a, vel: v});
        else if (kind === 0x80 || kind === 0x90) events.push({tick, type: 'off', ch, key: a});
        else if (kind === 0xb0 && a === 64) events.push({tick, type: 'pedal', ch, down: v >= 64});
        else if (kind === 0xc0) events.push({tick, type: 'program', ch, program: a});
        // An, Dn, En and the other controllers are read past with their lengths and not used
      }
    }
  } catch (e) {
    if (!(e instanceof Damaged)) throw e;
    damaged = true;
  }
  return {events, name: cleanTitle(name), end: tick, damaged};
};

/** seconds from ticks: tempo segments for ticks a quarter note, a fixed rate for SMPTE time */
const makeClock = (division, tempos) => {
  if (division & 0x8000) {
    const fps = -((division >> 8) << 24 >> 24);
    const perFrame = division & 0xff;
    const rate = (fps === 29 ? 29.97 : fps) * perFrame;
    if (!(rate > 0)) throw new Error('This MIDI file is damaged.');
    return {sec: (t) => t / rate, quarter: rate * 0.5, segments: [{tick: 0, sec: 0, us: DEFAULT_TEMPO}], smpte: true};
  }
  if (!division) throw new Error('This MIDI file is damaged.');
  const segments = [{tick: 0, sec: 0, us: DEFAULT_TEMPO}];
  for (const t of tempos) {
    const last = segments[segments.length - 1];
    const sec = last.sec + ((t.tick - last.tick) * last.us) / 1e6 / division;
    if (t.tick === last.tick) last.us = t.us;
    else segments.push({tick: t.tick, sec, us: t.us});
  }
  const sec = (tick) => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const s = segments[lo];
    return s.sec + ((tick - s.tick) * s.us) / 1e6 / division;
  };
  return {sec, quarter: division, segments, smpte: false};
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** the share of the time a part sounds during which two or more of its notes sound at once */
const overlapOf = (notes) => {
  const ev = [];
  for (const n of notes) ev.push([n.start, 1], [n.start + n.duration, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0;
  let prev = 0;
  let any = 0;
  let many = 0;
  for (const [t, d] of ev) {
    if (count >= 1) any += t - prev;
    if (count >= 2) many += t - prev;
    count += d;
    prev = t;
  }
  return any > 0 ? many / any : 0;
};

const DRUM_NAME = /drum|perc|kit/i;
const BASS_NAME = /bass/i;
const MELODY_NAME = /melody|lead|vocal|voice|solo|tune/i;

/**
 * Which part each track plays. `tracks` is [{name, channel, program, notes: [{start, duration, midi}]}]; returns
 * [{part, guessed}] in the same order. `guessed` marks percussion found by its name outside channel 10.
 */
export const assignParts = (tracks) => {
  const out = tracks.map(() => null);
  const mean = tracks.map((t) => (t.notes.length ? t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length : 0));
  tracks.forEach((t, i) => {
    if (t.channel === 9) out[i] = {part: 'drums', guessed: false};
    else if (
      DRUM_NAME.test(t.name) &&
      t.notes.length &&
      t.notes.every((n) => n.midi >= 35 && n.midi <= 81) &&
      median(t.notes.map((n) => n.duration)) < 0.25
    ) {
      out[i] = {part: 'drums', guessed: true};
    } else if ((t.program >= 32 && t.program <= 39) || BASS_NAME.test(t.name)) out[i] = {part: 'bass', guessed: false};
    else if (MELODY_NAME.test(t.name)) out[i] = {part: 'melody', guessed: false};
  });
  const rest = tracks.map((_, i) => i).filter((i) => !out[i] && tracks[i].notes.length);
  let melody = out.some((o) => o?.part === 'melody');
  if (!melody) {
    let best = -1;
    for (const i of rest) if (overlapOf(tracks[i].notes) < 0.1 && (best < 0 || mean[i] > mean[best])) best = i;
    if (best >= 0) {
      out[best] = {part: 'melody', guessed: false};
      melody = true;
    }
  }
  for (const i of rest) if (!out[i]) out[i] = {part: mean[i] < 52 ? 'bass' : 'chords', guessed: false};
  if (!melody) {
    // nothing sings alone: the highest track that is not drums carries the tune
    let best = -1;
    tracks.forEach((t, i) => {
      if (t.notes.length && out[i]?.part !== 'drums' && (best < 0 || mean[i] > mean[best])) best = i;
    });
    if (best >= 0) out[best] = {part: 'melody', guessed: false};
  }
  return out.map((o) => o || {part: 'chords', guessed: false});
};

/**
 * Read a Standard MIDI File into a Timeline; throws a short message for the user. `fileName` gives the title when
 * the first track has no name. The timeline also carries `tracks` ([{name, channel, program, notes, part, guessed}],
 * where `notes` is a count; every note's `track` points into it) and `dropped`, the notes under 40 ms let go.
 */
export const parseMidi = (buffer, fileName = '') => {
  if (!(buffer instanceof ArrayBuffer)) throw new Error('This is not a MIDI file.');
  if (buffer.byteLength > MAX_BYTES) throw new Error('MIDI files can be up to 4 MB.');
  const b = new Uint8Array(buffer);
  if (b.length < 14 || ascii(b, 0) !== 'MThd') throw new Error('This is not a MIDI file.');
  const headLen = u32(b, 4);
  if (headLen < 6 || 8 + headLen > b.length) throw new Error('This is not a MIDI file.');
  const format = u16(b, 8);
  const declared = u16(b, 10);
  const division = u16(b, 12);
  if (format > 1) throw new Error('This MIDI type is not supported.');
  if (declared > MAX_TRACKS) throw new Error('MIDI files can have up to 256 tracks.');

  // chunks: tracks are read, anything else is skipped by its length; a length past the end is cut at the end
  const tracks = [];
  const counter = {n: 0};
  let pos = 8 + headLen;
  while (pos + 8 <= b.length && tracks.length < MAX_TRACKS) {
    const type = ascii(b, pos);
    const len = u32(b, pos + 4);
    const start = pos + 8;
    const end = Math.min(b.length, start + len);
    if (type === 'MTrk') tracks.push(readTrack(b, start, end, counter));
    pos = start + len;
  }
  if (!tracks.length) throw new Error('No notes found in this file.');

  const tempos = [];
  const sigs = [];
  tracks.forEach((t) => {
    for (const e of t.events) {
      if (e.type === 'tempo') tempos.push(e);
      else if (e.type === 'sig') sigs.push(e);
    }
  });
  tempos.sort((a, b2) => a.tick - b2.tick);
  sigs.sort((a, b2) => a.tick - b2.tick);
  const clock = makeClock(division, tempos);

  // every track's events in one stream, by tick, then track, then file order
  const stream = [];
  tracks.forEach((t, ti) => t.events.forEach((e, k) => e.type !== 'tempo' && e.type !== 'sig' && stream.push({e, ti, k})));
  stream.sort((x, y) => x.e.tick - y.e.tick || x.ti - y.ti || x.k - y.k);

  // notes pair up per channel and key; a second note on for an open key ends the first there
  const units = new Map(); // track * 16 + channel -> {track, channel, program, notes}
  const program = new Int16Array(16).fill(-1);
  const pedal = new Uint8Array(16);
  const open = new Map(); // channel * 128 + key -> {tick, vel, unit, held}
  const raw = [];
  let tooMany = false;
  const end = (o, tick) => {
    if (raw.length >= MAX_NOTES * 2) {
      tooMany = true;
      return;
    }
    raw.push({from: o.tick, to: tick, vel: o.vel, key: o.key, unit: o.unit, capped: false});
  };
  for (const {e, ti} of stream) {
    if (e.type === 'program') program[e.ch] = e.program;
    else if (e.type === 'on') {
      const id = e.ch * 128 + e.key;
      const prev = open.get(id);
      if (prev) end(prev, e.tick);
      const uid = ti * 16 + e.ch;
      if (!units.has(uid)) units.set(uid, {track: ti, channel: e.ch, program: program[e.ch], notes: []});
      open.set(id, {tick: e.tick, vel: e.vel, key: e.key, unit: uid, held: false});
    } else if (e.type === 'off') {
      const id = e.ch * 128 + e.key;
      const o = open.get(id);
      if (!o || o.held) continue;
      if (pedal[e.ch]) o.held = true;
      else {
        end(o, e.tick);
        open.delete(id);
      }
    } else if (e.type === 'pedal') {
      pedal[e.ch] = e.down ? 1 : 0;
      if (!e.down) {
        for (const [id, o] of open) {
          if (o.held && id >> 7 === e.ch) {
            end(o, e.tick);
            open.delete(id);
          }
        }
      }
    }
  }
  // notes left open end with their track, and never last more than 8 s
  for (const o of open.values()) {
    const before = raw.length;
    end(o, Math.max(o.tick, tracks[units.get(o.unit).track].end));
    if (raw.length > before) raw[raw.length - 1].capped = true;
  }
  if (tooMany) throw new Error('This song has more than 20,000 notes.');

  // the parts list: one entry per track and channel that has notes, in file order
  const unitList = [...units.entries()].sort((x, y) => x[0] - y[0]);
  const unitIndex = new Map(unitList.map(([uid], i) => [uid, i]));
  const channelsInTrack = new Map();
  for (const [, u] of unitList) channelsInTrack.set(u.track, (channelsInTrack.get(u.track) || 0) + 1);
  for (const n of raw) {
    const start = clock.sec(n.from);
    let duration = clock.sec(n.to) - start;
    if (n.capped) duration = Math.min(HOLD_CAP, duration);
    units.get(n.unit).notes.push({start, duration, midi: n.key, velocity: n.vel / 127});
  }
  const info = unitList.map(([, u]) => {
    const tName = tracks[u.track].name;
    let name = tName || (format === 0 || channelsInTrack.get(u.track) > 1 ? `Channel ${u.channel + 1}` : `Track ${u.track + 1}`);
    if (tName && channelsInTrack.get(u.track) > 1) name = `${tName}, channel ${u.channel + 1}`;
    return {name: cleanTitle(name).slice(0, 60), channel: u.channel, program: u.program, notes: u.notes};
  });
  const parts = assignParts(info);

  const notes = [];
  info.forEach((u, i) => {
    for (const n of u.notes) {
      const note = {...n, part: parts[i].part, confidence: 1, source: 'midi', track: i};
      if (note.part === 'drums') note.drum = drumOf(n.midi);
      notes.push(note);
    }
  });
  const merged = mergeShort(notes);
  if (!merged.notes.length) throw new Error('No notes found in this file.');
  const counts = new Array(info.length).fill(0);
  for (const n of merged.notes) counts[n.track]++;
  let duration = 0;
  for (const n of merged.notes) duration = Math.max(duration, n.start + n.duration);
  if (duration > 600) throw new Error('Songs can be up to 10 minutes long.');

  // beats on the grid of each time signature (its lower number is the beat), from the start until the last note ends
  const sigList = sigs.length && sigs[0].tick === 0 ? sigs : [{tick: 0, num: 4, den: 4}, ...sigs];
  const beats = [];
  const sigTimes = [];
  for (let s = 0; s < sigList.length && beats.length < MAX_BEATS; s++) {
    const from = sigList[s].tick;
    const until = s + 1 < sigList.length ? sigList[s + 1].tick : Infinity;
    if (until <= from) continue;
    sigTimes.push({time: clock.sec(from), numerator: sigList[s].num});
    const step = (clock.quarter * 4) / sigList[s].den;
    for (let t = from; t < until && beats.length < MAX_BEATS; t += step) {
      const sec = clock.sec(t);
      if (sec >= duration - 1e-9) break;
      beats.push(sec);
    }
  }

  // the tempo in force for the longest time is the song's tempo
  let bpm = 120;
  if (!clock.smpte) {
    const held = new Map();
    clock.segments.forEach((s, i) => {
      const until = i + 1 < clock.segments.length ? clock.segments[i + 1].sec : duration;
      const len = Math.max(0, Math.min(until, duration) - s.sec);
      held.set(s.us, (held.get(s.us) || 0) + len);
    });
    let best = 0;
    for (const [us, len] of held) if (len > best || (len === best && 60e6 / us > bpm)) [best, bpm] = [len, 60e6 / us];
  }

  // sections start where the time signature or the tempo changes, and where the music changes
  const splits = [];
  for (let s = 1; s < sigList.length; s++) {
    const a = sigList[s - 1];
    const b = sigList[s];
    if (b.tick > a.tick && (a.num !== b.num || a.den !== b.den)) splits.push(clock.sec(b.tick));
  }
  for (let s = 1; s < clock.segments.length; s++) {
    if (Math.abs(clock.segments[s - 1].us / clock.segments[s].us - 1) > TEMPO_SPLIT) splits.push(clock.segments[s].sec);
  }
  const bars = barsFrom(beats, sigTimes);
  const sorted = merged.notes.slice().sort((a, b2) => a.start - b2.start);

  const title = tracks[0].name || cleanTitle(String(fileName).replace(/\.[^.]*$/, '')) || 'Untitled';
  const timeline = validateTimeline({
    notes: merged.notes,
    tempo: {bpm, beats},
    bars,
    sections: findSections(sorted, bars, {duration, splits}),
    duration,
    title,
    tracks: info.map((u, i) => ({name: u.name, channel: u.channel, program: u.program, notes: counts[i], ...parts[i]})),
    dropped: merged.dropped,
  });
  return timeline;
};

/** the same timeline with one track moved to another part; nothing else changes */
export const setTrackPart = (timeline, track, part) => {
  const tracks = timeline.tracks.map((t, i) => (i === track ? {...t, part, guessed: false} : t));
  const notes = timeline.notes.map((n) => {
    if (n.track !== track) return n;
    const m = {...n, part};
    if (part === 'drums') m.drum = drumOf(Math.round(n.midi));
    else delete m.drum;
    return m;
  });
  return {...timeline, notes, tracks};
};
