// A real FFT: iterative radix 2, with its twiddles and bit reversal table worked out once for its size. A real signal
// of n samples is packed into a complex one of n / 2 (even samples real, odd ones imaginary), transformed, and split
// back into the n / 2 + 1 bins of the real spectrum. Float64Array throughout. Plain JavaScript, so Node runs it.

export class RealFFT {
  /** n: a power of two, at least 4 */
  constructor(n) {
    if (!(n >= 4) || (n & (n - 1)) !== 0) throw new Error('The FFT size must be a power of two.');
    this.n = n;
    const m = n >> 1;
    this.m = m;
    this.rev = new Uint32Array(m);
    for (let i = 0, bits = Math.log2(m); i < m; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    // twiddles of the half size complex transform, and of the split into the real spectrum
    this.cos = new Float64Array(m >> 1 || 1);
    this.sin = new Float64Array(m >> 1 || 1);
    for (let i = 0; i < m >> 1; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / m);
      this.sin[i] = Math.sin((2 * Math.PI * i) / m);
    }
    this.wr = new Float64Array(m + 1);
    this.wi = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      this.wr[k] = Math.cos((2 * Math.PI * k) / n);
      this.wi[k] = Math.sin((2 * Math.PI * k) / n);
    }
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
  }

  /** the complex transform of zr + i zi in place; sign -1 forward, +1 inverse (not scaled) */
  complex(sign) {
    const {m, rev, cos, sin, zr, zi} = this;
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      if (j > i) {
        let t = zr[i];
        zr[i] = zr[j];
        zr[j] = t;
        t = zi[i];
        zi[i] = zi[j];
        zi[j] = t;
      }
    }
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1;
      const step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const c = cos[t];
          const s = sign * sin[t];
          const a = start + k;
          const b = a + half;
          const xr = zr[b] * c - zi[b] * s;
          const xi = zr[b] * s + zi[b] * c;
          zr[b] = zr[a] - xr;
          zi[b] = zi[a] - xi;
          zr[a] += xr;
          zi[a] += xi;
        }
      }
    }
  }

  /** x: n real samples; re, im: n / 2 + 1 bins of its spectrum, X[k] = sum x[j] e^(-2 pi i j k / n) */
  forward(x, re, im) {
    const {m, zr, zi, wr, wi} = this;
    for (let i = 0; i < m; i++) {
      zr[i] = x[2 * i];
      zi[i] = x[2 * i + 1];
    }
    this.complex(-1);
    for (let k = 0; k <= m; k++) {
      const a = k % m;
      const b = (m - k) % m;
      // the even and odd halves, from Z[k] and the conjugate of Z[m - k]
      const er = 0.5 * (zr[a] + zr[b]);
      const ei = 0.5 * (zi[a] - zi[b]);
      const or = 0.5 * (zi[a] + zi[b]);
      const oi = -0.5 * (zr[a] - zr[b]);
      // X[k] = E[k] + e^(-2 pi i k / n) O[k]
      re[k] = er + wr[k] * or + wi[k] * oi;
      im[k] = ei + wr[k] * oi - wi[k] * or;
    }
  }

  /** re, im: n / 2 + 1 bins; x: the n real samples they are the spectrum of (scaled by 1 / n) */
  inverse(re, im, x) {
    const {m, zr, zi, wr, wi} = this;
    for (let k = 0; k < m; k++) {
      const j = m - k;
      // E[k] = (X[k] + conj X[m - k]) / 2, O[k] = (X[k] - conj X[m - k]) e^(2 pi i k / n) / 2
      const er = 0.5 * (re[k] + re[j]);
      const ei = 0.5 * (im[k] - im[j]);
      const dr = 0.5 * (re[k] - re[j]);
      const di = 0.5 * (im[k] + im[j]);
      const or = dr * wr[k] - di * wi[k];
      const oi = dr * wi[k] + di * wr[k];
      // Z[k] = E[k] + i O[k]
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.complex(1);
    const s = 1 / m;
    for (let i = 0; i < m; i++) {
      x[2 * i] = zr[i] * s;
      x[2 * i + 1] = zi[i] * s;
    }
  }
}

/** a periodic Hann window: shifted copies at a hop of n / 4 or n / 8 add up to a constant */
export const hann = (n) => {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
};
