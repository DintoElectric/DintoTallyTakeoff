// "Count similar": the estimator boxes ONE symbol on the drawing, and every look-alike on the page is found.
// For devices drawn as a bare symbol (a duct smoke detector, a module in a box) there is no text to count; for devices
// that are a plain circle or square with letters in or beside it ("CR", "MM"), the letters are part of the symbol.
import type { Prim } from './primitives.ts';
import { similarity, type Box, type Signature } from './shapeMatch.ts';

const DARK = 0.35;     // linework and fills that carry a symbol; gray hatching and ceiling grid do not
const SIZE_MAX = 60;   // symbols are small: ignore long lines (walls, grid)
const N_MAX = 400;     // curves have many points; CAD text drawn as shapes has more
const CELL = 48;       // grid cell for finding the shapes near a spot quickly
const MARGIN = 1.5;    // points: how far from the box, or from the symbol, a piece still counts as part of it
const LABEL_MAX = 6;   // characters: the letters of a symbol are short ("CR", "MM"); a longer piece of text is something else

const keep = (p: Prim) => p.lum <= DARK && p.x1 - p.x0 <= SIZE_MAX && p.y1 - p.y0 <= SIZE_MAX && p.n <= N_MAX;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/** Only the shapes a symbol search can use. A dense page has 300,000 shapes; this keeps the few thousand that matter. */
export const darkSmall = (prims: Prim[]): Prim[] => prims.filter(keep);

/** The shapes of a symbol: dark shapes fully inside the box, positions relative to the box's top-left. */
export function symbolSignature(prims: Prim[], box: Box): Signature {
  const out: Signature = [];
  for (const p of prims) {
    if (!keep(p) || p.x0 < box.x0 - 0.3 || p.x1 > box.x1 + 0.3 || p.y0 < box.y0 - 0.3 || p.y1 > box.y1 + 0.3) continue;
    out.push({ x0: p.x0 - box.x0, y0: p.y0 - box.y0, x1: p.x1 - box.x0, y1: p.y1 - box.y0, n: p.n, fill: p.fill });
  }
  // The same shape drawn twice on top of itself (CAD does this) counts once.
  const seen = new Set<string>();
  return out.filter((s) => { const k = `${s.n}|${s.fill}|${s.x0.toFixed(1)}|${s.y0.toFixed(1)}|${s.x1.toFixed(1)}|${s.y1.toFixed(1)}`; return seen.has(k) ? false : (seen.add(k), true); });
}

/** The shapes inside a box, positions relative to the box itself (the search window is padded a little so edges are not lost). */
function signatureIn(prims: Prim[], box: Box): Signature {
  const pad = 0.5;
  return symbolSignature(prims, { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad })
    .map((s) => ({ ...s, x0: s.x0 - pad, y0: s.y0 - pad, x1: s.x1 - pad, y1: s.y1 - pad }));
}

export interface SymbolMatch { x: number; y: number; score: number } // centre of the match, points
export interface TextMark { s: string; x: number; y: number }          // a piece of text on the page: its centre, points
export interface SymbolSearchOptions { minScore?: number; maxMatches?: number; texts?: TextMark[] }

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

function search(prims: Prim[], t: Template, minScore: number, texts: TextMark[]): SymbolMatch[] {
  const A = t.sig[anchorOf(t.sig)];
  const aw = A.x1 - A.x0, ah = A.y1 - A.y0;
  const grid = new Map<string, Prim[]>();
  const dark: Prim[] = [];
  for (const p of prims) {
    if (!keep(p)) continue;
    dark.push(p);
    const k = `${Math.floor(((p.x0 + p.x1) / 2) / CELL)},${Math.floor(((p.y0 + p.y1) / 2) / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const near = (box: Box): Prim[] => {
    const out: Prim[] = [];
    for (let cx = Math.floor(box.x0 / CELL) - 1; cx <= Math.floor(box.x1 / CELL) + 1; cx++)
      for (let cy = Math.floor(box.y0 / CELL) - 1; cy <= Math.floor(box.y1 / CELL) + 1; cy++) out.push(...(grid.get(`${cx},${cy}`) ?? []));
    return out;
  };
  const TOL = 1.5;
  const found: SymbolMatch[] = [];
  const tried = new Set<string>();
  for (const p of dark) {
    if (p.fill !== A.fill || p.n !== A.n || Math.abs(p.x1 - p.x0 - aw) > TOL || Math.abs(p.y1 - p.y0 - ah) > TOL) continue;
    const ox = p.x0 - A.x0, oy = p.y0 - A.y0;
    const key = `${Math.round(ox)},${Math.round(oy)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const box: Box = { x0: ox, y0: oy, x1: ox + t.w, y1: oy + t.h };
    if (t.texts.length && !hasLetters(box, texts, t.texts, t.inside === true)) continue; // the same letters ("CR", not "DC")
    const score = similarity(t.sig, signatureIn(near(box), box));
    if (score >= minScore) found.push({ x: ox + t.w / 2, y: oy + t.h / 2, score });
  }
  return found;
}

/**
 * Finds every place on the page that looks like the template, in any of its eight orientations. A template with no
 * letters needs at least two shapes: a lone circle or line would match half the drawing. With letters, one shape is
 * enough, because the letters tell it apart. A box holding only letters finds that same text.
 */
export function findSimilar(prims: Prim[], template: Template, opts: SymbolSearchOptions = {}): SymbolMatch[] {
  const minScore = opts.minScore ?? 0.85;
  const texts = opts.texts ?? [];
  if (template.sig.length === 0) {
    if (template.texts.length !== 1) return [];
    return texts.filter((m) => norm(m.s) === template.texts[0]).map((m) => ({ x: m.x, y: m.y, score: 1 })).sort((m, n) => m.y - n.y || m.x - n.x);
  }
  if (template.sig.length < 2 && template.texts.length === 0) return [];
  const all: SymbolMatch[] = [];
  for (const o of orientations(template)) all.push(...search(prims, o, minScore, texts));
  // One symbol, one match: drop weaker matches that overlap a better one.
  all.sort((m, n) => n.score - m.score);
  const kept: SymbolMatch[] = [];
  const reach = Math.max(template.w, template.h) * 0.7;
  for (const m of all) if (!kept.some((k) => Math.abs(k.x - m.x) < reach && Math.abs(k.y - m.y) < reach)) kept.push(m);
  return kept.slice(0, opts.maxMatches ?? 2000).sort((m, n) => m.y - n.y || m.x - n.x);
}

/** Matches that already have a count of the same item within `tol` points are dropped, so running twice adds nothing. */
export function dropCounted(matches: SymbolMatch[], counted: { x: number; y: number }[], tol: number): SymbolMatch[] {
  return matches.filter((m) => !counted.some((c) => Math.abs(c.x - m.x) <= tol && Math.abs(c.y - m.y) <= tol));
}
