// Symbols matched by how they look, not by how they were drawn. A legend's duplex receptacle may be one curve and two lines
// while the plan's is ten short straight pieces and two lines, a little smaller: piece-by-piece comparison never matches
// them. So a symbol is the points along all its linework (and inside its fills), in its own box; two symbols match when
// those points lie close to each other's, at any quarter turn, mirrored or not, and within a little of the same size.
import type { Prim } from './primitives.ts';

export interface Shape { w: number; h: number; pts: [number, number][]; fill: number }   // points: within the box, in points; fill: the share of its box it covers
export interface ShapeMatch { x: number; y: number; score: number; turn: number; w?: number; h?: number }   // centre and size, points; turn: quarter turns

const DARK = 0.35;     // linework that carries a symbol (gray hatching and ceiling grid do not)
const PIECE_MAX = 22;  // points: a symbol's pieces are short; walls and grid lines are not part of one
const JOIN = 0.9;      // points: pieces this close belong to one symbol
const STEP = 0.35;     // points: spacing of the points along the linework

type P = Prim & { pts?: [number, number][] | number[] };
const ptsOf = (p: P): [number, number][] => {
  const raw = (p.path ?? p.pts) as unknown;   // (along its curves, when read with keepPoints)
  if (Array.isArray(raw) && raw.length) {
    if (Array.isArray(raw[0])) return raw as [number, number][];
    const a = raw as number[]; const out: [number, number][] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out;
  }
  return [[p.x0, p.y0], [p.x1, p.y1]];
};
/** Points every STEP along a shape's outline (and across it, when it is filled). */
function sample(p: P, out: [number, number][]) {
  const q = ptsOf(p);
  for (let i = 0; i + 1 < q.length; i++) {
    const [ax, ay] = q[i], [bx, by] = q[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / STEP));
    for (let k = 0; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (p.fill && p.x1 - p.x0 < PIECE_MAX && p.y1 - p.y0 < PIECE_MAX)
    for (let x = p.x0; x <= p.x1; x += STEP * 2) for (let y = p.y0; y <= p.y1; y += STEP * 2) out.push([x, y]);
}
const small = (p: Prim) => p.lum < DARK && Math.max(p.x1 - p.x0, p.y1 - p.y0) <= PIECE_MAX;

/** Groups of small dark pieces that touch: each is one symbol (or part of the drawing that is not one). */
function clusters(prims: Prim[]): { prims: Prim[]; x0: number; y0: number; x1: number; y1: number }[] {
  const ps = prims.filter(small);
  const C = 8, grid = new Map<string, number[]>();
  ps.forEach((p, i) => { for (let gx = Math.floor((p.x0 - JOIN) / C); gx <= Math.floor((p.x1 + JOIN) / C); gx++) for (let gy = Math.floor((p.y0 - JOIN) / C); gy <= Math.floor((p.y1 + JOIN) / C); gy++) { const k = `${gx}:${gy}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); } });
  const seen = new Int32Array(ps.length).fill(-1), out: { prims: Prim[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < ps.length; i++) {
    if (seen[i] >= 0) continue;
    const c = { prims: [] as Prim[], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const stack = [i]; seen[i] = out.length;
    while (stack.length) {
      const j = stack.pop()!; const p = ps[j]; c.prims.push(p);
      c.x0 = Math.min(c.x0, p.x0); c.y0 = Math.min(c.y0, p.y0); c.x1 = Math.max(c.x1, p.x1); c.y1 = Math.max(c.y1, p.y1);
      if (c.x1 - c.x0 > 3 * PIECE_MAX || c.y1 - c.y0 > 3 * PIECE_MAX) continue;   // (a long chain of pieces is drawing, not a symbol)
      for (let gx = Math.floor((p.x0 - JOIN) / C); gx <= Math.floor((p.x1 + JOIN) / C); gx++) for (let gy = Math.floor((p.y0 - JOIN) / C); gy <= Math.floor((p.y1 + JOIN) / C); gy++)
        for (const k of grid.get(`${gx}:${gy}`) ?? []) {
          if (seen[k] >= 0) continue;
          const o = ps[k];
          if (o.x0 > p.x1 + JOIN || o.x1 < p.x0 - JOIN || o.y0 > p.y1 + JOIN || o.y1 < p.y0 - JOIN) continue;
          seen[k] = out.length; stack.push(k);
        }
    }
    out.push(c);
  }
  return out;
}

/** The shape of the symbol drawn in a box (a legend's symbol column beside a row): the biggest group of pieces in it. */
export function shapeIn(prims: Prim[], box: { x0: number; y0: number; x1: number; y1: number }): Shape | null {
  const inBox = prims.filter((p) => (p.x0 + p.x1) / 2 >= box.x0 && (p.x0 + p.x1) / 2 <= box.x1 && (p.y0 + p.y1) / 2 >= box.y0 && (p.y0 + p.y1) / 2 <= box.y1);
  const cs = clusters(inBox).filter((c) => c.x1 - c.x0 >= 3 || c.y1 - c.y0 >= 3);
  if (!cs.length) return null;
  const c = cs.reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
  return shapeOf(c);
}
function shapeOf(c: { prims: Prim[]; x0: number; y0: number; x1: number; y1: number }): Shape {
  const raw: [number, number][] = [];
  for (const p of c.prims) sample(p as P, raw);
  // thinned to one point per small cell: what the symbol looks like, however finely it was drawn
  const seen = new Set<string>(); const pts: [number, number][] = [];
  for (const [x, y] of raw) { const k = `${Math.round((x - c.x0) / STEP)}:${Math.round((y - c.y0) / STEP)}`; if (!seen.has(k)) { seen.add(k); pts.push([Math.round((x - c.x0) * 100) / 100, Math.round((y - c.y0) * 100) / 100]); } }
  // How much of its box it covers: a filled band reads the same whether it was drawn as a fill (on the legend) or as close
  // hatching (on the plan); an outline covers less. Two symbols that differ only by a fill differ by this.
  const Cc = 0.7, cells = new Set(pts.map(([x, y]) => `${Math.floor(x / Cc)}:${Math.floor(y / Cc)}`));
  const fill = Math.round((cells.size / ((Math.floor((c.x1 - c.x0) / Cc) + 1) * (Math.floor((c.y1 - c.y0) / Cc) + 1))) * 1000) / 1000;
  return { w: Math.round((c.x1 - c.x0) * 100) / 100, h: Math.round((c.y1 - c.y0) * 100) / 100, pts, fill };
}

/**
 * The angle a symbol is turned by, within a quarter turn (-45 to 45 degrees): the direction its straight pieces agree on,
 * weighted by length. A duplex's two lines set it; the many short pieces of its circle point every way and cancel out.
 * Square to the sheet, it is 0.
 */
function tiltOf(c: { prims: Prim[] }): number {
  let sx = 0, sy = 0;
  for (const p of c.prims) {
    const q = ptsOf(p as P);
    for (let i = 0; i + 1 < q.length; i++) {
      const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1], len = Math.hypot(dx, dy);
      if (len < 2) continue;
      const a = 4 * Math.atan2(dy, dx);   // (four times the angle: directions a quarter turn apart agree)
      sx += len * len * Math.cos(a); sy += len * len * Math.sin(a);
    }
  }
  return Math.hypot(sx, sy) < 1e-6 ? 0 : Math.atan2(sy, sx) / 4;
}
/** A group of pieces as a shape, straightened by an angle (radians) about its middle first. */
function shapeTurned(c: { prims: Prim[]; x0: number; y0: number; x1: number; y1: number }, angle: number): Shape {
  if (Math.abs(angle) < 0.05) return shapeOf(c);   // (within 3 degrees: as it is)
  const raw: [number, number][] = [];
  for (const p of c.prims) sample(p as P, raw);
  const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2, co = Math.cos(-angle), si = Math.sin(-angle);
  const rot = raw.map(([x, y]) => [mx + (x - mx) * co - (y - my) * si, my + (x - mx) * si + (y - my) * co] as [number, number]);
  const x0 = Math.min(...rot.map((p) => p[0])), y0 = Math.min(...rot.map((p) => p[1])), x1 = Math.max(...rot.map((p) => p[0])), y1 = Math.max(...rot.map((p) => p[1]));
  const seen = new Set<string>(); const pts: [number, number][] = [];
  for (const [x, y] of rot) { const k = `${Math.round((x - x0) / STEP)}:${Math.round((y - y0) / STEP)}`; if (!seen.has(k)) { seen.add(k); pts.push([Math.round((x - x0) * 100) / 100, Math.round((y - y0) * 100) / 100]); } }
  const Cc = 0.7, cells = new Set(pts.map(([x, y]) => `${Math.floor(x / Cc)}:${Math.floor(y / Cc)}`));
  const fill = Math.round((cells.size / ((Math.floor((x1 - x0) / Cc) + 1) * (Math.floor((y1 - y0) / Cc) + 1))) * 1000) / 1000;
  return { w: Math.round((x1 - x0) * 100) / 100, h: Math.round((y1 - y0) * 100) / 100, pts, fill };
}

/** The shape turned by quarter turns (0-3), mirrored or not, in its new box. */
function turned(s: Shape, turn: number, mirror: boolean): Shape {
  let pts = s.pts.map(([x, y]) => [mirror ? s.w - x : x, y] as [number, number]);
  let w = s.w, h = s.h;
  for (let t = 0; t < turn; t++) { pts = pts.map(([x, y]) => [h - y, x] as [number, number]); [w, h] = [h, w]; }
  return { ...s, w, h, pts };
}

// Compared in a common box: each shape scaled to 10 units across its own box (a small difference in size is allowed for by
// the size check), its points on a grid prepared once, so each comparison is quick.
const U = 10, G = 0.5;
interface Ready { w: number; h: number; fill: number; pts: [number, number][]; grid: Map<number, [number, number][]> }
function ready(s: Shape): Ready {
  const sx = U / Math.max(s.w, 0.5), sy = U / Math.max(s.h, 0.5);
  const pts = s.pts.map(([x, y]) => [x * sx, y * sy] as [number, number]);
  const grid = new Map<number, [number, number][]>();
  for (const p of pts) { const k = Math.floor(p[0] / G) * 1000 + Math.floor(p[1] / G); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  return { w: s.w, h: s.h, fill: s.fill, pts, grid };
}
function nearest(r: Ready, x: number, y: number, max: number): number {
  let d = max; const gx = Math.floor(x / G), gy = Math.floor(y / G), reach = Math.ceil(max / G);
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) for (const p of r.grid.get((gx + i) * 1000 + gy + j) ?? []) { const e = Math.hypot(p[0] - x, p[1] - y); if (e < d) d = e; }
  return d;
}
/** How alike two shapes are (0..1): the share of each one's points that come close to the other's, less a fill one lacks. */
function alikeR(a: Ready, b: Ready): number {
  const tol = (0.035 * Math.hypot(b.w, b.h) + 0.15) * U / Math.max(b.w, b.h, 0.5);   // (tight enough to tell a diamond from a circle)
  let ab = 0; for (const [x, y] of a.pts) if (nearest(b, x, y, tol * 1.01) <= tol) ab++;
  const s1 = ab / Math.max(1, a.pts.length);
  if (s1 < 0.6) return s1;
  let ba = 0; for (const [x, y] of b.pts) if (nearest(a, x, y, tol * 1.01) <= tol) ba++;
  // (a small difference in coverage is drawing style; a bigger one is a fill one has and the other has not)
  return Math.min(s1, ba / Math.max(1, b.pts.length)) - Math.min(0.5, Math.max(0, Math.abs(a.fill - b.fill) - 0.08) * 2);
}
/** How alike two shapes are as drawn (no turning): for telling which legend rows share a symbol. */
export const shapesAlike = (a: Shape, b: Shape) => alikeR(ready(a), ready(b));

/** Every symbol on a page that looks like the shape: at any quarter turn, mirrored, within about a fifth of its size. */
export function findShapes(prims: Prim[], shape: Shape, opts: { minScore?: number } = {}): ShapeMatch[] {
  return findBestShapes(prims, [{ key: 'x', shape }], opts);
}

/**
 * Each symbol on a page that looks like one of several shapes, given to the one it looks most like (a duplex receptacle is
 * not also counted as a double duplex), at any quarter turn, mirrored, within about a fifth of its size.
 */
export function findBestShapes(prims: Prim[], shapes: { key: string; shape: Shape }[], opts: { minScore?: number } = {}): (ShapeMatch & { key: string; second: number })[] {
  const min = opts.minScore ?? 0.76, slack = 0.22;
  const vars = shapes.map((sh) => { const v: { r: Ready; turn: number }[] = []; for (let t = 0; t < 4; t++) for (const m of [false, true]) v.push({ r: ready(turned(sh.shape, t, m)), turn: t }); return { key: sh.key, v }; });
  const out: (ShapeMatch & { key: string; second: number })[] = [];
  const sizeMax = Math.max(...shapes.map((sh) => Math.hypot(sh.shape.w, sh.shape.h))) * (1 + slack);
  for (const c of clusters(prims)) {
    // (a symbol turned at an angle, along an angled wall, is straightened by its own lines first)
    if (Math.hypot(c.x1 - c.x0, c.y1 - c.y0) > sizeMax * 1.05) continue;
    const tilt = tiltOf(c);
    const straight = shapeTurned(c, tilt);
    const w = straight.w, h = straight.h;
    const fits = (r: Ready) => Math.abs(w - r.w) <= slack * Math.max(r.w, 2) && Math.abs(h - r.h) <= slack * Math.max(r.h, 2);
    if (!vars.some((x) => x.v.some((v) => fits(v.r)))) continue;
    const cand = ready(straight);
    const scores = vars.map((x) => { let best = 0, turn = 0; for (const v of x.v) { if (!fits(v.r)) continue; const sc = alikeR(v.r, cand); if (sc > best) { best = sc; turn = v.turn; } } return { key: x.key, best, turn }; }).sort((a, b) => b.best - a.best);
    if (scores[0].best >= min) out.push({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2, w, h, score: scores[0].best, turn: scores[0].turn, key: scores[0].key, second: scores[1]?.best ?? 0 });
  }
  return out;
}

export interface SymbolItem { id: string; code: string; symbol: Shape & { letters?: string[] } }
export interface SymbolHit { itemId: string; code: string; x: number; y: number; score: number }   // x, y: points
/**
 * The library's symbol items found on a page. Items whose symbols look the same (a legend's duplex, and its rows with
 * "GF", "WP" beside the same duplex) are one symbol here: each match goes to the symbol it looks most like, then the letters
 * beside it decide the item (each letter to its nearest symbol only), and a bare symbol is the item with no letters.
 */
export function findSymbolItems(prims: Prim[], texts: { s: string; x: number; y: number }[], items: SymbolItem[], opts: { minScore?: number } = {}): SymbolHit[] {
  const groups: { rep: SymbolItem; members: SymbolItem[] }[] = [];
  for (const it of [...items].sort((a, b) => (a.symbol.letters?.length ?? 0) - (b.symbol.letters?.length ?? 0))) {
    // (the same symbol drawn again scores 1.00; a double duplex and one above counter, close as they are, about 0.95)
    const g = groups.find((x) => shapesAlike(x.rep.symbol, it.symbol) >= 0.98 && shapesAlike(it.symbol, x.rep.symbol) >= 0.98);
    if (g) g.members.push(it); else groups.push({ rep: it, members: [it] });
  }
  const matches = findBestShapes(prims, groups.map((g, i) => ({ key: String(i), shape: g.rep.symbol })), opts);
  // the modifiers: items drawn as the most common symbol with letters beside it (a duplex with "GF")
  const modifiers = groups.flatMap((g) => g.members.filter((it) => (it.symbol.letters ?? []).length && g.members.some((m) => !(m.symbol.letters ?? []).length)));
  // the short pieces of text near the matches, each given to the match it is nearest (a neighbour's "G" is not this one's)
  const REACH = 16;
  const owner = new Map<number, number>();
  texts.forEach((t, ti) => {
    const s = t.s.trim(); if (!s || s.length > 4 || /^\d+$/.test(s)) return;
    let best = -1, d = REACH;
    matches.forEach((m, mi) => { const e = Math.hypot(m.x - t.x, m.y - t.y); if (e < d) { d = e; best = mi; } });
    if (best >= 0) owner.set(ti, best);
  });
  const lettersOf = new Map<number, string[]>();
  for (const [ti, mi] of owner) (lettersOf.get(mi) ?? lettersOf.set(mi, []).get(mi)!).push(texts[ti].s.trim().toUpperCase());
  const out: SymbolHit[] = [];
  matches.forEach((m, mi) => {
    const g = groups[Number(m.key)], have = lettersOf.get(mi) ?? [];
    const hasAll = (it: SymbolItem) => (it.symbol.letters ?? []).length > 0 && (it.symbol.letters ?? []).every((l) => have.includes(l.toUpperCase()));
    // this symbol's own lettered row (USB beside a double duplex: its own row), else a modifier written beside any symbol
    // (G, GF, WP, E: the legend shows them on the duplex, the plans put them beside others too), else the plain one
    const lettered = g.members.find(hasAll) ?? modifiers.find(hasAll);
    // (letters inside the symbol say what it is: a square with "J" in it is a junction box, not a plain square's item;
    // a number inside, as in a special purpose receptacle's, is only a reference)
    const inside = texts.filter((t) => { const v = t.s.trim(); return v && !/^\d+$/.test(v) && v.length <= 4 && Math.abs(t.x - m.x) <= (m.w ?? 0) / 2 && Math.abs(t.y - m.y) <= (m.h ?? 0) / 2; });
    const plain = inside.length ? undefined : g.members.find((it) => !(it.symbol.letters ?? []).length);
    const it = lettered ?? plain;
    if (it) out.push({ itemId: it.id, code: it.code, x: m.x, y: m.y, score: m.score });
  });
  return out;
}
