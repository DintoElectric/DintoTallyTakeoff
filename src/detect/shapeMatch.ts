// Tells variants of the same tag apart by the shape drawn next to it (for example a plain
// rectangle versus a rectangle with a black wedge). The estimator shows one example of each
// variant; every other tag with the same code is given to the variant it looks most like.
import type { Prim } from './primitives.ts';

export const WINDOW = { left: 40, right: 40, up: 48, down: 48 }; // points around the tag center: a 4-foot fixture can stand vertically above or below its tag
const SIZE_MAX = 60;      // ignore long lines (walls, grid): symbols are small
const DARK = 0.35;        // only dark linework and dark fills carry the symbol; gray hatching does not
const TOL = 1.5;          // points of position tolerance between two drawings of the same symbol

export interface SigPrim { x0: number; y0: number; x1: number; y1: number; n: number; fill: boolean }
export type Signature = SigPrim[];

/** Salient shapes around a tag, positions relative to the tag center, in points. */
export function signatureAt(prims: Prim[], tagX: number, tagY: number, win = WINDOW): Signature {
  const out: Signature = [];
  for (const p of prims) {
    if (p.lum > DARK) continue;
    if (p.x1 - p.x0 > SIZE_MAX || p.y1 - p.y0 > SIZE_MAX || p.n > 12) continue;
    const cx = (p.x0 + p.x1) / 2 - tagX;
    const cy = (p.y0 + p.y1) / 2 - tagY;
    if (cx < -win.left || cx > win.right || cy < -win.up || cy > win.down) continue;
    out.push({ x0: p.x0 - tagX, y0: p.y0 - tagY, x1: p.x1 - tagX, y1: p.y1 - tagY, n: p.n, fill: p.fill });
  }
  return out;
}

const same = (p: SigPrim, q: SigPrim, dx: number, dy: number) =>
  q.fill === p.fill && q.n === p.n &&
  Math.abs(q.x0 - p.x0 - dx) <= TOL && Math.abs(q.y0 - p.y0 - dy) <= TOL &&
  Math.abs(q.x1 - p.x1 - dx) <= TOL && Math.abs(q.y1 - p.y1 - dy) <= TOL;

/** How many shapes of `a` appear in `b` once b is shifted by (dx, dy). */
function matches(a: Signature, b: Signature, dx: number, dy: number): number {
  const used = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (const p of a) {
    for (let j = 0; j < b.length; j++) if (!used[j] && same(p, b[j], dx, dy)) { used[j] = true; m++; break; }
  }
  return m;
}

/**
 * Best alignment of b onto a: every pair of look-alike shapes votes for the shift between them,
 * so the tag's text position does not need to be exact. Returns the shift with the most votes.
 */
export function align(a: Signature, b: Signature): { dx: number; dy: number } {
  const votes = new Map<string, { dx: number; dy: number; v: number }>();
  for (const p of a) {
    for (const q of b) {
      if (q.fill !== p.fill || q.n !== p.n) continue;
      if (Math.abs(q.x1 - q.x0 - (p.x1 - p.x0)) > TOL || Math.abs(q.y1 - q.y0 - (p.y1 - p.y0)) > TOL) continue;
      const dx = q.x0 - p.x0, dy = q.y0 - p.y0;
      if (Math.abs(dx) > 24 || Math.abs(dy) > 24) continue;
      const key = `${Math.round(dx / TOL)},${Math.round(dy / TOL)}`;
      const e = votes.get(key) ?? { dx, dy, v: 0 };
      e.v++;
      votes.set(key, e);
    }
  }
  let best = { dx: 0, dy: 0, v: -1 };
  for (const e of votes.values()) if (e.v > best.v) best = e;
  return { dx: best.dx, dy: best.dy };
}

/** Dice similarity between two signatures after alignment: 1 = identical, 0 = nothing in common. */
export function similarity(a: Signature, b: Signature): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const { dx, dy } = align(a, b);
  return (2 * matches(a, b, dx, dy)) / (a.length + b.length);
}

// Meaningful shapes: solid fills and outlines with 3 or more points. Short stray line segments are noise.
const meaningful = (p: SigPrim) => p.fill || p.n >= 3;

/** Same kind of shape and same size (either way round, so rotated and mirrored symbols still match). */
const sameShape = (p: SigPrim, q: SigPrim) => {
  if (p.fill !== q.fill || p.n !== q.n) return false;
  const pw = p.x1 - p.x0, ph = p.y1 - p.y0, qw = q.x1 - q.x0, qh = q.y1 - q.y0;
  return (Math.abs(pw - qw) <= TOL && Math.abs(ph - qh) <= TOL) || (Math.abs(pw - qh) <= TOL && Math.abs(ph - qw) <= TOL);
};

/**
 * Score of "does candidate b contain the distinguishing shapes of variant a": the share of a's meaningful
 * shapes that its sibling variant lacks, found anywhere in b's window. Shapes both variants share cancel out.
 */
export function distinctiveScore(a: Signature, sibling: Signature, b: Signature): number {
  const only = a.filter((p) => meaningful(p) && !sibling.some((q) => sameShape(p, q)));
  if (only.length === 0) return 0;
  const used = new Array<boolean>(b.length).fill(false);
  let found = 0;
  for (const p of only) {
    const j = b.findIndex((q, k) => !used[k] && sameShape(p, q));
    if (j >= 0) { used[j] = true; found++; }
  }
  return found / only.length;
}

export interface Variant { id: string; sig: Signature }
export interface Classified { id: string; score: number; certain: boolean }

/**
 * Chooses which variant a candidate tag is. A variant with extra shapes (a wedge, a second bar) wins when
 * the candidate shows those shapes; a candidate showing none of them belongs to the plainest variant.
 * `certain` is false when the choice rests on absence alone, so those counts can be flagged for review.
 */
export function classify(sig: Signature, variants: Variant[], minEvidence = 0.5): Classified | null {
  if (variants.length === 0) return null;
  if (variants.length === 1) {
    const s = similarity(sig, variants[0].sig);
    return s >= 0.5 ? { id: variants[0].id, score: s, certain: true } : null;
  }
  // Evidence for each variant: the share of its distinguishing shapes (versus every sibling) that the candidate has.
  const evidence = variants.map((v) => ({
    v,
    e: Math.min(...variants.filter((o) => o !== v).map((o) => distinctiveScore(v.sig, o.sig, sig))),
  }));
  const best = evidence.reduce((m, x) => (x.e > m.e ? x : m));
  if (best.e >= minEvidence) return { id: best.v.id, score: best.e, certain: true };
  // No variant's extra shapes are present: the plainest variant (fewest shapes) is the answer, by absence.
  const plain = variants.reduce((m, x) => (x.sig.length < m.sig.length ? x : m));
  return { id: plain.id, score: 1 - best.e, certain: false };
}

export interface Box { x0: number; y0: number; x1: number; y1: number } // points, same space as Prim

/** The example: shapes inside the box the estimator drew around one symbol (positions relative to the box). */
export function signatureInBox(prims: Prim[], box: Box): Signature {
  const out: Signature = [];
  for (const p of prims) {
    if (p.lum > DARK || p.n > 12) continue;
    if (p.x0 < box.x0 || p.x1 > box.x1 || p.y0 < box.y0 || p.y1 > box.y1) continue;
    out.push({ x0: p.x0 - box.x0, y0: p.y0 - box.y0, x1: p.x1 - box.x0, y1: p.y1 - box.y0, n: p.n, fill: p.fill });
  }
  return out;
}
