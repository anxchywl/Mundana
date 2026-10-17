// The picture, drawn on the GPU with WebGL2 in float32. Float32 is why the zoom stops at about 1 / 50,000 of the
// starting view: past that the pixels run out of digits. The sound is computed separately in float64.
//
// The look is an engraved map: the set is one flat tone, and every escape count outside it is a thin paper contour
// line. Where the lines get too dense to read they merge into a quiet tone. With "orbit tones" on, the inside is shaded by what its orbits do.
//
// While the view is still, frames are re-rendered with a sub-pixel jitter and blended, so the image sharpens.
//
// Each fractal gets its own compiled program, its formula pasted in from fractals.js, so no time is spent choosing
// between formulas inside the loop. Programs are compiled the first time a fractal is shown.
//
// Switching fractals morphs: a second kind of program holds two formulas and steps with a blend of both,
// (1 − t) A(z, c) + t B(z, c), while t runs from 0 to 1. Every frame of the switch is a real fractal in between.

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// one formula, or two blended by uT. Each body reads its own slider as uP, a local copy of uPA or uPB
const stepCode = (a, b) =>
  b
    ? `vec2 stepA(vec2 z, vec2 c) { float uP = uPA; ${a} }
vec2 stepB(vec2 z, vec2 c) { float uP = uPB; ${b} }
vec2 mapStep(vec2 z, vec2 c) { return mix(stepA(z, c), stepB(z, c), uT); }`
    : `vec2 mapStep(vec2 z, vec2 c) { float uP = uPA; ${a} }`;

const frag = (a, b) => `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uSpan;
uniform float uPA, uPB;    // the sliders of the fractal (A) and, while morphing, of the one it becomes (B)
uniform float uT;          // morph position, 0 = A, 1 = B
uniform int uHasStartA, uHasStartB; // 1: orbits start at uStart instead of at the point itself
uniform vec2 uStartA, uStartB;
uniform int uBounded;      // nothing escapes: the plain picture is shaded by orbits instead of one flat tone
uniform int uIters;
uniform int uDrawM, uDrawJ, uColor;
uniform vec2 uJulia;
uniform vec2 uJitter;
uniform float uAlpha;
uniform float uK;
uniform vec3 cGround, cInside, cLine, cBand, cBlue, cPaper;

const float ESCAPE = 10000.0;
// shading is scaled to a fixed depth, not to this frame's step count, so quick frames and full frames look alike
const float DEPTH = 1000.0;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }
vec2 ccube(vec2 a) {
  float x2 = a.x * a.x, y2 = a.y * a.y, d = x2 - y2;
  return vec2(a.x * (d - y2 - y2), a.y * (x2 + x2 + d));
}

${stepCode(a, b)}

// count of steps to escape (uIters if it never does). For an orbit that stays, shape describes how it moves:
// x its mean step length, y its mean turning (1 carries straight on, -1 doubles straight back), z its mean reach
int run(vec2 z, vec2 c, out vec3 shape) {
  vec2 d0 = vec2(0.0);
  shape = vec3(0.0);
  for (int i = 0; i < 20000; i++) {
    if (i >= uIters) break;
    vec2 next = mapStep(z, c);
    if (dot(next, next) > ESCAPE) return i;
    vec2 d1 = next - z;
    float len = length(d1);
    shape.x += len;
    shape.y += dot(d0, d1) / (length(d0) * len + 1e-12);
    shape.z += length(next);
    d0 = d1;
    z = next;
  }
  shape /= float(uIters);
  return uIters;
}

int count(vec2 z, vec2 c) {
  for (int i = 0; i < 20000; i++) {
    if (i >= uIters) return uIters;
    z = mapStep(z, c);
    if (dot(z, z) > ESCAPE) return i;
  }
  return uIters;
}

float band(int n) { return floor(log2(float(n) + 1.0) * 5.0); }

vec2 toPlane(vec2 frag) {
  vec2 d = frag - 0.5 * uRes;
  return uCenter + vec2(d.x, -d.y) / min(uRes.x, uRes.y) * uSpan;
}

// julia 0: the point is c and the orbit starts at z0 (the point itself, or the fractal's fixed start).
// julia 1: c is held at uJulia and the point is z0
vec2 startOf(vec2 p, int julia) {
  if (julia == 1) return p;
  return mix(uHasStartA == 1 ? uStartA : p, uHasStartB == 1 ? uStartB : p, uT);
}

vec3 shade(vec2 frag, int julia) {
  vec2 p = toPlane(frag);
  vec2 c = julia == 1 ? uJulia : p;
  vec3 sumz;
  int n = run(startOf(p, julia), c, sumz);
  int mode = uColor == 0 && uBounded == 1 ? 1 : uColor;
  bool colour = mode == 1;
  if (n >= uIters) {
    if (mode == 0) return cInside;
    float stride = 1.0 - exp(-2.5 * sumz.x); // 0 for a still point, towards 1 for big leaps
    float turn = 0.5 - 0.5 * sumz.y; // 0 carries on, 1 doubles back, as a period 2 orbit does
    float reach = 1.0 - exp(-0.6 * sumz.z);
    if (mode == 2) {
      // vivid: a cosine palette whose hue follows how the orbit turns and how far it strides
      vec3 hue = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + 0.85 * turn + 0.45 * stride));
      return hue * (0.3 + 0.7 * mix(stride, 1.0, 0.4)) * (0.6 + 0.4 * reach);
    }
    // tones: brightness from the stride, a blue cast where the orbit doubles back
    vec3 base = mix(cInside, cBand, stride);
    base = mix(base, cPaper, 0.3 * stride * reach);
    return mix(base, cBlue * (0.7 + 0.5 * stride), 0.55 * smoothstep(0.35, 1.0, turn) * stride);
  }
  if (mode == 2) {
    // dim bands outside, so the coloured inside carries the picture
    return (0.5 + 0.5 * cos(6.28318 * (vec3(0.6, 0.7, 0.8) + float(n) * 0.04))) * 0.12;
  }
  // outside: the contour map. Neighbours one output pixel away tell us whether a count line passes here
  float px = uSpan / min(uRes.x, uRes.y) * uK;
  vec2 pr = p + vec2(px, 0.0), pu = p + vec2(0.0, px);
  int nr = count(startOf(pr, julia), julia == 1 ? uJulia : pr);
  int nu = count(startOf(pu, julia), julia == 1 ? uJulia : pu);
  // lines follow log-spaced bands of the count, so slow-escaping maps (counts in the hundreds, different at every
  // pixel) read as a quiet tone instead of a field of lines. Low counts still get one line each
  float d = max(abs(band(nr) - band(n)), abs(band(nu) - band(n)));
  float line = d >= 1.0 ? 1.0 : 0.0;
  float dense = smoothstep(1.0, 2.5, d);
  float a = mix(line * 0.5, 0.08, dense);
  float lift = smoothstep(0.0, 1.0, log(float(n) + 1.0) / log(DEPTH + 1.0) * 1.6);
  float strength = colour ? 0.45 : 1.0;
  vec3 col = mix(cGround, cBand, 0.2 * lift * strength);
  bool edge = nr >= uIters || nu >= uIters;
  // the set's edge is one crisp line where the outside escapes quickly, and fades where bounded and slow-escaping
  // points are mixed at pixel scale (fine streaks of a slow-escaping map), which would otherwise be a wall of edges
  float edgeA = 0.85 * (1.0 - smoothstep(0.03, 0.3, float(n) / DEPTH));
  return mix(col, cLine, (edge ? max(edgeA, a) : a) * strength);
}

void main() {
  vec2 frag = gl_FragCoord.xy + uJitter;
  vec3 col = vec3(0.0);
  if (uDrawM == 1) col += shade(frag, 0);
  if (uDrawJ == 1) col += shade(frag, 1);
  if (uDrawM == 1 && uDrawJ == 1) col *= 0.5;
  outColor = vec4(col, uAlpha);
}`;

const UNIFORMS = [
  'uRes', 'uCenter', 'uSpan', 'uPA', 'uPB', 'uT', 'uHasStartA', 'uHasStartB', 'uStartA', 'uStartB', 'uBounded', 'uIters', 'uDrawM', 'uDrawJ', 'uColor', 'uJulia', 'uJitter', 'uAlpha', 'uK',
  'cGround', 'cInside', 'cLine', 'cBand', 'cBlue', 'cPaper',
];

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// the palette: ink, paper, stone and one blue
const PALETTE = {
  cGround: rgb('#0B0B0C'),
  cInside: rgb('#222225'),
  cLine: rgb('#F7F1E9'),
  cBand: rgb('#817C7A'),
  cBlue: rgb('#3E7C8F'),
  cPaper: rgb('#F7F1E9'),
};

const compile = (gl, type, src) => {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
};

// a fixed low-discrepancy sequence of sub-pixel offsets, so the sharpening converges evenly
const halton = (i, b) => {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
};

export const MAX_FRAMES = 48;
// compiled programs kept at once; morphs between many pairs would otherwise pile up in GPU memory
const MAX_PROGRAMS = 32;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {alpha: false, antialias: false, preserveDrawingBuffer: true, depth: false});
    if (!gl) throw new Error('This browser has no WebGL2.');
    this.gl = gl;
    this.k = 1;
    this.lost = false;
    this.init();
    // phones and drivers can drop the GPU context at any time; keep the canvas and rebuild when it comes back
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      this.onRestore?.();
    });
  }

  /** everything that lives on the GPU, created again after a lost context */
  init() {
    const {gl} = this;
    this.vert = compile(gl, gl.VERTEX_SHADER, VERT);
    this.programs = new Map();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** the compiled program for one fractal, or for a morph from f to g, built on first use */
  program(f, g = null) {
    const key = g ? `${f.key}>${g.key}` : f.key;
    let p = this.programs.get(key);
    if (p) {
      // most recently used goes to the back of the queue
      this.programs.delete(key);
      this.programs.set(key, p);
      return p;
    }
    const {gl} = this;
    if (this.programs.size >= MAX_PROGRAMS) {
      const [oldKey, old] = this.programs.entries().next().value;
      gl.deleteProgram(old.prog);
      this.programs.delete(oldKey);
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, this.vert);
    const fs = compile(gl, gl.FRAGMENT_SHADER, frag(f.glsl, g?.glsl));
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    // the shader object is not needed once linked
    gl.detachShader(prog, fs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`${key}: ${log}`);
    }
    gl.useProgram(prog);
    const loc = {};
    for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(prog, u);
    for (const [k, v] of Object.entries(PALETTE)) gl.uniform3fv(loc[k], v);
    p = {prog, loc, attr: gl.getAttribLocation(prog, 'p')};
    this.programs.set(key, p);
    return p;
  }

  resize(w, h, k) {
    this.k = k;
    this.canvas.width = Math.round(w * k);
    this.canvas.height = Math.round(h * k);
  }

  /** frame 0 draws fresh; later frames add a jittered sample to the running average.
   *  With s.morph = {to, param, t} the picture is the blend from s.fractal toward s.morph.to */
  draw(s, frame) {
    const {gl} = this;
    if (this.lost || gl.isContextLost()) return;
    const m = s.morph;
    const {prog, loc, attr} = this.program(s.fractal, m?.to);
    gl.useProgram(prog);
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const f = s.fractal;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(loc.uRes, w, h);
    gl.uniform2f(loc.uCenter, s.cx, s.cy);
    gl.uniform1f(loc.uSpan, s.span);
    const g = m ? m.to : f;
    gl.uniform1f(loc.uPA, s.param);
    gl.uniform1f(loc.uPB, m ? m.param : s.param);
    gl.uniform1f(loc.uT, m ? m.t : 0);
    gl.uniform1i(loc.uHasStartA, f.start ? 1 : 0);
    gl.uniform2f(loc.uStartA, f.start ? f.start[0] : 0, f.start ? f.start[1] : 0);
    gl.uniform1i(loc.uHasStartB, g.start ? 1 : 0);
    gl.uniform2f(loc.uStartB, g.start ? g.start[0] : 0, g.start ? g.start[1] : 0);
    // the inside switches its shading halfway through, when the picture is more the new fractal than the old
    const shaded = (x) => (x.bounded || x.shadeInside ? 1 : 0);
    gl.uniform1i(loc.uBounded, m && m.t > 0.5 ? shaded(g) : shaded(f));
    gl.uniform1i(loc.uIters, s.iters);
    gl.uniform1i(loc.uDrawM, s.drawM ? 1 : 0);
    gl.uniform1i(loc.uDrawJ, s.drawJ ? 1 : 0);
    gl.uniform1i(loc.uColor, s.colour);
    gl.uniform2f(loc.uJulia, s.julia ? s.julia[0] : 0, s.julia ? s.julia[1] : 0);
    gl.uniform1f(loc.uK, this.k);
    if (s.alpha !== undefined) {
      // a crossfade step: blend a whole new frame over what is there
      gl.enable(gl.BLEND);
      gl.uniform2f(loc.uJitter, 0, 0);
      gl.uniform1f(loc.uAlpha, s.alpha);
    } else if (frame === 0) {
      gl.disable(gl.BLEND);
      gl.uniform2f(loc.uJitter, 0, 0);
      gl.uniform1f(loc.uAlpha, 1);
    } else {
      gl.enable(gl.BLEND);
      gl.uniform2f(loc.uJitter, halton(frame, 2) - 0.5, halton(frame, 3) - 0.5);
      gl.uniform1f(loc.uAlpha, 1 / (frame + 1));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
