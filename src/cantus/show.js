// Show mode: the Cantus panel (choose a MIDI file, see its tracks and parts, set the voices, the fractals and each
// part's settings, press Play), the transport bar, and the show itself, where the page follows the plan: each frame
// asks the plan for the fractal, the morph and the view at the song time the frame will be on screen, and every
// sounding note is drawn as its orbit. main.js loads this module the first time the music button is pressed and calls
// into it through a few small hooks; everything it needs from the page comes in `api`.

import {parseMidi, setTrackPart, MAX_BYTES} from './midi.js?v=25';
import {planShow, settingsOf, pitchedFractals, cameraAt, morphAt, fractalAt, DEFAULTS, MAX_VOICES, MAX_SET, EVERY} from './mapper.js?v=25';
import {Transport} from './scheduler.js?v=25';
import {loadPoints} from './points.js?v=25';
import {paramOf} from '../fractals.js?v=25';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const PARTS = [
  ['melody', 'Melody'],
  ['bass', 'Bass'],
  ['chords', 'Chords'],
  ['drums', 'Drums'],
];

/** the running show, for the browser checks and for later phases: `t` is the song time of the last frame, `page` the
 * page's state, `drift` every measured drift in ms */
export const live = {plan: null, transport: null, audio: null, drift: [], budget: null, t: 0, page: null};

/**
 * The frame budget of a show: frame times over a sliding 2 s window. When their 95th percentile is over the target
 * (20 ms for 60 fps, 36 ms for 30 fps on a phone), step() says 'lower'; after 5 s under it, 'raise'. Each step waits
 * for a full window of new frames. The show lowers the picture's iterations, then its render scale, never the sound.
 */
export class FrameBudget {
  constructor(target, {window = 2000, recover = 5000} = {}) {
    this.target = target;
    this.window = window;
    this.recover = recover;
    this.times = [];
    this.since = 0; // when the window started filling after the last step
    this.under = -1; // since when the 95th percentile has been under the target, or -1
    this.last = 0;
  }

  p95() {
    const s = this.times.map((x) => x[1]).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
  }

  /** one frame that took `ms`, ending at `now`; returns 'lower', 'raise' or null */
  step(now, ms) {
    if (!this.since) this.since = now;
    this.times.push([now, ms]);
    while (this.times.length && this.times[0][0] < now - this.window) this.times.shift();
    if (now - this.since < this.window) return null;
    const p = this.p95();
    this.last = p;
    if (p > this.target) {
      this.reset(now);
      return 'lower';
    }
    if (this.under < 0) this.under = now;
    if (now - this.under >= this.recover) {
      this.reset(now);
      return 'raise';
    }
    return null;
  }

  reset(now) {
    this.times.length = 0;
    this.since = now;
    this.under = -1;
  }
}
export const BUDGET = {laptop: 20, phone: 36, minIters: 200, iterStep: 0.75, minK: 0.5, kStep: 0.85};

const clock = (s) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const count = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const MIN_VOICES = 4; // the panel offers 4 to 6 voices
const LEFT = {bass: ['bass note', 'bass notes'], chords: ['chord note', 'chord notes'], drums: ['drum hit', 'drum hits']};
const MAX_DRAWN = 6;

const option = (value, label) => {
  const o = document.createElement('option');
  o.value = String(value);
  o.textContent = label;
  return o;
};

export const initShow = (api) => {
  const panel = $('#cantus');
  const file = $('#c-file');
  const bar = $('#transport');
  const playBtn = $('#t-play');
  const seek = $('#t-seek');
  const timeOut = $('#t-time');
  let points = null;
  let timeline = null;
  let plan = null;
  let transport = null;
  let mode = 'off'; // 'off', 'playing' or 'paused'
  let dragging = false;
  let shownTime = '';
  let settings = settingsOf(DEFAULTS, null);
  let longest = 0; // the longest press of the plan, so drawing looks back no further than that
  live.page = api.state;
  const byKey = new Map(api.fractals.map((f) => [f.key, f]));
  const index = new Map(api.fractals.map((f, i) => [f.key, i]));

  const panelOpen = () => panel.classList.contains('open');
  const togglePanel = (open = !panelOpen()) => {
    if (open) api.closeSettings();
    panel.classList.toggle('open', open);
    document.body.classList.toggle('song-panel', open);
    $$('[data-act="song"]').forEach((b) => b.classList.toggle('on', open));
    api.dimForSheets();
  };
  const closePanel = () => panelOpen() && togglePanel(false);

  // ---------- the song in the panel ----------

  const fail = (e, fallback) => {
    const msg = e instanceof Error && e.message && e.message.length < 80 ? e.message : fallback;
    api.toast(msg);
  };

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > MAX_BYTES) {
      api.toast('MIDI files can be up to 4 MB.');
      return;
    }
    let t;
    try {
      // read with the File API: a blob: URL cannot be fetched under this page's policy
      t = parseMidi(await f.arrayBuffer(), f.name);
    } catch (e) {
      fail(e, 'This is not a MIDI file.');
      return;
    }
    try {
      points = await loadPoints();
    } catch (e) {
      fail(e, 'The notes could not load. Try again.');
      return;
    }
    stopShow();
    timeline = t;
    replan();
  });

  const replan = (announce = true) => {
    transport = null;
    plan = null;
    try {
      plan = planShow(timeline, settings, points, {reducedMotion: api.reducedMotion()});
    } catch (e) {
      fail(e, 'This song cannot be played.');
    }
    if (plan && !plan.presses.length) {
      if (announce) api.toast('Nothing here can play. Give a track a part, or turn a part back on.');
    } else if (plan?.drumsOnly && announce) api.toast('No melody in this song. Playing the drums.');
    longest = plan ? plan.presses.reduce((m, p) => Math.max(m, p.duration), 0) : 0;
    live.plan = plan;
    live.transport = null;
    renderSong();
    prepare();
  };

  const renderSong = () => {
    $('#c-song').hidden = !timeline;
    if (!timeline) return;
    $('#c-title').textContent = timeline.title;
    $('#c-meta').textContent = `${clock(timeline.duration)}, ${count(timeline.notes.length, 'note', 'notes')} found`;
    const list = $('#c-tracks');
    list.replaceChildren();
    timeline.tracks.forEach((tr, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = tr.name;
      const n = document.createElement('span');
      n.className = 'c-count';
      n.textContent = tr.guessed ? `${count(tr.notes, 'note', 'notes')}, guessed as drums by its name` : count(tr.notes, 'note', 'notes');
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Part for ${tr.name}`);
      for (const [value, label] of PARTS) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = tr.part;
      sel.addEventListener('change', () => {
        stopShow();
        timeline = setTrackPart(timeline, i, sel.value);
        replan(false);
      });
      const text = document.createElement('span');
      text.className = 'c-track';
      text.append(name, n);
      li.append(text, sel);
      list.appendChild(li);
    });
    renderParts();
    const notes = [];
    for (const part of ['chords', 'bass', 'drums']) {
      const n = plan?.left[part];
      if (n) notes.push(`${count(n, ...LEFT[part])} left out: more than ${plan.voices} voices.`);
    }
    if (plan?.drumsBorrowed) {
      notes.push(
        settings.layout === 'one'
          ? `The drums use sounds of the Burning ship: the ${byKey.get(plan.fractal).name} has none.`
          : 'The drums use sounds of the Burning ship where a fractal has none.',
      );
    }
    if (plan?.moved) notes.push(`${count(plan.moved, 'note was', 'notes were')} moved by whole octaves to fit.`);
    if (plan?.skipped) notes.push(`${count(plan.skipped, 'lower note', 'lower notes')} under the melody left out.`);
    if (timeline.dropped) notes.push(`${count(timeline.dropped, 'very short note', 'very short notes')} dropped.`);
    $('#c-notes').textContent = notes.join(' ');
    $('#c-notes').hidden = !notes.length;
    $('#c-play').disabled = !plan?.presses.length;
  };

  /** settings changed: the song stops and is planned again */
  const change = (fn) => {
    fn();
    settings = settingsOf(settings, points);
    stopShow();
    replan(false);
  };

  // voices, the fractals (one, a set list by section, or a change every few bars), and per part its fractal, its
  // preferred period and a mute switch; rebuilt with the song
  const renderParts = () => {
    const voices = $('#c-voices');
    if (!voices.options.length) {
      for (let n = MIN_VOICES; n <= MAX_VOICES; n++) voices.appendChild(option(n, String(n)));
      voices.addEventListener('change', () => change(() => (settings.voices = Number(voices.value))));
    }
    voices.value = String(settings.voices);
    const keys = pitchedFractals(points);
    renderLayout(keys);
    const list = $('#c-parts');
    list.replaceChildren();
    for (const [part, label] of [['melody', 'Melody'], ['chords', 'Chords'], ['bass', 'Bass'], ['drums', 'Drums']]) {
      const s = settings.parts[part];
      const li = document.createElement('li');
      li.classList.toggle('muted', s.mute);
      const name = document.createElement('span');
      name.className = 'c-part';
      name.textContent = label;
      li.appendChild(name);
      if (part === 'drums') {
        const where = document.createElement('span');
        where.className = 'c-where';
        where.textContent = 'On the fractal on screen';
        li.appendChild(where);
      } else {
        // with a set list every part plays the fractal on screen
        let fr;
        if (settings.layout === 'one') {
          fr = document.createElement('select');
          fr.setAttribute('aria-label', `Fractal for the ${part}`);
          for (const k of keys) fr.appendChild(option(k, byKey.get(k).name));
          fr.value = s.fractal;
          fr.addEventListener('change', () => change(() => (s.fractal = fr.value)));
        } else {
          fr = document.createElement('span');
          fr.className = 'c-where c-here';
          fr.textContent = 'Fractal on screen';
        }
        const per = document.createElement('select');
        per.setAttribute('aria-label', `Preferred period for the ${part}`);
        const used = settings.layout === 'one' ? [s.fractal] : settings.setList;
        const periods = [...new Set(used.flatMap((k) => points.fractals[k].periods))].sort((a, b) => a - b);
        for (const p of periods) per.appendChild(option(p, `Period ${p}`));
        // the preferred period need not be one the fractal has; the nearest one it has is shown
        per.value = String(periods.reduce((a, b) => (Math.abs(b - s.period) < Math.abs(a - s.period) ? b : a)));
        per.addEventListener('change', () => change(() => (s.period = Number(per.value))));
        li.append(fr, per);
      }
      const mute = document.createElement('button');
      mute.className = 'c-mute';
      mute.textContent = 'Mute';
      mute.setAttribute('aria-pressed', String(s.mute));
      mute.setAttribute('aria-label', `Mute the ${part}`);
      mute.addEventListener('click', () => change(() => (s.mute = !s.mute)));
      li.appendChild(mute);
      list.appendChild(li);
    }
  };

  const layoutSel = $('#c-layout');
  const everySel = $('#c-every');
  for (let n = EVERY.min; n <= EVERY.max; n++) everySel.appendChild(option(n, String(n)));
  layoutSel.addEventListener('change', () => change(() => (settings.layout = layoutSel.value)));
  everySel.addEventListener('change', () => change(() => (settings.every = Number(everySel.value))));

  /** the fractals: one, or a set list with a row per section, or a row per fractal in turn every few bars */
  const renderLayout = (keys) => {
    layoutSel.value = settings.layout;
    everySel.value = String(settings.every);
    $('#c-every-row').hidden = settings.layout !== 'bars';
    const list = $('#c-set');
    list.hidden = settings.layout === 'one';
    list.replaceChildren();
    if (settings.layout === 'one') return;
    const sections = timeline.sections;
    const rows = settings.layout === 'sections' ? Math.min(sections.length, MAX_SET) : settings.setList.length;
    // a song with more sections than the list gets the list again, so every section has its own row
    const set = settings.setList;
    const base = set.length;
    while (set.length < rows) set.push(set[set.length % base]);
    for (let i = 0; i < rows; i++) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'c-part';
      name.textContent = settings.layout === 'sections' ? `${sections[i].label} ${clock(sections[i].start)}` : String(i + 1);
      const fr = document.createElement('select');
      fr.setAttribute('aria-label', settings.layout === 'sections' ? `Fractal for section ${sections[i].label} at ${clock(sections[i].start)}` : `Fractal ${i + 1}`);
      for (const k of keys) fr.appendChild(option(k, byKey.get(k).name));
      fr.value = set[i];
      fr.addEventListener('change', () => change(() => (settings.setList[i] = fr.value)));
      li.append(name, fr);
      list.appendChild(li);
    }
  };

  // ---------- the picture's programs, built ahead ----------

  // every program the plan needs, one per idle moment; until all are built the panel says so. A morph whose program
  // is not built when it comes becomes a cut
  let queue = [];
  let prepId = 0;
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, {timeout: 300}) : setTimeout(fn, 0));
  const prepare = () => {
    const id = ++prepId;
    queue = [];
    if (plan) {
      for (const seg of plan.layout) queue.push([seg.fractal, null]);
      for (const m of plan.morphs) queue.push([m.from, m.to]);
    }
    const next = () => {
      if (id !== prepId) return;
      while (queue.length && api.ready(...queue[0])) queue.shift();
      $('#c-prep').hidden = !queue.length;
      if (!queue.length) return;
      try {
        api.warm(...queue.shift());
      } catch (e) {
        // a program this GPU cannot build: the show cuts there instead of morphing
        console.warn(e);
      }
      idle(next);
    };
    next();
  };

  // ---------- the show ----------

  const restoreManual = () => {
    // the song set the voice's fractal, rate and dampening; manual playing gets the page's own settings back
    for (const m of api.setupMessages()) api.send(m);
  };

  const showBar = () => {
    bar.hidden = mode === 'off';
    document.body.classList.toggle('show-on', mode !== 'off');
    bar.classList.toggle('paused', mode === 'paused');
    playBtn.setAttribute('aria-label', mode === 'playing' ? 'Pause' : 'Resume');
    playBtn.title = mode === 'playing' ? 'Pause' : 'Resume';
    if (transport) seek.max = String(transport.duration);
    updateBar(true);
  };

  const updateBar = (force = false) => {
    if (!transport) return;
    const t = dragging ? Number(seek.value) : transport.now();
    if (!dragging) seek.value = String(t);
    const text = `${clock(t)} / ${clock(transport.duration)}`;
    if (force || text !== shownTime) timeOut.textContent = shownTime = text;
  };

  const begin = async () => {
    await api.startAudio();
    const a = api.audio();
    if (!a?.node) return false;
    live.audio = a;
    if (!transport || transport.ctx !== a.ctx) {
      transport = new Transport({ctx: a.ctx, send: api.send, plan, onEnd: () => stopShow()});
      live.transport = transport;
    }
    api.send({type: 'voices', n: plan.voices});
    // the fractal of this moment of the song; this also stops a manual note and leaves a Julia set
    api.showFractal(fractalAt(plan, transport.state === 'stopped' ? 0 : transport.pos));
    startPicture();
    $('#hint').classList.add('gone');
    mode = 'playing';
    showBar();
    return true;
  };

  /** Play in the panel: the song from the start */
  const playSong = async () => {
    if (!plan?.presses.length) return;
    transport?.stop();
    togglePanel(false);
    if (await begin()) transport.play();
  };

  const resume = async () => {
    if (mode !== 'paused' || !transport) return;
    if (await begin()) transport.play();
  };

  const pause = () => {
    if (mode !== 'playing') return;
    transport.pause();
    mode = 'paused';
    endPicture();
    restoreManual();
    showBar();
  };

  function stopShow() {
    if (mode === 'off') return;
    transport?.stop();
    mode = 'off';
    endPicture();
    restoreManual();
    showBar();
  }

  playBtn.addEventListener('click', () => (mode === 'playing' ? pause() : resume()));
  $('#t-stop').addEventListener('click', stopShow);
  $('#c-play').addEventListener('click', playSong);
  seek.addEventListener('input', () => {
    dragging = true;
    updateBar();
  });
  seek.addEventListener('change', () => {
    dragging = false;
    transport?.seek(Number(seek.value));
    updateBar(true);
  });

  // ---------- the picture during a show ----------

  const phone = () => window.matchMedia('(max-width: 760px)').matches;
  let saved = null; // the picture's detail before the show, given back when it pauses or stops
  let budget = null;
  let lastNow = 0;
  let frameT = 0; // the song time this frame shows
  let prevT = -1; // the song time the last frame showed, and the anchor it was on
  let prevAnchor = null;
  let morphOn = false;

  const startPicture = () => {
    saved = api.quality();
    budget = new FrameBudget(phone() ? BUDGET.phone : BUDGET.laptop);
    live.budget = budget;
    lastNow = 0;
    prevT = -1;
  };

  const endPicture = () => {
    if (!saved) return;
    api.setIters(saved.iters);
    api.setScaleCap(Infinity);
    saved = null;
    // a morph cut short lands on the fractal it was heading to
    api.state.morph = null;
  };

  /** the frame took too long, or has been quick for a while: the picture's detail steps down or up */
  const adjust = (way) => {
    const q = api.quality();
    if (way === 'lower') {
      if (q.iters > BUDGET.minIters) api.setIters(Math.max(BUDGET.minIters, Math.round(q.iters * BUDGET.iterStep)));
      else if (q.k > BUDGET.minK + 1e-9) api.setScaleCap(Math.max(BUDGET.minK, q.k * BUDGET.kStep));
    } else if (q.k < q.baseK - 1e-9) {
      const k = q.k / BUDGET.kStep;
      api.setScaleCap(k >= q.baseK - 1e-9 ? Infinity : k);
    } else if (q.iters < saved.iters) api.setIters(Math.min(saved.iters, Math.round(q.iters / BUDGET.iterStep)));
  };

  /**
   * each frame of a playing show: the fractal, the morph and the view of the plan at the song time this frame will
   * be on screen (one frame interval after its start). Returns {type, view, morph} for main.js to use as they are,
   * and `slow`, the frame time in ms the budget aims under.
   */
  const frame = (now) => {
    const interval = lastNow ? Math.min(50, now - lastNow) : 16.7;
    if (lastNow) {
      const way = budget.step(now, now - lastNow);
      if (way) adjust(way);
    }
    lastNow = now;
    // drift: the song time the last frame showed against the song time of the audio clock now that it is on screen
    const anchor = transport.anchors[transport.anchors.length - 1];
    if (prevT >= 0 && anchor === prevAnchor) addDrift((prevT - transport.songAtWall(now)) * 1000);
    const t = transport.songAtWall(now + interval);
    frameT = t;
    live.t = t;
    prevT = t;
    prevAnchor = anchor;
    const view = cameraAt(plan, t);
    const m = morphAt(plan, t);
    let key = fractalAt(plan, t);
    let morph = null;
    morphOn = false;
    // a morph whose program is not built yet is a cut at its downbeat
    if (m && api.ready(m.from, m.to)) {
      key = m.to;
      const from = byKey.get(m.from);
      morph = {from: index.get(m.from), fromParam: paramOf(from, {}), e: m.e};
      morphOn = true;
    }
    api.hideLimit();
    updateBar();
    return {type: index.get(key), view, morph, slow: budget.target};
  };

  const drawn = [];

  /** each frame of a playing show: the orbit of every sounding note, at most one a voice; a drum hit fades out. During
   * a morph the picture is between two formulas, so the orbits are drawn at half strength */
  const draw = () => {
    const t = frameT;
    const ps = plan.presses;
    let lo = 0;
    let hi = ps.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].time <= t) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // a sounding note started at most `longest` ago; each voice plays one note at a time
    drawn.length = 0;
    for (let k = i; k >= 0 && drawn.length < MAX_DRAWN && ps[k].time >= t - longest; k--) {
      if (t < ps[k].time + ps[k].duration) drawn.push(ps[k]);
    }
    const half = morphOn ? 0.5 : 1;
    for (let k = drawn.length - 1; k >= 0; k--) {
      const p = drawn[k];
      const f = byKey.get(p.fractal);
      const fade = (p.part === 'drums' ? Math.max(0, 1 - (t - p.time) / p.duration) : 1) * half;
      api.drawOrbit(f, paramOf(f, {}), p.point, {escape: p.drum === 'kick', fade});
    }
  };

  // drift since the page opened: its magnitudes in 0.1 ms bins up to 100 ms, for the 95th percentile, and the largest
  const bins = new Uint32Array(1001);
  let drifts = 0;
  let driftLast = 0;
  let driftMax = 0;
  const addDrift = (ms) => {
    bins[Math.min(1000, Math.round(Math.abs(ms) * 10))]++;
    drifts++;
    driftLast = ms;
    driftMax = Math.max(driftMax, Math.abs(ms));
    if (live.drift.length < 200000) live.drift.push(ms);
  };
  /** the drift measured so far, in ms: the last one, the 95th percentile of the magnitudes and the largest */
  const drift = () => {
    if (!drifts) return null;
    let k = 0;
    for (let seen = 0; k < 1000 && (seen += bins[k]) < drifts * 0.95; k++);
    return {last: driftLast, p95: k / 10, max: driftMax};
  };

  return {
    playing: () => mode === 'playing',
    interrupt: pause,
    togglePanel,
    closePanel,
    frame,
    draw,
    drift,
    // the GPU came back with no programs: build them again
    restored: prepare,
  };
};
