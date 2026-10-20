// Show mode: the Cantus panel (choose a MIDI file, see its tracks and parts, set the voices, the fractals and each
// part's settings, press Play or Edit notes), the transport bar, the piano roll's link to the show, and the show itself, where the page follows the plan: each frame
// asks the plan for the fractal, the morph and the view at the song time the frame will be on screen, and every
// sounding note is drawn as its orbit. main.js loads this module the first time the music button is pressed and calls
// into it through a few small hooks; everything it needs from the page comes in `api`.

import {parseMidi, setTrackPart, MAX_BYTES} from './midi.js?v=29';
import {validateTimeline, cleanTitle} from './timeline.js?v=29';
import {planShow, settingsOf, pitchedFractals, cameraAt, morphAt, fractalAt, DEFAULTS, MAX_VOICES, MAX_SET, EVERY} from './mapper.js?v=29';
import {Transport} from './scheduler.js?v=29';
import {loadPoints} from './points.js?v=29';
import {paramOf} from '../fractals.js?v=29';
import {initEditor} from './editor.js?v=29';
import {Recorder, support, pickType, estimate, sizeText, fileName, VIDEO_BITS, COUNT_IN_MS} from './record.js?v=29';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const PARTS = [
  ['melody', 'Melody'],
  ['bass', 'Bass'],
  ['chords', 'Chords'],
  ['drums', 'Drums'],
];

/** the running show, for the browser checks and for later phases: `t` is the song time of the last frame, `page` the
 * page's state, `drift` every measured drift in ms, `heard` the report of the last audio file heard ({file, info}),
 * `recorder` the last recording and `saved` its file ({bytes, type, frames, ms}) */
export const live = {plan: null, transport: null, audio: null, drift: [], budget: null, t: 0, page: null, editor: null, heard: null, recorder: null, saved: null};

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
const EDIT_WAIT = 300; // ms without a new edit before the song is planned again
const AUDIO_BYTES = 50 * 1024 * 1024;
const AUDIO_SECONDS = 600;
const AUDIO_RATE = 22050; // the analysis hears the song in mono at this rate
const SILENT = 0.001; // -60 dBFS
const STAGE_NAMES = {
  spectrum: 'Splitting the notes from the drums',
  beats: 'Finding the beat',
  melody: 'Following the melody',
  bass: 'Following the bass',
  chords: 'Hearing the chords',
  drums: 'Finding the drums',
  sections: 'Finding the sections',
  done: 'Writing the notes',
};
const UNREADABLE = 'This file could not be read. It may be damaged, protected, or a type this browser cannot open.';

/** a MIDI file by its name or type; anything else is heard as audio unless its first bytes say MIDI */
const namedMidi = (f) => /\.midi?$/i.test(f.name) || /^audio\/(x-)?midi$/.test(f.type);

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
  let editTimer = 0;
  let cue = 0; // where the song starts when there is no show, set by a click on the editor's ruler
  live.page = api.state;
  const byKey = new Map(api.fractals.map((f) => [f.key, f]));
  const index = new Map(api.fractals.map((f, i) => [f.key, i]));

  const panelOpen = () => panel.classList.contains('open');
  const togglePanel = (open = !panelOpen()) => {
    if (open) api.closeSettings();
    // the estimate follows a range chosen in the editor
    if (open && timeline) renderRecord();
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
    if (!f || work) return;
    let midi = namedMidi(f);
    if (!midi) {
      // checked before anything is read
      if (f.size > AUDIO_BYTES) {
        api.toast('This file is over 50 MB.');
        return;
      }
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      midi = String.fromCharCode(...head) === 'MThd';
    }
    if (!midi) {
      loadAudio(f);
      return;
    }
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
    if (await usePoints()) useSong(t, null);
  });

  const usePoints = async () => {
    try {
      points = await loadPoints();
      return true;
    } catch (e) {
      fail(e, 'The notes could not load. Try again.');
      return false;
    }
  };

  /** a new song in the panel, from a MIDI file or from a recording (`heard` is then the analysis's report) */
  const useSong = (t, heard) => {
    stopShow();
    dropOriginal();
    timeline = t;
    audioSong = heard;
    live.heard = heard;
    cue = 0;
    replan();
    editor.load(timeline);
  };

  // ---------- a song from an audio file ----------

  // the work under way: {worker, cancelled}; the song from a recording: {file, info}
  let work = null;
  let audioSong = null;
  const pick = $('#c-pick');
  const workBox = $('#c-work');
  const stageOut = $('#c-stage');
  const fill = $('#c-fill');

  const showWork = (text, fraction = 0) => {
    pick.hidden = true;
    workBox.hidden = false;
    if (stageOut.textContent !== text) stageOut.textContent = text;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  };
  const endWork = () => {
    work?.worker?.terminate();
    work = null;
    workBox.hidden = true;
    $('#c-ask').hidden = true;
    pick.hidden = false;
  };
  $('#c-cancel').addEventListener('click', () => {
    if (work) work.cancelled = true;
    endWork();
  });

  /** the question about a song over 10 minutes: true to use its first 10 minutes */
  const askLong = () =>
    new Promise((resolve) => {
      workBox.hidden = true;
      const box = $('#c-ask');
      box.hidden = false;
      const answer = (yes) => {
        box.hidden = true;
        $('#c-use').removeEventListener('click', use);
        $('#c-no').removeEventListener('click', no);
        resolve(yes);
      };
      const use = () => answer(true);
      const no = () => answer(false);
      $('#c-use').addEventListener('click', use);
      $('#c-no').addEventListener('click', no);
      $('#c-use').focus();
    });

  /**
   * An audio file: decoded by the browser at 22,050 Hz, mixed down to one channel through an offline context (the
   * first 10 minutes at most), checked for silence, and handed to the analysis worker, which sends back the notes.
   * Nothing leaves the device; the file's bytes and the decoded sound are let go before the worker starts.
   */
  const loadAudio = async (f) => {
    const job = {worker: null, cancelled: false};
    work = job;
    showWork('Reading the file');
    let samples;
    try {
      let bytes = await f.arrayBuffer();
      if (job.cancelled) return;
      let decoded;
      try {
        // an offline context at 22,050 Hz decodes straight to that rate: a 10 minute stereo song then takes 106 MB,
        // not 230 MB at 48 kHz
        decoded = await new OfflineAudioContext(1, 1, AUDIO_RATE).decodeAudioData(bytes);
      } catch {
        decoded = null;
      }
      bytes = null;
      if (job.cancelled) return;
      if (!decoded || !decoded.length) {
        endWork();
        api.toast(UNREADABLE);
        return;
      }
      let length = decoded.length;
      if (decoded.duration > AUDIO_SECONDS) {
        if (!(await askLong()) || job.cancelled) {
          endWork();
          return;
        }
        workBox.hidden = false;
        length = Math.min(length, AUDIO_SECONDS * decoded.sampleRate);
      }
      showWork('Reading the file', 0.01);
      // one channel: the offline context mixes the channels down
      const oc = new OfflineAudioContext(1, Math.round((length * AUDIO_RATE) / decoded.sampleRate), AUDIO_RATE);
      const src = oc.createBufferSource();
      src.buffer = decoded;
      src.connect(oc.destination);
      src.start();
      decoded = null;
      let mono = await oc.startRendering();
      samples = mono.getChannelData(0);
      mono = null;
    } catch (e) {
      if (job.cancelled) return;
      endWork();
      fail(e instanceof RangeError ? new Error('Not enough memory for this song. Try a shorter one.') : e, UNREADABLE);
      return;
    }
    if (job.cancelled) return;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / samples.length) < SILENT) {
      endWork();
      api.toast('This file is silent.');
      return;
    }
    if (!(await usePoints()) || job.cancelled) {
      endWork();
      return;
    }
    let worker;
    try {
      worker = new Worker(new URL('./analyse-worker.js?v=29', import.meta.url), {type: 'module'});
    } catch {
      endWork();
      api.toast('This browser cannot hear songs in the background. Try another browser.');
      return;
    }
    job.worker = worker;
    worker.onmessage = (e) => {
      const m = e.data;
      if (job.cancelled || !m) return;
      if (m.type === 'progress') showWork(STAGE_NAMES[m.stage] || 'Listening', m.fraction);
      else if (m.type === 'error') {
        endWork();
        api.toast(m.message);
      } else if (m.type === 'done') {
        endWork();
        let t;
        try {
          t = validateTimeline({...m.timeline, title: cleanTitle(f.name.replace(/\.[^.]*$/, '')) || 'Untitled'});
        } catch (err) {
          fail(err, 'This song cannot be played.');
          return;
        }
        if (!t.notes.length) {
          api.toast('No notes were heard in this file.');
          return;
        }
        useSong(t, {file: f, info: m.info});
        if (m.info?.drumsOnly) api.toast('Almost nothing in this file has a pitch, so it plays as drums.');
        else if (m.info?.noisy) api.toast('This recording is noisy, so the notes are rough.');
      }
    };
    worker.onerror = () => {
      if (job.cancelled) return;
      endWork();
      api.toast('This song could not be read.');
    };
    showWork(STAGE_NAMES.spectrum, 0.02);
    // transferred, not copied: from here the page holds no copy of the sound
    worker.postMessage({samples, sr: AUDIO_RATE}, [samples.buffer]);
    samples = null;
  };

  // ---------- the recording under the notes ----------

  // off by default. The recording is decoded again, at the sound's own rate, the first time it is turned on; a source
  // plays it from each anchor of the transport (play, seek, a loop wrap), through the page's volume
  const original = {on: false, level: 0.3, buffer: null, source: null, gain: null};
  const origBtn = $('#c-orig');
  const levelIn = $('#c-level');

  const syncOriginal = () => {
    $('#c-orig-row').hidden = !audioSong;
    origBtn.textContent = original.on ? 'On' : 'Off';
    origBtn.setAttribute('aria-pressed', String(original.on));
    // only at normal speed: at any other the recording would drift from the notes
    $('#c-orig-note').hidden = !(audioSong && original.on && transport && transport.speed !== 1);
  };

  const stopOriginal = (at = 0) => {
    const s = original.source;
    original.source = null;
    if (!s) return;
    s.onended = () => s.disconnect();
    try {
      s.stop(at);
    } catch {
      // never started
      s.disconnect();
    }
  };

  const dropOriginal = () => {
    stopOriginal();
    original.buffer = null;
    original.on = false;
    syncOriginal();
  };

  /** the recording from song time anchor.song, at context time anchor.ctx; the one playing before stops there */
  const startOriginal = (anchor) => {
    const a = api.audio();
    if (!original.on || !original.buffer || !original.gain || !a?.ctx || !transport) return;
    if (transport.speed !== 1) {
      stopOriginal();
      syncOriginal();
      return;
    }
    const at = Math.max(a.ctx.currentTime, anchor.ctx);
    stopOriginal(at);
    const src = a.ctx.createBufferSource();
    src.buffer = original.buffer;
    src.connect(original.gain);
    src.start(at, Math.max(0, anchor.song + (at - anchor.ctx)));
    original.source = src;
  };

  origBtn.addEventListener('click', async () => {
    if (original.on) {
      original.on = false;
      stopOriginal();
      syncOriginal();
      return;
    }
    const song = audioSong;
    if (!song?.file) return;
    original.on = true;
    syncOriginal();
    await api.startAudio();
    const a = api.audio();
    if (!a?.ctx || !a.gain) {
      original.on = false;
      syncOriginal();
      return;
    }
    if (!original.gain || original.gain.context !== a.ctx) {
      original.gain = a.ctx.createGain();
      original.gain.gain.value = original.level;
      original.gain.connect(a.gain);
    }
    if (!original.buffer) {
      try {
        const buffer = await a.ctx.decodeAudioData(await song.file.arrayBuffer());
        if (audioSong !== song) return;
        original.buffer = buffer;
      } catch {
        original.on = false;
        syncOriginal();
        api.toast('The original audio could not be read.');
        return;
      }
    }
    if (!original.on || mode !== 'playing' || !transport) return;
    // a song playing now: the recording joins it a moment from now, and follows any loop wrap already sent
    const at = a.ctx.currentTime + 0.05;
    startOriginal({ctx: at, song: transport.songAt(at)});
    for (const anchor of transport.anchors) if (anchor.ctx > at) startOriginal(anchor);
  });

  levelIn.addEventListener('input', () => {
    original.level = Number(levelIn.value) / 100;
    if (original.gain) original.gain.gain.setTargetAtTime(original.level, original.gain.context.currentTime, 0.02);
  });

  const replan = (announce = true) => {
    clearTimeout(editTimer);
    editTimer = 0;
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
    $('#c-meta').textContent = audioSong
      ? `${clock(timeline.duration)}, ${count(timeline.notes.length, 'note', 'notes')} heard, about ${Math.round(timeline.tempo.bpm)} beats a minute`
      : `${clock(timeline.duration)}, ${count(timeline.notes.length, 'note', 'notes')} found`;
    syncOriginal();
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
        editor.replace(timeline);
      });
      const text = document.createElement('span');
      text.className = 'c-track';
      text.append(name, n);
      li.append(text, sel);
      list.appendChild(li);
    });
    renderParts();
    const notes = [];
    if (audioSong) {
      notes.push('Notes heard in a recording are approximate: good for a solo instrument or a clear voice, decent for the melody and bass of a band, rough for the chords of a dense mix.');
      if (audioSong.info?.drumsOnly) notes.push('Almost nothing in it has a pitch, so it plays as drums.');
      else if (audioSong.info?.noisy) notes.push('This recording is noisy, so the notes are rough.');
    }
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
    renderRecord();
  };

  /**
   * The notes were edited: plan again from the new timeline. A show keeps going: the transport takes the new plan
   * at its next wake, and the picture follows the new plan from its next frame.
   */
  const replanLive = () => {
    clearTimeout(editTimer);
    editTimer = 0;
    let next;
    try {
      next = planShow(timeline, settings, points, {reducedMotion: api.reducedMotion()});
    } catch (e) {
      fail(e, 'This song cannot be played.');
      return;
    }
    plan = next;
    longest = plan.presses.reduce((m, p) => Math.max(m, p.duration), 0);
    live.plan = plan;
    if (transport) {
      transport.setPlan(plan);
      seek.max = String(transport.duration);
      updateBar(true);
    }
    renderSong();
    prepare();
  };
  const flushEdits = () => editTimer && replanLive();

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
        where.textContent = settings.layout === 'one' ? 'On the fractal on screen' : 'Fractal on screen';
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
    if (rec) return showRecording(force);
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
      transport = new Transport({ctx: a.ctx, send: api.send, plan, onEnd: () => stopShow(), onAnchor: (anchor) => startOriginal(anchor)});
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
    flushEdits();
    if (!plan?.presses.length) return;
    transport?.stop();
    // the whole song: a range chosen in the editor is let go
    editor.setRange(null);
    togglePanel(false);
    if (await begin()) transport.play();
  };

  const resume = async () => {
    if (mode !== 'paused' || !transport) return;
    flushEdits();
    if (await begin()) transport.play();
  };

  const pause = () => {
    if (mode !== 'playing' || rec) return;
    transport.pause();
    stopOriginal();
    mode = 'paused';
    endPicture();
    restoreManual();
    showBar();
  };

  function stopShow() {
    if (rec) finishRecording();
    if (mode === 'off') return;
    transport?.stop();
    stopOriginal();
    mode = 'off';
    endPicture();
    restoreManual();
    showBar();
  }

  /** from the editor: play from a, looping to b; with no range, play on from where the song is */
  const playRange = async (a, b) => {
    flushEdits();
    if (!plan?.presses.length || mode === 'playing') return;
    const from = a ?? (mode === 'paused' && transport ? transport.pos : cue);
    if (!(await begin())) return;
    transport.setLoop(null);
    if (a !== null && b !== null) transport.setLoop(a, b);
    transport.seek(from);
    transport.play();
    showBar();
  };

  const editor = initEditor({
    timeline: () => timeline,
    plan: () => plan,
    commit: (t) => {
      timeline = t;
      clearTimeout(editTimer);
      editTimer = setTimeout(replanLive, EDIT_WAIT);
    },
    playing: () => mode === 'playing',
    songTime: (now) => (!transport || mode === 'off' ? cue : mode === 'playing' ? transport.songAtWall(now + 16.7) : transport.pos),
    playRange,
    pause: () => pause(),
    seek: (t) => {
      if (transport && mode !== 'off') {
        transport.seek(t);
        updateBar(true);
      } else cue = t;
    },
    setLoop: (a, b) => {
      if (!transport) return;
      if (a === null) transport.setLoop(null);
      else {
        try {
          transport.setLoop(a, b);
        } catch {
          // shorter than a quarter of a second once held inside the song: no loop
          transport.setLoop(null);
        }
      }
    },
    opened: (open) => {
      if (open) togglePanel(false);
      api.dimForSheets();
    },
  });
  live.editor = editor;
  $('#c-edit').addEventListener('click', () => editor.open());

  playBtn.addEventListener('click', () => (mode === 'playing' ? pause() : resume()));
  $('#c-record').addEventListener('click', () => startRecording());
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

  // ---------- recording the show as a video ----------

  const recType = pickType();
  let rec = null; // {recorder, from, to, counting}

  /** the panel's line: the size a recording would take, or why there is none; with #debug=1, what this browser can do */
  const renderRecord = () => {
    const btn = $('#c-record');
    const note = $('#c-rec-note');
    btn.disabled = !recType || !plan?.presses.length || !!rec;
    if (!recType) note.textContent = 'Video recording is not supported in this browser. Try Chrome or Safari.';
    else {
      const range = editor.range();
      const seconds = range ? range.b - range.a : timeline?.duration || 0;
      note.textContent = `Recording takes the song in real time: about ${sizeText(estimate(seconds))} for ${clock(seconds)}, at ${VIDEO_BITS / 1e6} Mbps.`;
    }
    note.hidden = !timeline;
    const box = $('#c-rec-support');
    box.hidden = !api.debugOn;
    if (api.debugOn) {
      const s = support();
      box.textContent = [
        `captureStream ${s.captureStream ? 'yes' : 'no'}, requestFrame ${s.requestFrame ? 'yes' : 'no'}, MediaRecorder ${s.mediaRecorder ? 'yes' : 'no'}`,
        ...s.types.map(([t, ok]) => `${ok ? 'yes' : 'no'}  ${t}`),
        `records as ${recType || 'nothing'}`,
      ].join('\n');
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Record video: from the start (or the start of the range chosen in the editor), after a count in of a second, the
   * show plays in real time to the end (or the range's end) and is saved. Stop saves what there is so far.
   */
  const startRecording = async () => {
    flushEdits();
    if (!recType || !plan?.presses.length || rec) return;
    const range = editor.range();
    const from = range ? range.a : 0;
    const to = range ? range.b : transport?.duration || timeline.duration;
    togglePanel(false);
    editor.close();
    transport?.stop();
    if (!(await begin())) return;
    transport.setLoop(null);
    transport.seek(from);
    const a = api.audio();
    const c = api.canvases();
    let recorder;
    try {
      recorder = new Recorder({
        fractal: c.fractal,
        overlay: c.overlay,
        ctx: a.ctx,
        gain: a.gain,
        title: timeline.title,
        type: recType,
        stageW: c.W,
        stageH: c.H,
        dpr: window.devicePixelRatio || 1,
        paper: getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim(),
      });
    } catch (e) {
      console.warn(e);
      stopShow();
      api.toast('The video could not start recording.');
      return;
    }
    rec = {recorder, from, to, counting: true};
    live.recorder = recorder;
    bar.classList.add('recording');
    playBtn.disabled = true;
    seek.disabled = true;
    renderRecord();
    timeOut.textContent = 'Recording in 1';
    await sleep(COUNT_IN_MS);
    if (rec?.recorder !== recorder) return;
    rec.counting = false;
    recorder.start();
    transport.play();
  };

  /** the elapsed time and the size so far, in the transport bar */
  let recText = '';
  const showRecording = (force) => {
    if (rec.counting) return;
    const text = `${clock(transport.now() - rec.from)}, ${sizeText(rec.recorder.bytes)}`;
    if (force || text !== recText) timeOut.textContent = recText = text;
  };

  /** the recording ends: the file is built and saved, and everything it held is let go */
  async function finishRecording(message) {
    const r = rec;
    if (!r) return;
    rec = null;
    bar.classList.remove('recording');
    playBtn.disabled = false;
    seek.disabled = false;
    if (r.counting) {
      r.recorder.release();
      renderRecord();
      return;
    }
    const blob = await r.recorder.stop();
    live.saved = {bytes: blob.size, type: blob.type, frames: r.recorder.frames, ms: performance.now() - r.recorder.started};
    const url = URL.createObjectURL(blob);
    api.download(url, fileName(timeline?.title, recType));
    // the download has its own copy once it starts
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    renderRecord();
    api.toast(message || `Video saved, ${sizeText(blob.size)}.`);
  }

  /** after each frame of the page: the picture into the recording, and the end of a range */
  const afterFrame = () => {
    if (!rec || rec.counting || mode !== 'playing') return;
    rec.recorder.frame();
    if (transport.now() >= rec.to - 1e-6 && rec.to < transport.duration) stopShow();
  };

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
    // on screen a frame is seen one interval after it is drawn; a recording takes it as it is drawn
    const t = transport.songAtWall(rec && !rec.counting ? now : now + interval);
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
    recording: () => !!rec,
    afterFrame,
    /** the page interrupts the show; while recording only a hidden tab counts, and it saves what was recorded */
    interrupt: (reason) => {
      if (!rec) return pause();
      if (reason !== 'hidden') return;
      finishRecording('Recording stopped because the tab was hidden.');
      stopShow();
    },
    togglePanel,
    closePanel,
    editorOpen: () => editor.isOpen(),
    frame,
    draw,
    drift,
    // the GPU came back with no programs: build them again
    restored: prepare,
  };
};
