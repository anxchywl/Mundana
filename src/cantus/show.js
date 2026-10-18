// Show mode: the Cantus panel (choose a MIDI file, see its tracks and parts, press Play), the transport bar, and the
// show itself, where the page follows the plan: the camera holds the fractal's starting view and every sounding note
// is drawn as its orbit. main.js loads this module the first time the music button is pressed and calls into it
// through a few small hooks; everything it needs from the page comes in `api`.

import {parseMidi, setTrackPart, MAX_BYTES} from './midi.js?v=24';
import {planShow} from './mapper.js?v=24';
import {Transport} from './scheduler.js?v=24';
import {loadPoints} from './points.js?v=24';
import {paramOf} from '../fractals.js?v=24';

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

  const replan = () => {
    transport = null;
    plan = null;
    try {
      plan = planShow(timeline, {}, points);
    } catch (e) {
      fail(e, 'This song cannot be played.');
    }
    if (plan && !plan.presses.length) {
      api.toast('No melody found in this file. Try giving a track the melody part.');
    }
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
      n.textContent = tr.guessed ? `${count(tr.notes, 'note', 'notes')}, drums by name` : count(tr.notes, 'note', 'notes');
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
        replan();
      });
      const text = document.createElement('span');
      text.className = 'c-track';
      text.append(name, n);
      li.append(text, sel);
      list.appendChild(li);
    });
    const notes = ['Only the melody plays for now, one note at a time.'];
    if (plan?.moved) notes.push(`${count(plan.moved, 'note was', 'notes were')} moved by whole octaves to fit.`);
    if (plan?.skipped) notes.push(`${count(plan.skipped, 'lower note', 'lower notes')} under the melody left out.`);
    if (timeline.dropped) notes.push(`${count(timeline.dropped, 'very short note', 'very short notes')} dropped.`);
    $('#c-notes').textContent = notes.join(' ');
    $('#c-play').disabled = !plan?.presses.length;
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
    // the plan's fractal at its starting view; this also stops a manual note and leaves a Julia set
    api.showFractal(plan.presses[0].fractal);
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

  /** each frame of a playing show: the orbit of every sounding note */
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
    // one voice plays one note at a time, so only the last note to start can be sounding
    if (i < 0 || t >= ps[i].time + ps[i].duration) return;
    const p = ps[i];
    const f = api.fractals.find((x) => x.key === p.fractal);
    api.drawOrbit(f, paramOf(f, {}), p.point);
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
