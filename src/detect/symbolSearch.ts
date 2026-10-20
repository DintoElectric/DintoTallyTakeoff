// "Count similar": the estimator boxes ONE symbol on the drawing, and every look-alike on the page is found.
// For devices drawn as a bare symbol (a duct smoke detector, a module in a box) there is no text to count; for devices
// that are a plain circle or square with letters in or beside it ("CR", "MM"), the letters are part of the symbol.
import type { Prim } from './primitives.ts';
import { similarity, weightedSimilarity, type Box, type Signature } from './shapeMatch.ts';

const DARK = 0.35;     // linework and fills that carry a symbol; gray hatching and ceiling grid do not
const SIZE_MAX = 60;   // symbols are small: ignore long lines (walls, grid)
const N_MAX = 400;     // curves have many points; CAD text drawn as shapes has more
const CELL = 48;       // grid cell for finding the shapes near a spot quickly
const MARGIN = 1.5;    // points: how far from the box, or from the symbol, a piece still counts as part of it
const LABEL_MAX = 6;   // characters: the letters of a symbol are short ("CR", "MM"); a longer piece of text is something else

/**
 * Lines and rectangles keep their exact point count (a 2-point line is not a 4-point box), but a curve is a curve
 * however many points the CAD export used to draw it: the same symbol has an outline of 10, 46 or 59 points on
 * different drawings. So every shape of 8 or more points counts as one kind.
 */
export const curveKey = (n: number) => (n >= 8 ? 8 : n);

const diameters = new WeakMap<Prim, number>();
/**
 * A shape's diameter: the longest distance between two of its points. Unlike its bounding box, it does not change when the
 * shape is turned, which is what lets a turned wedge be told from a thin arc at the same spot. Needs the shape's points
 * (`extractPrims` with `keepPoints`); without them it falls back to the box diagonal, which is right for a line and for
 * anything that is not turned.
 */
export function diameterOf(p: Prim): number {
  const known = diameters.get(p);
  if (known !== undefined) return known;
  let d = Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
  const q = p.pts;
  if (q && q.length >= 4 && q.length <= 200) {
    d = 0;
    for (let i = 0; i < q.length; i += 2) for (let j = i + 2; j < q.length; j += 2) { const e = Math.hypot(q[i] - q[j], q[i + 1] - q[j + 1]); if (e > d) d = e; }
  }
  diameters.set(p, d);
  return d;
}

const keep = (p: Prim) => p.lum <= DARK && p.x1 - p.x0 <= SIZE_MAX && p.y1 - p.y0 <= SIZE_MAX && p.n <= N_MAX;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/** Only the shapes a symbol search can use. A dense page has 300,000 shapes; this keeps the few thousand that matter. */
export const darkSmall = (prims: Prim[]): Prim[] => prims.filter(keep);

/** The shapes of a symbol: dark shapes fully inside the box, positions relative to the box's top-left. */
export function symbolSignature(prims: Prim[], box: Box): Signature {
  const out: Signature = [];
  for (const p of prims) {
    if (!keep(p) || p.x0 < box.x0 - 0.3 || p.x1 > box.x1 + 0.3 || p.y0 < box.y0 - 0.3 || p.y1 > box.y1 + 0.3) continue;
    out.push({ x0: p.x0 - box.x0, y0: p.y0 - box.y0, x1: p.x1 - box.x0, y1: p.y1 - box.y0, n: curveKey(p.n), fill: p.fill, d: diameterOf(p) });
  }
  // The same shape drawn twice (CAD does this, often a hair apart for a heavy line) counts once.
  const NEAR_DUP = 1.0;
  const dedup: Signature = [];
  for (const q of out) {
    if (dedup.some((o) => o.n === q.n && o.fill === q.fill && Math.abs(o.x0 - q.x0) <= NEAR_DUP && Math.abs(o.y0 - q.y0) <= NEAR_DUP && Math.abs(o.x1 - q.x1) <= NEAR_DUP && Math.abs(o.y1 - q.y1) <= NEAR_DUP)) continue;
    dedup.push(q);
  }
  return dedup;
}

/** The shapes inside a box, positions relative to the box itself (the search window is padded a little so edges are not lost). */
function signatureIn(prims: Prim[], box: Box): Signature {
  const pad = 0.5;
  return symbolSignature(prims, { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad })
    .map((s) => ({ ...s, x0: s.x0 - pad, y0: s.y0 - pad, x1: s.x1 - pad, y1: s.y1 - pad }));
}

export interface SymbolMatch { x: number; y: number; score: number; weighted?: number } // centre of the match, points

// Big shapes count for more than small ones (weighted by area): a camera is a ring of 60 tiny segments plus two wedges, and
// the wedges are what tell it from a four-wedge camera. A match must clear the plain score and this one, which sits
// a little higher, since a real copy agrees on its big shapes almost exactly.
const WEIGHT_POWER = 1;
const WEIGHT_MARGIN = 0.05;
const COMPLEX = 12; // shapes: a symbol with this many or more gets the stricter size-weighted check
export interface TextMark { s: string; x: number; y: number }          // a piece of text on the page: its centre, points
export interface SymbolSearchOptions { minScore?: number; minWeighted?: number; maxMatches?: number; texts?: TextMark[] }

/** The example: a symbol's shapes (relative to its own top-left) and the letters that belong to it. */
export interface Template { sig: Signature; w: number; h: number; texts: string[]; inside?: boolean } // inside: the letters were inside the symbol, not beside it

/** Short pieces of text with their distance (points) from a symbol's outline; 0 means inside it. */
function nearbyTexts(bb: Box, texts: TextMark[]): { t: string; d: number }[] {
  const reach = Math.max(MARGIN, Math.min(8, 0.5 * Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0))); // about half the symbol's size
  const out: { t: string; d: number }[] = [];
  for (const m of texts) {
    const t = norm(m.s);
    if (!t || t.length > LABEL_MAX) continue;
    const dx = Math.max(bb.x0 - m.x, 0, m.x - bb.x1), dy = Math.max(bb.y0 - m.y, 0, m.y - bb.y1);
    const d = Math.hypot(dx, dy);
    if (d <= reach) out.push({ t, d });
  }
  return out;
}

/**
 * The letters of the example symbol: those inside it, or if none, the one nearest (an "MM" set just below its circle).
 * Taking only the nearest keeps a neighbouring device's letters out of the example.
 */
export function learnTexts(bb: Box, texts: TextMark[]): { texts: string[]; inside: boolean } {
  const near = nearbyTexts(bb, texts).sort((a, b) => a.d - b.d);
  const inside = near.filter((x) => x.d === 0).map((x) => x.t);
  return inside.length ? { texts: inside.sort(), inside: true } : { texts: near.slice(0, 1).map((x) => x.t), inside: false };
}

/**
 * Does a candidate carry the example's letters? When the example's letters were inside its symbol, the candidate's must be
 * inside too: a square sitting next to a "CR" does not borrow that "CR". When they were set beside it (an "MM" below its
 * circle), any short text close to the candidate will do, since other labels can sit nearer.
 */
function hasLetters(bb: Box, texts: TextMark[], want: string[], inside: boolean): boolean {
  const near = nearbyTexts(bb, texts);
  const have = (inside ? near.filter((x) => x.d === 0) : near).map((x) => x.t);
  return want.every((w) => { const i = have.indexOf(w); if (i < 0) return false; have.splice(i, 1); return true; });
}

/**
 * The example symbol, from the box the estimator drew. The box does not have to be exact: every shape that sits mostly in
 * it is a candidate, and the symbol is what is joined up with the biggest one near the middle (a circle and its ticks, a
 * square and its sides). Its letters are part of it ("CR" in a square is not "DC" in a square). Null for an empty box.
 */
export function buildTemplate(prims: Prim[], texts: TextMark[], box: Box): Template | null {
  const inBox = (cx: number, cy: number) => cx >= box.x0 - MARGIN && cx <= box.x1 + MARGIN && cy >= box.y0 - MARGIN && cy <= box.y1 + MARGIN;
  const cand = prims.filter((p) => keep(p) && inBox((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2));
  if (cand.length === 0) {
    const t = texts.filter((m) => inBox(m.x, m.y)).map((m) => norm(m.s)).filter(Boolean);
    return t.length ? { sig: [], w: 0, h: 0, texts: t.sort() } : null;   // only letters in the box
  }
  const area = (p: Prim) => (p.x1 - p.x0) * (p.y1 - p.y0) + p.n * 1e-4;
  // People centre the box on the symbol, so start from the biggest shape near its middle (a loose box can hold others).
  const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2, rx = (box.x1 - box.x0) * 0.45, ry = (box.y1 - box.y0) * 0.45;
  const middle = cand.filter((p) => Math.abs((p.x0 + p.x1) / 2 - mx) <= rx && Math.abs((p.y0 + p.y1) / 2 - my) <= ry);
  const seed = (middle.length ? middle : cand).reduce((m, p) => (area(p) > area(m) ? p : m));
  // Grow the symbol from that shape through everything that touches it.
  const cluster = new Set<Prim>([seed]);
  let bb = { x0: seed.x0, y0: seed.y0, x1: seed.x1, y1: seed.y1 };
  for (let grew = true; grew;) {
    grew = false;
    for (const p of cand) {
      if (cluster.has(p) || p.x1 < bb.x0 - MARGIN || p.x0 > bb.x1 + MARGIN || p.y1 < bb.y0 - MARGIN || p.y0 > bb.y1 + MARGIN) continue;
      cluster.add(p);
      bb = { x0: Math.min(bb.x0, p.x0), y0: Math.min(bb.y0, p.y0), x1: Math.max(bb.x1, p.x1), y1: Math.max(bb.y1, p.y1) };
      grew = true;
    }
  }
  const sig = signatureIn([...cluster], bb);
  const learned = learnTexts(bb, texts);
  return { sig, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, texts: learned.texts, inside: learned.inside };
}

/** A symbol turned 90, 180, 270 degrees and mirrored: the same device drawn the other way round. */
export function orientations(t: Template): Template[] {
  const out: Template[] = [];
  const seen = new Set<string>();
  const turn = (sig: Signature, w: number, h: number) => ({ // 90 degrees clockwise
    sig: sig.map((s) => ({ ...s, x0: h - s.y1, y0: s.x0, x1: h - s.y0, y1: s.x1 })), w: h, h: w,
  });
  const flip = (sig: Signature, w: number): Signature => sig.map((s) => ({ ...s, x0: w - s.x1, x1: w - s.x0 }));
  let cur = { sig: t.sig, w: t.w, h: t.h };
  for (let k = 0; k < 4; k++) {
    for (const mirrored of [false, true]) {
      const sig = mirrored ? flip(cur.sig, cur.w) : cur.sig;
      const key = sig.map((s) => `${s.n}${s.fill ? 'f' : ''}:${s.x0.toFixed(0)},${s.y0.toFixed(0)},${s.x1.toFixed(0)},${s.y1.toFixed(0)}`).sort().join('|');
      if (!seen.has(key)) { seen.add(key); out.push({ sig, w: cur.w, h: cur.h, texts: t.texts, inside: t.inside }); }
    }
    cur = turn(cur.sig, cur.w, cur.h);
  }
  return out;
}

/** Which shape of the template to anchor on: the biggest one (a circle or box, not a tick). */
function anchorOf(sig: Signature): number {
  let best = -1, area = -1;
  sig.forEach((s, i) => { const a = (s.x1 - s.x0) * (s.y1 - s.y0) + s.n * 1e-4; if (a > area) { area = a; best = i; } });
  return best;
}

/** The dark shapes of a page, indexed by position so "what is near here" is quick. */
interface Index { dark: Prim[]; near(box: Box): Prim[]; around(x: number, y: number, r: number): Prim[] }

function indexOf(prims: Prim[]): Index {
  const grid = new Map<string, Prim[]>();
  const dark: Prim[] = [];
  for (const p of prims) {
    if (!keep(p)) continue;
    dark.push(p);
    const k = `${Math.floor(((p.x0 + p.x1) / 2) / CELL)},${Math.floor(((p.y0 + p.y1) / 2) / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const cellsOf = (x0: number, y0: number, x1: number, y1: number) => {
    const out: Prim[] = [];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) { const g = grid.get(`${cx},${cy}`); if (g) for (const p of g) out.push(p); }
    return out;
  };
  return {
    dark,
    near: (box) => cellsOf(box.x0 - CELL, box.y0 - CELL, box.x1 + CELL, box.y1 + CELL),
    around: (x, y, r) => cellsOf(x - r, y - r, x + r, y + r).filter((p) => Math.hypot((p.x0 + p.x1) / 2 - x, (p.y0 + p.y1) / 2 - y) <= r),
  };
}

/** The symbol as drawn: found by sliding the template over the page in one of its four quarter-turn orientations. */
function search(ix: Index, t: Template, minScore: number, minWeighted: number, texts: TextMark[]): SymbolMatch[] {
  const A = t.sig[anchorOf(t.sig)];
  const aw = A.x1 - A.x0, ah = A.y1 - A.y0;
  const TOL = 1.5;
  const found: SymbolMatch[] = [];
  const tried = new Set<string>();
  for (const p of ix.dark) {
    if (p.fill !== A.fill || curveKey(p.n) !== A.n || Math.abs(p.x1 - p.x0 - aw) > TOL || Math.abs(p.y1 - p.y0 - ah) > TOL) continue;
    const ox = p.x0 - A.x0, oy = p.y0 - A.y0;
    const key = `${Math.round(ox)},${Math.round(oy)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const box: Box = { x0: ox, y0: oy, x1: ox + t.w, y1: oy + t.h };
    if (t.texts.length && !hasLetters(box, texts, t.texts, t.inside === true)) continue; // the same letters ("CR", not "DC")
    const here = signatureIn(ix.near(box), box);
    const score = similarity(t.sig, here);
    if (score < minScore) continue;
    const weighted = weightedSimilarity(t.sig, here, WEIGHT_POWER);
    if (weighted >= minWeighted) found.push({ x: ox + t.w / 2, y: oy + t.h / 2, score, weighted });
  }
  return found;
}

/**
 * The symbol turned by any angle (and mirrored). A turned shape's bounding box changes, but two things do not: where its
 * centre lies relative to the rest of the symbol, and (for a line) its length. So: take the template's biggest shape as an
 * anchor; for each candidate anchor on the page and each angle, predict where every other shape of the symbol would land,
 * and score how many are there. Quarter turns are left to `search`, which is exact. Symbols with letters are left alone too.
 *
 * A curved shape's box centre moves a little when it is turned, so the anchor's position is only roughly right. The short
 * straight segments (a camera's rings are made of dozens) have exact midpoints, so the position is refined from those.
 */
function searchRotated(ix: Index, t: Template, minScore: number, minWeighted: number, texts: TextMark[]): SymbolMatch[] {
  // A symbol with letters or a number beside it (an outlet's triangle and its "2") is told apart by them, so even one shape will
  // do; the letters stay upright when the symbol turns, so they are checked as text beside it. Without letters, a symbol needs
  // enough shapes that a turn cannot be matched by chance.
  if (t.sig.length === 0 || (t.texts.length === 0 && t.sig.length < 6)) return [];
  const mx = t.w / 2, my = t.h / 2;
  const wt = (area: number) => Math.max(1, area) ** WEIGHT_POWER;
  const tp = t.sig.map((s) => {
    const w = s.x1 - s.x0, h = s.y1 - s.y0;
    const hi = Math.hypot(w, h);
    return { x: (s.x0 + s.x1) / 2 - mx, y: (s.y0 + s.y1) / 2 - my, fill: s.fill, n: s.n, hi, d: s.d ?? hi, lo: Math.min(w, h), area: w * h, tol: s.n === 2 ? 1.6 : Math.max(2.2, 0.2 * hi) };
  });
  type TP = (typeof tp)[number];
  const order = tp.map((_, i) => i).sort((i, j) => tp[j].area - tp[i].area); // big shapes first: they decide quickly
  const A = tp[order[0]];
  const big = order.slice(0, Math.min(3, order.length)).map((i) => tp[i]);
  const reach = Math.max(...tp.map((q) => Math.hypot(q.x, q.y) + q.hi / 2)) + 1;
  const stepDeg = Math.max(1, Math.min(5, ((2 * Math.asin(Math.min(1, 1 / reach))) * 180) / Math.PI)); // fine enough that a turn lands within tolerance
  const compat = (p: TP, q: Prim) => {
    if (p.fill !== q.fill || p.n !== curveKey(q.n)) return false;
    // The diameter does not change when a shape is turned, whatever its box does: a line keeps its length, a wedge its
    // span, and a thin lens arc is not mistaken for a thick wedge outline at the same spot.
    return Math.abs(diameterOf(q) - p.d) <= (p.n === 2 ? 1.5 : 1.8);
  };
  const totalW = tp.reduce((n, p) => n + wt(p.area), 0);
  const centre = (r: Prim) => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2] as const;
  const found: SymbolMatch[] = [];
  for (const q of ix.dark) {
    if (!compat(A, q)) continue;
    const [qx, qy] = centre(q);
    for (const mirror of [false, true]) {
      for (let deg = stepDeg; deg < 360; deg += stepDeg) {
        const turn = deg % 90;
        if (turn < 1.5 || turn > 88.5) continue; // a quarter turn: handled exactly by `search`
        const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
        const at = (p: TP, cx: number, cy: number) => { const x = mirror ? -p.x : p.x; return [cx + c * x - s * p.y, cy + s * x + c * p.y] as const; };
        // where the template centre lands, if the anchor lies on q
        const [ax, ay] = at(A, 0, 0);
        let Cx = qx - ax, Cy = qy - ay;
        // the other big shapes must be there (loosely: the position is refined below), or this angle is out
        let ok = true;
        for (const b of big) {
          if (b === A) continue;
          const [px, py] = at(b, Cx, Cy);
          if (!ix.around(px, py, b.tol + 1).some((r) => compat(b, r))) { ok = false; break; }
        }
        if (!ok) continue;
        // refine the position from the straight segments: the mean offset of the lines that are nearly where they should be
        const dxs: number[] = [], dys: number[] = [];
        for (const p of tp) {
          if (p.n !== 2) continue;
          const [px, py] = at(p, Cx, Cy);
          let best: Prim | null = null, bd = 3;
          for (const r of ix.around(px, py, 3)) { if (!compat(p, r)) continue; const [rx, ry] = centre(r); const d = Math.hypot(rx - px, ry - py); if (d < bd) { best = r; bd = d; } }
          if (best) { const [rx, ry] = centre(best); dxs.push(rx - px); dys.push(ry - py); }
        }
        if (dxs.length >= 6) { dxs.sort((u, v) => u - v); dys.sort((u, v) => u - v); Cx += dxs[dxs.length >> 1]; Cy += dys[dys.length >> 1]; }
        // score the placement
        const used = new Set<Prim>();
        let m = 0, mw = 0;
        for (const i of order) {
          const p = tp[i];
          const [px, py] = at(p, Cx, Cy);
          let best: Prim | null = null, bd = p.tol + 1e-9;
          for (const r of ix.around(px, py, p.tol)) {
            if (used.has(r) || !compat(p, r)) continue;
            const [rx, ry] = centre(r); const d = Math.hypot(rx - px, ry - py);
            if (d <= bd) { best = r; bd = d; }
          }
          if (best) { used.add(best); m++; mw += wt(p.area); }
        }
        if (t.texts.length) { const h = Math.max(t.w, t.h) / 2; if (!hasLetters({ x0: Cx - h, y0: Cy - h, x1: Cx + h, y1: Cy + h }, texts, t.texts, t.inside === true)) continue; }
        // For a small symbol with letters, count only what lies wholly within its reach (a wall crossing nearby is not part of it), as
        // the exact search does. A complex symbol keeps the stricter count of everything centred nearby.
        const win = ix.around(Cx, Cy, reach).filter((r) => !t.texts.length || used.has(r) || Math.max(Math.hypot(r.x0 - Cx, r.y0 - Cy), Math.hypot(r.x1 - Cx, r.y0 - Cy), Math.hypot(r.x0 - Cx, r.y1 - Cy), Math.hypot(r.x1 - Cx, r.y1 - Cy)) <= reach + 1);
        const score = (2 * m) / (tp.length + win.length);
        if (score < minScore) continue;
        // a matched shape weighs the same on both sides (a turned wedge's box is bigger, but it is the same wedge); only the extras count for themselves
        const extraW = win.reduce((n, r) => (used.has(r) ? n : n + wt((r.x1 - r.x0) * (r.y1 - r.y0))), 0);
        const weighted = (2 * mw) / (totalW + mw + extraW);
        if (weighted >= minWeighted) found.push({ x: Cx, y: Cy, score, weighted });
      }
    }
  }
  return found;
}

/**
 * Finds every place on the page that looks like the template: in any of its quarter-turn orientations (mirrored too), and
 * turned by any other angle. A template with no letters needs at least two shapes: a lone circle or line would match half
 * the drawing. With letters, one shape is enough, because the letters tell it apart. A box holding only letters finds that
 * same text.
 */
export function findSimilar(prims: Prim[], template: Template, opts: SymbolSearchOptions = {}): SymbolMatch[] {
  const minScore = opts.minScore ?? 0.85;
  // The size-weighted check is for complex symbols only (a camera: dozens of tiny shapes and a few big ones, where the plain
  // score cannot see the big ones disagree). A small symbol is a handful of lines: one stray shape beside it would veto a
  // perfect match, so it is judged by the plain score alone, as before.
  const minWeighted = opts.minWeighted ?? (template.sig.length >= COMPLEX ? Math.min(0.97, minScore + WEIGHT_MARGIN) : 0);
  const texts = opts.texts ?? [];
  if (template.sig.length === 0) {
    if (template.texts.length !== 1) return [];
    return texts.filter((m) => norm(m.s) === template.texts[0]).map((m) => ({ x: m.x, y: m.y, score: 1 })).sort((m, n) => m.y - n.y || m.x - n.x);
  }
  if (template.sig.length < 2 && template.texts.length === 0) return [];
  const ix = indexOf(prims);
  const all: SymbolMatch[] = [];
  for (const o of orientations(template)) all.push(...search(ix, o, minScore, minWeighted, texts));
  all.push(...searchRotated(ix, template, minScore, minWeighted, texts));
  // One symbol, one match: drop weaker matches that overlap a better one.
  all.sort((m, n) => n.score - m.score);
  const kept: SymbolMatch[] = [];
  const reachMatch = Math.max(template.w, template.h) * 0.7;
  for (const m of all) if (!kept.some((k) => Math.abs(k.x - m.x) < reachMatch && Math.abs(k.y - m.y) < reachMatch)) kept.push(m);
  return kept.slice(0, opts.maxMatches ?? 2000).sort((m, n) => m.y - n.y || m.x - n.x);
}

/** Matches that already have a count of the same item within `tol` points are dropped, so running twice adds nothing. */
export function dropCounted(matches: SymbolMatch[], counted: { x: number; y: number }[], tol: number): SymbolMatch[] {
  return matches.filter((m) => !counted.some((c) => Math.abs(c.x - m.x) <= tol && Math.abs(c.y - m.y) <= tol));
}
