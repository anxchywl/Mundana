// Song links: a song's notes and settings in the address, `#cantus=1.<payload>`, the payload base64url of deflate-raw
// of JSON. A link carries notes only, never sound. A link is untrusted input: its length is checked first, it is
// decompressed as a stream that stops past 512 KB, and the JSON is checked by hand, every key known, every number in
// bounds, before validateTimeline sees it. Anything wrong rejects the whole link. Plain JavaScript; Node runs it too.

import {validateTimeline, cleanTitle, PARTS, DRUMS, MAX_SECONDS, MAX_NOTES, MAX_BEATS, MAX_SECTIONS} from './timeline.js?v=31';
import {fractals} from '../fractals.js?v=31';

export const PREFIX = 'cantus=1.';
export const MAX_HASH = 32768;
export const MAX_JSON = 512 * 1024;
export const MAX_BARS = 5000;
export const MAX_LIST = 64;
const MAX_MS = MAX_SECONDS * 1000;

export const DAMAGED = 'This song link is damaged.';
export const NEWER = 'This link was made by a newer Mundana.';
export const UNSUPPORTED = 'This browser cannot open song links.';
export const TOO_LONG = 'This song is too long to share as a link.';

/** whether this browser can make and open song links */
export const canShare = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

const KEYS = new Set(fractals.map((f) => f.key));
const LAYOUT_OUT = {one: 'one', sections: 'sections', bars: 'every'};
const LAYOUT_IN = {one: 'one', sections: 'sections', every: 'bars'};
const PITCHED = ['melody', 'chords', 'bass'];

// ---------- bytes ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** bytes to base64url, no padding */
export const toBase64url = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
};

/** base64url to bytes; throws on any other character or an impossible length */
export const fromBase64url = (s) => {
  if (s.length % 4 === 1) throw new Error(DAMAGED);
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const len = Math.min(4, s.length - i);
    for (let j = 0; j < 4; j++) {
      const c = j < len ? s.charCodeAt(i + j) : 65;
      const v = c < 128 ? B64_INDEX[c] : -1;
      if (v < 0) throw new Error(DAMAGED);
      n = (n << 6) | v;
    }
    out[o++] = (n >> 16) & 255;
    if (len > 2) out[o++] = (n >> 8) & 255;
    if (len > 3) out[o++] = n & 255;
  }
  return out.subarray(0, o);
};

const pipe = async (bytes, stream, limit = Infinity) => {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      // a small link must not expand into a huge one
      await reader.cancel().catch(() => {});
      throw new Error(DAMAGED);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---------- encoding ----------

const ms = (s) => Math.round(s * 1000);

/** the beats as [first, period] when evenly spaced within 1 ms all the way to the end, else every beat */
const packBeats = (beats, duration) => {
  const b = beats.map(ms);
  if (b.length >= 3) {
    const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    const expanded = expandBeats([b[0], period * 1000], duration * 1000);
    if (expanded.length === b.length && expanded.every((v, i) => Math.abs(v - beats[i] * 1000) <= 1)) return [b[0], Math.round(period * 1e6) / 1e3];
  }
  return b;
};

/** [first, period] in ms to every beat in ms, before the end */
const expandBeats = ([first, period], endMs) => {
  const out = [];
  if (!(period > 0)) return [first];
  for (let t = first; t < endMs - 1e-6 && out.length < MAX_BEATS; t = first + out.length * period) out.push(t);
  return out;
};

/** a note's pitch in hundredths: the measured pitch of a note heard in a recording, kept within 0.49 of its key so it
 * rounds back to the same key */
const pitch100 = (n) => {
  const key = Math.round(n.midi * 100);
  if (n.midiMeasured === undefined) return key;
  return key + Math.max(-49, Math.min(49, Math.round((n.midiMeasured - n.midi) * 100)));
};

/** the link's payload object for a timeline and settings (mapper settings) */
export const payloadOf = (timeline, settings) => {
  const audio = timeline.notes.some((n) => n.source === 'audio');
  const p = {
    v: 1,
    t: timeline.title,
    d: Math.round(timeline.duration * 1000) / 1000,
    bpm: Math.round(timeline.tempo.bpm * 1000) / 1000,
    beats: packBeats(timeline.tempo.beats, timeline.duration),
    bars: (timeline.bars || []).map(ms),
    sec: timeline.sections.map((s) => [ms(s.start), ms(s.end), s.label]),
    // each start as the time since the one before (notes are sorted by start): measured 19 to 54 percent shorter
    n: timeline.notes.map((n, i, all) => [
      ms(n.start) - (i ? ms(all[i - 1].start) : 0),
      ms(n.duration),
      pitch100(n),
      Math.round(n.velocity * 127),
      PARTS.indexOf(n.part),
      n.part === 'drums' ? DRUMS.indexOf(n.drum) : -1,
      Math.round(n.confidence * 100),
    ]),
    s: {
      layout: LAYOUT_OUT[settings.layout] || 'one',
      every: settings.every,
      list: settings.setList.slice(0, MAX_LIST),
      parts: Object.fromEntries(
        Object.entries(settings.parts).map(([part, s]) => [part, part === 'drums' ? [s.mute ? 1 : 0] : [s.fractal, s.period, s.mute ? 1 : 0]]),
      ),
      voices: settings.voices,
      speed: 1,
    },
  };
  // optional fields: notes heard in a recording, and the tempo they came with
  if (audio) p.a = 1;
  return p;
};

/** the hash of a song link, without '#': 'cantus=1.<payload>' */
export const encodeSong = async (timeline, settings) => {
  const json = new TextEncoder().encode(JSON.stringify(payloadOf(timeline, settings)));
  return PREFIX + toBase64url(await pipe(json, new CompressionStream('deflate-raw')));
};

// ---------- decoding ----------

const fail = () => {
  throw new Error(DAMAGED);
};
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
/** every own key of o is one of `keys`, and every one of `need` is there */
const onlyKeys = (o, keys, need = keys) => {
  if (!isObj(o)) fail();
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail();
  for (const k of need) if (!Object.hasOwn(o, k)) fail();
};
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail());
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fail());
const arr = (v, max) => (Array.isArray(v) && v.length <= max ? v : fail());
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : fail());

/** the payload, checked by hand; returns a clean copy or throws DAMAGED */
export const checkPayload = (p) => {
  onlyKeys(p, ['v', 't', 'd', 'bpm', 'beats', 'bars', 'sec', 'n', 's', 'a'], ['v', 't', 'd', 'bpm', 'beats', 'bars', 'sec', 'n', 's']);
  if (p.v !== 1) fail();
  const out = {};
  out.t = str(p.t, 120);
  out.d = num(p.d, 0.001, MAX_SECONDS);
  out.bpm = num(p.bpm, 1, 1000);
  out.beats = arr(p.beats, MAX_BEATS).map((b) => num(b, 0, MAX_MS));
  out.bars = arr(p.bars, MAX_BARS).map((b) => int(b, 0, MAX_MS));
  out.sec = arr(p.sec, MAX_SECTIONS).map((s) => {
    arr(s, 3);
    if (s.length !== 3) fail();
    return [int(s[0], 0, MAX_MS), int(s[1], 0, MAX_MS), str(s[2], 40)];
  });
  let at = 0;
  out.n = arr(p.n, MAX_NOTES).map((n) => {
    arr(n, 7);
    if (n.length !== 7) fail();
    const part = int(n[4], 0, PARTS.length - 1);
    const drum = int(n[5], -1, DRUMS.length - 1);
    if ((PARTS[part] === 'drums') !== (drum >= 0)) fail();
    // starts come as steps from the one before; their sum stays within the song's limit
    at += int(n[0], 0, MAX_MS);
    return [int(at, 0, MAX_MS), int(n[1], 0, MAX_MS), int(n[2], 0, 12700), int(n[3], 0, 127), part, drum, int(n[6], 0, 100)];
  });
  if (Object.hasOwn(p, 'a')) out.a = int(p.a, 1, 1);
  const s = p.s;
  onlyKeys(s, ['layout', 'every', 'list', 'parts', 'voices', 'speed']);
  if (!Object.hasOwn(LAYOUT_IN, s.layout)) fail();
  const fractal = (k) => (typeof k === 'string' && KEYS.has(k) ? k : fail());
  out.s = {
    layout: s.layout,
    every: int(s.every, 4, 32),
    list: arr(s.list, MAX_LIST).map(fractal),
    voices: int(s.voices, 4, 6),
    speed: num(s.speed, 0.5, 1.5),
    parts: {},
  };
  onlyKeys(s.parts, [...PITCHED, 'drums']);
  for (const part of PITCHED) {
    const v = arr(s.parts[part], 3);
    if (v.length !== 3) fail();
    out.s.parts[part] = [fractal(v[0]), int(v[1], 2, 16), int(v[2], 0, 1)];
  }
  const drums = arr(s.parts.drums, 1);
  if (drums.length !== 1) fail();
  out.s.parts.drums = [int(drums[0], 0, 1)];
  return out;
};

/** a checked payload to {timeline, settings}; validateTimeline as for any other input */
export const songOf = (p) => {
  const audio = p.a === 1;
  const source = audio ? 'audio' : 'midi';
  const beats = p.beats.length === 2 ? expandBeats(p.beats, p.d * 1000) : p.beats;
  const used = PARTS.filter((part) => p.n.some((n) => PARTS[n[4]] === part));
  const notes = p.n.map(([start, dur, midi100, vel, part, drum, conf]) => {
    const note = {
      start: start / 1000,
      duration: dur / 1000,
      midi: audio ? Math.round(midi100 / 100) : midi100 / 100,
      velocity: vel / 127,
      part: PARTS[part],
      confidence: conf / 100,
      source,
      track: used.indexOf(PARTS[part]),
    };
    if (audio && drum < 0 && midi100 % 100 !== 0) note.midiMeasured = midi100 / 100;
    if (drum >= 0) note.drum = DRUMS[drum];
    return note;
  });
  const names = {melody: 'Melody', bass: 'Bass', chords: 'Chords', drums: 'Drums'};
  const timeline = validateTimeline({
    notes,
    tempo: {bpm: p.bpm, beats: beats.map((b) => b / 1000), ...(audio ? {estimated: true} : {})},
    bars: p.bars.map((b) => b / 1000),
    sections: p.sec.map(([a, b, label]) => ({start: a / 1000, end: b / 1000, label})),
    duration: p.d,
    title: cleanTitle(p.t),
    tracks: used.map((part) => ({name: names[part], part, notes: notes.filter((n) => n.part === part).length})),
  });
  const settings = {
    voices: p.s.voices,
    layout: LAYOUT_IN[p.s.layout],
    every: p.s.every,
    setList: p.s.list,
    parts: {
      ...Object.fromEntries(PITCHED.map((part) => [part, {fractal: p.s.parts[part][0], period: p.s.parts[part][1], mute: p.s.parts[part][2] === 1}])),
      drums: {mute: p.s.parts.drums[0] === 1},
    },
  };
  return {timeline, settings, audio};
};

/**
 * A song link's hash (with or without '#') to {timeline, settings, audio}. Throws an Error whose message is for the
 * user: damaged, made by a newer Mundana, or a browser that cannot open song links. Never returns half a song.
 */
export const decodeSong = async (hash) => {
  const h = String(hash ?? '');
  if (h.length > MAX_HASH + 1) throw new Error(DAMAGED);
  const s = h.startsWith('#') ? h.slice(1) : h;
  if (!s.startsWith(PREFIX)) {
    const m = /^cantus=(\d{1,6})\./.exec(s);
    throw new Error(m && Number(m[1]) > 1 ? NEWER : DAMAGED);
  }
  if (!canShare()) throw new Error(UNSUPPORTED);
  let p;
  try {
    const bytes = await pipe(fromBase64url(s.slice(PREFIX.length)), new DecompressionStream('deflate-raw'), MAX_JSON);
    p = checkPayload(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    return songOf(p);
  } catch {
    throw new Error(DAMAGED);
  }
};
