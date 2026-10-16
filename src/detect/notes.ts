// Drawing notes ("keynotes") are numbers or number+letter labels inside a hexagon: 14, 1A, 4B ...
// CAD exports draw the hexagon as six separate line segments (or sometimes as one closed path), so the shape
// is found from its geometry and the label is the text inside it.
import type { PageRun } from './pageRuns.ts';
import type { Prim } from './primitives.ts';

export interface HexNote { label: string; x: number; y: number; r: number } // normalized center, plus half-width (points)

const SQ3 = Math.sqrt(3);
const T = 0.9; // points of tolerance

const near = (a: number, b: number, t = T) => Math.abs(a - b) <= t;

/** Flat-topped hexagons made of six line segments (side s: two horizontals of length s, four diagonals s/2 by s*sqrt(3)/2). */
function fromSegments(prims: Prim[]): { cx: number; cy: number; s: number }[] {
  const segs = prims.filter((p) => !p.fill && p.n === 2 && p.lum < 0.6);
  const horiz = segs.filter((p) => p.y1 - p.y0 < 0.6 && p.x1 - p.x0 >= 4 && p.x1 - p.x0 <= 16);
  const diag = segs.filter((p) => p.x1 - p.x0 >= 2 && p.x1 - p.x0 <= 8.5 && p.y1 - p.y0 >= 3.5 && p.y1 - p.y0 <= 14);
  // spatial hash for the diagonals
  const cell = 12;
  const grid = new Map<string, Prim[]>();
  for (const d of diag) {
    const k = `${Math.floor(d.x0 / cell)},${Math.floor(d.y0 / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(d);
  }
  const has = (x0: number, x1: number, y0: number, y1: number) => {
    for (let i = Math.floor((x0 - 1) / cell); i <= Math.floor((x0 + 1) / cell); i++)
      for (let j = Math.floor((y0 - 1) / cell); j <= Math.floor((y0 + 1) / cell); j++)
        for (const d of grid.get(`${i},${j}`) ?? []) if (near(d.x0, x0) && near(d.x1, x1) && near(d.y0, y0) && near(d.y1, y1)) return true;
    return false;
  };
  const byY = new Map<number, Prim[]>();
  for (const h of horiz) (byY.get(Math.round(h.y0)) ?? byY.set(Math.round(h.y0), []).get(Math.round(h.y0))!).push(h);
  const found = new Map<string, { cx: number; cy: number; s: number }>();
  for (const top of horiz) {
    const s = top.x1 - top.x0;
    const yB = top.y0 + s * SQ3;
    for (let dy = -1; dy <= 1; dy++) {
      for (const bot of byY.get(Math.round(yB) + dy) ?? []) {
        if (!near(bot.x0, top.x0) || !near(bot.x1, top.x1) || !near(bot.y0, yB, 1.2)) continue;
        const yT = top.y0, mid = (yT + bot.y0) / 2, h2 = mid - yT, hs = s / 2;
        if (has(top.x0 - hs, top.x0, yT, mid) && has(top.x0 - hs, top.x0, mid, bot.y0) && has(top.x1, top.x1 + hs, yT, mid) && has(top.x1, top.x1 + hs, mid, bot.y0) && h2 > 0) {
          const cx = (top.x0 + top.x1) / 2, cy = mid;
          found.set(`${Math.round(cx)},${Math.round(cy)}`, { cx, cy, s });
        }
      }
    }
  }
  return [...found.values()];
}

/** Hexagons drawn as one closed path of 6 or 7 points. */
function fromPaths(prims: Prim[]): { cx: number; cy: number; s: number }[] {
  return prims
    .filter((p) => !p.fill && (p.n === 6 || p.n === 7) && p.lum < 0.6)
    .filter((p) => { const w = p.x1 - p.x0, h = p.y1 - p.y0; return w >= 8 && w <= 34 && Math.abs(w / h - 2 / SQ3) < 0.12; })
    .map((p) => ({ cx: (p.x0 + p.x1) / 2, cy: (p.y0 + p.y1) / 2, s: (p.x1 - p.x0) / 2 }));
}

export function findHexNotes(prims: Prim[], runs: PageRun[], pageW: number, pageH: number): HexNote[] {
  const hexes = [...fromSegments(prims), ...fromPaths(prims)];
  const seen = new Set<string>();
  const out: HexNote[] = [];
  const cells = runs.filter((r) => r.str.trim()).map((r) => ({ s: r.str.trim(), cx: r.cx * pageW, cy: r.cy * pageH }));
  for (const h of hexes) {
    const key = `${Math.round(h.cx / 3)},${Math.round(h.cy / 3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const halfW = h.s * 1.0, halfH = (h.s * SQ3) / 2;
    const inside = cells.filter((c) => Math.abs(c.cx - h.cx) <= halfW && Math.abs(c.cy - h.cy) <= halfH).sort((a, b) => a.cx - b.cx);
    const label = inside.map((c) => c.s).join('').replace(/\s+/g, '');
    if (label && /^[A-Z0-9]{1,4}$/i.test(label)) out.push({ label: label.toUpperCase(), x: h.cx / pageW, y: h.cy / pageH, r: halfW });
  }
  return out;
}
