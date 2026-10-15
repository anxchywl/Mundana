// Finds stable sound spots in each fractal's starting view. Run: node tools/find-spots.mjs > spots.json, then copy the
// first five cycles and two chaos points per fractal into src/spots.js.
import {fractals, orbitOf, analyse, ESCAPE_SQ} from '../src/fractals.js';
const out = [0, 0];
const bounded = (f, x, y, n = 300) => {
  const {z0, c} = orbitOf(f, [x, y], null);
  const k = f.param ? f.param.value : 0;
  let [a, b] = z0;
  for (let i = 0; i < n; i++) { f.step(a, b, c[0], c[1], out, k); a = out[0]; b = out[1]; if (!(a*a+b*b <= ESCAPE_SQ)) return false; }
  return true;
};
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const res = {};
for (const f of fractals) {
  const k = f.param ? f.param.value : 0;
  const view = f.view;
  res[f.key] = {view};
  // spots
  const kind = (x, y) => { const {z0, c} = orbitOf(f, [x, y], null); return analyse(f, z0, c, k); };
  const sig = (r) => r.kind === 'cycle' ? 'p' + r.period : r.kind;
  const cyc = new Map(); const chaos = [];
  for (let t = 0; t < 12000 && (cyc.size < 14 || chaos.length < 2); t++) {
    const x = view.cx + (rnd() - 0.5) * view.span, y = view.cy + (rnd() - 0.5) * view.span;
    const r = kind(x, y);
    const s = sig(r);
    if (r.kind === 'escape' || (r.kind === 'cycle' && (r.period < 2 || r.period > 80))) continue;
    if (r.kind === 'cycle' && cyc.has(r.period)) continue;
    if (r.kind === 'chaos' && chaos.length >= 2) continue;
    const e = view.span * 0.006; let ok = true;
    for (const [dx, dy] of [[e,0],[-e,0],[0,e],[0,-e]]) { if (sig(kind(x+dx, y+dy)) !== s) { ok = false; break; } }
    if (!ok) continue;
    const p = [+x.toPrecision(7), +y.toPrecision(7)];
    if (r.kind === 'cycle') cyc.set(r.period, p); else chaos.push(p);
  }
  const periods = [...cyc.keys()].sort((a, b) => a - b).slice(0, 6);
  res[f.key].spots = [...periods.map((p) => ({p: cyc.get(p), period: p})), ...chaos.map((p) => ({p, chaos: true}))];
}
console.log(JSON.stringify(res, null, 1));
