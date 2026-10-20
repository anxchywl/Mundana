// The piano roll: the song's notes drawn on one canvas, time across and pitch up, with a drum lane at the bottom. Notes
// can be selected, moved, stretched, transposed, deleted and given another part, and any range of the song can be
// played. Every change is a small edit record that goes through applyEdit, which returns a new checked timeline; the
// show plans again from it. The top of this file is plain JavaScript, so Node runs it in the tests; initEditor is
// the part that needs a page.

import {checkNote, byTime, timeToBeat, beatToTime, PARTS, DRUMS, MAX_SECONDS, MIN_NOTE} from './timeline.js?v=31';

export const MAX_STEPS = 100; // undo steps
export const HISTORY_NOTES = 200000; // and at most this many changed notes kept for them (see History)

/** a drum's row in the drum lane, from the top */
const rowOf = (n) => Math.max(0, DRUMS.indexOf(n.drum));

/**
 * An edit with its numbers held inside the bounds, or null when it touches no note. Edits:
 * {type: 'move', ids, dt, dmidi, drow}: seconds, semitones (pitched notes) and drum rows (drum notes), all notes
 * together: the first note to reach a bound stops the group. {type: 'transpose', ids, dmidi}: the same in pitch only.
 * {type: 'stretch', ids, dd}: seconds added to each length; each note stops at 40 ms on its own. {type: 'delete',
 * ids}. {type: 'part', ids, part, drum}: a note moved to the drums gets `drum` if it is given, else 'other'.
 */
export const clampEdit = (timeline, edit) => {
  if (!edit || !Array.isArray(edit.ids)) return null;
  const ids = new Set(edit.ids);
  const sel = timeline.notes.filter((n) => ids.has(n.id));
  if (!sel.length) return null;
  const out = {type: edit.type, ids: sel.map((n) => n.id)};
  if (edit.type === 'move' || edit.type === 'transpose') {
    let minStart = Infinity;
    let maxEnd = 0;
    let lo = Infinity;
    let hi = -Infinity;
    let rLo = Infinity;
    let rHi = -Infinity;
    for (const n of sel) {
      minStart = Math.min(minStart, n.start);
      maxEnd = Math.max(maxEnd, n.start + n.duration);
      if (n.part === 'drums') {
        rLo = Math.min(rLo, rowOf(n));
        rHi = Math.max(rHi, rowOf(n));
      } else {
        lo = Math.min(lo, n.midi);
        hi = Math.max(hi, n.midi);
      }
    }
    const dt = edit.type === 'move' ? Number(edit.dt) || 0 : 0;
    const dmidi = Math.round(Number(edit.dmidi) || 0);
    const drow = edit.type === 'move' ? Math.round(Number(edit.drow) || 0) : 0;
    out.type = 'move';
    out.dt = Math.min(Math.max(0, MAX_SECONDS - maxEnd), Math.max(-minStart, dt));
    out.dmidi = lo === Infinity ? 0 : Math.min(Math.floor(127 - hi), Math.max(Math.ceil(-lo), dmidi));
    out.drow = rLo === Infinity ? 0 : Math.min(DRUMS.length - 1 - rHi, Math.max(-rLo, drow));
    return out;
  }
  if (edit.type === 'stretch') {
    out.dd = Number(edit.dd) || 0;
    return out;
  }
  if (edit.type === 'delete') return out;
  if (edit.type === 'part') {
    if (!PARTS.includes(edit.part)) return null;
    out.part = edit.part;
    if (DRUMS.includes(edit.drum)) out.drum = edit.drum;
    return out;
  }
  return null;
};

/** a note after an edit, before it is checked */
const changed = (n, e) => {
  const m = {...n};
  if (e.type === 'move') {
    m.start = Math.max(0, n.start + e.dt);
    if (n.part === 'drums') m.drum = DRUMS[Math.max(0, Math.min(DRUMS.length - 1, rowOf(n) + e.drow))];
    else m.midi = Math.max(0, Math.min(127, n.midi + e.dmidi));
    // a pitch heard in a recording moves with its note
    if (n.midiMeasured !== undefined && n.part !== 'drums') m.midiMeasured = Math.max(0, Math.min(127, n.midiMeasured + (m.midi - n.midi)));
  } else if (e.type === 'stretch') {
    // a note stops at 40 ms, and never runs past 10 minutes
    m.duration = Math.min(MAX_SECONDS, Math.max(MIN_NOTE, Math.min(Math.max(n.duration, MAX_SECONDS - n.start), n.duration + e.dd)));
  } else if (e.type === 'part') {
    m.part = e.part;
    if (e.part === 'drums') m.drum = e.drum || (n.part === 'drums' ? n.drum : 'other');
    else delete m.drum;
  }
  return m;
};

const noop = (e) =>
  (e.type === 'move' && !e.dt && !e.dmidi && !e.drow) || (e.type === 'stretch' && !e.dd);

/** two lists sorted by time, merged into one */
const merge = (a, b) => {
  const out = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = byTime(b[j], a[i]) < 0 ? b[j++] : a[i++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
};

/** applyEdit, and how many new notes it made (for the history's memory) */
const apply = (timeline, edit) => {
  const e = clampEdit(timeline, edit);
  if (!e || noop(e)) return {timeline, made: 0};
  const ids = new Set(e.ids);
  const keep = [];
  const sel = [];
  for (const n of timeline.notes) (ids.has(n.id) ? sel : keep).push(n);
  let notes = keep;
  let duration = timeline.duration;
  let made = 0;
  if (e.type !== 'delete') {
    const next = sel.map((n) => changed(n, e));
    if (e.type === 'part' && next.every((m, i) => m.part === sel[i].part && m.drum === sel[i].drum)) return {timeline, made: 0};
    // the song grows to hold a note moved or stretched past its end
    for (const m of next) duration = Math.max(duration, Math.min(MAX_SECONDS, m.start + m.duration));
    const fresh = next.map((m) => checkNote(m, duration)).sort(byTime);
    made = fresh.length;
    notes = merge(keep, fresh);
  }
  const out = {...timeline, notes, duration};
  if (Array.isArray(timeline.tracks) && e.type === 'delete') {
    const counts = new Array(timeline.tracks.length).fill(0);
    for (const n of notes) if (n.track !== undefined && n.track < counts.length) counts[n.track]++;
    out.tracks = timeline.tracks.map((k, i) => ({...k, notes: counts[i]}));
  }
  return {timeline: out, made};
};

/**
 * The timeline after one edit (see clampEdit), checked: every note it changes is checked again, notes it does not
 * change are the same objects as before (so the undo history stays small), and the notes stay sorted. An edit that
 * changes nothing returns the same timeline. Edits never change a note in place.
 */
export const applyEdit = (timeline, edit) => apply(timeline, edit).timeline;

/**
 * Undo and redo: a stack of timelines, at most 100 steps back. Unchanged notes are shared between steps, so a step
 * costs its new notes plus one list of the song's notes. A step that changed many notes costs more: past 200,000
 * changed notes in all, the oldest steps are let go (a song of 20,000 notes keeps at least 10 steps of edits to all
 * of it). The step being looked at is always kept.
 */
export class History {
  constructor(timeline, {steps = MAX_STEPS, budget = HISTORY_NOTES} = {}) {
    this.steps = steps;
    this.budget = budget;
    this.past = [];
    this.future = [];
    this.now = {timeline, cost: 0};
  }

  get timeline() {
    return this.now.timeline;
  }

  /** apply an edit; the new timeline, or null if nothing changed */
  apply(edit) {
    const r = apply(this.now.timeline, edit);
    if (r.timeline === this.now.timeline) return null;
    this.push(r.timeline, r.made);
    return r.timeline;
  }

  /** a timeline changed outside the editor (a track given another part), kept as one step */
  push(timeline, made = timeline.notes.length) {
    this.past.push(this.now);
    this.now = {timeline, cost: made + timeline.notes.length / 20};
    this.future = [];
    let total = this.past.reduce((s, x) => s + x.cost, 0);
    while (this.past.length > this.steps || (this.past.length > 1 && total > this.budget)) total -= this.past.shift().cost;
  }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.now);
    this.now = this.past.pop();
    return this.now.timeline;
  }

  redo() {
    if (!this.future.length) return null;
    this.past.push(this.now);
    this.now = this.future.pop();
    return this.now.timeline;
  }
}

/** the index of the first note starting at or after `t` (notes sorted by start) */
export const firstFrom = (notes, t) => {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** a time on the grid of sixteenths of a beat */
export const snap = (t, beats) => beatToTime(Math.round(timeToBeat(t, beats) * 16) / 16, beats);

// ---------- the page ----------

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const DRUM_NAMES = {kick: 'Kick', snare: 'Snare', hat: 'Hat', other: 'Other'};
const AXIS = [21, 108]; // the piano's keys; the axis grows to hold any note outside them
const MIN_SECS = 2;
const LONG_PRESS = 500;
const SLOP = 6; // a press that moves less than this many pixels is a click

const clock = (s) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** the editor's draw times in ms, for the browser checks */
export const roll = {times: [], editor: null};

/**
 * api: timeline() and plan() (the show's), commit(timeline) (an edit was made), playing(), songTime(now) (the song
 * time a frame at `now` shows, or null with no show), playRange(a, b) (play from a, looping to b; a null range plays
 * on from where the song is), pause(), seek(t), setLoop(a, b) (null ends it), opened(open).
 */
export const initEditor = (api) => {
  const panel = document.querySelector('#editor');
  const canvas = document.querySelector('#e-canvas');
  const ctx = canvas.getContext('2d');
  const q = (s) => panel.querySelector(s);
  const timeOut = q('#e-time');
  const css = getComputedStyle(document.documentElement);
  const tok = (name) => css.getPropertyValue(name).trim();
  const ink = {
    ink: tok('--ink'),
    paper: tok('--paper'),
    paper2: tok('--paper-2'),
    paper3: tok('--paper-3'),
    surface2: tok('--surface-2'),
    surface3: tok('--surface-3'),
    blue: tok('--blue'),
    blueDeep: tok('--blue-deep'),
  };
  const COLOUR = {melody: ink.blue, bass: ink.blueDeep, chords: ink.paper2, drums: ink.paper3};
  const roundRect = typeof ctx.roundRect === 'function';

  let history = null;
  let open = false;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let dirty = true;
  let raf = 0;
  const phone = () => window.matchMedia('(max-width: 760px)').matches;
  const geo = {keys: 46, ruler: 30, drumRow: 13, gap: 6, handle: 6};
  // the view: song time t0 at the left edge, secs across; `lo` is the pitch at the bottom row, kh a row's height
  const view = {t0: 0, secs: 10, lo: 48, kh: 10};
  let selected = new Set();
  let range = null; // {a, b} in song time
  let playhead = null;
  let longest = 0;
  let axis = AXIS.slice();
  let movedIds = new Map(); // note id -> octaves the plan moved it
  let shownPlan = null;
  let preview = null; // an edit being dragged, drawn but not applied
  let box = null; // a selection box being dragged, in canvas pixels
  let act = null; // what the pointer is doing
  const pointers = new Map();
  let gesture = null;

  const tl = () => history.timeline;
  const plotW = () => W - geo.keys;
  const drumTop = () => H - DRUMS.length * geo.drumRow;
  const plotBottom = () => drumTop() - geo.gap;
  const plotH = () => plotBottom() - geo.ruler;
  const xOf = (t) => geo.keys + ((t - view.t0) / view.secs) * plotW();
  const tOf = (x) => view.t0 + ((x - geo.keys) / plotW()) * view.secs;
  const yOf = (midi) => plotBottom() - (midi - view.lo + 1) * view.kh;
  const midiOf = (y) => view.lo - 1 + (plotBottom() - y) / view.kh;
  const rows = () => plotH() / view.kh;

  const clampView = () => {
    const dur = tl().duration;
    view.secs = Math.max(Math.min(MIN_SECS, dur), Math.min(dur, view.secs));
    view.t0 = Math.max(0, Math.min(dur - view.secs, view.t0));
    view.kh = Math.max(6, Math.min(22, view.kh));
    const span = axis[1] - axis[0] + 1;
    if (rows() >= span) view.lo = axis[0] - (rows() - span) / 2;
    else view.lo = Math.max(axis[0], Math.min(axis[1] + 1 - rows(), view.lo));
  };

  /** the pitch axis holds the piano and every pitched note; the view starts on the notes */
  const fitPitch = () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of tl().notes) {
      if (n.part === 'drums') continue;
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    if (lo === Infinity) {
      lo = 48;
      hi = 72;
    }
    // rows tall enough to read and to catch with a finger; a wide song scrolls, centred on its notes
    const want = Math.max(24, hi - lo + 5);
    view.kh = Math.max(phone() ? 12 : 9, plotH() / want);
    view.lo = (lo + hi) / 2 - rows() / 2 + 1;
  };

  const noteFacts = () => {
    const t = tl();
    longest = t.notes.reduce((m, n) => Math.max(m, n.duration), 0);
    let lo = AXIS[0];
    let hi = AXIS[1];
    for (const n of t.notes) {
      if (n.part === 'drums') continue;
      lo = Math.min(lo, Math.floor(n.midi));
      hi = Math.max(hi, Math.ceil(n.midi));
    }
    axis = [lo, hi];
    q('#e-approx').hidden = !t.notes.some((n) => n.source === 'audio');
  };

  // ---------- drawing ----------

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(3, window.devicePixelRatio || 1);
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const p = phone();
    geo.keys = p ? 38 : 46;
    geo.drumRow = p ? 17 : 13;
    geo.handle = p ? 12 : 6;
    if (history) clampView();
    dirty = true;
  };

  // notes are drawn in batches, one path per colour and strength, from lists kept between frames
  const batches = new Map();
  const rect = (x, y, w, h) => {
    if (roundRect && w > 6 && h > 6) ctx.roundRect(x, y, w, h, 3);
    else ctx.rect(x, y, w, h);
  };

  const draw = () => {
    const t0 = performance.now();
    dirty = false;
    const t = tl();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const left = geo.keys;
    const top = geo.ruler;
    const bottom = plotBottom();
    const dTop = drumTop();
    const t1 = view.t0 + view.secs;
    ctx.font = '500 11px Jost, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // rows: black keys darker, a line under every C
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, bottom - top);
    ctx.clip();
    const first = Math.floor(view.lo);
    const last = Math.ceil(view.lo + rows());
    ctx.fillStyle = ink.surface2;
    for (let m = first; m <= last; m++) if (BLACK[((m % 12) + 12) % 12]) ctx.fillRect(left, yOf(m), W - left, view.kh);
    ctx.fillStyle = ink.surface3;
    for (let m = first; m <= last; m++) if (((m % 12) + 12) % 12 === 0) ctx.fillRect(left, yOf(m) + view.kh - 1, W - left, 1);
    ctx.restore();

    // bars and beats
    const beats = t.tempo.beats;
    const bars = t.bars || [];
    const beatPx = beats.length > 1 ? (plotW() * (beats[1] - beats[0])) / view.secs : 0;
    ctx.fillStyle = ink.surface2;
    if (beatPx >= 10) for (let i = firstTime(beats, view.t0); i < beats.length && beats[i] <= t1; i++) ctx.fillRect(Math.round(xOf(beats[i])), top, 1, H - top);
    ctx.fillStyle = ink.surface3;
    for (let i = firstTime(bars, view.t0); i < bars.length && bars[i] <= t1; i++) ctx.fillRect(Math.round(xOf(bars[i])), top, 1, H - top);

    // the range to play
    if (range) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = ink.blueDeep;
      const a = Math.max(left, xOf(range.a));
      const b = Math.min(W, xOf(range.b));
      if (b > a) ctx.fillRect(a, 0, b - a, H);
      ctx.globalAlpha = 1;
    }

    // the notes in view: a binary search by start, looking back by the longest note
    for (const list of batches.values()) list.length = 0;
    const notes = t.notes;
    const end = firstFrom(notes, t1);
    for (let i = firstFrom(notes, view.t0 - longest); i < end; i++) {
      const n = notes[i];
      if (n.start + n.duration < view.t0) continue;
      const key = `${n.part}${Math.round((0.3 + 0.7 * n.confidence) * 10)}`;
      let list = batches.get(key);
      if (!list) batches.set(key, (list = []));
      list.push(n);
    }
    const moving = preview && preview.type !== 'delete';
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, W - left, H - top);
    ctx.clip();
    for (const [key, list] of batches) {
      if (!list.length) continue;
      ctx.fillStyle = COLOUR[list[0].part];
      ctx.globalAlpha = Number(key.slice(list[0].part.length)) / 10;
      ctx.beginPath();
      for (const n of list) {
        if (moving && selected.has(n.id)) continue;
        noteRect(n, rect);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // the selection, where the drag would put it, with an outline
    const sel = [];
    for (const list of batches.values()) for (const n of list) if (selected.has(n.id)) sel.push(moving ? changedPreview(n) : n);
    if (moving) {
      // notes dragged from outside the view stay drawn
      for (const n of notes) if (selected.has(n.id) && !(n.start < t1 && n.start + n.duration >= view.t0)) sel.push(changedPreview(n));
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink.paper;
    for (const n of sel) {
      ctx.fillStyle = COLOUR[n.part];
      ctx.globalAlpha = 0.3 + 0.7 * n.confidence;
      ctx.beginPath();
      noteRect(n, rect);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
    // notes the plan moved by octaves: a small mark at their start, pointing the way they moved
    ctx.fillStyle = ink.paper;
    for (const list of batches.values()) {
      for (const n of list) {
        const moved = movedIds.get(n.id);
        if (!moved || (moving && selected.has(n.id))) continue;
        const x = xOf(n.start) + 2;
        const y = n.part === 'drums' ? dTop + rowOf(n) * geo.drumRow : yOf(n.midi);
        const h = n.part === 'drums' ? geo.drumRow - 1 : view.kh - 1;
        const cy = y + h / 2;
        ctx.beginPath();
        if (moved > 0) {
          ctx.moveTo(x, cy + 2.5);
          ctx.lineTo(x + 5, cy + 2.5);
          ctx.lineTo(x + 2.5, cy - 2.5);
        } else {
          ctx.moveTo(x, cy - 2.5);
          ctx.lineTo(x + 5, cy - 2.5);
          ctx.lineTo(x + 2.5, cy + 2.5);
        }
        ctx.fill();
      }
    }
    ctx.restore();

    // the drum lane's rows and the piano keys
    ctx.fillStyle = ink.surface2;
    ctx.fillRect(0, dTop - geo.gap / 2, W, 1);
    for (let r = 0; r < DRUMS.length; r++) {
      if (r % 2) ctx.fillRect(left, dTop + r * geo.drumRow, W - left, geo.drumRow);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, left, bottom - top);
    ctx.clip();
    for (let m = first; m <= last; m++) {
      const pc = ((m % 12) + 12) % 12;
      ctx.fillStyle = BLACK[pc] ? ink.ink : ink.surface3;
      ctx.fillRect(0, yOf(m), left - 4, view.kh - 1);
      if (pc === 0 && view.kh >= 7) {
        ctx.fillStyle = ink.paper2;
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, 4, yOf(m) + view.kh / 2);
      }
    }
    ctx.restore();
    ctx.fillStyle = ink.paper3;
    ctx.font = '500 10px Jost, system-ui, sans-serif';
    DRUMS.forEach((d, r) => ctx.fillText(DRUM_NAMES[d], 3, dTop + r * geo.drumRow + geo.drumRow / 2));

    // the ruler: bar numbers, and seconds below them
    ctx.fillStyle = ink.surface2;
    ctx.fillRect(left, 0, W - left, top - 2);
    ctx.font = '500 11px Jost, system-ui, sans-serif';
    ctx.fillStyle = ink.paper2;
    let lastX = -Infinity;
    for (let i = firstTime(bars, view.t0); i < bars.length && bars[i] <= t1; i++) {
      const x = xOf(bars[i]);
      if (x - lastX < 28 || x < left) continue;
      ctx.fillText(String(i + 1), x + 3, 9);
      lastX = x;
    }
    const steps = [1, 2, 5, 10, 15, 30, 60, 120];
    const every = steps.find((s) => (s * plotW()) / view.secs >= 56) || 300;
    ctx.fillStyle = ink.paper3;
    for (let s = Math.ceil(view.t0 / every) * every; s <= t1; s += every) {
      const x = xOf(s);
      ctx.fillRect(Math.round(x), top - 7, 1, 5);
      if (x > left - 1) ctx.fillText(clock(s), x + 3, top - 9);
    }

    // the playhead
    if (playhead !== null && playhead >= view.t0 && playhead <= t1) {
      ctx.fillStyle = ink.paper;
      ctx.fillRect(Math.round(xOf(playhead)) - 0.5, 0, 1.5, H);
    }
    if (box) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = ink.paper3;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(box.x0, box.x1) + 0.5, Math.min(box.y0, box.y1) + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.setLineDash([]);
    }
    const ms = performance.now() - t0;
    if (roll.times.length >= 2000) roll.times.shift();
    roll.times.push(ms);
  };

  /** the index of the first time in a sorted list at or after t */
  const firstTime = (list, t) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const noteBox = (n) => {
    const x = xOf(n.start);
    const w = Math.max(2, (n.duration / view.secs) * plotW() - 1);
    if (n.part === 'drums') return [x, drumTop() + rowOf(n) * geo.drumRow + 1, w, geo.drumRow - 2];
    return [x, yOf(n.midi) + 0.5, w, Math.max(2, view.kh - 1)];
  };
  const noteRect = (n, f) => {
    const [x, y, w, h] = noteBox(n);
    f(x, y, w, h);
  };
  // where a selected note is drawn while an edit is dragged
  const changedPreview = (n) => {
    if (!preview) return n;
    if (preview.type === 'stretch') {
      return {...n, duration: Math.min(MAX_SECONDS, Math.max(MIN_NOTE, Math.min(Math.max(n.duration, MAX_SECONDS - n.start), n.duration + preview.dd)))};
    }
    if (preview.type === 'move') {
      const m = {...n, start: Math.max(0, n.start + preview.dt)};
      if (n.part === 'drums') m.drum = DRUMS[Math.max(0, Math.min(DRUMS.length - 1, rowOf(n) + preview.drow))];
      else m.midi = Math.max(0, Math.min(127, n.midi + preview.dmidi));
      return m;
    }
    return n;
  };

  const loop = (now) => {
    raf = 0;
    if (!open) return;
    const t = api.songTime(now);
    if (t !== playhead) {
      playhead = t;
      dirty = true;
      // while the song plays, the view turns the page when the playhead leaves it
      if (api.playing() && t !== null && !act && !gesture && (t < view.t0 || t > view.t0 + view.secs * 0.97)) {
        view.t0 = t - view.secs * 0.03;
        clampView();
      }
    }
    if (api.plan() !== shownPlan) {
      shownPlan = api.plan();
      movedIds = new Map();
      for (const p of shownPlan?.presses || []) if (p.moved && p.id !== undefined) movedIds.set(p.id, p.moved);
      dirty = true;
    }
    const text = `${clock(playhead ?? 0)} / ${clock(tl().duration)}`;
    if (timeOut.textContent !== text) timeOut.textContent = text;
    q('#e-play').classList.toggle('playing', api.playing());
    if (dirty) draw();
    raf = requestAnimationFrame(loop);
  };
  const redraw = () => {
    dirty = true;
    if (open && !raf) raf = requestAnimationFrame(loop);
  };

  // ---------- editing ----------

  const syncTools = () => {
    const none = !selected.size;
    for (const b of panel.querySelectorAll('[data-needs="selection"]')) b.disabled = none;
    q('#e-undo').disabled = !history?.past.length;
    q('#e-redo').disabled = !history?.future.length;
    q('#e-count').textContent = selected.size ? `${selected.size.toLocaleString('en')} selected${heardAt()}` : '';
    redraw();
  };

  /** one note heard in a recording selected: how far from its key it was heard */
  const heardAt = () => {
    if (selected.size !== 1) return '';
    const [id] = selected;
    const n = tl().notes.find((x) => x.id === id);
    if (n?.midiMeasured === undefined) return '';
    const cents = Math.round((n.midiMeasured - n.midi) * 100);
    return cents === 0 ? ', heard in tune' : `, heard ${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'}`;
  };

  const commit = (t) => {
    if (!t) return;
    noteFacts();
    // a deleted note leaves the selection
    if (selected.size) {
      const ids = new Set(t.notes.map((n) => n.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
    }
    api.commit(t);
    syncTools();
  };
  const edit = (e) => commit(history.apply({...e, ids: [...selected]}));
  const undo = () => commit(history.undo());
  const redo = () => commit(history.redo());
  const transpose = (d) => edit({type: 'transpose', dmidi: d});
  const remove = () => edit({type: 'delete'});
  const setPart = (part) => edit({type: 'part', part});

  const togglePlay = () => {
    if (api.playing()) api.pause();
    else api.playRange(range ? range.a : null, range ? range.b : null);
    redraw();
  };

  const setRange = (r) => {
    range = r;
    api.setLoop(r ? r.a : null, r ? r.b : null);
    redraw();
  };

  // ---------- pointer ----------

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  /** the note under a point, the one drawn last first */
  const hit = (x, y) => {
    const t = tOf(x);
    const notes = tl().notes;
    const inDrums = y >= drumTop() - geo.gap / 2;
    const end = firstFrom(notes, t + 1e-9);
    for (let i = end - 1; i >= 0 && notes[i].start >= t - longest; i--) {
      const n = notes[i];
      if ((n.part === 'drums') !== inDrums) continue;
      const [bx, by, bw, bh] = noteBox(n);
      if (x >= bx - 1 && x <= bx + bw + 1 && y >= by - 1 && y <= by + bh + 1) return n;
    }
    // a narrow note is easier to catch a few pixels after its end
    for (let i = end; i < notes.length && notes[i].start <= tOf(x + 3); i++) {
      const n = notes[i];
      if ((n.part === 'drums') !== inDrums) continue;
      const [bx, by, bw, bh] = noteBox(n);
      if (x >= bx - 3 && x <= bx + bw && y >= by - 1 && y <= by + bh + 1) return n;
    }
    return null;
  };

  const dragEdit = (act, x, y, e) => {
    const n = act.note;
    const beats = tl().tempo.beats;
    const free = e.altKey;
    if (act.kind === 'stretch') {
      const end = n.start + n.duration;
      let to = end + ((x - act.x) / plotW()) * view.secs;
      if (!free) to = snap(to, beats);
      return clampEdit(tl(), {type: 'stretch', ids: [...selected], dd: to - end});
    }
    let start = n.start + ((x - act.x) / plotW()) * view.secs;
    if (!free) start = snap(start, beats);
    return clampEdit(tl(), {
      type: 'move',
      ids: [...selected],
      dt: start - n.start,
      dmidi: Math.round(-(y - act.y) / view.kh),
      drow: Math.round((y - act.y) / geo.drumRow),
    });
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({preventScroll: true});
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer: dragging still works inside the canvas
    }
    const [x, y] = local(e);
    pointers.set(e.pointerId, [x, y]);
    if (pointers.size === 2) {
      // two fingers: pinch the time axis, drag to scroll; whatever one finger started is dropped
      clearTimeout(act?.timer);
      act = null;
      preview = null;
      box = null;
      const [a, b] = [...pointers.values()];
      gesture = {d: Math.max(1, Math.abs(a[0] - b[0])), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]};
      redraw();
      return;
    }
    if (pointers.size > 2 || gesture) return;
    const touch = e.pointerType === 'touch';
    if (y < geo.ruler) {
      act = {kind: 'range', x, y, a: Math.max(0, tOf(x))};
      return;
    }
    if (x < geo.keys) {
      act = {kind: 'pitch', x, y, lo: view.lo};
      return;
    }
    const n = hit(x, y);
    if (!n) {
      act = {kind: 'box', x, y, add: e.shiftKey, touch};
      return;
    }
    const [bx, , bw] = noteBox(n);
    const stretch = x >= bx + bw - Math.min(geo.handle, bw / 2);
    if (touch) {
      // a tap selects; a long press adds to the selection; a drag moves or stretches
      act = {kind: stretch ? 'stretch' : 'move', note: n, x, y, pending: true, touch};
      act.timer = setTimeout(() => {
        if (!act?.pending) return;
        if (selected.has(n.id)) selected.delete(n.id);
        else selected.add(n.id);
        act = null;
        navigator.vibrate?.(10);
        syncTools();
      }, LONG_PRESS);
      return;
    }
    if (e.shiftKey) {
      if (selected.has(n.id)) selected.delete(n.id);
      else selected.add(n.id);
      syncTools();
      if (!selected.has(n.id)) return;
    } else if (!selected.has(n.id)) {
      selected = new Set([n.id]);
      syncTools();
    }
    act = {kind: stretch ? 'stretch' : 'move', note: n, x, y, pending: true};
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      // the pointer's shape tells what a press would do here
      const [x, y] = local(e);
      const n = y > geo.ruler && x > geo.keys ? hit(x, y) : null;
      let cursor = y < geo.ruler ? 'text' : '';
      if (n) {
        const [bx, , bw] = noteBox(n);
        cursor = x >= bx + bw - Math.min(geo.handle, bw / 2) ? 'ew-resize' : 'grab';
      }
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
      return;
    }
    const [x, y] = local(e);
    pointers.set(e.pointerId, [x, y]);
    if (gesture) {
      if (pointers.size !== 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.max(1, Math.abs(a[0] - b[0]));
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const at = tOf(gesture.m[0]);
      view.secs *= gesture.d / d;
      clampView();
      view.t0 = at - ((m[0] - geo.keys) / plotW()) * view.secs;
      view.lo += (m[1] - gesture.m[1]) / view.kh;
      clampView();
      gesture = {d, m};
      redraw();
      return;
    }
    if (!act) return;
    if (act.pending) {
      if (Math.hypot(x - act.x, y - act.y) < SLOP) return;
      act.pending = false;
      clearTimeout(act.timer);
      if (act.touch && (act.kind === 'move' || act.kind === 'stretch') && !selected.has(act.note.id)) {
        selected = new Set([act.note.id]);
        syncTools();
      }
    }
    if (act.kind === 'range') {
      const t = Math.max(0, Math.min(tl().duration, tOf(x)));
      range = {a: Math.min(act.a, t), b: Math.max(act.a, t)};
      act.moved = true;
      redraw();
    } else if (act.kind === 'pitch') {
      view.lo = act.lo + (y - act.y) / view.kh;
      clampView();
      redraw();
    } else if (act.kind === 'box') {
      if (Math.hypot(x - act.x, y - act.y) >= SLOP) box = {x0: act.x, y0: act.y, x1: x, y1: y};
      redraw();
    } else {
      preview = dragEdit(act, x, y, e);
      redraw();
    }
  });

  const up = (e) => {
    const had = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (gesture) {
      if (!pointers.size) gesture = null;
      return;
    }
    if (!had || !act) return;
    const a = act;
    act = null;
    clearTimeout(a.timer);
    const [x, y] = local(e);
    if (e.type === 'pointercancel') {
      preview = null;
      box = null;
      redraw();
      return;
    }
    if (a.kind === 'range') {
      if (!a.moved || !range || range.b - range.a < 0.25) {
        // a click on the ruler: no range, and the song goes there
        setRange(null);
        api.seek(Math.max(0, Math.min(tl().duration, tOf(x))));
      } else setRange(range);
    } else if (a.kind === 'box') {
      if (box) {
        const t0 = tOf(Math.min(box.x0, box.x1));
        const t1 = tOf(Math.max(box.x0, box.x1));
        const y0 = Math.min(box.y0, box.y1);
        const y1 = Math.max(box.y0, box.y1);
        if (!a.add) selected = new Set();
        const notes = tl().notes;
        const end = firstFrom(notes, t1);
        for (let i = firstFrom(notes, t0 - longest); i < end; i++) {
          const n = notes[i];
          const [bx, by, bw, bh] = noteBox(n);
          if (bx + bw >= Math.min(box.x0, box.x1) && by + bh >= y0 && by <= y1) selected.add(n.id);
        }
        box = null;
      } else if (!a.add) selected = new Set();
      syncTools();
    } else if (a.kind === 'move' || a.kind === 'stretch') {
      if (a.pending) {
        // a tap on a note: it alone is selected
        if (a.touch) selected = new Set([a.note.id]);
        else if (!e.shiftKey) selected = new Set([a.note.id]);
        syncTools();
      } else {
        const ed = dragEdit(a, x, y, e);
        preview = null;
        if (ed) commit(history.apply(ed));
        redraw();
      }
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [x] = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 33 : e.deltaX;
      if (x < geo.keys || e.altKey) {
        // over the keys, or with Alt: up and down the pitches
        view.lo -= dy / view.kh / 2;
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        view.t0 += ((e.shiftKey ? dy || dx : dx) / plotW()) * view.secs;
      } else {
        // a wheel or a pinch zooms the time axis around the pointer
        const at = tOf(x);
        view.secs *= Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0016));
        clampView();
        view.t0 = at - ((x - geo.keys) / plotW()) * view.secs;
      }
      clampView();
      redraw();
    },
    {passive: false},
  );

  // ---------- keys, only while the roll has focus ----------

  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k.toLowerCase() === 'z') e.shiftKey ? redo() : undo();
    else if (mod && k.toLowerCase() === 'y') redo();
    else if (mod && k.toLowerCase() === 'a') {
      selected = new Set(tl().notes.map((n) => n.id));
      syncTools();
    } else if (mod || e.altKey) return;
    else if (k === 'ArrowUp') transpose(e.shiftKey ? 12 : 1);
    else if (k === 'ArrowDown') transpose(e.shiftKey ? -12 : -1);
    else if (k === 'Delete' || k === 'Backspace') remove();
    else if (k >= '1' && k <= '4') setPart(['melody', 'bass', 'chords', 'drums'][Number(k) - 1]);
    else if (k === ' ') {
      if (!e.repeat) togglePlay();
    } else if (k === 'Escape') {
      if (selected.size) {
        selected = new Set();
        syncTools();
      } else close();
    } else return;
    e.preventDefault();
    // the page's own keys never see the editor's
    e.stopPropagation();
  });
  canvas.addEventListener('keyup', (e) => {
    if (e.key === ' ') e.stopPropagation();
  });

  // ---------- the toolbar ----------

  q('#e-play').addEventListener('click', togglePlay);
  q('#e-undo').addEventListener('click', undo);
  q('#e-redo').addEventListener('click', redo);
  q('#e-down12').addEventListener('click', () => transpose(-12));
  q('#e-down').addEventListener('click', () => transpose(-1));
  q('#e-up').addEventListener('click', () => transpose(1));
  q('#e-up12').addEventListener('click', () => transpose(12));
  q('#e-delete').addEventListener('click', remove);
  q('#e-close').addEventListener('click', () => close());
  const partSel = q('#e-part');
  partSel.addEventListener('change', () => {
    if (partSel.value) setPart(partSel.value);
    partSel.value = '';
    canvas.focus({preventScroll: true});
  });

  new ResizeObserver(() => {
    resize();
    redraw();
  }).observe(canvas);

  // ---------- open and close ----------

  function close() {
    if (!open) return;
    open = false;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('editor-open');
    api.opened(false);
  }

  const show = () => {
    if (!history) return;
    open = true;
    panel.classList.add('open');
    panel.removeAttribute('aria-hidden');
    document.body.classList.add('editor-open');
    api.opened(true);
    resize();
    clampView();
    syncTools();
    canvas.focus({preventScroll: true});
    redraw();
  };

  const editor = {
    open: show,
    close,
    isOpen: () => open,
    /** a new song: a fresh history, nothing selected, the view on its first bars */
    load(timeline) {
      history = new History(timeline);
      selected = new Set();
      range = null;
      noteFacts();
      resize();
      view.t0 = 0;
      view.secs = Math.min(timeline.duration, 15);
      fitPitch();
      clampView();
      syncTools();
    },
    /** the song changed outside the editor: one more step to undo */
    replace(timeline) {
      if (!history) return editor.load(timeline);
      history.push(timeline);
      noteFacts();
      syncTools();
    },
    /** the range to play, if one is chosen */
    range: () => range,
    // for the browser checks
    get history() {
      return history;
    },
    get view() {
      return view;
    },
    get selected() {
      return selected;
    },
    select(ids) {
      selected = new Set(ids);
      syncTools();
    },
    edit,
    setRange,
    togglePlay,
    redraw,
    toCanvas: (t, midi) => [xOf(t), yOf(midi) + view.kh / 2],
    /** the view moves so that a time and a pitch are in its middle */
    reveal(t, midi) {
      view.t0 = t - view.secs / 2;
      if (midi !== undefined) view.lo = midi - rows() / 2;
      clampView();
      redraw();
    },
  };
  roll.editor = editor;
  return editor;
};
