// Scores for the transcription test, after the rules of mir_eval: notes match one to one (a maximum matching) when
// their pitch is the same semitone and their onsets are within the tolerance; beats the same, without pitch.

/** the size of a maximum matching between a and b, where ok(i, j) says whether a[i] may match b[j] */
const matching = (a, b, ok) => {
  const owner = new Int32Array(b.length).fill(-1);
  // candidates per a, nearest in time first is not needed for a maximum matching, only for speed
  const cand = a.map((_, i) => b.map((_, j) => j).filter((j) => ok(i, j)));
  const tryAssign = (i, seen) => {
    for (const j of cand[i]) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (owner[j] < 0 || tryAssign(owner[j], seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  let n = 0;
  for (let i = 0; i < a.length; i++) if (tryAssign(i, new Uint8Array(b.length))) n++;
  return n;
};

const prf = (matched, est, ref) => {
  const precision = est ? matched / est : 0;
  const recall = ref ? matched / ref : 0;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {precision, recall, f, matched, est, ref};
};

/** notes [{start, midi}] against the truth: onset within `tol` seconds and the same semitone */
export const noteScore = (est, ref, tol = 0.05) =>
  prf(
    matching(ref, est, (i, j) => Math.round(est[j].midi) === Math.round(ref[i].midi) && Math.abs(est[j].start - ref[i].start) <= tol),
    est.length,
    ref.length,
  );

/** beat times against the truth, within `tol` seconds */
export const beatScore = (est, ref, tol = 0.07) => prf(matching(ref, est, (i, j) => Math.abs(est[j] - ref[i]) <= tol), est.length, ref.length);

/** drum hits against the truth: the same drum, onset within `tol` */
export const drumScore = (est, ref, drum, tol = 0.05) => {
  const e = est.filter((d) => d.drum === drum);
  const r = ref.filter((d) => d.drum === drum);
  return prf(matching(r, e, (i, j) => Math.abs(e[j].start - r[i].start) <= tol), e.length, r.length);
};

/** the chord found at time t, or null */
const chordAt = (chords, t) => chords.find((c) => c.start <= t && t < c.end) || null;

/** the share of the truth's beats (taken at their middles) where the found chord has the right root, and root and quality */
export const chordScore = (est, ref, beats) => {
  let root = 0;
  let both = 0;
  let n = 0;
  for (let i = 0; i < beats.length; i++) {
    const t = i + 1 < beats.length ? (beats[i] + beats[i + 1]) / 2 : beats[i] + 0.1;
    const r = chordAt(ref, t);
    if (!r) continue;
    n++;
    const e = chordAt(est, t);
    if (e && e.root === r.root) {
      root++;
      if (e.quality === r.quality) both++;
    }
  }
  return {root: n ? root / n : 0, both: n ? both / n : 0, beats: n};
};
