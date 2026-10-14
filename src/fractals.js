// Every fractal in the explorer, in one place. Each entry carries its formula twice, side by side: `step` in float64
// JavaScript for the sound, the period readout and the drawn orbit, and `glsl` for the picture on the GPU. Keep the
// two in step when editing.
//
// This module is shared by the page and the audio worklet, so what you see and what you hear are the same numbers.
// The first eight maps and the synthesis follow CodeParade's Fractal Sound Explorer (MIT); the rest are added here.
//
// Conventions, as in the original:
//   - a point of the picture is c. Unless `start` is given, its orbit starts at z0 = c. For the maps in the Mandelbrot
//     family that is the same orbit as starting at 0, one step later.
//   - `start` fixes z0 instead (the critical point, for families where it is not 0, or the usual seed of a map),
//     so the picture is the true parameter plane.
//   - in Julia mode c is held fixed and every point of the picture is a z0.
//   - `param` is one extra constant the user can slide. It reaches step() as k and the shader as uP.
//   - `bounded` maps never escape, so the plain picture would be one flat tone; they are shaded by their orbits.
//     `shadeInside` does the same for maps that do escape but whose inside is a large, otherwise flat region.
//   - `normalized` maps are heard as the orbit's direction from c, so far-flung and tight orbits are equally loud.

export const ESCAPE_SQ = 1000;

/** Default iteration rate of the orbit, in steps per second. Period p is heard at rate / p hertz. */
export const RATE = 4000;

export const families = [
  {key: 'mandel', short: 'Mandelbrot family', name: 'The Mandelbrot set and its cousins', note: 'Polynomials and their relatives. Their stable regions are cycles, so they play clean notes.'},
  {key: 'ship', short: 'Burning ship', name: 'The burning ship family', note: 'One absolute value breaks the symmetry, and stable chaos appears: growls, breaths, engines.'},
  {key: 'parade', short: 'Inventions', name: 'Two inventions', note: 'Shapes made up for their sound in the original Fractal Sound Explorer.'},
  {key: 'maps', short: 'Chaotic maps', name: 'Chaotic maps', note: 'Physics and dynamics. Here c holds the two constants of the map, and every point is a different system.'},
];

export const fractals = [
  // ---------- the Mandelbrot set and its cousins ----------
  {
    key: 'mandelbrot',
    family: 'mandel',
    name: 'Mandelbrot set',
    formula: 'z² + c',
    note: 'Inside the set every orbit settles into a cycle. Each bulb is a different period, so each bulb is a different note.',
    view: {cx: -0.6, cy: 0, span: 2.6},
    normalized: true,
    step(x, y, cx, cy, out) {
      out[0] = x * x - y * y + cx;
      out[1] = 2 * x * y + cy;
    },
    glsl: 'return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;',
  },
  // ---------- the burning ship family ----------
  {
    key: 'burning-ship',
    family: 'ship',
    name: 'Burning ship',
    formula: '(|Re z| + i |Im z|)² + c',
    note: 'One absolute value, and the chaotic regions become stable. Some of them sound like something breathing.',
    view: {cx: -0.45, cy: -0.5, span: 2.9},
    step(x, y, cx, cy, out) {
      out[0] = x * x - y * y + cx;
      out[1] = 2 * Math.abs(x * y) + cy;
    },
    glsl: 'return vec2(z.x * z.x - z.y * z.y, 2.0 * abs(z.x * z.y)) + c;',
  },
  // ---------- CodeParade's two inventions ----------
  {
    key: 'feather',
    family: 'parade',
    name: 'Feather',
    formula: 'z³ / (1 + z·z) + c',
    note: 'Clusters everywhere, each with its own note. Zoom in to find the intervals between them, like an endless piano.',
    view: {cx: 0, cy: 0, span: 3.4},
    step(x, y, cx, cy, out) {
      // z³ / (1 + (x², y²)): the denominator squares each part separately, as in the original
      const x2 = x * x;
      const y2 = y * y;
      const d = x2 - y2;
      const ax = x * (d - y2 - y2);
      const ay = y * (x2 + x2 + d);
      const bx = 1 + x2;
      const by = y2;
      const inv = 1 / (bx * bx + by * by);
      out[0] = (ax * bx + ay * by) * inv + cx;
      out[1] = (ay * bx - ax * by) * inv + cy;
    },
    glsl: 'return cdiv(ccube(z), vec2(1.0, 0.0) + z * z) + c;',
  },
  {
    key: 'sfx',
    family: 'parade',
    name: 'Sound effects',
    formula: 'z |z|² − z · (Re c², Im c²)',
    note: 'Not much to look at, but its orbits have a strange symmetry. Lasers, coins, alarms: try Save sound on the good ones.',
    view: {cx: 0, cy: 0, span: 3.2},
    step(x, y, cx, cy, out) {
      const m = x * x + y * y;
      const ax = cx * cx;
      const ay = cy * cy;
      out[0] = x * m - (x * ax - y * ay);
      out[1] = y * m - (x * ay + y * ax);
    },
    glsl: 'return z * dot(z, z) - cmul(z, c * c);',
  },

  // ---------- chaotic maps ----------
  {
    key: 'henon',
    family: 'maps',
    name: 'Hénon map',
    formula: '(1 − a x² + y,  b x)',
    note: 'The classic strange attractor of 1976. Here c = (a, b) and the orbit starts at c too.',
    view: {cx: 0.41, cy: 0, span: 2.7},
    step(x, y, cx, cy, out) {
      out[0] = 1 - cx * x * x + y;
      out[1] = cy * x;
    },
    glsl: 'return vec2(1.0 - c.x * z.x * z.x + z.y, c.y * z.x);',
  },
  {
    key: 'duffing',
    family: 'maps',
    name: 'Duffing map',
    formula: '(y,  −b x + a y − y³)',
    note: 'A driven spring with a stiff cubic term. Near the edges of its stable region it buzzes and growls.',
    view: {cx: 0.9, cy: 0, span: 6.8},
    step(x, y, cx, cy, out) {
      out[0] = y;
      out[1] = -cy * x + cx * y - y * y * y;
    },
    glsl: 'return vec2(z.y, -c.y * z.x + c.x * z.y - z.y * z.y * z.y);',
  },
  {
    key: 'ikeda',
    family: 'maps',
    name: 'Ikeda map',
    formula: 't = 0.4 − 6 / (1 + |z|²),  1 + a z e^(it)',
    note: 'Light circling inside a ring cavity. The bounded island in the middle is all spirals, and every turn of them is a different timbre.',
    view: {cx: 0, cy: 0, span: 4.4},
    step(x, y, cx, cy, out) {
      const t = 0.4 - 6 / (1 + x * x + y * y);
      const st = Math.sin(t);
      const ct = Math.cos(t);
      out[0] = 1 + cx * (x * ct - y * st);
      out[1] = cy * (x * st + y * ct);
    },
    glsl: 'float t = 0.4 - 6.0 / (1.0 + dot(z, z)); float st = sin(t), ct = cos(t); return vec2(1.0 + c.x * (z.x * ct - z.y * st), c.y * (z.x * st + z.y * ct));',
  },
  {
    key: 'chirikov',
    family: 'maps',
    name: 'Chirikov map',
    formula: 'y += b sin x,  x += a y',
    note: 'The standard map of a kicked rotor. Its Julia orbits form continuums, so sliding the point bends the sound.',
    view: {cx: 0, cy: 0, span: 7.2},
    step(x, y, cx, cy, out) {
      const ny = y + cy * Math.sin(x);
      out[0] = x + cx * ny;
      out[1] = ny;
    },
    glsl: 'z.y += c.y * sin(z.x); z.x += c.x * z.y; return z;',
  },
];

/** The current value of a fractal's slider, or 0 when it has none. */
export const paramOf = (f, values) => (f.param ? values?.[f.key] ?? f.param.value : 0);

/**
 * Where the orbit of a pressed point starts, and its constant. In the fractal itself the point is c; in a Julia set
 * c is held and the point is z0.
 */
export const orbitOf = (f, point, julia) => {
  if (julia) return {z0: point, c: julia};
  return {z0: f.start || point, c: point};
};

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const noteName = (hz) => {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100);
  return {name: `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, cents};
};

/**
 * What the orbit does, measured in float64: escapes after n steps, settles into a cycle of period p,
 * or wanders with no repeat we can find (chaos, or a cycle too long to hear as a pitch).
 */
export const analyse = (f, z0, c, k) => {
  const out = [0, 0];
  let [x, y] = z0;
  const [cx, cy] = c;
  const settle = 6000;
  for (let i = 0; i < settle; i++) {
    f.step(x, y, cx, cy, out, k);
    x = out[0];
    y = out[1];
    if (!(x * x + y * y <= ESCAPE_SQ)) return {kind: 'escape', steps: i + 1};
  }
  const maxP = 2000;
  const ax = x;
  const ay = y;
  // the tolerance follows the orbit's own size, so tiny orbits near a fixed point still count as cycles
  let size = 0;
  const xs = new Float64Array(maxP);
  const ys = new Float64Array(maxP);
  for (let p = 1; p <= maxP; p++) {
    f.step(x, y, cx, cy, out, k);
    x = out[0];
    y = out[1];
    if (!(x * x + y * y <= ESCAPE_SQ)) return {kind: 'escape', steps: settle + p};
    xs[p - 1] = x;
    ys[p - 1] = y;
    size = Math.max(size, Math.abs(x - ax), Math.abs(y - ay));
    const tol = 1e-7 * Math.max(size, 1e-6) + 1e-12;
    if (Math.abs(x - ax) < tol && Math.abs(y - ay) < tol) {
      // confirm: a whole second lap must match too
      let ok = true;
      let qx = x;
      let qy = y;
      for (let j = 0; j < p && ok; j++) {
        f.step(qx, qy, cx, cy, out, k);
        qx = out[0];
        qy = out[1];
        if (Math.abs(qx - xs[j]) > tol * 10 || Math.abs(qy - ys[j]) > tol * 10) ok = false;
      }
      if (ok) return {kind: 'cycle', period: p};
    }
  }
  return {kind: 'chaos'};
};
