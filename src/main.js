import {fractals, families, analyse, noteName, orbitOf, paramOf, RATE, ESCAPE_SQ, clampRate} from './fractals.js?v=25';
import {spots} from './spots.js?v=25';
import {Renderer, MAX_FRAMES} from './renderer.js?v=25';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stage = $('#stage');
const glCanvas = $('#fractal');
const overlay = $('#overlay');
const ctx2d = overlay.getContext('2d');

const ITERS_MOVING = 220;
// a morph steps two formulas at once, so it gets its own budget, lowered on a device that cannot keep up
const MORPH_ITERS = 420;
let morphIters = MORPH_ITERS;
// float32 runs out of digits below this span, see renderer.js
const MIN_SPAN = 6e-5;
const MAX_SPAN = 60;
const COLOUR_NAMES = ['Plain', 'Tones', 'Vivid'];

const state = {
  type: 0,
  view: {...fractals[0].view},
  dest: {...fractals[0].view},
  params: {}, // slider values the user has moved, by fractal key
  julia: null, // the fixed c of a Julia set, or null for the fractal itself
  picking: false, // choosing c for a Julia set: both pictures are drawn, blended
  colour: 0, // 0 plain engraving, 1 muted orbit tones, 2 vivid colours
  sustain: false, // dampening on by default, so notes ring and fade like an instrument
  animate: false, // slow motion: the path is replayed a step at a time
  traceStart: 0,
  traceHold: 0,
  point: null, // where the user last played, in plane units
  playing: false,
  playedAt: 0,
  info: null,
  shared: false,
  volume: 0.7,
  rate: RATE,
  iters: 1000,
  panTool: false,
  morph: null, // a switch in progress: {from, fromParam, t0, viewFrom}
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MORPH_MS = reducedMotion ? 0 : 1700;
const desktop = () => window.matchMedia('(min-width: 761px)').matches;

const cur = () => fractals[state.type];
const kOf = () => paramOf(cur(), state.params);

// ---------- view ----------

let W = 0;
let H = 0;
let renderer;
try {
  renderer = new Renderer(glCanvas);
} catch (e) {
  $('#nogl').hidden = false;
  throw e;
}

let frame = 0;
let settling = false;

const resize = () => {
  const r = stage.getBoundingClientRect();
  W = r.width;
  H = r.height;
  // capped at about 2.2 million pixels so the slowest maps (Chirikov with orbit tones, about 45 ns a pixel on an
  // M3) still redraw several times a second on a big monitor
  renderer.resize(W, H, Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2.2e6 / (W * H))));
  const k = window.devicePixelRatio || 1;
  overlay.width = Math.round(W * k);
  overlay.height = Math.round(H * k);
  ctx2d.setTransform(k, 0, 0, k, 0, 0);
  frame = 0;
};

// span is the view's size across the shorter side of the screen, so every fractal fits on a phone held upright
const M = () => Math.min(W, H);
const toPlane = (sx, sy, v = state.view) => [v.cx + ((sx - W / 2) / M()) * v.span, v.cy + ((sy - H / 2) / M()) * v.span];
const toScreen = (x, y, v = state.view) => [W / 2 + ((x - v.cx) / v.span) * M(), H / 2 + ((y - v.cy) / v.span) * M()];

/** zoom the destination view by factor f, keeping the plane point under (sx, sy) fixed */
const zoomAt = (sx, sy, f) => {
  const d = state.dest;
  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, d.span / f));
  const [px, py] = toPlane(sx, sy, d);
  d.cx = px - ((sx - W / 2) / M()) * span;
  d.cy = py - ((sy - H / 2) / M()) * span;
  d.span = span;
  $('#limit').hidden = span > MIN_SPAN * 1.01;
  saveHash();
};

const panBy = (dxPx, dyPx) => {
  const s = state.dest.span / M();
  state.dest.cx -= dxPx * s;
  state.dest.cy -= dyPx * s;
  state.view.cx -= dxPx * s;
  state.view.cy -= dyPx * s;
  saveHash();
};

// ---------- song mode: hooks ----------

// Cantus, the song mode (src/cantus/show.js), loads the first time the music button is pressed. Until then these
// hooks do nothing, so manual playing runs exactly the same code as before.
let cantus = null;
let cantusLoading = null;
let showSwitching = false; // the show itself is switching fractal, so it does not pause
const interruptShow = () => cantus?.interrupt();

// ---------- sound ----------

let audio = null;
const pending = [];
const send = (m) => (audio?.node ? audio.node.port.postMessage(m) : pending.push(m));
const workletURL = new URL('./synth-worklet.js?v=25', import.meta.url);

const setupMessages = () => [
  {type: 'fractal', index: state.type, param: kOf()},
  {type: 'julia', c: state.julia},
  {type: 'sustain', on: state.sustain},
  {type: 'rate', value: state.rate},
];

let audioFailed = false;
const startAudio = async () => {
  if (audio) {
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    return;
  }
  if (audioFailed || !window.AudioContext || !window.AudioWorkletNode) {
    if (!audioFailed) toast('Sound is not supported in this browser. The pictures still work.');
    audioFailed = true;
    return;
  }
  let ac;
  try {
    ac = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
  } catch {
    ac = new AudioContext({latencyHint: 'interactive'});
  }
  audio = {ctx: ac, node: null};
  try {
    const gain = ac.createGain();
    gain.gain.value = state.volume;
    audio.gain = gain;
    gain.connect(ac.destination);
    await ac.audioWorklet.addModule(workletURL);
    const node = new AudioWorkletNode(ac, 'orbit-synth', {numberOfInputs: 0, outputChannelCount: [2]});
    node.connect(gain);
    node.port.onmessage = (e) => {
      if (e.data?.type === 'escaped') state.playing = false;
    };
    // only the latest state matters: the queued setup messages are replaced by the current ones, points are kept
    for (const m of setupMessages()) node.port.postMessage(m);
    for (const m of pending.splice(0)) if (m.type === 'point' || m.type === 'stop') node.port.postMessage(m);
    audio.node = node;
    if (ac.state !== 'running') ac.resume().catch(() => {});
  } catch {
    // usually a page opened as a file, where the audio module cannot load
    ac.close().catch(() => {});
    audio = null;
    pending.length = 0;
    toast('Sound could not start. Open the page over http or https.');
  }
};

// a hidden tab keeps no audio thread awake
document.addEventListener('visibilitychange', () => {
  if (!audio) return;
  if (document.hidden) interruptShow();
  if (document.hidden) audio.ctx.suspend().catch(() => {});
  else if (state.playing) audio.ctx.resume().catch(() => {});
});

// the readout analysis runs up to 8,000 steps, so a fast drag asks for it at most once a frame
let analyseQueued = false;
const analyseSoon = () => {
  if (analyseQueued) return;
  analyseQueued = true;
  requestAnimationFrame(() => {
    analyseQueued = false;
    if (!state.point) return;
    const {z0, c} = orbitOf(cur(), state.point, state.julia);
    state.info = analyse(cur(), z0, c, kOf());
    showReadout();
  });
};

const play = (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  state.point = [x, y];
  state.traceStart = performance.now();
  state.traceHold = 0;
  state.playing = true;
  state.playedAt = performance.now();
  send({type: 'point', p: [x, y]});
  if (!state.info) {
    const {z0, c} = orbitOf(cur(), state.point, state.julia);
    state.info = analyse(cur(), z0, c, kOf());
    showReadout();
  } else analyseSoon();
  $('#hint').classList.add('gone');
  saveHash();
};

const stop = () => {
  state.playing = false;
  state.point = null;
  state.info = null;
  send({type: 'stop'});
  showReadout();
  saveHash();
};

// ---------- fractal and modes ----------

const setFractal = (i, keepView = false, morph = true) => {
  if (!showSwitching) interruptShow();
  const next = (i + fractals.length) % fractals.length;
  // morph from what is on screen now; a switch during a switch starts from the fractal it was heading to
  if (morph && MORPH_MS > 0 && next !== state.type && !keepView) {
    state.morph = {from: state.type, fromParam: kOf(), t0: 0, viewFrom: {...state.view}};
  }
  state.type = next;
  if (state.morph) {
    // compile the blended program first, so its cost is not taken out of the animation
    try {
      renderer.program(fractals[state.morph.from], cur());
    } catch {
      state.morph = null;
    }
    if (state.morph) state.morph.t0 = performance.now();
    morphIters = MORPH_ITERS;
  }
  state.julia = null;
  state.picking = false;
  if (!keepView) {
    state.dest = {...cur().view};
    if (!state.morph) state.view = {...cur().view};
    $('#limit').hidden = true;
  }
  send({type: 'fractal', index: state.type, param: kOf()});
  send({type: 'julia', c: null});
  stop();
  frame = 0;
  renderParam();
  syncUI();
  saveHash();
};

const setParam = (v) => {
  state.params[cur().key] = v;
  send({type: 'param', value: v});
  $$('.param-value').forEach((o) => (o.textContent = v.toFixed(decimals(cur().param.step))));
  $$('.param-range').forEach((r) => (r.value = v));
  if (state.point && state.playing) play(...state.point);
  saveHash();
};

const decimals = (step) => Math.max(0, Math.ceil(-Math.log10(step)));

const setJulia = (c) => {
  interruptShow();
  state.julia = c;
  send({type: 'julia', c});
  frame = 0;
};

const toggleJulia = () => {
  if (cur().noJulia) {
    toast(`${cur().name} has no Julia sets.`);
    return;
  }
  if (state.julia && !state.picking) {
    setJulia(null);
    stop();
  } else if (state.picking) {
    state.picking = false;
  } else {
    // pick mode: drag across the picture to choose c; both pictures show, blended, until you let go
    state.picking = true;
    setJulia(state.point ? [...state.point] : toPlane(W / 2, H / 2));
    stop();
    toast('Drag across the picture to pick a Julia set, then let go.');
  }
  syncUI();
  saveHash();
};

const reset = () => {
  state.dest = {...cur().view};
  $('#limit').hidden = true;
  saveHash();
};

const setColour = (c) => {
  state.colour = c;
  syncUI();
  saveHash();
};

/** fly to a point if it is off screen, then play it */
const goTo = (p) => {
  const [sx, sy] = toScreen(p[0], p[1], state.dest);
  const margin = 80;
  if (sx < margin || sy < margin || sx > W - margin || sy > H - margin) {
    state.dest.cx = p[0];
    state.dest.cy = p[1];
  }
  startAudio();
  play(...p);
};

// ---------- files: picture, sound, link ----------

const download = (href, name) => {
  const a = document.createElement('a');
  a.download = name;
  a.href = href;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const snapshot = () => {
  // a fresh full-depth frame, so the saved image is the sharp one
  renderer.draw(drawState(true), 0);
  // the picture and the orbit path live on two canvases; the saved image has both, at the larger of their sizes
  const scale = Math.max(1, overlay.width / glCanvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(glCanvas.width * scale);
  out.height = Math.round(glCanvas.height * scale);
  const g = out.getContext('2d');
  g.drawImage(glCanvas, 0, 0, out.width, out.height);
  drawOverlay(performance.now());
  g.drawImage(overlay, 0, 0, out.width, out.height);
  download(out.toDataURL('image/png'), `${cur().key}-${Date.now()}.png`);
  frame = 0;
};

const spotName = () => {
  const i = state.info;
  if (!i) return 'sound';
  if (i.kind === 'cycle' && i.period > 1) return `period${i.period}`;
  return i.kind;
};

/** render the current point offline with the same worklet, and save it as a 16-bit stereo WAV */
let saving = false;
const saveSound = async () => {
  if (!state.point) {
    toast('Play a point first, then save it.');
    return;
  }
  if (saving) return;
  if (!window.OfflineAudioContext || !window.AudioWorkletNode) {
    toast('This browser cannot save the sound.');
    return;
  }
  saving = true;
  try {
    await renderWav();
  } catch {
    toast('The sound could not be saved.');
  } finally {
    saving = false;
  }
};

const renderWav = async () => {
  toast('Saving the sound…');
  const seconds = state.sustain ? 4 : 3;
  const sr = 48000;
  const oc = new OfflineAudioContext(2, sr * seconds, sr);
  await oc.audioWorklet.addModule(workletURL);
  const node = new AudioWorkletNode(oc, 'orbit-synth', {numberOfInputs: 0, outputChannelCount: [2]});
  node.connect(oc.destination);
  for (const m of setupMessages()) node.port.postMessage(m);
  node.port.postMessage({type: 'point', p: state.point});
  // messages reach the audio thread asynchronously; give them a moment before rendering starts
  await new Promise((r) => setTimeout(r, 60));
  const buf = await oc.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let peak = 1e-9;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak < 1e-4) {
    toast('This point is silent. Try one that plays a note.');
    return;
  }
  // normalised to -1 dB, with a short fade at the end so it cuts cleanly
  const g = 0.89 / peak;
  const n = L.length;
  const fade = Math.round(sr * 0.03);
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, sr, true);
  data.setUint32(28, sr * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const f = i > n - fade ? (n - i) / fade : 1;
    data.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i] * g * f)) * 32767, true);
    data.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i] * g * f)) * 32767, true);
  }
  const url = URL.createObjectURL(new Blob([data], {type: 'audio/wav'}));
  download(url, `${cur().key}-${spotName()}.wav`);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Sound saved as a WAV file.');
};

const copyLink = async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied. It opens exactly this view.');
  } catch {
    toast('Copy the address bar to share this view.');
  }
};

let toastTimer = 0;
const hideToast = () => {
  $('#toast').classList.remove('show');
  document.body.classList.remove('toasting');
};
const toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  // on a phone the message takes the name card's exact place while the card steps aside
  if (!desktop()) {
    const r = $('.info').getBoundingClientRect();
    t.style.top = `${r.top}px`;
    t.style.minHeight = `${r.height}px`;
    document.body.classList.add('toasting');
  } else {
    t.style.top = '';
    t.style.minHeight = '';
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  // longer messages stay up longer
  toastTimer = setTimeout(hideToast, Math.min(5000, 1800 + msg.length * 45));
};
$('#toast').addEventListener('click', hideToast);

// ---------- readout ----------

const fmt = (v) => {
  const d = Math.max(4, Math.min(12, Math.ceil(-Math.log10(state.view.span)) + 4));
  return (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
};

const pitchOf = (period) => {
  const hz = state.rate / period;
  const n = noteName(hz);
  const cents = n.cents === 0 ? '' : ` ${n.cents > 0 ? '+' : '−'}${Math.abs(n.cents)}¢`;
  return {hz, name: n.name, cents};
};

const showReadout = () => {
  const el = $('#readout');
  el.hidden = !state.point;
  if (!state.point) return;
  const [x, y] = state.point;
  $('#r-point').textContent = `${state.julia ? 'z₀' : 'c'} = ${fmt(x)}, ${fmt(y)}`;
  const info = state.info;
  el.classList.toggle('escaped', info.kind === 'escape');
  if (info.kind === 'escape') {
    $('#r-what').textContent = `Escapes after ${info.steps.toLocaleString('en')} steps`;
    $('#r-note').textContent = 'a click, then silence';
  } else if (info.kind === 'cycle' && info.period === 1) {
    $('#r-what').textContent = 'Period 1';
    $('#r-note').textContent = 'a still point, no pitch';
  } else if (info.kind === 'cycle') {
    const p = pitchOf(info.period);
    $('#r-what').textContent = `Period ${info.period}`;
    $('#r-note').textContent = p.hz >= 20 ? `${p.hz.toFixed(p.hz < 100 ? 1 : 0)} Hz, ${p.name}${p.cents}` : `${p.hz.toFixed(2)} Hz, a rhythm`;
  } else {
    $('#r-what').textContent = 'Chaos';
    $('#r-note').textContent = 'noise, no steady note';
  }
  if (desktop()) fitLine($('#r-what'));
  else $('#r-what').style.fontSize = '';
  if (desktop()) fitLine($('#r-note'));
  else $('#r-note').style.fontSize = '';
};

// ---------- the side panel: slider and spots ----------

const renderParam = () => {
  const f = cur();
  $$('.param').forEach((el) => (el.hidden = !f.param));
  if (!f.param) return;
  $$('.param-range').forEach((r) => {
    Object.assign(r, {min: f.param.min, max: f.param.max, step: f.param.step});
    r.value = kOf();
  });
  $$('.param-name').forEach((o) => (o.textContent = f.param.name));
  $$('.param-value').forEach((o) => (o.textContent = kOf().toFixed(decimals(f.param.step))));
};

const playSpot = (i) => {
  const s = (spots[cur().key] || [])[i];
  const f = cur();
  if (!s || (f.param && Math.abs(kOf() - f.param.value) > 1e-9)) return;
  if (state.julia) {
    setJulia(null);
    syncUI();
  }
  goTo(s.p);
};

// ---------- gallery ----------

let thumbs = null;

const pick = (i) => {
  setFractal(i);
  toggleGallery(false);
};

// prepare the morph program for a card the pointer rests on, while the browser is idle, so picking it starts without
// a stutter and moving across the grid never freezes the page
let warmTimer = 0;
const warm = (i) => {
  clearTimeout(warmTimer);
  if (i === state.type) return;
  warmTimer = setTimeout(() => {
    const go = () => {
      try {
        renderer.program(cur(), fractals[i]);
      } catch {
        // a failed compile shows up properly when the switch itself draws
      }
    };
    if (window.requestIdleCallback) requestIdleCallback(go, {timeout: 500});
    else go();
  }, 180);
};

const buildGallery = () => {
  const body = $('#gallery-body');
  body.innerHTML = '';
  for (const fam of families) {
    const sec = document.createElement('section');
    sec.className = 'fam';
    sec.style.viewTransitionName = `fam-${fam.key}`;
    const h = document.createElement('h3');
    h.textContent = fam.name;
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'cards';
    fractals.forEach((f, i) => {
      if (f.family !== fam.key) return;
      const b = document.createElement('button');
      b.className = 'card-f';
      b.dataset.index = i;
      b.dataset.search = `${f.name} ${f.formula} ${fam.name}`.toLowerCase();
      // built from text nodes, never from HTML strings
      const thumb = document.createElement('span');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.key = f.key;
      thumb.appendChild(img);
      const name = document.createElement('span');
      name.className = 'cname fit';
      name.textContent = f.name;
      const formula = document.createElement('span');
      formula.className = 'cformula fit';
      formula.textContent = f.formula;
      b.append(thumb, name, formula);
      b.style.viewTransitionName = `card-${f.key}`;
      b.addEventListener('click', () => pick(i));
      b.addEventListener('pointerenter', () => warm(i));
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    body.appendChild(sec);
  }
};

const filterGallery = (q) => {
  // where the browser can, the change animates: cards glide to their new places and fade in or out
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(() => applyFilter(q));
  } else applyFilter(q);
};
const applyFilter = (q) => {
  q = q.trim().toLowerCase();
  for (const c of $$('.card-f')) c.hidden = q !== '' && !c.dataset.search.includes(q);
  for (const f of $$('.fam')) f.hidden = !f.querySelector('.card-f:not([hidden])');
};

/** small pictures of every fractal, drawn one per frame by a second, offscreen renderer */
const makeThumbs = () => {
  if (thumbs) return;
  thumbs = {};
  let r;
  try {
    r = new Renderer(document.createElement('canvas'));
  } catch {
    return;
  }
  r.resize(360, 240, 1);
  let i = 0;
  const next = () => {
    if (i >= fractals.length) {
      r.gl.getExtension('WEBGL_lose_context')?.loseContext();
      return;
    }
    const f = fractals[i++];
    const v = f.view;
    // the thumbnail frames the same view as the full screen, fitted to its shorter side
    r.draw({fractal: f, cx: v.cx, cy: v.cy, span: v.span, param: f.param ? f.param.value : 0, iters: 500, drawM: true, drawJ: false, julia: null, colour: 0}, 0);
    thumbs[f.key] = r.canvas.toDataURL('image/jpeg', 0.82);
    $$(`img[data-key="${f.key}"]`).forEach((img) => (img.src = thumbs[f.key]));
    setTimeout(next, 16);
  };
  next();
};

const galleryOpen = () => $('#gallery').classList.contains('open');
const toggleGallery = (open = !galleryOpen()) => {
  if (open) interruptShow();
  $('#gallery').classList.toggle('open', open);
  dimForSheets();
  if (!open) return;
  requestAnimationFrame(fitAll);
  makeThumbs();
  closeSettings();
  $$('.card-f').forEach((c) => c.classList.toggle('on', Number(c.dataset.index) === state.type));
  $('.card-f.on')?.scrollIntoView({block: 'center'});
  if (desktop()) $('#g-search').focus();
};

// ---------- drawing ----------

let last = performance.now();
let lastKey = '';
let landed = false;
// after a morph, the full-depth picture crossfades in over this many frames, ending fully replaced
const LAND_STEPS = 12;
let landStep = 0;

// a sine ease: it leaves and lands softly, and never rushes through the middle
const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

const drawState = (full = false) => ({
  // while morphing, the picture is the old fractal's formula blending into the new one's
  fractal: state.morph ? fractals[state.morph.from] : cur(),
  morph: state.morph ? {to: cur(), param: kOf(), t: state.morph.e} : null,
  cx: state.view.cx,
  cy: state.view.cy,
  span: state.view.span,
  param: state.morph ? state.morph.fromParam : kOf(),
  iters: state.morph ? Math.min(morphIters, state.iters) : !full && frame === 0 && settling ? Math.min(ITERS_MOVING, state.iters) : state.iters,
  drawM: !state.julia || state.picking,
  drawJ: !!state.julia,
  julia: state.julia,
  colour: state.colour,
});

// overlay colours live here, not in CSS variables, so the path never falls back to black if the stylesheet changes
const ink = {
  blue: '#5ab4dc', // an orbit that stays: a note or chaos
  red: '#e0606f', // an orbit that escapes: a click, then silence
  paper: '#f7f1e9',
  stone: '#a29c98',
  ground: '#0b0b0c',
};

const ring = (x, y, r, col, a) => {
  ctx2d.save();
  ctx2d.globalAlpha = a;
  ctx2d.setLineDash([4.5, 3.2]);
  ctx2d.lineWidth = 1.5;
  ctx2d.strokeStyle = col;
  ctx2d.beginPath();
  ctx2d.arc(x, y, r, 0, Math.PI * 2);
  ctx2d.stroke();
  ctx2d.restore();
};

const dot = (x, y, r, col) => {
  ctx2d.fillStyle = col;
  ctx2d.beginPath();
  ctx2d.arc(x, y, r, 0, Math.PI * 2);
  ctx2d.fill();
};

/** a point's orbit on screen: from where the orbit starts, so the spiral into its cycle (the star) stays on screen,
 * for 200 steps or until it escapes */
const orbitPath = (f, k, point, julia) => {
  const {z0, c} = orbitOf(f, point, julia);
  const out = [0, 0];
  let [x, y] = z0;
  const pts = [toScreen(x, y)];
  for (let i = 0; i < 200; i++) {
    f.step(x, y, c[0], c[1], out, k);
    x = out[0];
    y = out[1];
    const [sx, sy] = toScreen(x, y);
    pts.push([Math.max(-1e4, Math.min(1e4, sx)), Math.max(-1e4, Math.min(1e4, sy))]);
    if (!(x * x + y * y <= ESCAPE_SQ)) break;
  }
  return pts;
};

/** the path up to point `shown`, in a colour over a keyline */
const strokeOrbit = (pts, shown, fade, colour) => {
  const path = () => {
    ctx2d.beginPath();
    ctx2d.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= shown; i++) ctx2d.lineTo(pts[i][0], pts[i][1]);
  };
  ctx2d.lineJoin = 'round';
  ctx2d.lineCap = 'round';
  // a keyline in the ground colour under the path, so it reads over light orbit colours as well as dark ground
  ctx2d.globalAlpha = 0.55 * fade;
  ctx2d.lineWidth = 4;
  ctx2d.strokeStyle = ink.ground;
  path();
  ctx2d.stroke();
  ctx2d.globalAlpha = fade;
  ctx2d.lineWidth = 2;
  ctx2d.strokeStyle = colour;
  path();
  ctx2d.stroke();
};

/** the pressed point: a dashed ring around a dot */
const markPoint = (p, colour, alpha = 1) => {
  const [px, py] = toScreen(p[0], p[1]);
  ring(px, py, 14, ink.stone, 0.75 * alpha);
  dot(px, py, 3.5, colour);
};

/** a sounding orbit of a song: the whole path and its point, in blue, or red for an orbit that escapes (a kick) */
const drawOrbit = (f, k, point, {escape = false, fade = 1} = {}) => {
  const colour = escape ? ink.red : ink.blue;
  const pts = orbitPath(f, k, point, null);
  strokeOrbit(pts, pts.length - 1, fade, colour);
  ctx2d.globalAlpha = fade;
  markPoint(point, colour, fade);
  ctx2d.globalAlpha = 1;
};

const drawOverlay = (now) => {
  ctx2d.clearRect(0, 0, W, H);
  if (state.julia && (state.picking || !state.point)) {
    // the chosen c, as a dashed ring
    const [sx, sy] = toScreen(state.julia[0], state.julia[1]);
    ring(sx, sy, 14, ink.stone, 0.75);
    dot(sx, sy, 3, ink.paper);
  }
  if (cantus?.playing()) {
    cantus.draw(now);
    return;
  }
  if (!state.point) return;
  // with dampening on, the drawn orbit dims as the note dies, but never so far that it cannot be read
  const age = (now - state.playedAt) / 1000;
  const fade = !state.playing || state.sustain ? 1 : Math.max(0.55, Math.pow(0.9992, age * state.rate));
  const pts = orbitPath(cur(), kOf(), state.point, state.julia);
  // slow motion: the orbit replays a step at a time, from about 4 steps a second and speeding up, then pauses and
  // starts over. You can watch it settle into the cycle you hear, and count its period on the step counter
  let shown = pts.length - 1;
  let frac = 0;
  if (state.animate) {
    // the frame clock can run a few ms behind the press, so time never goes below zero
    const t = Math.max(0, (now - state.traceStart) / 1000);
    const nf = 4 * t + 3 * t * t;
    const n = Math.floor(nf);
    frac = nf - n;
    if (n >= shown) {
      frac = 0;
      if (!state.traceHold) state.traceHold = now;
      else if (now - state.traceHold > 1500) {
        state.traceStart = now;
        state.traceHold = 0;
      }
    } else shown = n;
  }
  const escapes = state.info?.kind === 'escape';
  strokeOrbit(pts, shown, fade, escapes ? ink.red : ink.blue);
  if (state.animate) {
    // the hop in progress is drawn bright, and the point glides along it with its step number
    const [ax, ay] = pts[shown];
    const [bx, by] = pts[Math.min(shown + 1, pts.length - 1)];
    const hx = ax + (bx - ax) * frac;
    const hy = ay + (by - ay) * frac;
    ctx2d.globalAlpha = 1;
    ctx2d.lineWidth = 3;
    ctx2d.strokeStyle = ink.paper;
    ctx2d.beginPath();
    ctx2d.moveTo(ax, ay);
    ctx2d.lineTo(hx, hy);
    ctx2d.stroke();
    dot(hx, hy, 5, escapes ? ink.red : ink.blue);
    ring(hx, hy, 9, ink.paper, 0.8);
    ctx2d.font = '500 12px Jost, system-ui, sans-serif';
    ctx2d.fillStyle = ink.paper;
    ctx2d.fillText(String(shown), hx + 13, hy - 9);
  }
  ctx2d.globalAlpha = 1;
  markPoint(state.point, escapes ? ink.red : ink.blue);
};

const tick = (now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (cantus?.playing()) cantus.frame(now);
  // ease toward the destination, frame-rate independent
  const e = 1 - Math.pow(0.8, dt * 60);
  const v = state.view;
  const d = state.dest;
  const logS = Math.log(v.span) + (Math.log(d.span) - Math.log(v.span)) * e;
  v.cx += (d.cx - v.cx) * e;
  v.cy += (d.cy - v.cy) * e;
  v.span = Math.exp(logS);
  const still = Math.abs(d.cx - v.cx) / v.span < 1e-4 && Math.abs(d.cy - v.cy) / v.span < 1e-4 && Math.abs(d.span / v.span - 1) < 1e-4;
  if (still) Object.assign(v, d);
  if (state.morph) {
    // the formula and the view travel together, on one eased clock
    const m = state.morph;
    const t = Math.min(1, (now - m.t0) / MORPH_MS);
    // a slow frame means the GPU is behind: draw the rest of the morph with fewer steps
    if (now - m.t0 > 120 && dt > 0.034 && morphIters > 160) morphIters = Math.round(morphIters * 0.75);
    m.e = easeInOut(t);
    const a = m.viewFrom;
    v.cx = a.cx + (d.cx - a.cx) * m.e;
    v.cy = a.cy + (d.cy - a.cy) * m.e;
    v.span = Math.exp(Math.log(a.span) + (Math.log(d.span) - Math.log(a.span)) * m.e);
    if (t >= 1) {
      state.morph = null;
      Object.assign(v, d);
      landed = true;
    }
  }

  const key = JSON.stringify([v, state.type, kOf(), state.morph?.e, state.julia, state.picking, state.colour, state.iters, W, H]);
  if (key !== lastKey && landed) {
    // a morph just landed: the full-depth picture blends in over its last frame instead of cutting to it
    lastKey = key;
    landed = false;
    settling = false;
    landStep = 1;
  } else if (key !== lastKey) {
    lastKey = key;
    landStep = 0;
    frame = 0;
    settling = true;
  } else if (settling) {
    // the view has stopped: redraw once at full depth, then let jittered frames sharpen it
    settling = false;
    frame = 0;
  }
  if (landStep > 0) {
    // step k of n blends at 1 / (n - k + 1), so the old frame's share falls evenly to nothing
    try {
      renderer.draw({...drawState(), alpha: 1 / (LAND_STEPS - landStep + 1)}, 0);
    } catch {
      landStep = LAND_STEPS;
    }
    if (++landStep > LAND_STEPS) {
      landStep = 0;
      frame = 1;
    }
  } else if (frame < MAX_FRAMES) {
    try {
      renderer.draw(drawState(), frame);
    } catch (err) {
      // a shader that will not compile on this GPU: drop the morph, or step back to the Mandelbrot set
      console.warn(err);
      if (state.morph) state.morph = null;
      else if (state.type !== 0) {
        toast(`${cur().name} cannot be drawn on this device.`);
        setFractal(0, false, false);
      }
    }
    if (!settling) frame++;
  }

  drawOverlay(now);
  requestAnimationFrame(tick);
};

// ---------- input on the picture ----------

const pointers = new Map();
let mode = null; // 'play' | 'pan' | 'pick' | 'pinch'
let pinch = null;
let spaceHeld = false;
let jHeld = false;
let mouse = [0, 0];
let rightDown = null;

const local = (e) => {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};

stage.addEventListener('pointerdown', (e) => {
  interruptShow();
  startAudio();
  closeSettings();
  closeSettings();
  try {
    stage.setPointerCapture(e.pointerId);
  } catch {
    // some pens and synthetic pointers cannot be captured; dragging still works inside the stage
  }
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]};
    mode = 'pinch';
    return;
  }
  if (pointers.size > 2) return;
  if (e.button === 2) {
    rightDown = p;
    mode = 'pan';
  } else if (e.button === 1 || spaceHeld || e.shiftKey || state.panTool) {
    mode = 'pan';
  } else if (state.picking) {
    mode = 'pick';
    setJulia(toPlane(...p));
  } else {
    mode = 'play';
    // a shared point plays exactly when its ring is pressed, not wherever the finger happens to land
    const near = state.shared && state.point && Math.hypot(...toScreen(...state.point).map((v, i) => v - p[i])) < 24;
    state.shared = false;
    play(...(near ? state.point : toPlane(...p)));
  }
  e.preventDefault();
});

stage.addEventListener('pointermove', (e) => {
  const p = local(e);
  mouse = p;
  if (jHeld && state.picking && !pointers.size) setJulia(toPlane(...p));
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, p);
  if (mode === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    panBy(m[0] - pinch.m[0], m[1] - pinch.m[1]);
    zoomAt(m[0], m[1], d / pinch.d);
    Object.assign(state.view, state.dest);
    pinch = {d, m};
  } else if (mode === 'pan') {
    panBy(p[0] - prev[0], p[1] - prev[1]);
  } else if (mode === 'play') {
    play(...toPlane(...p));
  } else if (mode === 'pick') {
    setJulia(toPlane(...p));
  }
});

const up = (e) => {
  const p = local(e);
  if (e.button === 2 && rightDown && Math.hypot(p[0] - rightDown[0], p[1] - rightDown[1]) < 4) stop();
  rightDown = null;
  pointers.delete(e.pointerId);
  if (mode === 'pick') {
    state.picking = false;
    syncUI();
    saveHash();
  }
  if (pointers.size === 0) mode = null;
  else if (mode === 'pinch') mode = null;
};
stage.addEventListener('pointerup', up);
stage.addEventListener('pointercancel', up);
stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = local(e);
    // pinch on a trackpad arrives as a ctrl-wheel with small deltas; a mouse wheel notch is about 100
    const scale = e.ctrlKey ? 0.012 : 0.0016;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(p[0], p[1], Math.exp(-delta * scale));
  },
  {passive: false},
);

// ---------- keyboard ----------

const overlayOpen = () => galleryOpen() || !$('#welcome').hidden;

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    if (!$('#welcome').hidden) start();
    else if (galleryOpen()) toggleGallery(false);
    else if ($('#about').classList.contains('open')) toggleAbout(false);
    else if ($('#settings').classList.contains('open')) closeSettings();
    else stop();
  } else if (k === 'g') toggleGallery();
  else if (k === 'h' || k === '?') toggleAbout();
  else if (overlayOpen()) {
    if (k === 'enter' && !$('#welcome').hidden) start();
    return;
  } else if (k === '[') setFractal(state.type - 1);
  else if (k === ']') setFractal(state.type + 1);
  else if (k === 'x') surprise();
  else if (k === 'd') toggleSustain();
  else if (k === 'c') setColour((state.colour + 1) % 3);
  else if (k === 'a') toggleAnimate();
  else if (k === 'r') reset();
  else if (k === 's') snapshot();
  else if (k === 'w') saveSound();
  else if (k === 'l') copyLink();
  else if (k === ' ') {
    spaceHeld = true;
    stage.classList.add('panning');
  } else if (k === 'j' && !e.repeat) {
    // hold J and move the mouse to choose c, let go to keep that Julia set; press again to go back
    if (cur().noJulia) toggleJulia();
    else if (state.julia && !state.picking) toggleJulia();
    else {
      jHeld = true;
      state.picking = true;
      startAudio();
      stop();
      setJulia(toPlane(...mouse));
      syncUI();
    }
  } else return;
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') {
    spaceHeld = false;
    stage.classList.remove('panning');
  } else if (k === 'j' && jHeld) {
    jHeld = false;
    state.picking = false;
    frame = 0;
    syncUI();
    saveHash();
  }
});

// ---------- buttons ----------

const toggleSustain = () => {
  state.sustain = !state.sustain;
  send({type: 'sustain', on: state.sustain});
  if (state.point && state.playing) play(...state.point);
  syncUI();
};

const toggleAnimate = () => {
  state.animate = !state.animate;
  state.traceStart = performance.now();
  state.traceHold = 0;
  syncUI();
};


// settings (bottom right) and about (bottom left) are popovers: one open at a time, anything else closes them
const toggleSettings = (open = !$('#settings').classList.contains('open')) => {
  if (open) toggleAbout(false);
  if (open) cantus?.closePanel();
  $('#settings').classList.toggle('open', open);
  $$('.settings-btn').forEach((b) => b.classList.toggle('on', open));
  dimForSheets();
};
const toggleAbout = (open = !$('#about').classList.contains('open')) => {
  if (open) toggleSettings(false);
  if (open) cantus?.closePanel();
  $('#about').classList.toggle('open', open);
  $('.about-btn').classList.toggle('on', open);
  dimForSheets();
};
// on a phone an open sheet dims the picture behind it
const dimForSheets = () => {
  const open = $('#settings').classList.contains('open') || $('#about').classList.contains('open') || $('#cantus').classList.contains('open') || galleryOpen();
  document.body.classList.toggle('sheet-open', open && !desktop());
};
const closeSettings = () => {
  toggleSettings(false);
  toggleAbout(false);
  cantus?.closePanel();
};

/** a random fractal and one of its sound spots: the switch morphs while the dashed ring turns, then the spot plays */
const surprise = () => {
  startAudio();
  closeSettings();
  let i = state.type;
  while (i === state.type) i = Math.floor(Math.random() * fractals.length);
  setFractal(i);
  const btn = $('#random');
  btn.classList.remove('spinning');
  void btn.offsetWidth;
  btn.classList.add('spinning');
  const list = spots[fractals[i].key] || [];
  if (list.length) {
    const n = Math.floor(Math.random() * list.length);
    setTimeout(() => state.type === i && playSpot(n), MORPH_MS + 80);
  }
};
$('#random').addEventListener('animationend', (e) => e.currentTarget.classList.remove('spinning'));

const zoomBy = (f) => zoomAt(W / 2, H / 2, f);

const start = () => {
  $('#welcome').hidden = true;
  try {
    localStorage.setItem('fse-welcomed', '1');
  } catch {
    // private windows may refuse storage; the welcome then simply shows again next time
  }
  startAudio();
};

const actions = {
  gallery: () => toggleGallery(),
  prev: () => setFractal(state.type - 1),
  next: () => setFractal(state.type + 1),
  colour: () => setColour((state.colour + 1) % 3),
  julia: () => {
    startAudio();
    closeSettings();
    toggleJulia();
  },
  damp: toggleSustain,
  animate: toggleAnimate,
  settings: () => toggleSettings(),
  surprise,
  'zoom-in': () => zoomBy(1.6),
  'zoom-out': () => zoomBy(1 / 1.6),
  wav: saveSound,
  snap: snapshot,
  link: copyLink,
  reset,
  about: () => toggleAbout(),
  stop,
  start,
  song: () => openSong(),
  'param-default': () => {
    setParam(cur().param.value);
    renderParam();
  },
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act], [data-colour]');
  if (!b) {
    if (!e.target.closest('.pop')) closeSettings();
    return;
  }
  if (!b.closest('.pop') && !['settings', 'about', 'song'].includes(b.dataset.act)) closeSettings();
  if (b.dataset.colour) setColour(Number(b.dataset.colour));
  else actions[b.dataset.act]?.();
});

// clicking the dim area around a sheet closes it
$('#gallery').addEventListener('click', (e) => e.target === e.currentTarget && toggleGallery(false));
$('#welcome').addEventListener('click', (e) => e.target === e.currentTarget && start());

$('#g-search').addEventListener('input', (e) => filterGallery(e.target.value));
$('#g-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('.card-f:not([hidden])')?.click();
  if (e.key === 'Escape') toggleGallery(false);
});

$$('.param-range').forEach((r) => r.addEventListener('input', (e) => setParam(Number(e.target.value))));

const inputs = {
  volume: (v) => {
    state.volume = v;
    if (audio?.gain) audio.gain.gain.setTargetAtTime(v, audio.ctx.currentTime, 0.02);
  },
  // the slider is in semitones from the normal rate, so every notch is one piano key
  rate: (v) => {
    state.rate = clampRate(RATE * 2 ** (v / 12));
    send({type: 'rate', value: state.rate});
      showReadout();
    saveHash();
  },
  iters: (v) => {
    state.iters = v;
  },
};
for (const el of $$('[data-input]')) {
  el.addEventListener('input', (e) => {
    inputs[el.dataset.input](Number(e.target.value));
    syncUI();
  });
}

/** one line each: a name or formula that is too wide for its card shrinks until it fits */
const fitLine = (el) => {
  el.style.fontSize = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  let size = base;
  while (el.scrollWidth > el.clientWidth + 0.5 && size > base * 0.62) {
    size -= 0.5;
    el.style.fontSize = `${size}px`;
  }
};
const fitAll = () => $$('.fit').forEach(fitLine);
document.fonts?.ready.then(fitAll);
window.addEventListener('resize', fitAll);

let shownName = '';
let booted = false; // the first fractal, from the link or the default, appears without a fade
let freshTimer = 0;
const syncUI = () => {
  const f = cur();
  if (booted && shownName && shownName !== f.name) {
    const card = $('.info');
    card.classList.remove('fresh');
    void card.offsetWidth;
    card.classList.add('fresh');
    // the staggered fade lasts under 0.8 s; then the card is left with no animation on it
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => card.classList.remove('fresh'), 900);
  }
  shownName = f.name;
  $$('.f-name').forEach((el) => (el.textContent = f.name));
  $$('.f-formula').forEach((el) => (el.textContent = f.formula));
  $$('.f-note').forEach((el) => (el.textContent = f.note));
  fitAll();
  $$('[data-colour]').forEach((b) => b.classList.toggle('on', Number(b.dataset.colour) === state.colour));
  $$('.bar-colour').forEach((el) => (el.textContent = COLOUR_NAMES[state.colour]));
  $$('[data-act="damp"]').forEach((b) => b.classList.toggle('on', !state.sustain));
  $$('[data-act="animate"]').forEach((b) => b.classList.toggle('on', state.animate));
  $$('[data-act="julia"]').forEach((b) => {
    b.classList.toggle('on', !!state.julia);
    b.classList.toggle('disabled', !!f.noJulia);
  });
  $$('.julia-lbl').forEach((l) => (l.textContent = state.picking ? 'Julia set: choose c' : 'Julia set'));
  // pitch reads as a musical shift from normal: whole octaves, or semitones in between
  const st = Math.round(12 * Math.log2(state.rate / RATE));
  const sign = st > 0 ? '+' : '−';
  const shift = st === 0 ? 'normal' : st % 12 === 0 ? `${sign}${Math.abs(st) / 12} oct` : `${sign}${Math.abs(st)} semitones`;
  $$('.rate-value').forEach((el) => (el.textContent = shift));
  stage.classList.toggle('picking', state.picking);
  showReadout();
};

// ---------- shareable links ----------

let hashTimer = 0;
const writeHash = () => {
  clearTimeout(hashTimer);
  const d = state.dest;
  const f = cur();
  const parts = [`f=${f.key}`, `x=${d.cx}`, `y=${d.cy}`, `s=${d.span}`];
  if (f.param && kOf() !== f.param.value) parts.push(`k=${kOf()}`);
  if (state.julia && !state.picking) parts.push(`jx=${state.julia[0]}`, `jy=${state.julia[1]}`);
  if (state.point) parts.push(`px=${state.point[0]}`, `py=${state.point[1]}`);
  if (state.colour) parts.push(`colours=${state.colour}`);
  if (state.rate !== RATE) parts.push(`rate=${state.rate}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
};
const saveHash = () => {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 250);
};

// a link is untrusted input: it is only ever read as a fractal name from the list and as bounded numbers
const LIMIT = 1e3;
const loadHash = () => {
  if (location.hash.length > 600) return false;
  const q = new URLSearchParams(location.hash.slice(1));
  const i = fractals.findIndex((f) => f.key === q.get('f'));
  if (i < 0) return false;
  const n = (k) => {
    if (!q.has(k)) return null;
    const v = Number(q.get(k));
    return Number.isFinite(v) && Math.abs(v) <= LIMIT ? v : null;
  };
  const f = fractals[i];
  if (f.param && n('k') !== null) state.params[f.key] = Math.min(f.param.max, Math.max(f.param.min, n('k')));
  const rate = Number(q.get('rate'));
  if (q.has('rate') && Number.isFinite(rate)) {
    state.rate = clampRate(rate);
    $$('[data-input="rate"]').forEach((o) => (o.value = Math.round(12 * Math.log2(state.rate / RATE))));
    send({type: 'rate', value: state.rate});
  }
  setFractal(i, false, false);
  if (n('x') !== null && n('y') !== null && n('s') > 0) {
    state.dest = {cx: n('x'), cy: n('y'), span: Math.min(MAX_SPAN, Math.max(MIN_SPAN, n('s')))};
    state.view = {...state.dest};
  }
  if (!f.noJulia && n('jx') !== null && n('jy') !== null) setJulia([n('jx'), n('jy')]);
  state.colour = [0, 1, 2].includes(Number(q.get('colours'))) ? Number(q.get('colours')) : q.get('tones') === '1' ? 1 : 0;
  // a shared point is marked and plays when its ring is pressed (browsers need a gesture before any sound)
  if (n('px') !== null && n('py') !== null) {
    const p = [n('px'), n('py')];
    state.point = p;
    const o = orbitOf(f, p, state.julia);
    state.info = analyse(f, o.z0, o.c, kOf());
    state.shared = true;
    $('#hint').textContent = 'Someone shared this point. Press the ringed dot to hear it.';
  }
  syncUI();
  return true;
};

// ---------- songs ----------

const openSong = async () => {
  if (!cantus) {
    cantusLoading ||= import('./cantus/show.js?v=25').then((m) =>
      m.initShow({
        state,
        fractals,
        send,
        startAudio,
        audio: () => audio,
        setupMessages,
        toast,
        closeSettings,
        dimForSheets,
        desktop,
        drawOrbit,
        hideLimit: () => ($('#limit').hidden = true),
        /** switch to a fractal for the show, without pausing it and without a morph */
        showFractal: (key) => {
          const i = fractals.findIndex((f) => f.key === key);
          showSwitching = true;
          try {
            setFractal(i, false, false);
          } finally {
            showSwitching = false;
          }
        },
      }),
    );
    try {
      cantus = await cantusLoading;
    } catch (e) {
      console.warn(e);
      cantusLoading = null;
      toast('Songs could not load. Try reloading the page.');
      return;
    }
  }
  cantus.togglePanel();
};

// ---------- start ----------

renderer.onRestore = () => (frame = 0);
new ResizeObserver(resize).observe(stage);
resize();
buildGallery();
renderParam();
syncUI();
const fromLink = loadHash();
booted = true;
let welcomed = false;
try {
  welcomed = localStorage.getItem('fse-welcomed') === '1';
} catch {
  // no storage: show the welcome
}
// a shared link goes straight to its point; first-time visitors get one screen of explanation
$('#welcome').hidden = welcomed || fromLink;
requestAnimationFrame(tick);
// draw the gallery's small pictures while the visitor is still reading
setTimeout(makeThumbs, 1500);
