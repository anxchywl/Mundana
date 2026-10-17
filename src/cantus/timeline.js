// The song as notes in time: the Timeline every part of Cantus reads. A MIDI file (and later an audio file or the
// editor) produces one; the mapper turns it into presses. Times are in seconds from the start of the song.
//
// Note = {start, duration, midi, velocity, part, drum?, confidence, source, track?}
// Timeline = {notes, tempo: {bpm, beats}, bars, sections, duration, title, tracks?}
//
// Everything here is plain JavaScript, so Node runs it in the tests.

export const PARTS = ['melody', 'bass', 'chords', 'drums'];
export const DRUMS = ['kick', 'snare', 'hat', 'other'];
export const SOURCES = ['midi', 'audio'];

export const MAX_SECONDS = 600;
export const MAX_NOTES = 20000;
export const MAX_SECTIONS = 64;
export const MAX_TITLE = 120;
export const MAX_BEATS = 20000;
export const MIN_NOTE = 0.04; // shorter notes are merged into a neighbour or dropped
const JOIN_GAP = 0.02;

const num = (v, lo, hi, what) => {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} is out of range.`);
  return v;
};

/** a title for the screen: no control characters, at most 120 characters */
export const cleanTitle = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);

/** a checked copy of a timeline, notes sorted by start then pitch; throws a short message for the user */
export const validateTimeline = (t) => {
  if (!t || typeof t !== 'object') throw new Error('This is not a song.');
  const duration = Number(t.duration);
  if (!(duration > 0)) throw new Error('This song is empty.');
  if (duration > MAX_SECONDS) throw new Error('Songs can be up to 10 minutes long.');
  if (!Array.isArray(t.notes)) throw new Error('This song has no notes.');
  if (t.notes.length > MAX_NOTES) throw new Error('This song has more than 20,000 notes.');
  const notes = t.notes.map((n) => {
    if (!n || typeof n !== 'object') throw new Error('A note is damaged.');
    const out = {
      start: num(n.start, 0, duration, 'A note start'),
      duration: num(n.duration, MIN_NOTE, MAX_SECONDS, 'A note length'),
      midi: num(n.midi, 0, 127, 'A note pitch'),
      velocity: num(n.velocity, 0, 1, 'A note velocity'),
      part: n.part,
      confidence: num(n.confidence, 0, 1, 'A note confidence'),
      source: n.source,
    };
    if (!PARTS.includes(out.part)) throw new Error('A note has an unknown part.');
    if (!SOURCES.includes(out.source)) throw new Error('A note has an unknown source.');
    if (out.part === 'drums') out.drum = DRUMS.includes(n.drum) ? n.drum : 'other';
    if (n.track !== undefined) out.track = num(n.track, 0, 4095, 'A note track');
    return out;
  });
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  const tempo = t.tempo || {};
  const beats = Array.isArray(tempo.beats) ? tempo.beats.slice(0, MAX_BEATS).filter((b) => Number.isFinite(b) && b >= 0) : [];
  const bars = Array.isArray(t.bars) ? t.bars.slice(0, MAX_BEATS).filter((b) => Number.isFinite(b) && b >= 0) : undefined;
  const sections = (Array.isArray(t.sections) ? t.sections : []).map((s) => ({
    start: num(s?.start, 0, duration, 'A section start'),
    end: num(s?.end, 0, duration, 'A section end'),
    label: cleanTitle(s?.label).slice(0, 40),
  }));
  if (sections.length > MAX_SECTIONS) throw new Error('This song has more than 64 sections.');
  const out = {
    notes,
    tempo: {bpm: Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? Math.min(1000, tempo.bpm) : 120, beats},
    sections: sections.length ? sections : [{start: 0, end: duration, label: 'Song'}],
    duration,
    title: cleanTitle(t.title),
  };
  if (bars) out.bars = bars;
  if (Array.isArray(t.tracks)) {
    out.tracks = t.tracks.slice(0, 4096).map((k) => ({
      name: cleanTitle(k?.name).slice(0, 60),
      notes: Number.isInteger(k?.notes) && k.notes >= 0 ? k.notes : 0,
      part: PARTS.includes(k?.part) ? k.part : 'chords',
      guessed: !!k?.guessed,
      channel: Number.isInteger(k?.channel) && k.channel >= 0 && k.channel < 16 ? k.channel : 0,
      program: Number.isInteger(k?.program) && k.program >= -1 && k.program < 128 ? k.program : -1,
    }));
  }
  if (Number.isInteger(t.dropped) && t.dropped >= 0) out.dropped = t.dropped;
  return out;
};

/**
 * Notes under 40 ms: each joins an immediately following note of the same pitch and part (a gap under 20 ms), or is
 * dropped. Returns {notes, dropped, joined}; the input is not changed.
 */
export const mergeShort = (input) => {
  const notes = input.map((n) => ({...n})).sort((a, b) => a.start - b.start || a.midi - b.midi);
  const gone = new Uint8Array(notes.length);
  let dropped = 0;
  let joined = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.duration >= MIN_NOTE) continue;
    const end = n.start + n.duration;
    let next = -1;
    // notes are sorted by start, so the search stops at the first note starting after the gap
    for (let j = i + 1; j < notes.length && notes[j].start - end < JOIN_GAP; j++) {
      const m = notes[j];
      if (!gone[j] && m.midi === n.midi && m.part === n.part && m.start >= n.start) {
        next = j;
        break;
      }
    }
    gone[i] = 1;
    if (next < 0) {
      dropped++;
      continue;
    }
    const m = notes[next];
    const mEnd = m.start + m.duration;
    m.start = n.start;
    m.duration = Math.max(mEnd, end) - n.start;
    joined++;
    // the joined note now starts earlier; it keeps its place, which is still after every note before i
  }
  return {notes: notes.filter((_, i) => !gone[i]), dropped, joined};
};

/**
 * Downbeats from beats and time signatures. `signatures` is [{time, numerator}] sorted by time; with none the song
 * is in 4/4. A signature starts a new bar on the first beat at or after its time.
 */
export const barsFrom = (beats, signatures = []) => {
  const sigs = signatures.length ? signatures : [{time: 0, numerator: 4}];
  const bars = [];
  let s = 0;
  let count = 0;
  let num = 4;
  for (let i = 0; i < beats.length && bars.length < MAX_BEATS; i++) {
    let changed = false;
    while (s < sigs.length && sigs[s].time <= beats[i] + 1e-6) {
      num = Math.max(1, Math.min(64, Math.round(sigs[s].numerator) || 4));
      s++;
      changed = true;
    }
    if (changed || i === 0) count = 0;
    if (count % num === 0) bars.push(beats[i]);
    count++;
  }
  return bars;
};

const search = (arr, v) => {
  // index of the last element <= v, or -1
  let lo = 0;
  let hi = arr.length - 1;
  let r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) {
      r = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return r;
};

/** the beat number at a time, fractional, linear between beats (and past the ends at the nearest beat's length) */
export const timeToBeat = (t, beats) => {
  if (beats.length < 2) return beats.length ? t - beats[0] : t;
  const i = Math.max(0, Math.min(beats.length - 2, search(beats, t)));
  return i + (t - beats[i]) / (beats[i + 1] - beats[i]);
};

/** the time of a beat number, fractional allowed; the inverse of timeToBeat */
export const beatToTime = (b, beats) => {
  if (beats.length < 2) return beats.length ? beats[0] + b : b;
  const i = Math.max(0, Math.min(beats.length - 2, Math.floor(b)));
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
};
