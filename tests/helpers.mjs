// Shared helpers for the Node tests: render a voice offline, measure its pitch and its level.
import {Master} from '../src/voice.js';

/**
 * render `seconds` of a lone Voice through the master path in blocks of 128 samples, as the audio thread does;
 * returns {L, R}. Pass `master` to go on from an earlier call.
 */
export const renderVoice = (voice, seconds, sr, master = new Master(sr)) => {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const mixL = new Float64Array(128);
  const mixR = new Float64Array(128);
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    mixL.fill(0);
    mixR.fill(0);
    const on = voice.on;
    voice.render(mixL, mixR, 0, m);
    master.render(mixL, mixR, L.subarray(i, i + m), R.subarray(i, i + m), m, on || voice.on ? 1 : 0, voice.broke);
  }
  return {L, R};
};

/** root mean square of one signal, or of several channels taken together */
export const rms = (signal) => {
  const chans = Array.isArray(signal) ? signal : [signal];
  let s = 0;
  let n = 0;
  for (const x of chans) {
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    n += x.length;
  }
  return n ? Math.sqrt(s / n) : 0;
};

/**
 * The pitch of a signal in Hz, by autocorrelation with parabolic interpolation. An FFT peak is not used because orbit
 * spectra often have a weak fundamental. `signal` is one channel or an array of channels, whose autocorrelations are
 * summed. The shortest lag that comes within `near` of the best one wins, so whole multiples of the period (an
 * octave or more down) are not picked by accident. Returns 0 when nothing repeats.
 */
export const pitchOf = (signal, sr, {minHz = 30, maxHz = 10000, near = 0.9} = {}) => {
  const chans = (Array.isArray(signal) ? signal : [signal]).map((x) => {
    let m = 0;
    for (let i = 0; i < x.length; i++) m += x[i];
    m /= x.length || 1;
    return Float64Array.from(x, (v) => v - m);
  });
  const n = chans[0].length;
  const lo = Math.max(2, Math.floor(sr / maxHz));
  const hi = Math.min(Math.floor(n / 2), Math.ceil(sr / minHz));
  if (hi <= lo + 1) return 0;
  const r = new Float64Array(hi + 2);
  for (let lag = 0; lag <= hi + 1; lag++) {
    if (lag > 0 && lag < lo - 1) continue;
    let s = 0;
    for (const x of chans) for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    r[lag] = s / (n - lag);
  }
  if (!(r[0] > 0)) return 0;
  let best = -Infinity;
  for (let lag = lo; lag <= hi; lag++) best = Math.max(best, r[lag]);
  if (!(best > 0.1 * r[0])) return 0;
  for (let lag = lo; lag <= hi; lag++) {
    if (r[lag] >= near * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const a = r[lag - 1];
      const b = r[lag];
      const c = r[lag + 1];
      const d = a - 2 * b + c;
      const shift = d !== 0 ? (0.5 * (a - c)) / d : 0;
      return sr / (lag + shift);
    }
  }
  return 0;
};

/**
 * The first sample in [from, to) where a voice starts. A silent voice's output is the tail of its high-pass, which
 * shrinks by exactly 0.9995 a sample, so the onset is the first sample that breaks that rule. Returns -1 if none.
 */
export const onsetIn = (x, from, to, tol = 1e-6) => {
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) {
    if (Math.abs(x[i] - 0.9995 * x[i - 1]) > tol) return i;
  }
  return -1;
};
