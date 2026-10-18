// The instrument: the orbit of a pressed point played as stereo sound, its x on the left and its y on the right.
//
// The orbit advances `rate` steps a second. Between steps the signal follows a Catmull-Rom curve through the four
// nearest orbit points, so it is smooth without rounding off the corners that give each cycle its timbre. The orbit is
// heard around its own centre (the average of its last 32 points), at a loudness set by its own level, through a soft
// saturator. A cycle of period p repeats rate / p times a second, so that is the pitch you hear.
//
// This is plain JavaScript with no audio API in it, so the audio worklet and Node (tests and tools) run the same code.

import {fractals, orbitOf, ESCAPE_SQ, RATE, clampRate} from './fractals.js?v=24';

const CENTRE_N = 32; // orbit points averaged to find the centre the sound swings around
const TARGET = 0.3; // level the automatic gain aims for
const MAX_GAIN = 24; // so a point that barely moves is not blown up into hiss
const LEVEL_S = 0.05; // how quickly the automatic gain follows the orbit
const ATTACK_S = 0.004;
const RELEASE_S = 0.015;
const FADE_S = 0.6; // time for a fading note to fall to about a third
const VELOCITY_DB = 30; // velocity 0 to 1 spans this many decibels

// Catmull-Rom through four values at t between the second and the third
const curve = (a, b, c, d, t, t2, t3) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);

const finitePair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

export class Voice {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.f = fractals[0];
    this.k = 0;
    this.rate = RATE;
    this.fading = true;
    this.julia = null;
    this.c = [0, 0];
    this.next = [0, 0];
    // the four orbit points the curve runs through, as x0 y0 x1 y1 x2 y2 x3 y3; the sound is between points 1 and 2
    this.p = new Float64Array(8);
    this.ring = new Float64Array(CENTRE_N * 2);
    this.ringSum = [0, 0];
    this.ringI = 0;
    this.phase = 0;
    this.escaped = false;
    this.on = false;
    this.releasing = false;
    this.attack = 0;
    this.decay = 1;
    this.release = 1;
    this.level = 0.05;
    this.hp = [0, 0, 0, 0];
    this.velocityGain = 1;
    this.releaseS = RELEASE_S;
    // called when the orbit escapes; the worklet forwards it to the page
    this.onEscape = null;
  }

  message(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'fractal') {
      if (!fractals[m.index]) return;
      this.f = fractals[m.index];
      this.k = Number.isFinite(m.param) ? m.param : 0;
      this.stop();
    } else if (m.type === 'param') {
      if (Number.isFinite(m.value)) this.k = m.value;
    } else if (m.type === 'rate') {
      if (Number.isFinite(m.value)) this.rate = clampRate(m.value);
    } else if (m.type === 'julia') {
      this.julia = Array.isArray(m.c) && m.c.every(Number.isFinite) ? m.c : null;
      this.stop();
    } else if (m.type === 'sustain') {
      this.fading = !m.on;
    } else if (m.type === 'stop') {
      this.stop();
    } else if (m.type === 'point') {
      if (Array.isArray(m.p) && m.p.every(Number.isFinite)) this.start(m.p, m.opts);
    }
  }

  /**
   * Begin a new orbit; while one is already sounding, the new one takes over without a fresh attack.
   * opts, all optional: z0 [x, y] starts the orbit there instead of where the fractal starts it (a point on the cycle
   * sounds its pitch from the first sample), velocity 0 to 1 (1 is full level, 0 is silent), rate in steps a second,
   * offset in seconds (the note began that long ago, so the envelope starts as it would be by then), and releaseS,
   * the length of the release for this voice from now on.
   */
  start(point, opts) {
    const o = opts && typeof opts === 'object' ? opts : null;
    if (o && Number.isFinite(o.rate)) this.rate = clampRate(o.rate);
    if (o && Number.isFinite(o.releaseS)) this.releaseS = Math.min(2, Math.max(0.001, o.releaseS));
    const velocity = o && Number.isFinite(o.velocity) ? Math.min(1, Math.max(0, o.velocity)) : 1;
    this.velocityGain = velocity > 0 ? 10 ** (((velocity - 1) * VELOCITY_DB) / 20) : 0;
    const orbit = orbitOf(this.f, point, this.julia);
    const z0 = o && finitePair(o.z0) ? o.z0 : orbit.z0;
    const c = orbit.c;
    this.c = c;
    const p = this.p;
    p[0] = p[2] = z0[0];
    p[1] = p[3] = z0[1];
    this.escaped = false;
    for (let i = 4; i < 8; i += 2) {
      this.f.step(p[i - 2], p[i - 1], c[0], c[1], this.next, this.k);
      p[i] = this.next[0];
      p[i + 1] = this.next[1];
    }
    this.ring.fill(0);
    for (let i = 0; i < CENTRE_N; i++) {
      this.ring[i * 2] = p[2];
      this.ring[i * 2 + 1] = p[3];
    }
    this.ringSum = [p[2] * CENTRE_N, p[3] * CENTRE_N];
    this.ringI = 0;
    this.phase = 0;
    if (!this.on || this.release < 1) this.attack = 0;
    this.on = true;
    this.releasing = false;
    this.decay = 1;
    this.release = 1;
    this.level = 0.05;
    const offset = o && Number.isFinite(o.offset) && o.offset > 0 ? o.offset : 0;
    if (offset > 0) {
      this.attack = Math.min(1, this.attack + offset / ATTACK_S);
      if (this.fading) this.decay = Math.exp(-offset / FADE_S);
    }
  }

  stop() {
    if (this.on) this.releasing = true;
  }

  /** move the window of four points one step along the orbit */
  advance() {
    if (this.escaped) return;
    const p = this.p;
    p.copyWithin(0, 2);
    this.f.step(p[4], p[5], this.c[0], this.c[1], this.next, this.k);
    const [x, y] = this.next;
    if (!(x * x + y * y <= ESCAPE_SQ)) {
      // the orbit left: hold its last point and let the sound release
      this.escaped = true;
      p[6] = p[4];
      p[7] = p[5];
      this.releasing = true;
      if (this.onEscape) this.onEscape();
      return;
    }
    p[6] = x;
    p[7] = y;
    const i = this.ringI * 2;
    this.ringSum[0] += x - this.ring[i];
    this.ringSum[1] += y - this.ring[i + 1];
    this.ring[i] = x;
    this.ring[i + 1] = y;
    this.ringI = (this.ringI + 1) % CENTRE_N;
  }

  /** write samples `from` to `to` (not included) of L and R */
  render(L, R, from, to) {
    const sr = this.sr;
    const inc = this.rate / sr;
    const followLevel = 1 - Math.exp(-1 / (LEVEL_S * sr));
    const fadeStep = Math.exp(-1 / (FADE_S * sr));
    const p = this.p;
    for (let i = from; i < to; i++) {
      let l = 0;
      let r = 0;
      if (this.on) {
        this.phase += inc;
        while (this.phase >= 1) {
          this.phase -= 1;
          this.advance();
        }
        const t = this.phase;
        const t2 = t * t;
        const t3 = t2 * t;
        const sx = curve(p[0], p[2], p[4], p[6], t, t2, t3) - this.ringSum[0] / CENTRE_N;
        const sy = curve(p[1], p[3], p[5], p[7], t, t2, t3) - this.ringSum[1] / CENTRE_N;
        this.level += (sx * sx + sy * sy - this.level) * followLevel;
        const gain = Math.min(MAX_GAIN, TARGET / Math.sqrt(this.level + 1e-12));
        this.attack = Math.min(1, this.attack + 1 / (ATTACK_S * sr));
        if (this.fading) this.decay *= fadeStep;
        if (this.releasing) {
          this.release -= 1 / (this.releaseS * sr);
          if (this.release <= 0) {
            this.on = false;
            this.releasing = false;
            this.release = 1;
          }
        }
        // velocity comes after the automatic level, so a soft note is quieter, not normalised back up
        const env = this.attack * this.decay * Math.max(0, this.release) * gain * this.velocityGain;
        l = Math.tanh(1.6 * sx * env) * 0.7;
        r = Math.tanh(1.6 * sy * env) * 0.7;
      }
      // a NaN would stick in the filters and silence everything after it, so it never gets that far
      if (!Number.isFinite(l) || !Number.isFinite(r)) {
        l = r = 0;
        this.on = false;
        this.hp.fill(0);
      }
      L[i] = this.block(0, l);
      R[i] = this.block(2, r);
    }
  }

  /** a gentle high-pass, so a still point sits at zero */
  block(j, v) {
    const y = v - this.hp[j] + 0.9995 * this.hp[j + 1];
    this.hp[j] = v;
    this.hp[j + 1] = y;
    return y;
  }
}
