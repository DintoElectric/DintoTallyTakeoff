// The ceiling a fixture is in, read from the texture drawn in the room on a ceiling plan:
//   drop       a grid of lines in two directions (the 2x2 or 2x4 ceiling grid)
//   sheetrock  speckled with tiny dashes at all angles (the gypsum board hatch)
//   open       neither (it may have some dashes or lines, but no grid and no speckle)
// The texture is drawn in grey: the background linework's grey on some drawings, a lighter grey of its own on others (PSEB's
// speckle is 0.92 grey over 0.67 walls). Fixtures, devices and text are drawn on top in black, so every light grey is looked
// at and black never is.
import type { Prim } from './primitives.ts';

export type Ceiling = 'drop' | 'sheetrock' | 'open';
export const CEILING_LABEL: Record<Ceiling, string> = { drop: 'Drop ceiling', sheetrock: 'Sheetrock', open: 'Open' };

interface Line { x0: number; y0: number; x1: number; y1: number; len: number }
const CELL = 32;
const HALF = 26;              // points: the window around a fixture (about 6 ft across at 1/8" = 1'-0")
const SPECKLE = 14;           // tiny slanted dashes in that window that make it sheetrock
const GRID_GAP = [10, 40];    // points between ceiling grid lines (a 2 ft grid is 18 pt at 1/8")

export interface CeilingIndex { at(x: number, y: number): Ceiling | null; hasTextures: boolean; background: number | null; textured?: number; samples?: number }

/** The most common colour of straight lines that are neither black nor white: the background linework. */
export function backgroundLum(prims: Prim[]): number | null {
  const n = new Map<string, number>();
  for (const p of prims) if (p.n === 2 && p.lum > 0.15 && p.lum < 0.9) n.set(p.lum.toFixed(2), (n.get(p.lum.toFixed(2)) ?? 0) + 1);
  let best: string | null = null, top = 0;
  for (const [k, v] of n) if (v > top) { top = v; best = k; }
  return best === null || top < 500 ? null : Number(best);
}

/** Is this sheet titled a ceiling plan? ("REFLECTED CEILING PLAN", "LIGHTING CEILING PLAN", "RCP") */
export const CEILING_TITLE = /\b(?:REFLECTED\s+)?CEILING\s+PLAN\b|\bRCP\b/i;

/**
 * Reads a sheet's ceiling textures once, then answers "what ceiling is at (x, y)?" for every fixture on it. `titled` says the
 * sheet calls itself a ceiling plan; then a little texture is enough (a plan with much outside the work, like PSEB's, is only a
 * few percent textured), where an untitled sheet must be textured all over.
 */
export function ceilingIndex(prims: Prim[], opts: { titled?: boolean } = {}): CeilingIndex {
  const bg = backgroundLum(prims);
  if (bg === null) return { at: () => null, hasTextures: false, background: null };
  const lines: Line[] = [];
  for (const p of prims) if (p.n === 2 && p.lum > 0.15 && p.lum < 0.97) lines.push({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, len: Math.hypot(p.x1 - p.x0, p.y1 - p.y0) });
  const grid = new Map<string, Line[]>();
  for (const l of lines) {
    // a long line goes in every cell it crosses
    for (let i = Math.floor(l.x0 / CELL); i <= Math.floor(l.x1 / CELL); i++) for (let j = Math.floor(l.y0 / CELL); j <= Math.floor(l.y1 / CELL); j++) { const k = `${i},${j}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(l); }
  }
  // Tiny dashes, indexed, so a dash can be checked for neighbours: the gypsum hatch is dashes standing alone; a curve (a door
  // swing, a stair rail) is a chain of tiny pieces touching end to end, and must not read as speckle.
  const tiny = lines.filter((l) => l.len >= 0.3 && l.len <= 4);
  const tgrid = new Map<string, Line[]>();
  for (const l of tiny) { const k = `${Math.floor(l.x0 / 4)},${Math.floor(l.y0 / 4)}`; (tgrid.get(k) ?? tgrid.set(k, []).get(k)!).push(l); }
  const alone = (l: Line) => {
    for (let i = Math.floor(l.x0 / 4) - 1; i <= Math.floor(l.x1 / 4) + 1; i++) for (let j = Math.floor(l.y0 / 4) - 1; j <= Math.floor(l.y1 / 4) + 1; j++)
      for (const o of tgrid.get(`${i},${j}`) ?? []) if (o !== l && o.x0 <= l.x1 + 0.25 && o.x1 >= l.x0 - 0.25 && o.y0 <= l.y1 + 0.25 && o.y1 >= l.y0 - 0.25) return false;
    return true;
  };
  const near = (x: number, y: number) => {
    const out = new Set<Line>();
    for (let i = Math.floor((x - HALF) / CELL); i <= Math.floor((x + HALF) / CELL); i++) for (let j = Math.floor((y - HALF) / CELL); j <= Math.floor((y + HALF) / CELL); j++) for (const l of grid.get(`${i},${j}`) ?? []) out.add(l);
    return [...out];
  };
  let module: number | null = null;   // the sheet's grid spacing, learned below (18 pt for a 2 ft grid at 1/8")
  const classify = (x: number, y: number, learn?: number[]): Ceiling => {
    const x0 = x - HALF, x1 = x + HALF, y0 = y - HALF, y1 = y + HALF;
    let speck = 0;
    const rows = new Map<number, number>(), cols = new Map<number, number>();   // covered length of horizontal lines at each y, vertical at each x
    for (const l of near(x, y)) {
      const w = l.x1 - l.x0, h = l.y1 - l.y0;
      if (l.len >= 0.3 && l.len <= 4) {
        const cx = (l.x0 + l.x1) / 2, cy = (l.y0 + l.y1) / 2;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && w > 0.15 * l.len && h > 0.15 * l.len && alone(l)) speck++;
      }
      if (h < 0.3 && l.y0 >= y0 && l.y0 <= y1) { const cov = Math.min(l.x1, x1) - Math.max(l.x0, x0); if (cov > 0) { const k = Math.round(l.y0 * 2) / 2; rows.set(k, (rows.get(k) ?? 0) + cov); } }
      if (w < 0.3 && l.x0 >= x0 && l.x0 <= x1) { const cov = Math.min(l.y1, y1) - Math.max(l.y0, y0); if (cov > 0) { const k = Math.round(l.x0 * 2) / 2; cols.set(k, (cols.get(k) ?? 0) + cov); } }
    }
    // A ceiling grid: lines running most of the way across, evenly spaced. One way there are at least three of them (two even
    // gaps: a 2 ft grid in a 6 ft window), the other way at least two (a 2x4 grid is 4 ft apart that way). A room's walls
    // can look like two lines each way; they are not evenly spaced three times over.
    const gapsOf = (m: Map<number, number>) => {
      const at = [...m].filter(([, cov]) => cov >= HALF * 2 * 0.6).map(([k]) => k).sort((a, b) => a - b);
      const g: number[] = []; for (let i = 1; i < at.length; i++) { const d = at[i] - at[i - 1]; if (d >= GRID_GAP[0] && d <= GRID_GAP[1]) g.push(d); }
      return g;
    };
    const even = (g: number[]) => g.length >= 2 && Math.max(...g) / Math.min(...g) <= 1.25;
    const gr = gapsOf(rows), gc = gapsOf(cols);
    if ((even(gr) && gc.length >= 1) || (even(gc) && gr.length >= 1)) { learn?.push(...(even(gr) ? gr : gc)); return 'drop'; }
    // A fixture hides the grid in its own cell, so a window round it may show only two lines each way. Still a grid when those
    // are spaced at the sheet's grid module (or twice it) both ways: walls are almost never exactly that far apart.
    const onModule = (g: number[]) => module !== null && g.some((d) => Math.abs(d - module!) <= 1.5 || Math.abs(d - 2 * module!) <= 2);
    if (onModule(gr) && onModule(gc)) return 'drop';
    if (speck >= SPECKLE) return 'sheetrock';
    return 'open';
  };
  // A sheet that is not a ceiling plan (a power plan) gets no ceiling: "open" everywhere would be wrong.
  let textured = 0;
  const step = 90;
  // the extent of the linework (a loop: a dense sheet has hundreds of thousands of lines, too many to spread into Math.min)
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const l of lines) { if (l.x0 < bx0) bx0 = l.x0; if (l.x0 > bx1) bx1 = l.x0; if (l.y0 < by0) by0 = l.y0; if (l.y0 > by1) by1 = l.y0; }
  const seen: number[] = [];
  let samples = 0;
  for (let x = bx0; x <= bx1; x += step / 2) for (let y = by0; y <= by1; y += step / 2) { samples++; if (classify(x, y, seen) !== 'open') textured++; }
  // the grid module: the spacing seen most often where the grid is clear
  if (seen.length >= 6) {
    const n = new Map<number, number>(); for (const g of seen) { const k = Math.round(g * 2) / 2; n.set(k, (n.get(k) ?? 0) + 1); }
    module = [...n].sort((a, b) => b[1] - a[1])[0][0];
  }
  // A sheet titled a ceiling plan needs 1% textured (PSEB's plans are 1% to 4%: much of them is outside the work); an untitled
  // one must be textured all over (12%), since stray spots on power or fire alarm plans reach 5% or 6%.
  const hasTextures = textured >= 8 && textured >= samples * (opts.titled ? 0.01 : 0.12);
  return { at: (x, y) => (hasTextures ? classify(x, y) : null), hasTextures, background: bg, textured, samples } as CeilingIndex;
}
