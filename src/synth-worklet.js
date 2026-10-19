// The audio thread's side of the instrument: a thin host around a pool of Voices (src/voice.js), which hold the sound
// itself, summed into one Master path. Voice 0 is the one you play by hand: the page's messages without a `voice` go
// to it, and it tells the page when its orbit escapes.
//
// A song sends timed messages as well: `press` and `release` carry `at`, a time on the AudioContext clock, and start
// on that exact sample; `clear` forgets everything pending and lets every voice go; `voices {n}` sets how many voices
// a song may use. Timed events wait in a ring per voice. Everything is allocated here, so the audio callback never
// allocates, and a voice that is not sounding is skipped before any work per sample.

import {Voice, Master} from './voice.js?v=26';
import {fractals, paramOf} from './fractals.js?v=26';

const MAX_VOICES = 6;
const DEFAULT_VOICES = 4;
const BLOCK = 128;
const RING = 256;
const PRESS = 1;
const RELEASE = 2;
const CLEAR_RELEASE_S = 0.015;

/** pending timed events of one voice, oldest first, kept in order of their sample */
class Ring {
  constructor() {
    this.frame = new Float64Array(RING);
    this.kind = new Uint8Array(RING);
    this.fractal = new Int16Array(RING);
    this.num = new Float64Array(RING * 9); // param, px, py, z0x, z0y, rate, velocity, offset, releaseS
    this.hasZ0 = new Uint8Array(RING);
    this.head = 0;
    this.size = 0;
  }

  copy(from, to) {
    this.frame[to] = this.frame[from];
    this.kind[to] = this.kind[from];
    this.fractal[to] = this.fractal[from];
    this.hasZ0[to] = this.hasZ0[from];
    this.num.copyWithin(to * 9, from * 9, from * 9 + 9);
  }

  /**
   * a free slot at the back, moved forward past later events, and past presses on the same sample if this is a
   * release, so a note that ends where the next begins never ends the new one; other ties keep their arrival order.
   * Returns its index, with its kind set.
   */
  push(frame, kind) {
    let i = (this.head + this.size) % RING;
    this.size++;
    for (let n = this.size - 1; n > 0; n--) {
      const before = (i - 1 + RING) % RING;
      if (this.frame[before] < frame || (this.frame[before] === frame && (kind !== RELEASE || this.kind[before] !== PRESS))) break;
      this.copy(before, i);
      i = before;
    }
    this.frame[i] = frame;
    this.kind[i] = kind;
    return i;
  }

  shift() {
    this.head = (this.head + 1) % RING;
    this.size--;
  }
}

const INDEX = new Map(fractals.map((f, i) => [f.key, i]));
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const pair = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

class OrbitVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({length: MAX_VOICES}, () => new Voice(sampleRate));
    this.voice = this.voices[0];
    this.voice.onEscape = () => this.port.postMessage({type: 'escaped'});
    this.rings = this.voices.map(() => new Ring());
    this.count = DEFAULT_VOICES;
    this.master = new Master(sampleRate);
    this.mixL = new Float64Array(BLOCK);
    this.mixR = new Float64Array(BLOCK);
    this.overflowed = false;
    // reused for every press, so applying one allocates nothing here
    this.point = [0, 0];
    this.z0 = [0, 0];
    this.opts = {z0: null, rate: 0, velocity: 1, offset: 0, releaseS: NaN};
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'press') this.press(m);
    else if (m.type === 'release') this.release(m);
    else if (m.type === 'clear') this.clear();
    else if (m.type === 'voices') this.setCount(m.n);
    else if (m.voice === undefined) this.voice.message(m);
    else if (Number.isInteger(m.voice) && m.voice >= 0 && m.voice < MAX_VOICES) this.voices[m.voice].message(m);
  }

  /** how many voices a song may use, 1 to 6; voices past the new count are let go */
  setCount(n) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_VOICES) return;
    this.count = n;
    for (let v = n; v < MAX_VOICES; v++) {
      this.rings[v].size = 0;
      this.voices[v].stop();
    }
  }

  ringFor(m) {
    const v = m.voice ?? 0;
    return Number.isInteger(v) && v >= 0 && v < this.count && Number.isFinite(m.at) ? this.rings[v] : null;
  }

  /** make room in a full ring by dropping its oldest event, and say so once */
  room(ring) {
    if (ring.size < RING) return;
    ring.shift();
    if (!this.overflowed) {
      this.overflowed = true;
      this.port.postMessage({type: 'overflow'});
    }
  }

  press(m) {
    const ring = this.ringFor(m);
    // the fractal is looked up here, once, not on the audio callback
    const index = INDEX.get(m.fractal) ?? -1;
    if (!ring || index < 0 || !pair(m.p) || !Number.isFinite(m.rate)) return;
    this.room(ring);
    const i = ring.push(Math.round(m.at * sampleRate), PRESS);
    ring.fractal[i] = index;
    ring.hasZ0[i] = pair(m.z0) ? 1 : 0;
    const n = ring.num;
    const o = i * 9;
    n[o] = finite(m.param, paramOf(fractals[index], {}));
    n[o + 1] = m.p[0];
    n[o + 2] = m.p[1];
    n[o + 3] = ring.hasZ0[i] ? m.z0[0] : 0;
    n[o + 4] = ring.hasZ0[i] ? m.z0[1] : 0;
    n[o + 5] = m.rate;
    n[o + 6] = finite(m.velocity, 1);
    n[o + 7] = finite(m.offset, 0);
    n[o + 8] = finite(m.releaseS, NaN);
  }

  release(m) {
    const ring = this.ringFor(m);
    if (!ring) return;
    this.room(ring);
    ring.push(Math.round(m.at * sampleRate), RELEASE);
  }

  clear() {
    for (const ring of this.rings) ring.size = 0;
    for (const v of this.voices) {
      v.releaseS = Math.min(v.releaseS, CLEAR_RELEASE_S);
      v.stop();
    }
    this.overflowed = false;
  }

  /** start or end a note now, at the sample the render has reached */
  apply(v, ring) {
    const i = ring.head;
    const voice = this.voices[v];
    if (ring.kind[i] === RELEASE) {
      voice.stop();
      return;
    }
    const n = ring.num;
    const o = i * 9;
    // a song note plays the fractal itself, held for its whole length
    voice.f = fractals[ring.fractal[i]];
    voice.fi = ring.fractal[i];
    voice.k = n[o];
    voice.julia = null;
    voice.fading = false;
    this.point[0] = n[o + 1];
    this.point[1] = n[o + 2];
    this.z0[0] = n[o + 3];
    this.z0[1] = n[o + 4];
    const opts = this.opts;
    opts.z0 = ring.hasZ0[i] ? this.z0 : null;
    opts.rate = n[o + 5];
    opts.velocity = n[o + 6];
    opts.offset = n[o + 7];
    opts.releaseS = n[o + 8];
    voice.start(this.point, opts);
  }

  process(_inputs, outputs) {
    const L = outputs[0][0];
    const R = outputs[0][1] || L;
    const len = L.length;
    // a render quantum of another size (none today) gets mix buffers of its size once, not every block
    if (this.mixL.length < len) {
      this.mixL = new Float64Array(len);
      this.mixR = new Float64Array(len);
    }
    const mixL = this.mixL;
    const mixR = this.mixR;
    mixL.fill(0, 0, len);
    mixR.fill(0, 0, len);
    // currentFrame is the first sample of this block; an event already past starts on the first sample
    const first = currentFrame;
    let sounding = 0;
    let reset = -1;
    for (let v = 0; v < MAX_VOICES; v++) {
      const voice = this.voices[v];
      const ring = this.rings[v];
      const due = ring.size > 0 && ring.frame[ring.head] < first + len;
      if (!voice.on && !due) continue;
      let pos = 0;
      while (ring.size && ring.frame[ring.head] < first + len) {
        const at = Math.max(pos, ring.frame[ring.head] - first);
        if (at > pos && voice.on) {
          voice.render(mixL, mixR, pos, at);
          if (voice.broke >= 0) reset = voice.broke;
        }
        pos = at;
        this.apply(v, ring);
        ring.shift();
      }
      if (pos < len && voice.on) {
        voice.render(mixL, mixR, pos, len);
        if (voice.broke >= 0) reset = voice.broke;
      }
      sounding++;
    }
    this.master.render(mixL, mixR, L, R, len, sounding, reset);
    return true;
  }
}

registerProcessor('orbit-synth', OrbitVoice);
