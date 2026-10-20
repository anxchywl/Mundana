// Songs from audio: a mono recording at 22,050 Hz in, an approximate Timeline out (melody, bass, chords, drums,
// beats, bars and sections). Pure JavaScript with no page and no Web Audio, so Node runs it in the tests and a worker
// runs it in the browser (analyse-worker.js). Each step is its own function:
//
//   spectrum      short time spectra, split into harmonic and percussive parts by median filtering (Fitzgerald
//                 2010), streamed a frame at a time: only the frames the filters need are kept, plus a few numbers
//                 a frame for the later steps, and the harmonic part turned back into sound
//   onsetPeaks    onsets from spectral flux, with an adaptive threshold
//   tempoOf       the tempo, by autocorrelation of the onset envelope under a prior around 120 bpm (Ellis 2007)
//   beatTrack     the beats, by dynamic programming (Ellis 2007)
//   yinTrack      the pitch of every frame (de Cheveigne and Kawahara 2002), the difference function through the FFT
//   framesToNotes pitched frames grouped into notes
//   cleanNotes    octaves fixed, short notes dropped, starts on the eighth note grid
//   chordsOf      a chord per beat from chroma and templates, smoothed by Viterbi
//   downbeatPhase which beat of four starts a bar
//   drumHits      percussive onsets, classified by where their energy is
//   sectionsOf    section boundaries from beat features, by Foote novelty
//
// Every number that sets how a step behaves is in the constants below.

import {RealFFT, hann} from './fft.js?v=31';
import {mergeShort, validateTimeline, MAX_NOTES} from './timeline.js?v=31';

export const SR = 22050;
export const STFT = {n: 2048, hop: 256};
export const HPSS = {width: 17, power: 2};
// lag: the flux peaks before the sound it marks (measured 12.5 ms on drum hits and 20 ms on clicks), so onsets move
// 15 ms later
export const ONSET = {compress: 100, median: 0.2, k: 0.07, local: 0.03, gap: 0.05, lag: 0.015};
export const TEMPO = {window: 8, centre: 120, octaves: 1, min: 60, max: 200, tightness: 100};
// melody and bass: the pitch range a note may have, and the wider range searched, so a note above it is not read as
// its octave below. The threshold is 0.4, the same bound as a frame kept as voiced (confidence 0.6): with 0.15 the
// first dip under it in a band was most often the period melody and bass share, not the melody's own
export const YIN = {window: 1024, hop: 220, threshold: 0.4, keep: 0.6, melody: [80, 1400], melodySearch: [80, 2000], bass: [40, 260], bassSearch: [40, 1000], cut: 250, decimate: 4, bassWindow: 256};
// min: the shortest note kept from a recording (150 ms) unless its confidence is `sure`; in a dense mix no note under
// it is kept, nor any under `denseGate`. grid: how far a start moves onto an eighth note
export const NOTES = {median: 5, stay: 0.5, octave: {window: 4, far: 7, gain: 5}, join: 0.03, min: 0.15, sure: 0.9, denseGate: 0.7, grid: 0.04, snap: 0.06, late: 0.25, rise: 1.3, echo: 0.15};
// chords: a template whose root is the bass note under the beat gains 0.1, since a bass most often plays the root.
// Log emissions are 40 times the similarity: two changes cost 2 log(0.9 / (0.1 / 84)), so a chord of two beats is
// found when its similarity is about 0.17 better (with 20 it took 0.33, and two beat chords merged)
export const CHORDS = {lo: 60, hi: 5000, quiet: 0.1, stay: 0.9, sharp: 40, margin: 0.2, harmonics: 6, decay: 0.6, bass: 0.1};
// a drum hit: percussive flux at least 3 times the harmonic flux, and a percussive spectrum spread 1,200 Hz or more
// or half its energy below 150 Hz (a kick). On the synthetic test songs note onsets spread at most 999 Hz with half of
// them under a ratio of 2.5, drum hits 1,400 Hz and 3.9 at their 10th percentile. Kicks ring low for 120 ms, when the
// bass's pitch is not trusted
export const DRUM_BANDS = {kick: 150, mid: 2000, hat: 5000, spread: 1500, ratio: 3, broad: 1200, low: 0.5, above: 0.1, around: 15, ring: 0.12};
export const SECTIONS = {kernel: 32, sigma: 8, minBars: 8, max: 16, same: 0.9};
export const SONG = {voiced: 0.05, noisy: 0.4, silent: 1e-3, dense: {voiced: 0.7, percussive: 0.12}};

export const QUALITIES = {maj: [0, 4, 7], min: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus2: [0, 2, 7], sus4: [0, 5, 7]};
const QUALITY_KEYS = Object.keys(QUALITIES);
const DRUM_KEY = {kick: 36, snare: 38, hat: 42, other: 47};
const STAGES = ['spectrum', 'beats', 'melody', 'bass', 'chords', 'drums', 'sections'];
// the share of the work each stage takes, for one progress bar (measured on a 4 minute song)
const WEIGHT = {spectrum: 0.55, beats: 0.03, melody: 0.25, bass: 0.1, chords: 0.02, drums: 0.02, sections: 0.03};

const now = () => globalThis.performance?.now?.() ?? Date.now();

/** the value at a fraction of the way through the sorted values (0.95 is the 95th percentile); 0 when empty */
export const percentile = (values, q) => {
  const s = Float64Array.from(values).sort();
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : 0;
};

const median = (values) => percentile(values, 0.5);

/** a running median of `x` over `2 * half + 1` values, the ends padded with zeros */
export const movingMedian = (x, half) => {
  const w = 2 * half + 1;
  const sorted = new Float64Array(w);
  const out = new Float64Array(x.length);
  for (let i = 0; i <= half && i < x.length; i++) sorted[half + i] = x[i];
  sorted.sort();
  for (let i = 0; i < x.length; i++) {
    out[i] = sorted[half];
    const leave = i - half >= 0 ? x[i - half] : 0;
    const enter = i + half + 1 < x.length ? x[i + half + 1] : 0;
    replaceSorted(sorted, 0, w, leave, enter);
  }
  return out;
};

/** in a sorted run sorted[base .. base + w), replace one copy of `leave` with `enter`, keeping the run sorted */
const replaceSorted = (sorted, base, w, leave, enter) => {
  let i = base;
  const end = base + w;
  while (i < end - 1 && sorted[i] !== leave) i++;
  sorted[i] = enter;
  while (i > base && sorted[i - 1] > sorted[i]) {
    const t = sorted[i];
    sorted[i] = sorted[i - 1];
    sorted[--i] = t;
  }
  while (i < end - 1 && sorted[i + 1] < sorted[i]) {
    const t = sorted[i];
    sorted[i] = sorted[i + 1];
    sorted[++i] = t;
  }
};

/** a counter of the bytes of the large arrays this analysis makes, for the memory report */
const counter = () => {
  const mem = {bytes: 0, peak: 0};
  mem.make = (Type, n) => {
    const a = new Type(n);
    mem.bytes += a.byteLength;
    mem.peak = Math.max(mem.peak, mem.bytes);
    return a;
  };
  mem.take = (a) => {
    mem.bytes += a.byteLength;
    mem.peak = Math.max(mem.peak, mem.bytes);
    return a;
  };
  mem.free = (a) => {
    if (a) mem.bytes -= a.byteLength;
  };
  return mem;
};

// ---------- the spectrum, harmonic and percussive ----------

/**
 * Short time spectra of `x` (frames of 2,048 samples, Hann, hop 256, frame f centred on sample f * 256), each split
 * into a harmonic and a percussive part: median over 17 frames in time per bin (harmonic) and over 17 bins in
 * frequency (percussive), soft masks with power 2. Streams: the time median needs 8 frames of look ahead, kept with
 * their spectra in a ring of 17. Returns per frame: flux of the full, percussive and harmonic spectra (log(1 + 100
 * |X|), half wave rectified, summed over bins), percussive energy below 150 Hz, from 150 to 2,000 Hz, above 5,000
 * Hz and from 2,000 to 5,000 Hz, the percussive spectrum's spread in Hz and the frame's energy; and
 * `harm`, the harmonic part as sound (inverse STFT, overlap added, divided by the window sum of 4).
 */
export const spectrum = (x, sr = SR, {mem = counter(), tick = () => {}} = {}) => {
  const N = STFT.n;
  const HOP = STFT.hop;
  const B = N / 2 + 1;
  const W = HPSS.width;
  const HALF = W >> 1;
  const len = x.length;
  const F = Math.floor(len / HOP) + 1;
  const fft = new RealFFT(N);
  const win = hann(N);
  const scale = 2 / (N / 2); // a sine of amplitude a gives a peak of about a
  const frame = new Float64Array(N);
  const re = new Float64Array(B);
  const im = new Float64Array(B);
  const hre = new Float64Array(B);
  const him = new Float64Array(B);
  const out = new Float64Array(N);
  const ringRe = new Float32Array(W * B);
  const ringIm = new Float32Array(W * B);
  const ringMag = new Float32Array(W * B);
  const sortedT = new Float32Array(B * W); // per bin, its 17 latest magnitudes sorted
  const sortedF = new Float32Array(W);
  const H = new Float64Array(B);
  const P = new Float64Array(B);
  const prevFull = new Float64Array(B);
  const prevPerc = new Float64Array(B);
  const prevHarm = new Float64Array(B);

  const harm = mem.make(Float32Array, len);
  const fullFlux = mem.make(Float32Array, F);
  const percFlux = mem.make(Float32Array, F);
  const harmFlux = mem.make(Float32Array, F);
  const band = mem.make(Float32Array, F * 4);
  const spread = mem.make(Float32Array, F);
  const energy = mem.make(Float32Array, F);

  // the bins of the drum bands
  const binHz = sr / N;
  const kLow = Math.floor(DRUM_BANDS.kick / binHz);
  const kMid = Math.floor(DRUM_BANDS.mid / binHz);
  const kHat = Math.ceil(DRUM_BANDS.hat / binHz);

  const L = (m) => Math.log(1 + ONSET.compress * m);

  for (let f = 0; f < F + HALF; f++) {
    const slot = f % W;
    const o = slot * B;
    if (f < F) {
      const s0 = f * HOP - N / 2;
      for (let i = 0; i < N; i++) {
        const j = s0 + i;
        frame[i] = j >= 0 && j < len ? x[j] * win[i] : 0;
      }
      fft.forward(frame, re, im);
    } else {
      re.fill(0);
      im.fill(0);
    }
    for (let k = 0; k < B; k++) {
      const m = Math.fround(Math.hypot(re[k], im[k]) * scale);
      replaceSorted(sortedT, k * W, W, ringMag[o + k], m);
      ringMag[o + k] = m;
      ringRe[o + k] = re[k];
      ringIm[o + k] = im[k];
    }
    const c = f - HALF;
    if (c < 0) continue;
    if ((c & 63) === 0) tick(c / F);

    // the centre frame: harmonic from the time medians, percussive from a median across its own bins
    const oc = (c % W) * B;
    for (let k = 0; k < B; k++) H[k] = sortedT[k * W + HALF];
    sortedF.fill(0);
    for (let k = 0; k <= HALF && k < B; k++) sortedF[HALF + k] = ringMag[oc + k];
    sortedF.sort();
    for (let k = 0; k < B; k++) {
      P[k] = sortedF[HALF];
      const leave = k - HALF >= 0 ? ringMag[oc + k - HALF] : 0;
      const enter = k + HALF + 1 < B ? ringMag[oc + k + HALF + 1] : 0;
      replaceSorted(sortedF, 0, W, leave, enter);
    }
    let fFlux = 0;
    let pFlux = 0;
    let hFlux = 0;
    let eLow = 0;
    let eMid = 0;
    let eHat = 0;
    let eGap = 0;
    let eAll = 0;
    let ePerc = 0;
    let sf = 0;
    let sf2 = 0;
    for (let k = 0; k < B; k++) {
      const m = ringMag[oc + k];
      const h2 = H[k] * H[k];
      const p2 = P[k] * P[k];
      const sum = h2 + p2;
      const mh = sum > 1e-30 ? h2 / sum : 0.5;
      const mp = 1 - mh;
      hre[k] = ringRe[oc + k] * mh;
      him[k] = ringIm[oc + k] * mh;
      const pm = m * mp;
      const hm = m * mh;
      const lf = L(m);
      const lp = L(pm);
      const lh = L(hm);
      if (lf > prevFull[k]) fFlux += lf - prevFull[k];
      if (lp > prevPerc[k]) pFlux += lp - prevPerc[k];
      if (lh > prevHarm[k]) hFlux += lh - prevHarm[k];
      prevFull[k] = lf;
      prevPerc[k] = lp;
      prevHarm[k] = lh;
      const pe = pm * pm;
      eAll += m * m;
      ePerc += pe;
      sf += k * pe;
      sf2 += k * k * pe;
      if (k < kLow) eLow += pe;
      else if (k < kMid) eMid += pe;
      else if (k >= kHat) eHat += pe;
      else eGap += pe;
    }
    fullFlux[c] = fFlux;
    percFlux[c] = pFlux;
    harmFlux[c] = hFlux;
    band[c * 4] = eLow;
    band[c * 4 + 1] = eMid;
    band[c * 4 + 2] = eHat;
    band[c * 4 + 3] = eGap;
    energy[c] = eAll;
    if (ePerc > 1e-20) {
      const mean = sf / ePerc;
      spread[c] = Math.sqrt(Math.max(0, sf2 / ePerc - mean * mean)) * binHz;
    }
    // the harmonic part back to sound: the masked spectrum, inverse transformed and overlap added
    fft.inverse(hre, him, out);
    const s0 = c * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      const j = s0 + i;
      if (j >= 0 && j < len) harm[j] += out[i] / 4;
    }
  }
  return {F, fps: sr / HOP, harm, fullFlux, percFlux, harmFlux, band, spread, energy};
};

/**
 * Chroma for every frame of the harmonic part (the same frames as spectrum): the spectral peaks from 60 to 5,000 Hz,
 * each at its frequency found by parabolic interpolation, folded into 12 pitch classes, weighted by its magnitude
 * and shared between the two nearest pitch classes by its distance in cents. Peaks, not every bin: below about 180 Hz
 * a bin is wider than a semitone, and a loud bass would spread over its neighbours. Returns a Float32Array of 12 a
 * frame.
 */
export const chromaFrames = (harm, sr, F, {mem = counter(), tick = () => {}} = {}) => {
  const N = STFT.n;
  const HOP = STFT.hop;
  const B = N / 2 + 1;
  const fft = new RealFFT(N);
  const win = hann(N);
  const frame = new Float64Array(N);
  const re = new Float64Array(B);
  const im = new Float64Array(B);
  const mag = new Float64Array(B);
  const chroma = mem.make(Float32Array, F * 12);
  const binHz = sr / N;
  const c0 = Math.max(2, Math.ceil(CHORDS.lo / binHz));
  const c1 = Math.min(B - 2, Math.floor(CHORDS.hi / binHz));
  const len = harm.length;
  const scale = 2 / (N / 2);
  for (let f = 0; f < F; f++) {
    if ((f & 255) === 0) tick(f / F);
    const s0 = f * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      const j = s0 + i;
      frame[i] = j >= 0 && j < len ? harm[j] * win[i] : 0;
    }
    fft.forward(frame, re, im);
    let top = 0;
    for (let k = c0 - 1; k <= c1 + 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]) * scale;
      if (mag[k] > top) top = mag[k];
    }
    const o = f * 12;
    for (let k = c0; k <= c1; k++) {
      const m = mag[k];
      // a peak, not lost in the floor
      if (!(m > mag[k - 1] && m >= mag[k + 1] && m > top * 1e-3)) continue;
      const a = Math.log(mag[k - 1] + 1e-12);
      const b = Math.log(m);
      const c = Math.log(mag[k + 1] + 1e-12);
      const d = a - 2 * b + c;
      const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      const hz = (k + shift) * binHz;
      const p = (((69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
      const lo = Math.floor(p);
      const w = 1 - (p - lo);
      chroma[o + (lo % 12)] += m * w;
      chroma[o + ((lo + 1) % 12)] += m * (1 - w);
    }
  }
  return chroma;
};

// ---------- onsets ----------

/**
 * Onsets from a flux curve: frames over a moving median of 0.2 s plus 0.07 times the song's 99th percentile flux,
 * the largest within 30 ms, at least 50 ms apart. Returns [{frame, time, strength}], time 15 ms after the frame.
 */
export const onsetPeaks = (flux, fps, o = ONSET) => {
  const n = flux.length;
  const base = movingMedian(flux, Math.max(1, Math.round((o.median * fps) / 2)));
  const lift = o.k * percentile(flux, 0.99);
  const near = Math.max(1, Math.round(o.local * fps));
  const gap = o.gap * fps;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = flux[i];
    if (!(v > base[i] + lift) || v <= 0) continue;
    let top = true;
    for (let j = Math.max(0, i - near); j <= Math.min(n - 1, i + near) && top; j++) {
      if (flux[j] > v || (flux[j] === v && j < i)) top = false;
    }
    if (!top) continue;
    const last = out[out.length - 1];
    if (last && i - last.frame < gap) {
      if (v > last.strength) out[out.length - 1] = {frame: i, time: i / fps + o.lag, strength: v};
      continue;
    }
    out.push({frame: i, time: i / fps + o.lag, strength: v});
  }
  return out;
};

/** the onset envelope the beat steps read: flux less its moving average over a second, never below 0, unit spread */
export const onsetEnvelope = (flux, fps) => {
  const n = flux.length;
  const half = Math.round(fps / 2);
  const env = new Float64Array(n);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + half)) sum += flux[++hi];
    while (lo < i - half) sum -= flux[lo++];
    env[i] = Math.max(0, flux[i] - sum / (hi - lo + 1));
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += env[i];
  m /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) v += (env[i] - m) ** 2;
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) env[i] /= sd;
  return env;
};

// ---------- tempo and beats ----------

/**
 * The tempo: the autocorrelation of the onset envelope over 8 s windows (half overlapping), summed, weighted by a
 * log Gaussian prior centred on 120 bpm, one octave wide, between 60 and 200 bpm. Returns {bpm, period} (period in
 * frames, fractional).
 */
export const tempoOf = (env, fps, o = TEMPO) => {
  const n = env.length;
  const lagMin = Math.max(1, Math.floor((60 * fps) / o.max));
  const lagMax = Math.ceil((60 * fps) / o.min);
  const L = Math.min(n, Math.round(o.window * fps));
  const step = Math.max(1, Math.round(L / 2));
  const acc = new Float64Array(lagMax + 2);
  for (let s = 0; s + L <= n; s += step) {
    let r0 = 0;
    for (let i = s; i < s + L; i++) r0 += env[i] * env[i];
    if (!(r0 > 0)) continue;
    for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
      let r = 0;
      for (let i = s; i + lag < s + L; i++) r += env[i] * env[i + lag];
      acc[lag] += r / r0 / (L - lag);
    }
  }
  const centre = (60 * fps) / o.centre;
  const weighted = (lag) => acc[lag] * Math.exp(-0.5 * (Math.log2(lag / centre) / o.octaves) ** 2);
  let best = lagMin;
  for (let lag = lagMin; lag <= lagMax; lag++) if (weighted(lag) > weighted(best)) best = lag;
  const a = weighted(best - 1);
  const b = weighted(best);
  const c = weighted(best + 1);
  const d = a - 2 * b + c;
  const period = best + (d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0);
  return {bpm: (60 * fps) / period, period};
};

/**
 * The beats by dynamic programming (Ellis 2007): each frame's score is its onset strength plus the best score of a
 * beat between half and twice a period before it, less tightness times the squared log of how far that gap is from
 * the period. The last beat is the best scoring frame of the last period; the rest come back from it. Frames.
 */
export const beatTrack = (env, period, tightness = TEMPO.tightness) => {
  const n = env.length;
  if (!n) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let from = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const s = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (s > best) {
        best = s;
        from = p;
      }
    }
    score[t] = env[t] + (from >= 0 ? best : 0);
    back[t] = from;
  }
  let last = Math.max(0, n - Math.round(period));
  for (let t = last; t < n; t++) if (score[t] > score[last]) last = t;
  const beats = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
};

// ---------- pitch ----------

/** a fourth order Butterworth low pass (or high pass) at `cut` Hz as two second order sections, run forward over x;
 * a new array */
export const butterworth = (x, sr, cut, high = false) => {
  const y = new Float32Array(x.length);
  const sections = [0.5411961, 1.306563].map((q) => {
    const w = (2 * Math.PI * cut) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    const g = high ? (1 + cw) / 2 : (1 - cw) / 2;
    return {b0: g / a0, b1: ((high ? -2 : 2) * g) / a0, b2: g / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0};
  });
  y.set(x);
  for (const s of sections) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const out = s.b0 * v + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = out;
      y[i] = out;
    }
  }
  return y;
};

/**
 * YIN on `x` at `sr`: frames every `hop` samples, frame k centred on sample k * hop, an integration window of
 * `window` samples. The difference d(lag) = e(0) + e(lag) - 2 r(lag) takes r from one FFT correlation of the window
 * with the frame and e from running sums of squares. Then the cumulative mean normalised difference, the first lag
 * under the threshold (followed down to its minimum) or the smallest one, parabolic interpolation. Returns
 * {hz, conf, rms} per frame; conf is 1 minus the normalised difference at the lag, 0 for a silent frame.
 */
export const yinTrack = (x, sr, {window, hop, lo, hi, threshold = YIN.threshold}, tick = () => {}) => {
  const lagMin = Math.max(2, Math.floor(sr / hi));
  const lagMax = Math.ceil(sr / lo);
  let N = 2;
  while (N < window + lagMax + 2) N *= 2;
  const fft = new RealFFT(N);
  const B = N / 2 + 1;
  const a = new Float64Array(N);
  const b = new Float64Array(N);
  const are = new Float64Array(B);
  const aim = new Float64Array(B);
  const bre = new Float64Array(B);
  const bim = new Float64Array(B);
  const r = new Float64Array(N);
  const sq = new Float64Array(N + 1);
  const d = new Float64Array(lagMax + 2);
  const K = Math.floor(x.length / hop) + 1;
  const hz = new Float32Array(K);
  const conf = new Float32Array(K);
  const rms = new Float32Array(K);
  const len = x.length;
  const gate = SONG.silent * SONG.silent * window;
  for (let k = 0; k < K; k++) {
    if ((k & 255) === 0) tick(k / K);
    const s0 = k * hop - (window >> 1);
    sq[0] = 0;
    for (let i = 0; i < N; i++) {
      const j = s0 + i;
      const v = j >= 0 && j < len ? x[j] : 0;
      b[i] = v;
      a[i] = i < window ? v : 0;
      sq[i + 1] = sq[i] + v * v;
    }
    const e0 = sq[window];
    rms[k] = Math.sqrt(e0 / window);
    if (e0 < gate) continue;
    fft.forward(a, are, aim);
    fft.forward(b, bre, bim);
    // conj(A) B: the correlation of the window with the frame, no wrap since window + lag stays inside N
    for (let i = 0; i < B; i++) {
      const pr = are[i] * bre[i] + aim[i] * bim[i];
      const pi = are[i] * bim[i] - aim[i] * bre[i];
      are[i] = pr;
      aim[i] = pi;
    }
    fft.inverse(are, aim, r);
    let run = 0;
    d[0] = 1;
    for (let lag = 1; lag <= lagMax + 1; lag++) {
      const diff = Math.max(0, e0 + (sq[lag + window] - sq[lag]) - 2 * r[lag]);
      run += diff;
      d[lag] = run > 0 ? (diff * lag) / run : 1;
    }
    let lag = -1;
    for (let t = lagMin; t <= lagMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= lagMax && d[t + 1] < d[t]) t++;
        lag = t;
        break;
      }
    }
    if (lag < 0) {
      lag = lagMin;
      for (let t = lagMin; t <= lagMax; t++) if (d[t] < d[lag]) lag = t;
    }
    const p = d[lag - 1];
    const q = d[lag];
    const s = d[lag + 1];
    const den = p - 2 * q + s;
    const shift = den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (p - s)) / den)) : 0;
    const best = den > 0 ? q - 0.25 * (p - s) * shift : q;
    hz[k] = sr / (lag + shift);
    conf[k] = Math.max(0, Math.min(1, 1 - best));
  }
  return {hz, conf, rms, hop, sr};
};

const midiOfHz = (f) => 69 + 12 * Math.log2(f / 440);

/**
 * Notes from a pitch track: frames with confidence at least 0.6 and a pitch in [lo, hi] Hz, the pitch in MIDI
 * median filtered over 5 frames; runs of frames within half a semitone of their running median become notes, split
 * where an onset brings a rise in level. A note starts at an onset within 60 ms of its first frame, if there is one,
 * or else at the latest onset up to 250 ms before it. Frames in the `skip` spans ([from, to] seconds) are passed over.
 * `midi` is rounded, `midiMeasured` keeps the measured pitch; velocity is the mean frame level over the song's 95th
 * percentile, confidence the mean frame confidence. Then cleanNotes (octaves, held notes, short notes, the eighth
 * note `grid`, stricter when `dense`), and notes under 40 ms are joined or dropped (mergeShort).
 */
export const framesToNotes = (track, {lo, hi, part, onsets = [], keep = YIN.keep, skip = [], grid = [], dense = false}) => {
  const {hz, conf, rms, hop, sr} = track;
  const K = hz.length;
  const dt = hop / sr;
  // frames whose pitch is not trusted (a kick ringing under the bass) neither add to a note nor end it
  const skipped = new Uint8Array(K);
  for (const [a, b] of skip) for (let k = Math.max(0, Math.ceil(a / dt)); k <= Math.min(K - 1, Math.floor(b / dt)); k++) skipped[k] = 1;
  const raw = new Float64Array(K).fill(NaN);
  for (let k = 0; k < K; k++) if (!skipped[k] && conf[k] >= keep && hz[k] >= lo && hz[k] <= hi) raw[k] = midiOfHz(hz[k]);
  const pitch = new Float64Array(K).fill(NaN);
  const half = NOTES.median >> 1;
  const around = [];
  for (let k = 0; k < K; k++) {
    if (Number.isNaN(raw[k])) continue;
    around.length = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(K - 1, k + half); j++) if (!Number.isNaN(raw[j])) around.push(raw[j]);
    around.sort((p, q) => p - q);
    pitch[k] = around[around.length >> 1];
  }
  const voicedRms = [];
  for (let k = 0; k < K; k++) if (!Number.isNaN(pitch[k])) voicedRms.push(rms[k]);
  const loud = percentile(voicedRms, 0.95) || 1;
  const times = onsets.map((o) => o.time).sort((p, q) => p - q);
  let oi = 0;
  const notes = [];
  let run = null;
  let prevEnd = 0;
  let onset = false; // an onset since the last frame that counted
  const close = () => {
    if (!run) return;
    const vals = run.vals.slice().sort((p, q) => p - q);
    const m = vals[vals.length >> 1];
    let start = run.first * dt;
    // the nearest onset at most 60 ms either side is where the note starts; failing that, the latest onset up to
    // 250 ms before it, after the last note ended: an attack, or a drum on top of it, can hide the pitch for a while
    let near = null;
    let late = null;
    for (const t of times) {
      if (t < start - NOTES.late) continue;
      if (t > start + NOTES.snap) break;
      if (t >= start - NOTES.snap) {
        if (near === null || Math.abs(t - start) < Math.abs(near - start)) near = t;
      } else if (t >= prevEnd) late = t;
    }
    if (near !== null) start = near;
    else if (late !== null) start = late;
    const end = (run.last + 1) * dt;
    prevEnd = end;
    notes.push({
      start: Math.max(0, start),
      duration: Math.max(0.001, end - Math.max(0, start)),
      midi: Math.max(0, Math.min(127, Math.round(m))),
      midiMeasured: Math.round(Math.max(0, Math.min(127, m)) * 100) / 100,
      velocity: Math.max(0.05, Math.min(1, run.level / run.vals.length / loud)),
      part,
      confidence: Math.max(0, Math.min(1, run.conf / run.vals.length)),
      source: 'audio',
      struck: run.struck,
    });
    run = null;
  };
  const runMedian = () => {
    const s = run.sorted;
    return s[s.length >> 1];
  };
  for (let k = 0; k < K; k++) {
    const t = k * dt;
    // the onsets since the last frame
    while (oi < times.length && times[oi] <= t) {
      if (times[oi] > t - dt) onset = true;
      oi++;
    }
    if (skipped[k]) continue;
    const p = pitch[k];
    if (Number.isNaN(p)) {
      close();
      continue;
    }
    if (run && Math.abs(p - runMedian()) <= NOTES.stay) {
      let split = false;
      if (onset && run.vals.length >= 4) {
        let before = Infinity;
        for (let j = Math.max(0, k - 4); j < k; j++) before = Math.min(before, rms[j]);
        let after = 0;
        for (let j = k; j < Math.min(K, k + 3); j++) after = Math.max(after, rms[j]);
        split = after > NOTES.rise * before;
      }
      if (!split) {
        onset = false;
        run.vals.push(p);
        const s = run.sorted;
        let i = s.length;
        s.push(p);
        while (i > 0 && s[i - 1] > p) {
          s[i] = s[i - 1];
          i--;
        }
        s[i] = p;
        run.last = k;
        run.conf += conf[k];
        run.level += rms[k];
        continue;
      }
    }
    // a run under 150 ms split at an onset into the same pitch is that note's pre-echo (the harmonic part is smoothed
    // over 93 ms either side): it is let go, not kept as a note
    if (run && onset && (k - run.first) * dt < NOTES.echo && Math.abs(p - runMedian()) <= NOTES.stay) run = null;
    close();
    onset = false;
    // struck: the level rises into it, as at a new attack (an onset alone is not enough: in a mix the hats leak into
    // the harmonic part)
    let before = Infinity;
    for (let j = Math.max(0, k - 4); j < k; j++) before = Math.min(before, rms[j]);
    let after = 0;
    for (let j = k; j < Math.min(K, k + 3); j++) after = Math.max(after, rms[j]);
    run = {first: k, last: k, vals: [p], sorted: [p], conf: conf[k], level: rms[k], struck: after > NOTES.rise * before};
  }
  close();
  return mergeShort(cleanNotes(notes, {lo: midiOfHz(lo), hi: midiOfHz(hi), grid, dense, octaves: part === 'melody' || dense})).notes;
};

/** the weighted median of `values` (weights alike in length) */
const weightedMedian = (values, weights) => {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (const w of weights) total += w;
  let run = 0;
  for (const i of order) {
    run += weights[i];
    if (run >= total / 2) return values[i];
  }
  return NaN;
};

/**
 * Notes of one line made playable (pitches `lo` to `hi` in MIDI, fractional):
 * - a note under 30 ms after the one before it, not struck (no rise in level into it), at the same pitch or one or
 *   two octaves from it, is that note held (read at another octave as it fades or as the bass comes in): it joins
 *   it, at its pitch
 * - octaves, when `octaves` (the melody, and the bass of a dense mix): a note 7 or more semitones from the median of
 *   the notes within 4 s around it (weighted by length) moves by an octave when that brings it at least 5 semitones
 *   closer and keeps it in range; a guitar's second harmonic, or a melody read at the period it shares with the bass,
 *   comes back to its line. Bass lines do jump octaves: on the test songs this lowered the bass's score (Twinkle 1.00
 *   to 0.92), on a distorted rock recording it halved the bass's jumps of 7 semitones or more
 * - notes under `NOTES.min` (150 ms) go, unless as sure as `NOTES.sure` (0.9): the short ones are mostly overtones
 *   and attacks of other instruments, and a show of blips sounds worse than a show of fewer notes. In a `dense` mix
 *   every short note goes, and so does any note less sure than `NOTES.denseGate` (0.7)
 * - a start within 40 ms of the `grid` (each beat and halfway between, eighth notes) moves onto it, its end kept
 */
export const cleanNotes = (input, {lo = 0, hi = 127, grid = [], dense = false, octaves = true} = {}) => {
  const notes = [];
  for (const n of input.map((x) => ({...x})).sort((a, b) => a.start - b.start)) {
    const last = notes[notes.length - 1];
    const apart = last ? Math.abs(last.midi - n.midi) : -1;
    if (last && !n.struck && (apart === 0 || apart === 12 || apart === 24) && n.start - (last.start + last.duration) < NOTES.join && n.start >= last.start) {
      last.duration = Math.max(last.duration, n.start + n.duration - last.start);
      continue;
    }
    notes.push(n);
  }
  const o = NOTES.octave;
  const orig = notes.map((n) => n.midi);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const vals = [];
    const ws = [];
    for (let j = i - 1; j >= 0 && n.start - notes[j].start <= o.window; j--) {
      vals.push(orig[j]);
      ws.push(notes[j].duration);
    }
    for (let j = i + 1; j < notes.length && notes[j].start - n.start <= o.window; j++) {
      vals.push(orig[j]);
      ws.push(notes[j].duration);
    }
    if (!octaves || !vals.length) continue;
    const med = weightedMedian(vals, ws);
    const off = Math.abs(n.midi - med);
    if (off < o.far) continue;
    for (const shift of [12, -12]) {
      const m = n.midi + shift;
      if (m < lo - 0.5 || m > hi + 0.5 || off - Math.abs(m - med) < o.gain) continue;
      n.midi = m;
      if (n.midiMeasured !== undefined) n.midiMeasured = Math.round((n.midiMeasured + shift) * 100) / 100;
      break;
    }
  }
  const gate = dense ? NOTES.denseGate : 0;
  const sure = dense ? Infinity : NOTES.sure;
  const kept = notes.filter((n) => n.confidence >= gate && (n.duration >= NOTES.min || n.confidence >= sure));
  let g = 0;
  for (const n of kept) {
    delete n.struck;
    while (g + 1 < grid.length && grid[g + 1] <= n.start) g++;
    let best = null;
    for (const t of [grid[g], grid[g + 1]]) if (t !== undefined && Math.abs(t - n.start) <= NOTES.grid && (best === null || Math.abs(t - n.start) < Math.abs(best - n.start))) best = t;
    if (best === null) continue;
    const end = n.start + n.duration;
    n.start = Math.max(0, best);
    n.duration = Math.max(0.001, end - n.start);
  }
  return kept;
};

/**
 * Melody and bass, told apart where they double each other at the same time (overlapping half the melody note). A
 * melody note an octave or two above a bass note is the bass's overtone: it goes. At the same pitch, if most bass
 * notes double the melody the song has no bass line of its own (a solo, a low voice): those bass notes go; otherwise
 * the melody track held the bass where the melody rests, and those melody notes go. Returns {melody, bass}.
 */
export const separateLines = (melody, bass) => {
  const twin = (m, b) => {
    const overlap = Math.min(m.start + m.duration, b.start + b.duration) - Math.max(m.start, b.start);
    return overlap > 0.5 * m.duration;
  };
  const unison = new Set();
  for (const b of bass) if (melody.some((m) => m.midi === b.midi && twin(m, b))) unison.add(b);
  const noBassLine = bass.length > 0 && unison.size > 0.5 * bass.length;
  const keptBass = noBassLine ? bass.filter((b) => !unison.has(b)) : bass;
  const keptMelody = melody.filter((m) => {
    for (const b of keptBass) {
      if (b.start >= m.start + m.duration) break;
      const apart = Math.abs(m.midi - b.midi);
      if (twin(m, b) && (apart === 12 || apart === 24 || (apart === 0 && !noBassLine))) return false;
    }
    return true;
  });
  return {melody: keptMelody, bass: keptBass};
};

// ---------- chords ----------

// templates as instruments sound them (Gomez 2006): each chord tone with its first 6 harmonics, each 0.6 of the one
// before, folded into pitch classes; plain 0 and 1 templates mistake the fifth's overtones for added ninths
const templates = () => {
  const out = [];
  for (const q of QUALITY_KEYS) {
    for (let root = 0; root < 12; root++) {
      const v = new Float64Array(12);
      for (const iv of QUALITIES[q]) {
        for (let h = 1; h <= CHORDS.harmonics; h++) v[(root + iv + Math.round(12 * Math.log2(h))) % 12] += CHORDS.decay ** (h - 1);
      }
      const n = Math.hypot(...v);
      for (let i = 0; i < 12; i++) v[i] /= n;
      out.push({root, quality: q, v});
    }
  }
  return out;
};
const NO_CHORD = 84;

/**
 * A chord for every beat: the chroma of the frames of each beat, summed and normalised; cosine similarity with 84
 * templates (12 roots by major, minor, dominant seventh, minor seventh, major seventh, sus2, sus4), or "no chord"
 * when the beat's energy is under 10 percent of the median; 0.1 more for a template whose root is the bass note at
 * the middle of the beat (`bassAt(i)`, a pitch class or -1); Viterbi over the beats with a self transition of 0.9,
 * the rest spread evenly, and log emissions of 40 times the similarity. Returns per beat {state, root, quality,
 * margin} (state NO_CHORD for no chord; margin, the best similarity less the second best) and the beats' energies.
 */
export const chordsOf = (chroma, energy, beatFrames, F, bassAt = () => -1) => {
  const TEMPLATES = templates();
  const nb = beatFrames.length;
  const vecs = [];
  const energies = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const a = beatFrames[i];
    const b = i + 1 < nb ? beatFrames[i + 1] : Math.min(F, a + (i ? a - beatFrames[i - 1] : 1));
    const v = new Float64Array(12);
    for (let f = a; f < Math.max(a + 1, b) && f < F; f++) {
      for (let p = 0; p < 12; p++) v[p] += chroma[f * 12 + p];
      energies[i] += energy[f];
    }
    energies[i] /= Math.max(1, b - a);
    const n = Math.hypot(...v);
    if (n > 0) for (let p = 0; p < 12; p++) v[p] /= n;
    vecs.push(v);
  }
  const quiet = CHORDS.quiet * median(energies);
  const S = NO_CHORD + 1;
  const emit = vecs.map((v, i) => {
    const e = new Float64Array(S);
    if (energies[i] < quiet) {
      e[NO_CHORD] = 1;
      return e;
    }
    const bassPc = bassAt(i);
    for (let s = 0; s < NO_CHORD; s++) {
      let dot = 0;
      for (let p = 0; p < 12; p++) dot += v[p] * TEMPLATES[s].v[p];
      e[s] = dot + (TEMPLATES[s].root === bassPc ? CHORDS.bass : 0);
    }
    return e;
  });
  // Viterbi
  const stay = Math.log(CHORDS.stay);
  const move = Math.log((1 - CHORDS.stay) / (S - 1));
  let prev = new Float64Array(S);
  const back = [];
  for (let s = 0; s < S; s++) prev[s] = CHORDS.sharp * (emit[0]?.[s] ?? 0);
  for (let i = 1; i < nb; i++) {
    let top = 0;
    for (let s = 1; s < S; s++) if (prev[s] > prev[top]) top = s;
    const cur = new Float64Array(S);
    const from = new Int16Array(S);
    for (let s = 0; s < S; s++) {
      const viaSelf = prev[s] + stay;
      const viaTop = prev[top] + move;
      if (viaSelf >= viaTop || top === s) {
        cur[s] = viaSelf;
        from[s] = s;
      } else {
        cur[s] = viaTop;
        from[s] = top;
      }
      cur[s] += CHORDS.sharp * emit[i][s];
    }
    back.push(from);
    prev = cur;
  }
  const path = new Int16Array(nb);
  if (nb) {
    let s = 0;
    for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
    path[nb - 1] = s;
    for (let i = nb - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]];
  }
  const beats = [];
  for (let i = 0; i < nb; i++) {
    const s = path[i];
    let first = 0;
    let second = 0;
    for (let k = 0; k < NO_CHORD; k++) {
      const v = emit[i][k];
      if (v > first) {
        second = first;
        first = v;
      } else if (v > second) second = v;
    }
    beats.push(s === NO_CHORD ? {state: s, root: -1, quality: null, margin: 0} : {state: s, root: TEMPLATES[s].root, quality: TEMPLATES[s].quality, margin: first - second});
  }
  return {beats, energies};
};

/** consecutive beats with the same chord as one chord: [{start, end, root, quality, margin, energy}] in seconds */
export const chordSpans = (beats, energies, beatTimes, end) => {
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const t1 = i + 1 < beatTimes.length ? beatTimes[i + 1] : end;
    const last = out[out.length - 1];
    if (last && last.state === b.state && last.end === beatTimes[i]) {
      last.end = t1;
      last.margins.push(b.margin);
      last.energies.push(energies[i]);
    } else out.push({state: b.state, root: b.root, quality: b.quality, start: beatTimes[i], end: t1, margins: [b.margin], energies: [energies[i]]});
  }
  return out
    .filter((c) => c.state !== NO_CHORD)
    .map((c) => ({
      start: c.start,
      end: c.end,
      root: c.root,
      quality: c.quality,
      margin: c.margins.reduce((s, v) => s + v, 0) / c.margins.length,
      energy: c.energies.reduce((s, v) => s + v, 0) / c.energies.length,
    }));
};

/** chords as notes: the root in MIDI 48 to 59, its other tones above it within the octave */
export const chordNotes = (spans) => {
  const loud = Math.sqrt(percentile(spans.map((c) => c.energy), 0.95)) || 1;
  const notes = [];
  for (const c of spans) {
    const root = 48 + c.root;
    const velocity = Math.max(0.2, Math.min(1, Math.sqrt(c.energy) / loud));
    const confidence = Math.max(0, Math.min(1, c.margin / CHORDS.margin));
    for (const iv of QUALITIES[c.quality]) {
      notes.push({start: c.start, duration: c.end - c.start, midi: root + iv, velocity, part: 'chords', confidence, source: 'audio'});
    }
  }
  return notes;
};

/**
 * Which beat of four is the first of a bar (4/4 assumed): the phase whose beats have the most percussive energy
 * below 150 Hz (each beat over the mean) plus the most chord changes.
 */
export const downbeatPhase = (low, changes) => {
  const n = low.length;
  const mean = low.reduce((s, v) => s + v, 0) / (n || 1) || 1;
  let best = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let s = 0;
    for (let i = phase; i < n; i += 4) s += low[i] / mean + (changes[i] ? 1 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = phase;
    }
  }
  return best;
};

// ---------- drums ----------

/**
 * Drum hits from percussive onsets. An onset is a drum when its percussive flux is at least 3 times the harmonic flux
 * and its percussive spectrum is spread 1,200 Hz or more or has half its energy below 150 Hz; otherwise it is a note
 * starting. Each hit's percussive energy
 * over three frames is split into shares: below 150 Hz, 150 to 2,000 Hz, above 5,000 Hz, and each is compared with
 * its median among the hits around it (31 hits), so a loud mix does not turn every hit into a kick. A kick's low share
 * is 0.1 over its median, or its largest. Of the others, a snare's middle share is 0.1 over the median of the other
 * hits that are not kicks around it, with a spectrum spread over 1,500 Hz. A hit like those around it is named by its
 * largest share: a hat above 5,000 Hz, in the middle a snare if spread wide, else 'other'. Velocity from onset
 * strength, confidence from the margin between the largest two shares.
 */
export const drumHits = (onsets, spec) => {
  const {band, spread, percFlux, harmFlux, F} = spec;
  const hits = [];
  for (const o of onsets) {
    const e = [0, 0, 0];
    let all = 0;
    let sp = 0;
    let ratio = 0;
    for (let f = o.frame; f < Math.min(F, o.frame + 3); f++) {
      for (let b = 0; b < 3; b++) e[b] += band[f * 4 + b];
      all += band[f * 4] + band[f * 4 + 1] + band[f * 4 + 2] + band[f * 4 + 3];
      sp = Math.max(sp, spread[f]);
    }
    for (let f = o.frame; f < Math.min(F, o.frame + 2); f++) ratio = Math.max(ratio, percFlux[f] / (harmFlux[f] + 1e-9));
    const share = e.map((v) => (all > 0 ? v / all : 0));
    if (ratio < DRUM_BANDS.ratio || (sp < DRUM_BANDS.broad && share[0] < DRUM_BANDS.low)) continue;
    hits.push({o, share, sp, drum: ''});
  }
  const around = DRUM_BANDS.around;
  const near = (i, band, keep) => {
    const vals = [];
    for (let j = Math.max(0, i - around); j <= Math.min(hits.length - 1, i + around); j++) if (keep(hits[j])) vals.push(hits[j].share[band]);
    return median(vals);
  };
  hits.forEach((h, i) => {
    const [low, mid, high] = h.share;
    if (low - near(i, 0, () => true) >= DRUM_BANDS.above || low >= Math.max(mid, high)) h.drum = 'kick';
  });
  hits.forEach((h, i) => {
    if (h.drum) return;
    const [, mid, high] = h.share;
    const broad = h.sp > DRUM_BANDS.spread;
    if (broad && mid - near(i, 1, (x) => x.drum !== 'kick') >= DRUM_BANDS.above) h.drum = 'snare';
    else if (high >= mid) h.drum = 'hat';
    else h.drum = broad ? 'snare' : 'other';
  });
  const loud = percentile(hits.map((h) => h.o.strength), 0.95) || 1;
  return hits.map((h) => {
    const sorted = h.share.slice().sort((p, q) => q - p);
    return {
      start: h.o.time,
      duration: 0.1,
      midi: DRUM_KEY[h.drum],
      velocity: Math.max(0.1, Math.min(1, h.o.strength / loud)),
      part: 'drums',
      drum: h.drum,
      confidence: Math.max(0, Math.min(1, sorted[0] - sorted[1])),
      source: 'audio',
    };
  });
};

// ---------- sections ----------

/**
 * Section starts, as beat indices: a feature per beat (its 12 chroma plus its loudness, scaled 0 to 0.5), cosine
 * self similarity, Foote novelty with a checkerboard kernel 32 beats wide tapered by a Gaussian (sigma 8 beats), peaks
 * over the mean plus one standard deviation, the strongest first, at least `minBeats` apart and from either end, at
 * most 15. Returns sorted beat indices.
 */
export const sectionsOf = (features, minBeats) => {
  const n = features.length;
  const half = SECTIONS.kernel / 2;
  const sim = (i, j) => {
    const a = features[i];
    const b = features[j];
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let k = 0; k < a.length; k++) {
      ab += a[k] * b[k];
      aa += a[k] * a[k];
      bb += b[k] * b[k];
    }
    return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
  };
  // near either end the kernel is cut to the same width on both sides: a kernel missing its past half sums only the
  // positive future block, and those edge values once set the threshold above every real change (a 189 s rock song,
  // novelty mean 3.6 and spread 8.9 from its ends, its section changes at about 5: one section)
  const nov = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, i, n - i);
    let s = 0;
    for (let a = -h; a < h; a++) {
      const ia = i + a;
      for (let b = -h; b < h; b++) {
        const ib = i + b;
        const sign = a < 0 === b < 0 ? 1 : -1;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * SECTIONS.sigma ** 2));
        s += sign * g * sim(ia, ib);
      }
    }
    nov[i] = s;
  }
  let m = 0;
  for (const v of nov) m += v;
  m /= n || 1;
  let v2 = 0;
  for (const v of nov) v2 += (v - m) ** 2;
  const cut = m + Math.sqrt(v2 / (n || 1));
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (nov[i] > cut && nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1]) peaks.push(i);
  }
  peaks.sort((a, b) => nov[b] - nov[a]);
  const kept = [];
  for (const p of peaks) {
    if (kept.length >= SECTIONS.max - 1) break;
    if (p < minBeats || p > n - minBeats) continue;
    if (kept.some((k) => Math.abs(k - p) < minBeats)) continue;
    kept.push(p);
  }
  return kept.sort((a, b) => a - b);
};

/** letters for sections: a section whose mean chroma matches an earlier one with cosine 0.9 or more takes its letter */
const labelSections = (means) => {
  const labels = [];
  let next = 0;
  means.forEach((v, i) => {
    let best = -1;
    let bestCos = SECTIONS.same;
    for (let j = 0; j < i; j++) {
      const w = means[j];
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let k = 0; k < 12; k++) {
        ab += v[k] * w[k];
        aa += v[k] * v[k];
        bb += w[k] * w[k];
      }
      const c = aa && bb ? ab / Math.sqrt(aa * bb) : 0;
      if (c >= bestCos) {
        bestCos = c;
        best = j;
      }
    }
    labels.push(best >= 0 ? labels[best] : String.fromCharCode(65 + (next++ % 26)));
  });
  return labels;
};

// ---------- the whole song ----------

/**
 * The whole analysis. samples: mono Float32Array at `sr` (22,050 Hz expected). onProgress(stage, fraction), where
 * fraction is of the whole analysis. Returns {timeline, info}: a checked Timeline whose notes are all `source:
 * 'audio'` (melody, bass, chords and drums, each its own track), tempo with `estimated: true`, bars and sections; and
 * info: {bpm, voiced, confidence, drumsOnly, noisy, chords, times (ms per stage), bytes (the most the large arrays
 * held at once)}.
 */
export const analyseAudio = (samples, sr = SR, onProgress = () => {}) => {
  if (!(samples instanceof Float32Array) || !samples.length) throw new Error('This file is silent.');
  const mem = counter();
  mem.bytes = samples.byteLength;
  mem.peak = mem.bytes;
  const times = {};
  let done = 0;
  let last = 0;
  const stage = (name) => {
    const t0 = now();
    const report = (fraction, force) => {
      const t = now();
      if (!force && t - last < 100) return;
      last = t;
      onProgress(name, Math.min(1, done + WEIGHT[name] * fraction));
    };
    report(0, true);
    return {
      tick: (fraction) => report(fraction, false),
      end: () => {
        times[name] = now() - t0;
        done += WEIGHT[name];
        report(0, true);
      },
    };
  };
  const duration = samples.length / sr;

  // spectrum, onsets, tempo and beats
  let st = stage('spectrum');
  const spec = spectrum(samples, sr, {mem, tick: st.tick});
  st.end();
  st = stage('beats');
  const fps = spec.fps;
  const fullOnsets = onsetPeaks(spec.fullFlux, fps);
  const percOnsets = onsetPeaks(spec.percFlux, fps);
  const harmOnsets = onsetPeaks(spec.harmFlux, fps);
  const env = onsetEnvelope(spec.fullFlux, fps);
  const {bpm, period} = tempoOf(env, fps);
  let beatFrames = beatTrack(env, period);
  // no beats where the song is silent, before its first sound or after its last
  const loudest = percentile(spec.energy, 0.5);
  let first = 0;
  while (first < spec.F && spec.energy[first] < 0.01 * loudest) first++;
  let lastF = spec.F - 1;
  while (lastF > 0 && spec.energy[lastF] < 0.01 * loudest) lastF--;
  beatFrames = beatFrames.filter((f) => f >= first - period / 4 && f <= lastF);
  const beatTimes = beatFrames.map((f) => f / fps + ONSET.lag);
  st.end();

  // melody and bass
  // the melody is followed above the bass: on the whole harmonic part YIN finds the period melody and bass share,
  // and a melody below 250 Hz still repeats at its own period in its harmonics
  st = stage('melody');
  const high = mem.take(butterworth(spec.harm, sr, YIN.cut, true));
  const melTrack = yinTrack(high, sr, {window: YIN.window, hop: YIN.hop, lo: YIN.melodySearch[0], hi: YIN.melodySearch[1]}, st.tick);
  mem.free(high);
  st.end();
  st = stage('bass');
  const low = mem.take(butterworth(spec.harm, sr, YIN.cut));
  const D = YIN.decimate;
  const dec = mem.make(Float32Array, Math.floor(low.length / D));
  for (let i = 0; i < dec.length; i++) dec[i] = low[i * D];
  mem.free(low);
  const bassTrack = yinTrack(dec, sr / D, {window: YIN.bassWindow, hop: YIN.hop / D, lo: YIN.bassSearch[0], hi: YIN.bassSearch[1]}, st.tick);
  st.end();

  // how much of the song has a pitch, and how sure the melody is
  let sounding = 0;
  let voiced = 0;
  let confSum = 0;
  for (let k = 0; k < melTrack.hz.length; k++) {
    if (melTrack.rms[k] < SONG.silent) continue;
    sounding++;
    confSum += melTrack.conf[k];
    if (melTrack.conf[k] >= YIN.keep) voiced++;
  }
  const voicedShare = sounding ? voiced / sounding : 0;
  const confidence = sounding ? confSum / sounding : 0;
  const drumsOnly = voicedShare < SONG.voiced;
  // the share of the sound's energy in the percussive part: drums, and the noise of distorted guitars
  let percE = 0;
  let allE = 0;
  for (let f = 0; f < spec.F; f++) {
    allE += spec.energy[f];
    for (let b = 0; b < 4; b++) percE += spec.band[f * 4 + b];
  }
  const percussive = allE > 0 ? percE / allE : 0;
  // a dense mix (a band with distorted guitars): few frames with a clear pitch and much of the sound percussive. The
  // melody heard in it is mostly other instruments' overtones, so the page plays it simple (melody muted) and the
  // notes of both lines must be surer. On the test songs the voiced share is 0.98 or more and the percussive share
  // 0.06 or less; on a distorted rock recording 0.40 and 0.26
  const dense = !drumsOnly && voicedShare < SONG.dense.voiced && percussive >= SONG.dense.percussive;

  // the drums first: a kick rings low, so the bass's pitch is not trusted for a moment after one
  st = stage('drums');
  const drums = drumHits(percOnsets, spec);
  st.end();
  const kicks = drums.filter((d) => d.drum === 'kick').map((d) => [d.start - 0.01, d.start + DRUM_BANDS.ring]);
  // eighth notes: each beat and the point halfway to the next
  const grid = [];
  beatTimes.forEach((t, i) => {
    grid.push(t);
    if (i + 1 < beatTimes.length) grid.push((t + beatTimes[i + 1]) / 2);
  });
  const {melody, bass} = separateLines(
    framesToNotes(melTrack, {lo: YIN.melody[0], hi: YIN.melody[1], part: 'melody', onsets: harmOnsets, grid, dense}),
    framesToNotes(bassTrack, {lo: YIN.bass[0], hi: YIN.bass[1], part: 'bass', onsets: harmOnsets, skip: kicks, grid, dense}),
  );

  // chords, and the bars from the beats
  st = stage('chords');
  const chroma = chromaFrames(spec.harm, sr, spec.F, {mem});
  // the bass note at the middle of each beat, as a pitch class: the root, most often
  const bassAt = (i) => {
    const t = i + 1 < beatTimes.length ? (beatTimes[i] + beatTimes[i + 1]) / 2 : beatTimes[i] + period / fps / 2;
    const n = bass.find((b) => b.start <= t && t < b.start + b.duration);
    return n ? n.midi % 12 : -1;
  };
  const {beats: chordBeats, energies} = chordsOf(chroma, spec.energy, beatFrames, spec.F, bassAt);
  const spans = chordSpans(chordBeats, energies, beatTimes, duration);
  const lowPerc = beatFrames.map((f) => {
    let s = 0;
    for (let k = Math.max(0, f - 1); k < Math.min(spec.F, f + 3); k++) s += spec.band[k * 4];
    return s;
  });
  const changes = chordBeats.map((b, i) => i > 0 && b.state !== chordBeats[i - 1].state);
  const phase = downbeatPhase(lowPerc, changes);
  const bars = beatTimes.filter((_, i) => i % 4 === phase);
  st.end();

  // sections, from beat features, snapped to bar lines
  st = stage('sections');
  let loudMin = Infinity;
  let loudMax = -Infinity;
  const loudness = energies.map((e) => Math.log10(e + 1e-12));
  for (const v of loudness) {
    loudMin = Math.min(loudMin, v);
    loudMax = Math.max(loudMax, v);
  }
  const features = beatFrames.map((a, i) => {
    const b = i + 1 < beatFrames.length ? beatFrames[i + 1] : a + 1;
    const v = new Float64Array(13);
    for (let f = a; f < b && f < spec.F; f++) for (let p = 0; p < 12; p++) v[p] += chroma[f * 12 + p];
    const n = Math.hypot(...v.subarray(0, 12)) || 1;
    for (let p = 0; p < 12; p++) v[p] /= n;
    v[12] = loudMax > loudMin ? (0.5 * (loudness[i] - loudMin)) / (loudMax - loudMin) : 0;
    return v;
  });
  const cuts = sectionsOf(features, SECTIONS.minBars * 4);
  const barIdx = beatTimes.map((_, i) => i).filter((i) => i % 4 === phase);
  const starts = [];
  for (const c of cuts) {
    let best = barIdx[0] ?? c;
    for (const b of barIdx) if (Math.abs(b - c) < Math.abs(best - c)) best = b;
    if (best > 0 && !starts.includes(best)) starts.push(best);
  }
  starts.sort((a, b) => a - b);
  const bounds = [0, ...starts.map((i) => beatTimes[i]), duration];
  const means = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const v = new Float64Array(12);
    beatTimes.forEach((t, i) => {
      if (t >= bounds[s] && t < bounds[s + 1]) for (let p = 0; p < 12; p++) v[p] += features[i][p];
    });
    means.push(v);
  }
  const labels = labelSections(means);
  const sections = labels.map((label, i) => ({start: bounds[i], end: bounds[i + 1], label}));
  st.end();

  let notes = drumsOnly ? drums : [...melody, ...bass, ...chordNotes(spans), ...drums];
  if (notes.length > MAX_NOTES) notes = notes.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_NOTES);
  const parts = ['melody', 'bass', 'chords', 'drums'];
  const names = {melody: 'Melody', bass: 'Bass', chords: 'Chords', drums: 'Drums'};
  const used = parts.filter((p) => notes.some((n) => n.part === p));
  const trackOf = new Map(used.map((p, i) => [p, i]));
  // times to the millisecond, as a song link keeps them: a note snapped to the grid can start 1e-14 s from a drum hit,
  // and the two must sort the same way before and after a link
  const ms = (t) => Math.round(t * 1000) / 1000;
  notes = notes.map((n) => ({...n, start: ms(n.start), duration: Math.max(0.04, ms(n.duration)), track: trackOf.get(n.part)}));
  const timeline = validateTimeline({
    notes,
    tempo: {bpm, beats: beatTimes, estimated: true},
    bars,
    sections,
    duration,
    title: 'Untitled',
    tracks: used.map((p) => ({name: names[p], part: p, notes: notes.filter((n) => n.part === p).length})),
  });
  onProgress('done', 1);
  return {
    timeline,
    info: {
      bpm,
      voiced: voicedShare,
      confidence,
      drumsOnly,
      noisy: !drumsOnly && confidence < SONG.noisy,
      dense,
      percussive,
      chords: spans.map(({start, end, root, quality}) => ({start, end, root, quality})),
      onsets: fullOnsets.length,
      times,
      bytes: mem.peak,
    },
  };
};

export {STAGES};
