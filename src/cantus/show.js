// Show mode: the Cantus panel (choose a MIDI file, see its tracks and parts, set the voices and each part's fractal,
// press Play), the transport bar, and the show itself, where the page follows the plan: the camera holds the fractal's
// starting view and every sounding note is drawn as its orbit. main.js loads this module the first time the music button is pressed and calls into it
// through a few small hooks; everything it needs from the page comes in `api`.

import {parseMidi, setTrackPart, MAX_BYTES} from './midi.js?v=25';
import {planShow, settingsOf, pitchedFractals, DEFAULTS, MAX_VOICES} from './mapper.js?v=25';
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

/** the running show, for the browser checks and for later phases */
export const live = {plan: null, transport: null, audio: null};

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
  const byKey = new Map(api.fractals.map((f) => [f.key, f]));

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
      plan = planShow(timeline, settings, points);
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
    if (plan?.drumsBorrowed) notes.push(`The drums use sounds of the Burning ship: the ${byKey.get(plan.fractal).name} has none.`);
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

  // voices, and per part its fractal, its preferred period and a mute switch; rebuilt with the song
  const renderParts = () => {
    const voices = $('#c-voices');
    if (!voices.options.length) {
      for (let n = MIN_VOICES; n <= MAX_VOICES; n++) voices.appendChild(option(n, String(n)));
      voices.addEventListener('change', () => change(() => (settings.voices = Number(voices.value))));
    }
    voices.value = String(settings.voices);
    const keys = pitchedFractals(points);
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
        const fr = document.createElement('select');
        fr.setAttribute('aria-label', `Fractal for the ${part}`);
        for (const k of keys) fr.appendChild(option(k, byKey.get(k).name));
        fr.value = s.fractal;
        fr.addEventListener('change', () => change(() => (s.fractal = fr.value)));
        const per = document.createElement('select');
        per.setAttribute('aria-label', `Preferred period for the ${part}`);
        const periods = points.fractals[s.fractal].periods;
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
    // the plan's fractal at its starting view; this also stops a manual note and leaves a Julia set
    api.showFractal(plan.fractal);
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
    restoreManual();
    showBar();
  };

  function stopShow() {
    if (mode === 'off') return;
    transport?.stop();
    mode = 'off';
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

  /** each frame of a playing show: the camera holds the plan's view */
  const frame = () => {
    const c = plan.camera[0];
    const v = {cx: c.centre[0], cy: c.centre[1], span: c.span};
    api.state.view = {...v};
    api.state.dest = {...v};
    api.hideLimit();
    updateBar();
  };

  const drawn = [];

  /** each frame of a playing show: the orbit of every sounding note, at most one a voice; a drum hit fades out */
  const draw = () => {
    const t = transport.now();
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
    for (let k = drawn.length - 1; k >= 0; k--) {
      const p = drawn[k];
      const f = byKey.get(p.fractal);
      const fade = p.part === 'drums' ? Math.max(0, 1 - (t - p.time) / p.duration) : 1;
      api.drawOrbit(f, paramOf(f, {}), p.point, {escape: p.drum === 'kick', fade});
    }
  };

  return {
    playing: () => mode === 'playing',
    interrupt: pause,
    togglePanel,
    closePanel,
    frame,
    draw,
  };
};
