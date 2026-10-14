// The instrument. The orbit of the chosen point is played as a sound wave: x drives the left speaker, y the right.
// The orbit takes RATE steps a second and is smoothed between steps with a cosine curve, so a cycle of period p
// is heard as a tone of rate / p hertz (RATE by default; the page can change it).
// A port of the Synth in CodeParade's Fractal Sound Explorer (MIT).

import {fractals, orbitOf, ESCAPE_SQ, RATE} from './fractals.js';

const VOLUME = 8000 / 32768;
const CLIP = 32000 / 32768;

class OrbitSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.f = fractals[0];
    this.k = 0;
    this.rate = RATE;
    this.sustain = false;
    this.julia = null;
    this.paused = true;
    this.out = [0, 0];
    this.phase = 1;
    this.x = this.y = this.cx = this.cy = this.px = this.py = 0;
    this.dx = this.dy = this.dpx = this.dpy = 0;
    this.meanX = this.meanY = 0;
    this.volume = VOLUME;
    // a short attack after each new point, and a DC blocker, so jumps click less and fixed points sit at zero
    this.attack = 0;
    this.hpL = {x: 0, y: 0};
    this.hpR = {x: 0, y: 0};
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (m.type === 'fractal') {
      this.f = fractals[m.index];
      this.k = m.param ?? 0;
      this.paused = true;
    } else if (m.type === 'param') {
      this.k = m.value;
    } else if (m.type === 'rate') {
      this.rate = m.value;
    } else if (m.type === 'julia') {
      this.julia = m.c;
      this.paused = true;
    } else if (m.type === 'sustain') {
      this.sustain = m.on;
    } else if (m.type === 'stop') {
      this.paused = true;
    } else if (m.type === 'point') {
      const {z0, c} = orbitOf(this.f, m.p, this.julia);
      const [x, y] = z0;
      this.cx = c[0];
      this.cy = c[1];
      this.x = this.px = this.meanX = x;
      this.y = this.py = this.meanY = y;
      this.dx = this.dy = this.dpx = this.dpy = 0;
      this.volume = VOLUME;
      this.phase = 1;
      if (this.paused) this.attack = 0;
      this.paused = false;
    }
  }

  // one step of the orbit, exactly as the original computes it
  iterate() {
    const f = this.f;
    this.px = this.x;
    this.py = this.y;
    f.step(this.x, this.y, this.cx, this.cy, this.out, this.k);
    this.x = this.out[0];
    this.y = this.out[1];
    if (!(this.x * this.x + this.y * this.y <= ESCAPE_SQ)) {
      this.paused = true;
      this.port.postMessage({type: 'escaped'});
      return;
    }
    let dx, dy, dpx, dpy;
    if (f.normalized) {
      dpx = this.px - this.cx;
      dpy = this.py - this.cy;
      dx = this.x - this.cx;
      dy = this.y - this.cy;
      if (dx !== 0 || dy !== 0) {
        const dpm = 1 / Math.sqrt(1e-12 + dpx * dpx + dpy * dpy);
        const dm = 1 / Math.sqrt(1e-12 + dx * dx + dy * dy);
        dpx *= dpm;
        dpy *= dpm;
        dx *= dm;
        dy *= dm;
      }
    } else {
      // heard relative to the orbit's running mean
      dx = this.x - this.meanX;
      dy = this.y - this.meanY;
      dpx = this.px - this.meanX;
      dpy = this.py - this.meanY;
    }
    this.meanX = this.meanX * 0.99 + this.x * 0.01;
    this.meanY = this.meanY * 0.99 + this.y * 0.01;
    // keep wild orbits from going to infinite volume
    let m = dx * dx + dy * dy;
    if (m > 2) {
      dx *= 2 / m;
      dy *= 2 / m;
    }
    m = dpx * dpx + dpy * dpy;
    if (m > 2) {
      dpx *= 2 / m;
      dpy *= 2 / m;
    }
    this.dx = dx;
    this.dy = dy;
    this.dpx = dpx;
    this.dpy = dpy;
    // dampening: the note dies away like a plucked string
    if (!this.sustain) this.volume *= 0.9992;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const inc = this.rate / sampleRate;
    for (let i = 0; i < L.length; i++) {
      let l = 0;
      let r = 0;
      if (!this.paused) {
        this.phase += inc;
        if (this.phase >= 1) {
          this.phase -= 1;
          this.iterate();
        }
      }
      if (!this.paused) {
        const t = 0.5 - 0.5 * Math.cos(this.phase * Math.PI);
        const g = this.volume * Math.min(1, this.attack);
        this.attack += 1 / 128;
        l = Math.max(-CLIP, Math.min(CLIP, (t * this.dx + (1 - t) * this.dpx) * g));
        r = Math.max(-CLIP, Math.min(CLIP, (t * this.dy + (1 - t) * this.dpy) * g));
      }
      L[i] = this.dc(this.hpL, l);
      R[i] = this.dc(this.hpR, r);
    }
    return true;
  }

  dc(s, v) {
    const y = v - s.x + 0.9995 * s.y;
    s.x = v;
    s.y = y;
    return y;
  }
}

registerProcessor('orbit-synth', OrbitSynth);
