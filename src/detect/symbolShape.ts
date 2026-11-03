// Symbols matched by how they look, not by how they were drawn. A legend's duplex receptacle may be one curve and two lines
// while the plan's is ten short straight pieces and two lines, a little smaller: piece-by-piece comparison never matches
// them. So a symbol is the points along all its linework (and inside its fills), in its own box; two symbols match when
// those points lie close to each other's, at any quarter turn, mirrored or not, and within a little of the same size.
import type { Prim } from './primitives.ts';

export interface Shape { w: number; h: number; pts: [number, number][]; fill: number }   // points: within the box, in points; fill: the share of its box it covers
export interface ShapeMatch { x: number; y: number; score: number; turn: number; w?: number; h?: number; ranked?: { key: string; score: number }[] }   // centre and size, points; turn: quarter turns; ranked: every shape it passes for, best first

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
      // (grown to its full size, so a row of receptacles along a wall is not cut through one of them; a chain bigger than
      // a room is drawing, not symbols, and stops)
      if (c.prims.length > 6000 || c.x1 - c.x0 > 400 || c.y1 - c.y0 > 400) continue;
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
export function findBestShapes(prims: Prim[], shapes: { key: string; shape: Shape }[], opts: { minScore?: number; inside?: boolean } = {}): (ShapeMatch & { key: string; second: number })[] {
  const min = opts.minScore ?? 0.76, slack = 0.22;
  const vars = shapes.map((sh) => { const v: { r: Ready; turn: number }[] = []; for (let t = 0; t < 4; t++) for (const m of [false, true]) v.push({ r: ready(turned(sh.shape, t, m)), turn: t }); return { key: sh.key, v }; });
  const out: (ShapeMatch & { key: string; second: number })[] = [];
  const sizeMax = Math.max(...shapes.map((sh) => Math.hypot(sh.shape.w, sh.shape.h))) * (1 + slack);
  const unmatched: ReturnType<typeof clusters> = [];
  const scales = new Map<string, number[]>();   // how big this sheet draws each symbol, against the legend
  for (const c of clusters(prims)) {
    // (a symbol turned at an angle, along an angled wall, is straightened by its own lines first)
    if (Math.hypot(c.x1 - c.x0, c.y1 - c.y0) > sizeMax * 1.05) { if (c.prims.length <= 6000) unmatched.push(c); continue; }   // (too big to be one symbol: looked inside)
    const tilt = tiltOf(c);
    const straight = shapeTurned(c, tilt);
    const w = straight.w, h = straight.h;
    const fits = (r: Ready) => Math.abs(w - r.w) <= slack * Math.max(r.w, 2) && Math.abs(h - r.h) <= slack * Math.max(r.h, 2);
    if (!vars.some((x) => x.v.some((v) => fits(v.r)))) continue;
    const cand = ready(straight);
    const scores = vars.map((x) => { let best = 0, turn = 0; for (const v of x.v) { if (!fits(v.r)) continue; const sc = alikeR(v.r, cand); if (sc > best) { best = sc; turn = v.turn; } } return { key: x.key, best, turn }; }).sort((a, b) => b.best - a.best);
    if (scores[0].best >= min) {
      out.push({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2, w, h, score: scores[0].best, turn: scores[0].turn, key: scores[0].key, second: scores[1]?.best ?? 0, ranked: scores.filter((q) => q.best >= min).map((q) => ({ key: q.key, score: q.best })) });
      const sh = shapes.find((q) => q.key === scores[0].key)!.shape;
      (scales.get(scores[0].key) ?? scales.set(scores[0].key, []).get(scores[0].key)!).push(Math.hypot(w, h) / Math.max(0.5, Math.hypot(sh.w, sh.h)));
    } else unmatched.push(c);
  }
  // Symbols touching one another, or touching other linework, read as one shape that matches nothing: look inside it.
  if (opts.inside !== false && unmatched.length) {
    // the sheet's middle size (and, inside a shape, the size the line a symbol is lined up on says)
    const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    const every = [...scales.values()].flat();
    const overall = every.length ? mid(every) : 0.95;
    const scale = new Map(shapes.map((sh) => [sh.key, overall]));
    // (a long line stuck to a symbol can pull the shape's direction off: square to the sheet is tried too, and whichever finds
    // more is kept)
    for (const c of unmatched) {
      const tilt = tiltOf(c);
      const a = findInside(c, shapes, scale, tilt);
      const b = Math.abs(tilt) > 0.05 ? findInside(c, shapes, scale, 0) : [];
      out.push(...(b.length > a.length ? b : a));
    }
  }
  return out;
}

/**
 * Inside a shape that matched nothing (two receptacles drawn touching, a receptacle against a counter's linework): each
 * legend symbol is slid over it, at this sheet's size, and kept where every part of it is there (nine tenths of its points
 * close to the shape's) and it is most of what is there (seven tenths of the shape's points in that spot are its own).
 * What is found is set aside and the search goes on, for a second symbol stuck to the first.
 */
function findInside(c: ReturnType<typeof clusters>[number], shapes: { key: string; shape: Shape }[], scales: Map<string, number>, tilt: number): (ShapeMatch & { key: string; second: number })[] {
  // the shape's straight pieces, straightened with it: only where a legend symbol's longest line lines up with one of these
  // can the symbol be (a few places to try, not every place)
  const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2, co = Math.cos(-tilt), si = Math.sin(-tilt);
  const turn1 = ([x, y]: [number, number]) => [mx + (x - mx) * co - (y - my) * si, my + (x - mx) * si + (y - my) * co] as [number, number];
  const lines: Run[] = [];
  for (const p of c.prims) {
    const q = ptsOf(p as P);
    for (let i = 0; i + 1 < q.length; i++) {
      const a = turn1(q[i]), b = turn1(q[i + 1]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 3) continue;
      if (Math.abs(b[1] - a[1]) < 0.5) lines.push({ dir: 'h', x: Math.min(a[0], b[0]), y: (a[1] + b[1]) / 2, len });
      else if (Math.abs(b[0] - a[0]) < 0.5) lines.push({ dir: 'v', x: (a[0] + b[0]) / 2, y: Math.min(a[1], b[1]), len });
    }
  }
  if (!lines.length) return [];
  const raw: [number, number][] = [];
  for (const p of c.prims) sample(p as P, raw);
  let pts = raw.map(turn1);
  const found: (ShapeMatch & { key: string; second: number })[] = [];
  const tol = 0.45, G2 = 0.6;
  const index = (set: [number, number][]) => { const g = new Map<number, [number, number][]>(); for (const p of set) { const k = Math.floor(p[0] / G2) * 100000 + Math.floor(p[1] / G2); (g.get(k) ?? g.set(k, []).get(k)!).push(p); } return g; };
  const hit = (g: Map<number, [number, number][]>, x: number, y: number, t = tol) => { const gx = Math.floor(x / G2), gy = Math.floor(y / G2); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of g.get((gx + i) * 100000 + gy + j) ?? []) if (Math.hypot(p[0] - x, p[1] - y) <= t) return true; return false; };
  // each legend symbol, in its eight positions, at this sheet's size, with its longest straight line
  const variants: { key: string; t: [number, number][]; few: [number, number][]; w: number; h: number; turn: number; run: Run }[] = [];
  for (const sh of shapes) {
    const seen = new Set<string>(), scale = scales.get(sh.key) ?? 0.95;
    for (let turn = 0; turn < 4; turn++) for (const mirror of [false, true]) {
      const v = turned(sh.shape, turn, mirror);
      const t = v.pts.map(([x, y]) => [x * scale, y * scale] as [number, number]);
      // (a symmetrical symbol looks the same turned or mirrored: each look is tried once)
      const sig = t.map(([x, y]) => `${Math.round(x)}:${Math.round(y)}`).sort().join(' ');
      if (seen.has(sig)) continue; seen.add(sig);
      const run = longestRun(t);
      if (run) variants.push({ key: sh.key, t, few: t.filter((_, i) => i % Math.max(1, Math.floor(t.length / 20)) === 0), w: v.w * scale, h: v.h * scale, turn, run });
    }
  }
  for (let round = 0; round < 4 && pts.length >= 20; round++) {
    const g = index(pts);
    let best: { key: string; score: number; ox: number; oy: number; v: (typeof variants)[number] } | null = null;
    for (const v of variants) {
      for (const l of lines) {
        if (l.dir !== v.run.dir || Math.abs(l.len - v.run.len) > 0.25 * v.run.len) continue;
        // at the sheet's size, and at the size this line says (a double duplex is not always drawn at the duplex's ratio
        // to the legend): the line the symbol is lined up on is the symbol's own
        const k = l.len / v.run.len;
        for (const f of Math.abs(k - 1) > 0.02 && Math.abs(k - 1) <= 0.15 ? [1, k] : [1]) {
        const vt = f === 1 ? v.t : v.t.map(([x, y]) => [x * f, y * f] as [number, number]);
        const vfew = f === 1 ? v.few : v.few.map(([x, y]) => [x * f, y * f] as [number, number]);
        const vw = v.w * f, vh = v.h * f, rx = v.run.x * f, ry = v.run.y * f, rl = v.run.len * f;
        // line the symbol's longest line up with this one (by either end), then settle it within half a point
        for (const [sx, sy] of v.run.dir === 'h' ? [[l.x - rx, l.y - ry], [l.x + l.len - (rx + rl), l.y - ry]] : [[l.x - rx, l.y - ry], [l.x - rx, l.y + l.len - (ry + rl)]]) {
          // (a sample of its points first, at a few spots; all of them only where the sample fits)
          let qb = { cov: 0, ox: sx, oy: sy };
          for (let dx = -0.5; dx <= 0.5; dx += 0.5) for (let dy = -0.5; dy <= 0.5; dy += 0.5) {
            let n = 0; for (const [x, y] of vfew) if (hit(g, x + sx + dx, y + sy + dy)) n++;
            const cov = n / vfew.length; if (cov > qb.cov) qb = { cov, ox: sx + dx, oy: sy + dy };
          }
          if (qb.cov < 0.8) continue;
          let fb = { cov: 0, ox: qb.ox, oy: qb.oy };
          for (let dx = -0.25; dx <= 0.25; dx += 0.125) for (let dy = -0.25; dy <= 0.25; dy += 0.125) {
            let n = 0; for (const [x, y] of vt) if (hit(g, x + qb.ox + dx, y + qb.oy + dy)) n++;
            const cov = n / vt.length; if (cov > fb.cov) fb = { cov, ox: qb.ox + dx, oy: qb.oy + dy };
          }
          if (fb.cov < 0.9) continue;
          // and it is most of what is there in that spot (a busy patch of casework is not a receptacle)
          const own = index(vt.map(([x, y]) => [x + fb.ox, y + fb.oy] as [number, number]));
          const inWin = pts.filter(([x, y]) => x >= fb.ox - 0.3 && x <= fb.ox + vw + 0.3 && y >= fb.oy - 0.3 && y <= fb.oy + vh + 0.3);
          const pur = inWin.length ? inWin.filter(([x, y]) => hit(own, x, y)).length / inWin.length : 0;
          // (receptacles drawn overlapping share a spot: one that is there almost whole may share it with its neighbour)
          if (pur < (fb.cov >= 0.95 ? 0.45 : 0.7)) continue;
          const score = Math.min(fb.cov, 0.5 + pur / 2);
          if (!best || score > best.score) best = { key: v.key, score, ox: fb.ox, oy: fb.oy, v: { ...v, t: vt, w: vw, h: vh } };
        }
        }
      }
    }
    if (!best) break;
    // its centre, turned back to where it is on the sheet
    const cx = best.ox + best.v.w / 2, cy = best.oy + best.v.h / 2, cb = Math.cos(tilt), sb = Math.sin(tilt);
    found.push({ x: mx + (cx - mx) * cb - (cy - my) * sb, y: my + (cx - mx) * sb + (cy - my) * cb, w: best.v.w, h: best.v.h, score: best.score, turn: best.v.turn, key: best.key, second: 0 });
    // set its points aside, and look again (a second symbol stuck to the first)
    const mine = index(best.v.t.map(([x, y]) => [x + best!.ox, y + best!.oy] as [number, number]));
    pts = pts.filter(([x, y]) => !hit(mine, x, y, tol * 1.6));
  }
  return found;
}

interface Run { dir: 'h' | 'v'; x: number; y: number; len: number }   // a straight line, from (x, y) to the right or downward
/** A symbol's longest straight line across or down (a duplex's lines, a square's sides), from its points. */
function longestRun(t: [number, number][]): Run | null {
  let best: Run | null = null;
  for (const dir of ['h', 'v'] as const) {
    const rows = new Map<number, number[]>();
    for (const [x, y] of t) { const k = Math.round((dir === 'h' ? y : x) / 0.15); (rows.get(k) ?? rows.set(k, []).get(k)!).push(dir === 'h' ? x : y); }
    for (const [k, vs] of rows) {
      vs.sort((a, b) => a - b);
      let s0 = vs[0];
      for (let i = 1; i <= vs.length; i++) {
        if (i === vs.length || vs[i] - vs[i - 1] > 0.6) {
          const len = vs[i - 1] - s0;
          if (len > (best?.len ?? 2.5)) best = dir === 'h' ? { dir, x: s0, y: k * 0.15, len } : { dir, x: k * 0.15, y: s0, len };
          if (i < vs.length) s0 = vs[i];
        }
      }
    }
  }
  return best;
}

export interface SymbolItem { id: string; code: string; symbol: Shape & { letters?: string[] } }
export interface SymbolHit { itemId: string; code: string; x: number; y: number; score: number }   // x, y: points
/**
 * The library's symbol items found on a page. Items whose symbols look the same (a legend's duplex, and its rows with
 * "GF", "WP" beside the same duplex) are one symbol here: each match goes to the symbol it looks most like, then the letters
 * beside it decide the item (each letter to its nearest symbol only), and a bare symbol is the item with no letters.
 */
export function findSymbolItems(prims: Prim[], texts: { s: string; x: number; y: number; w?: number; h?: number }[], items: SymbolItem[], opts: { minScore?: number } = {}): SymbolHit[] {
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
    const have = lettersOf.get(mi) ?? [];
    // the best-looking symbol that can take it: one whose item's letters are beside it, or a plain one (a double duplex that
    // looks as much like a symbol drawn only with "G" is still a double duplex when no "G" is there)
    for (const r of m.ranked ?? [{ key: m.key, score: m.score }]) {
      const g = groups[Number(r.key)];
      if (!g) continue;
    const hasAll = (it: SymbolItem) => (it.symbol.letters ?? []).length > 0 && (it.symbol.letters ?? []).every((l) => have.includes(l.toUpperCase()));
    // this symbol's own lettered row (USB beside a double duplex: its own row), else a modifier written beside any symbol
    // (G, GF, WP, E: the legend shows them on the duplex, the plans put them beside others too), else the plain one
    const lettered = g.members.find(hasAll) ?? modifiers.find(hasAll);
    // (letters inside the symbol say what it is: a square with "J" in it is a junction box, not a plain square's item;
    // a number inside, as in a special purpose receptacle's, is only a reference)
    // (text that fits inside it: a room number the symbol is drawn over is bigger than the symbol, and is not its letters)
    const inside = texts.filter((t) => { const v = t.s.trim(); return v && !/^\d+$/.test(v) && v.length <= 4 && Math.abs(t.x - m.x) <= (m.w ?? 0) / 2 && Math.abs(t.y - m.y) <= (m.h ?? 0) / 2 && (t.w ?? 0) <= (m.w ?? 0) * 1.1 + 0.5 && (t.h ?? 0) <= (m.h ?? 0) * 1.1 + 0.5; });
    const plain = inside.length ? undefined : g.members.find((it) => !(it.symbol.letters ?? []).length);
      const it = lettered ?? plain;
      if (it) { out.push({ itemId: it.id, code: it.code, x: m.x, y: m.y, score: r.score }); break; }
    }
  });
  return out;
}
