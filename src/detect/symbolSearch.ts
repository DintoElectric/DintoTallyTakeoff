// "Count similar": the estimator boxes ONE symbol on the drawing, and every look-alike on the page is found.
// For devices drawn as a bare symbol (a duct smoke detector, a module in a box) there is no text to count.
import type { Prim } from './primitives.ts';
import { similarity, type Box, type Signature } from './shapeMatch.ts';

const DARK = 0.35;     // linework and fills that carry a symbol; gray hatching and ceiling grid do not
const SIZE_MAX = 60;   // symbols are small: ignore long lines (walls, grid)
const N_MAX = 400;     // curves have many points; CAD text drawn as shapes has more
const CELL = 48;       // grid cell for finding the shapes near a spot quickly

const keep = (p: Prim) => p.lum <= DARK && p.x1 - p.x0 <= SIZE_MAX && p.y1 - p.y0 <= SIZE_MAX && p.n <= N_MAX;

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

export interface SymbolMatch { x: number; y: number; score: number } // centre of the match, points
export interface SymbolSearchOptions { minScore?: number; maxMatches?: number }

/** Which shape of the template to anchor on: the biggest meaningful one (a circle or box, not a tick). */
function anchorOf(sig: Signature): number {
  let best = -1, area = -1;
  sig.forEach((s, i) => { const a = (s.x1 - s.x0) * (s.y1 - s.y0) + (s.fill ? 0 : 0.01) + s.n * 1e-4; if (a > area) { area = a; best = i; } });
  return best;
}

/**
 * Finds every place on the page that looks like the template. A template needs at least two shapes: a lone circle,
 * line or dot would match half the drawing.
 */
export function findSimilar(prims: Prim[], template: Signature, tw: number, th: number, opts: SymbolSearchOptions = {}): SymbolMatch[] {
  const minScore = opts.minScore ?? 0.85;
  if (template.length < 2) return [];
  const a = anchorOf(template), A = template[a];
  const aw = A.x1 - A.x0, ah = A.y1 - A.y0;
  // index the dark small shapes by grid cell
  const grid = new Map<string, Prim[]>();
  const dark: Prim[] = [];
  for (const p of prims) {
    if (!keep(p)) continue;
    dark.push(p);
    const cx = Math.floor(((p.x0 + p.x1) / 2) / CELL), cy = Math.floor(((p.y0 + p.y1) / 2) / CELL);
    const k = `${cx},${cy}`;
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
    // a candidate anchor: same kind of shape and size as the template's anchor
    if (p.fill !== A.fill || p.n !== A.n || Math.abs(p.x1 - p.x0 - aw) > TOL || Math.abs(p.y1 - p.y0 - ah) > TOL) continue;
    const ox = p.x0 - A.x0, oy = p.y0 - A.y0; // where the template's top-left would sit
    const key = `${Math.round(ox)},${Math.round(oy)}`;
    if (tried.has(key)) continue; // the same shape drawn twice
    tried.add(key);
    const box: Box = { x0: ox, y0: oy, x1: ox + tw, y1: oy + th };
    const sig = symbolSignature(near(box), box);
    const score = similarity(template, sig);
    if (score >= minScore) found.push({ x: ox + tw / 2, y: oy + th / 2, score });
  }
  // One symbol, one match: drop weaker matches that overlap a better one.
  found.sort((m, n) => n.score - m.score);
  const kept: SymbolMatch[] = [];
  for (const m of found) if (!kept.some((k) => Math.abs(k.x - m.x) < tw * 0.7 && Math.abs(k.y - m.y) < th * 0.7)) kept.push(m);
  return kept.slice(0, opts.maxMatches ?? 2000).sort((m, n) => m.y - n.y || m.x - n.x);
}

/** Only the shapes a symbol search can use. A dense page has 300,000 shapes; this keeps the few thousand that matter. */
export const darkSmall = (prims: Prim[]): Prim[] => prims.filter(keep);

/**
 * The example symbol, from the box the estimator drew. The box is shrunk to what is inside it, so the search window is the
 * symbol itself. Returns null when the box holds nothing a search could use.
 */
export function tightTemplate(prims: Prim[], box: Box): { sig: Signature; w: number; h: number } | null {
  const first = symbolSignature(prims, box);
  if (first.length === 0) return null;
  const x0 = Math.min(...first.map((s) => s.x0)), y0 = Math.min(...first.map((s) => s.y0));
  const x1 = Math.max(...first.map((s) => s.x1)), y1 = Math.max(...first.map((s) => s.y1));
  const tight: Box = { x0: box.x0 + x0, y0: box.y0 + y0, x1: box.x0 + x1, y1: box.y0 + y1 };
  return { sig: symbolSignature(prims, tight), w: x1 - x0, h: y1 - y0 };
}

/** Matches that already have a count of the same item within `tol` points are dropped, so running twice adds nothing. */
export function dropCounted(matches: SymbolMatch[], counted: { x: number; y: number }[], tol: number): SymbolMatch[] {
  return matches.filter((m) => !counted.some((c) => Math.abs(c.x - m.x) <= tol && Math.abs(c.y - m.y) <= tol));
}
