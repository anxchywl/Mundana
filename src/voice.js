// The instrument: the orbit of a pressed point played as stereo sound, its x on the left and its y on the right.
//
// The orbit advances `rate` steps a second. Between steps the signal follows a Catmull-Rom curve through the four
// nearest orbit points, so it is smooth without rounding off the corners that give each cycle its timbre. The orbit is
// heard around its own centre (the average of its last 32 points), at a loudness set by its own level, through a soft
// saturator. A cycle of period p repeats rate / p times a second, so that is the pitch you hear.
//
// Voices are summed into one master path (Master, below): a gain for how many sound at once, one gentle high-pass and a
// soft limit. This is plain JavaScript with no audio API in it, so the audio worklet and Node (tests and tools) run the
// same code.

import {fractals, ESCAPE_SQ, RATE, clampRate} from './fractals.js?v=30';

const CENTRE_N = 32; // orbit points averaged to find the centre the sound swings around
const TARGET = 0.3; // level the automatic gain aims for
const MAX_GAIN = 24; // so a point that barely moves is not blown up into hiss
const LEVEL_S = 0.05; // how quickly the automatic gain follows the orbit
const ATTACK_S = 0.004;
const RELEASE_S = 0.015;
const FADE_S = 0.6; // time for a fading note to fall to about a third
const VELOCITY_DB = 30; // velocity 0 to 1 spans this many decibels
const GAIN_S = 0.02; // how quickly the master gain follows the number of sounding voices
const LIMIT = 0.9; // above this the master output is bent softly toward 1

// every fractal's step, by index
const S = fractals.map((f) => f.step);

// Catmull-Rom through four values at t between the second and the third
const curve = (a, b, c, d, t, t2, t3) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);

const finitePair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);

export class Voice {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.f = fractals[0];
    this.fi = 0; // the index of f in fractals
    this.k = 0;
    this.rate = RATE;
    this.fading = true;
    this.julia = null;
    this.c = new Float64Array(2);
    this.next = [0, 0];
    // the four orbit points the curve runs through, as x0 y0 x1 y1 x2 y2 x3 y3; the sound is between points 1 and 2
    this.p = new Float64Array(8);
    this.ring = new Float64Array(CENTRE_N * 2);
    this.ringSum = new Float64Array(2);
    this.ringI = 0;
    this.phase = 0;
    this.escaped = false;
    this.on = false;
    this.releasing = false;
    this.attack = 0;
    this.decay = 1;
    this.release = 1;
    this.level = 0.05;
    this.velocityGain = 1;
    // the sample of the last render where the sound broke (a NaN), or -1; the master path starts its filter afresh there
    this.broke = -1;
    this.releaseS = RELEASE_S;
    // called when the orbit escapes; the worklet forwards it to the page
    this.onEscape = null;
  }

  message(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'fractal') {
      if (!fractals[m.index]) return;
      this.f = fractals[m.index];
      this.fi = m.index;
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
    // the same start and c as orbitOf, copied into this voice's own arrays, so a press allocates nothing
    const julia = this.julia;
    const z0 = o && finitePair(o.z0) ? o.z0 : julia ? point : this.f.start || point;
    const from = julia || point;
    const c = this.c;
    c[0] = from[0];
    c[1] = from[1];
    const p = this.p;
    p[0] = p[2] = z0[0];
    p[1] = p[3] = z0[1];
    this.escaped = false;
    for (let i = 4; i < 8; i += 2) {
      this.stepFrom(i / 2);
      p[i] = this.next[0];
      p[i + 1] = this.next[1];
    }
    this.ring.fill(0);
    for (let i = 0; i < CENTRE_N; i++) {
      this.ring[i * 2] = p[2];
      this.ring[i * 2 + 1] = p[3];
    }
    this.ringSum[0] = p[2] * CENTRE_N;
    this.ringSum[1] = p[3] * CENTRE_N;
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

  /**
   * one step of the orbit from point j - 1 of the window (p[2j - 2], p[2j - 1]) into this.next. Every fractal has its
   * own call here, so each call only ever sees one function, which the optimiser inlines. One call shared by all of
   * them would see several functions once voices play different fractals and would not be inlined; every number passed
   * to it would then be boxed, garbage the audio thread would have to collect. This method itself takes only a small
   * integer, so nothing is boxed even if it is not inlined.
   */
  stepFrom(j) {
    const p = this.p;
    const x = p[2 * j - 2];
    const y = p[2 * j - 1];
    const cx = this.c[0];
    const cy = this.c[1];
    const out = this.next;
    const k = this.k;
    // prettier-ignore
    switch (this.fi) {
      case 0: S[0](x, y, cx, cy, out, k); break;
      case 1: S[1](x, y, cx, cy, out, k); break;
      case 2: S[2](x, y, cx, cy, out, k); break;
      case 3: S[3](x, y, cx, cy, out, k); break;
      case 4: S[4](x, y, cx, cy, out, k); break;
      case 5: S[5](x, y, cx, cy, out, k); break;
      case 6: S[6](x, y, cx, cy, out, k); break;
      case 7: S[7](x, y, cx, cy, out, k); break;
      case 8: S[8](x, y, cx, cy, out, k); break;
      case 9: S[9](x, y, cx, cy, out, k); break;
      case 10: S[10](x, y, cx, cy, out, k); break;
      case 11: S[11](x, y, cx, cy, out, k); break;
      case 12: S[12](x, y, cx, cy, out, k); break;
      case 13: S[13](x, y, cx, cy, out, k); break;
      case 14: S[14](x, y, cx, cy, out, k); break;
      case 15: S[15](x, y, cx, cy, out, k); break;
      case 16: S[16](x, y, cx, cy, out, k); break;
      case 17: S[17](x, y, cx, cy, out, k); break;
      case 18: S[18](x, y, cx, cy, out, k); break;
      case 19: S[19](x, y, cx, cy, out, k); break;
      case 20: S[20](x, y, cx, cy, out, k); break;
      case 21: S[21](x, y, cx, cy, out, k); break;
      case 22: S[22](x, y, cx, cy, out, k); break;
      case 23: S[23](x, y, cx, cy, out, k); break;
      default: S[this.fi](x, y, cx, cy, out, k);
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
    this.stepFrom(3);
    const x = this.next[0];
    const y = this.next[1];
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

  /** add samples `from` to `to` (not included) to L and R, the float64 mix of the master path */
  render(L, R, from, to) {
    const sr = this.sr;
    const inc = this.rate / sr;
    const followLevel = 1 - Math.exp(-1 / (LEVEL_S * sr));
    const fadeStep = Math.exp(-1 / (FADE_S * sr));
    const p = this.p;
    this.broke = -1;
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
        this.broke = i;
      }
      L[i] += l;
      R[i] += r;
    }
  }
}

const soft = (v) => (v > LIMIT ? LIMIT + (1 - LIMIT) * Math.tanh((v - LIMIT) / (1 - LIMIT)) : v < -LIMIT ? -LIMIT + (1 - LIMIT) * Math.tanh((v + LIMIT) / (1 - LIMIT)) : v);

/**
 * The master path: the voices' sum times 1 / sqrt(n) for n sounding voices (eased over 20 ms, so it never clicks),
 * then one gentle high-pass, so a still point sits at zero, then a soft limit above 0.9, so no sample passes 1. With
 * one voice the gain is exactly 1 and the limit is not reached by a lone voice's level, so one voice sounds as before.
 */
export class Master {
  constructor(sampleRate) {
    this.gain = 1;
    this.follow = 1 - Math.exp(-1 / (GAIN_S * sampleRate));
    this.hp = new Float64Array(4);
  }

  /**
   * write `len` samples of outL and outR from the mix; `voices` is how many sounded in this block, `reset` the sample
   * where a voice broke (the filter starts from zero there, as it always has) or -1
   */
  render(mixL, mixR, outL, outR, len, voices, reset = -1) {
    const target = 1 / Math.sqrt(Math.max(1, voices));
    const hp = this.hp;
    let g = this.gain;
    for (let i = 0; i < len; i++) {
      if (g !== target) {
        g += (target - g) * this.follow;
        if (Math.abs(target - g) < 1e-7) g = target;
      }
      if (i === reset) hp.fill(0);
      const l = mixL[i] * g;
      const r = mixR[i] * g;
      const yl = l - hp[0] + 0.9995 * hp[1];
      hp[0] = l;
      hp[1] = yl;
      const yr = r - hp[2] + 0.9995 * hp[3];
      hp[2] = r;
      hp[3] = yr;
      outL[i] = soft(yl);
      outR[i] = soft(yr);
    }
    this.gain = g;
  }
}
