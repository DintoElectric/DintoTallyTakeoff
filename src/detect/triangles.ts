// Outlets drawn as a triangle with a label beside it (telecommunications: "2", "4", "F2", "WAP", "IPC"...). The triangle and
// its label together are the device: a solid triangle with a 2 is a different outlet from a solid triangle with a 4, or from a
// hollow triangle with a 2. CAD draws the triangle as three separate lines and lays the solid black over it as its own filled
// shape, so triangles are found from lines that meet, at any angle; the fill decides solid or hollow.
import type { Prim } from './primitives.ts';
import type { TextMark } from './symbolSearch.ts';
import { fitRing, segIndex } from './symbolContext.ts';

export interface TriangleHit {
  x: number; y: number;        // the triangle's centre (centroid), points
  side: number;                // its longest side, points
  solid: boolean;
  /** Drawn inside a circle: the ceiling (or pendant) version of the outlet; a plain triangle is the wall-mounted one. */
  circled: boolean;
  label: string | null;        // the text beside it ("2", "WAP"); null when nothing is there
  labelAt: { x: number; y: number } | null;
}

interface Seg { ax: number; ay: number; bx: number; by: number; len: number }
const LABEL = /^[A-Z0-9][A-Z0-9-]{0,7}$/i;   // short: "2", "F2", "WAP-PM"
/**
 * What an outlet's label looks like: a port count ("2", "4"), a code with a number ("F2", "PT4", "4AC"), a short code ("WAP",
 * "K"), a code and its mounting ("IPC-PM"), or any code already in the library ("IPTV"). Not "100" (a mechanical rating), nor a
 * word from a note ("MORE", "HANGING"), nor "SHWP-2".
 */
export function outletLabel(s: string, known?: Set<string>): boolean {
  const t = s.trim().toUpperCase();
  if (known?.has(t)) return true;
  return /^\d{1,2}$/.test(t) || /^\d[A-Z]{1,3}$/.test(t) || /^[A-Z]{1,4}\d{1,2}$/.test(t) || /^[A-Z]{1,3}$/.test(t) || /^[A-Z]{1,4}-[A-Z]{1,3}$/.test(t);
}
const NUMBERISH = /^\d+(\.\d+)?$/;

/** Triangles made of three straight lines that meet end to end, sides between 5 and 30 points, equal-sided within a quarter. */
export function findTriangleShapes(prims: Prim[]): { a: number[]; b: number[]; c: number[]; cx: number; cy: number; side: number }[] {
  const segs: Seg[] = [];
  for (const p of prims) {
    if (p.n !== 2 || !p.pts || p.pts.length < 4) continue;
    const [ax, ay, bx, by] = p.pts; const len = Math.hypot(bx - ax, by - ay);
    if (len >= 5 && len <= 30) segs.push({ ax, ay, bx, by, len });
  }
  // end points, by position (a 1-point grid)
  const ends = new Map<string, { s: Seg; end: 0 | 1 }[]>();
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  for (const s of segs) for (const [end, x, y] of [[0, s.ax, s.ay], [1, s.bx, s.by]] as const) (ends.get(key(x, y)) ?? ends.set(key(x, y), []).get(key(x, y))!).push({ s, end });
  const near = (x: number, y: number) => { const out: { s: Seg; end: 0 | 1 }[] = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of ends.get(`${Math.round(x) + i},${Math.round(y) + j}`) ?? []) { const ex = e.end ? e.s.bx : e.s.ax, ey = e.end ? e.s.by : e.s.ay; if (Math.hypot(ex - x, ey - y) <= 0.6) out.push(e); } return out; };
  const other = (e: { s: Seg; end: 0 | 1 }) => (e.end ? [e.s.ax, e.s.ay] : [e.s.bx, e.s.by]);
  const seen = new Set<string>();
  const out: { a: number[]; b: number[]; c: number[]; cx: number; cy: number; side: number }[] = [];
  for (const s of segs) {
    const A = [s.ax, s.ay], B = [s.bx, s.by];
    for (const e of near(B[0], B[1])) {
      if (e.s === s) continue;
      const C = other(e);
      if (Math.hypot(C[0] - A[0], C[1] - A[1]) < 4) continue;
      // a third line from C back to A
      if (!near(C[0], C[1]).some((f) => f.s !== e.s && f.s !== s && Math.hypot(other(f)[0] - A[0], other(f)[1] - A[1]) <= 0.6)) continue;
      const sides = [Math.hypot(B[0] - A[0], B[1] - A[1]), Math.hypot(C[0] - B[0], C[1] - B[1]), Math.hypot(A[0] - C[0], A[1] - C[1])];
      const mx = Math.max(...sides), mn = Math.min(...sides);
      // An outlet's triangle is equal-sided (10.3, 10.4, 10.4). A flat or right-angled one is something else: a fire alarm
      // speaker hanging off a strobe's box, a corner of other linework.
      if (mx > 30 || mn < 5 || mx / mn > 1.25) continue;
      const k = [A, B, C].map(([x, y]) => `${Math.round(x * 2)},${Math.round(y * 2)}`).sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ a: A, b: B, c: C, cx: (A[0] + B[0] + C[0]) / 3, cy: (A[1] + B[1] + C[1]) / 3, side: mx });
    }
  }
  return out;
}

/**
 * Triangle outlets on a page: each triangle, whether it is solid, and the label beside it. A triangle with its label INSIDE it
 * is a revision delta, not an outlet, and is left out. A label belongs to the nearest triangle.
 */
export function findTriangles(prims: Prim[], texts: TextMark[], known?: Set<string>): TriangleHit[] {
  const tris = findTriangleShapes(prims);
  const ix = segIndex(prims);
  const fills = prims.filter((p) => p.fill && p.lum <= 0.35 && p.x1 - p.x0 <= 40 && p.y1 - p.y0 <= 40);
  const all = texts.map((t) => ({ s: t.s.trim(), x: t.x, y: t.y })).filter((t) => LABEL.test(t.s));
  const marks = all.filter((t) => outletLabel(t.s, known));
  const out: (TriangleHit & { delta: boolean })[] = tris.map((t) => {
    const x0 = Math.min(t.a[0], t.b[0], t.c[0]), x1 = Math.max(t.a[0], t.b[0], t.c[0]), y0 = Math.min(t.a[1], t.b[1], t.c[1]), y1 = Math.max(t.a[1], t.b[1], t.c[1]);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    // solid: a dark fill covering the triangle's box (and not much bigger than it)
    const solid = fills.some((f) => { const ox = Math.max(0, Math.min(x1, f.x1) - Math.max(x0, f.x0)), oy = Math.max(0, Math.min(y1, f.y1) - Math.max(y0, f.y0)); return (ox * oy) / area >= 0.6 && (f.x1 - f.x0) * (f.y1 - f.y0) <= area * 1.8; });
    // A label INSIDE the triangle makes it a revision delta, not an outlet.
    const delta = all.some((m) => inTriangle(m.x, m.y, t.a, t.b, t.c));
    // a circle drawn around it: the ceiling or pendant version (a plain triangle is wall mounted)
    const ring = fitRing(ix, t.cx, t.cy, 3);
    const circled = !!ring && ring.r >= t.side * 0.55 && ring.r <= t.side * 1.25 && Math.hypot(ring.x - t.cx, ring.y - t.cy) < 3;
    return { x: t.cx, y: t.cy, side: t.side, solid, circled, label: null, labelAt: null, delta };
  }).filter((t) => !t.delta);
  // each label goes to the nearest triangle within reach (beside it, not inside)
  const pairs: { ti: number; m: typeof marks[number]; d: number }[] = [];
  out.forEach((t, ti) => { for (const m of marks) { const d = Math.hypot(m.x - t.x, m.y - t.y); if (d >= t.side * 0.29 && d <= t.side + 12) pairs.push({ ti, m, d }); } });
  pairs.sort((p, q) => p.d - q.d);
  const usedMark = new Set<typeof marks[number]>();
  for (const p of pairs) {
    if (out[p.ti].label !== null || usedMark.has(p.m)) continue;
    out[p.ti].label = p.m.s; out[p.ti].labelAt = { x: p.m.x, y: p.m.y }; usedMark.add(p.m);
  }
  return out.map(({ delta: _d, ...t }) => t);
}

/**
 * The code a triangle outlet is counted under. Lettered labels keep their label ("IPC", "M4", matching the legend), a plain
 * number gets a prefix ("TRI-2": a bare 2 would be lost among every other 2 on a sheet). In a circle (ceiling) adds "-CLG",
 * unless the label already says pendant ("IPC-PM"); a hollow triangle is another device again ("TRIO-4").
 */
export function triangleCode(t: TriangleHit): string | null {
  const label = (t.label ?? '').toUpperCase();
  if (!label) return null;
  const base = t.solid ? (/[A-Z]/.test(label) && !NUMBERISH.test(label) ? label : `TRI-${label}`) : `TRIO-${label}`;
  return t.circled && !/-PM$/.test(label) ? `${base}-CLG` : base;
}
export function triangleName(t: TriangleHit): string {
  const label = (t.label ?? '').toUpperCase();
  return `Outlet "${label}"${t.solid ? '' : ', hollow triangle'}${t.circled ? (/-PM$/.test(label) ? ', pendant (triangle in a circle)' : ', ceiling (triangle in a circle)') : ', wall (plain triangle)'}`;
}

/** Is (x, y) inside the triangle abc? */
function inTriangle(x: number, y: number, a: number[], b: number[], c: number[]): boolean {
  const d = (p: number[], q: number[]) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
