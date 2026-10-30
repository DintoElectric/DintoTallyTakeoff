// Lining up an electrical plan with the architectural floor plan of the same level and area, so the architect's walls (and
// their wall-type tags) can be read at each device. Both are drawn from one building model: they share its column grid, so
// the grid bubbles (16, 19.7, P.8, S.5 …) say where each drawing sits on its sheet. A point on the electrical sheet maps to
// the architectural one as  A = s × E + d  (s: scale, the same drawing scale gives 1; d: the shift between the sheets).
import type { PageRun } from './pageRuns.ts';
import { isArchitectural } from '../../shared/sheetKinds.ts';

export interface Alignment { s: number; dx: number; dy: number; across: number; down: number; how: 'grid' | 'hand' }
export interface GridLabels { cols: Map<string, number[]>; rows: Map<string, number[]> }   // label: x (columns) or y (rows), points

/**
 * The grid bubbles on a sheet: large labels (12 points and up) that are numbers ("16", "19.7") for the grid lines across and
 * letters ("P", "S.5") for those down. The sheet border's own references (1-11, A-J, at the very edge) and the title block
 * are left out.
 */
export function gridLabels(runs: PageRun[], W: number, H: number): GridLabels {
  const cols = new Map<string, number[]>(), rows = new Map<string, number[]>();
  for (const r of runs) {
    const t = r.str.trim();
    if (r.rotated || r.h * H < 12) continue;
    const x = r.cx * W, y = r.cy * H;
    if (x < 0.05 * W || x > 0.915 * W || y < 0.02 * H || y > 0.98 * H) continue;
    if (/^\d{1,2}(\.\d)?$/.test(t)) (cols.get(t) ?? cols.set(t, []).get(t)!).push(x);
    else if (/^[A-Z](\.\d)?$/.test(t)) (rows.get(t) ?? rows.set(t, []).get(t)!).push(y);
  }
  return { cols, rows };
}

/** The scale and shift most labels agree on (to within 1 point): a = s × e + d. With s given, only the shift is found. */
function agree(e: Map<string, number[]>, a: Map<string, number[]>, fixed?: number): { n: number; s: number; d: number } {
  const pts: [number, number, string][] = [];
  for (const [k, es] of e) { const as = a.get(k); if (as) for (const pe of es) for (const pa of as) pts.push([pe, pa, k]); }
  let best = { n: 0, s: 1, d: 0 };
  const consider = (s: number, d: number) => {
    if (!(s > 0.2 && s < 5)) return;
    const hit = new Set<string>();
    for (const [pe, pa, k] of pts) if (Math.abs(s * pe + d - pa) < 1) hit.add(k);
    if (hit.size > best.n) best = { n: hit.size, s, d };
  };
  if (fixed !== undefined) for (const [pe, pa] of pts) consider(fixed, pa - fixed * pe);
  else {
    let tries = 0;
    for (let i = 0; i < pts.length && tries < 6000; i++) for (let j = i + 1; j < pts.length && tries < 6000; j++) {
      const p = pts[i], q = pts[j];
      if (p[2] === q[2] || Math.abs(p[0] - q[0]) < 150) continue;
      tries++;
      const s = (p[1] - q[1]) / (p[0] - q[0]);
      consider(s, p[1] - s * p[0]);
    }
  }
  // refine on the labels that agree: the average shift (and scale) over them
  return best;
}

/**
 * How the electrical sheet lines up with the architectural one, from the grid lines they share: the scale and shift across
 * (numbered grid lines), then the shift down (lettered ones) at that scale. Null when too few grid lines agree to trust it.
 */
export function alignByGrids(e: GridLabels, a: GridLabels): Alignment | null {
  const x = agree(e.cols, a.cols);
  if (x.n < 3) return null;
  const y = agree(e.rows, a.rows, x.s);
  if (y.n < 2) return null;
  return { s: x.s, dx: x.d, dy: y.d, across: x.n, down: y.n, how: 'grid' };
}

/** The level and area a plan's title names: "MAIN LEVEL ELECTRICAL POWER PLAN - AREA B" -> MAIN, B. */
export function levelOf(title: string | null): { level: string | null; area: string | null } {
  const t = ` ${(title ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  const lv = / (LOWER|MAIN|UPPER|BASEMENT|GROUND|MEZZANINE|ROOF|FIRST|SECOND|THIRD|FOURTH|FIFTH) (LEVEL|FLOOR)\b/.exec(t)?.[1]
    ?? / (LEVEL|FLOOR) (\d+)\b/.exec(t)?.[2] ?? / (\d+)(ST|ND|RD|TH) FLOOR\b/.exec(t)?.[1] ?? null;
  const ar = / AREA ([A-Z0-9])\b/.exec(t)?.[1] ?? null;
  return { level: lv, area: ar };
}

const ARCH_NOT_PLAN = /CEILING|REFLECTED|\bRCP\b|FINISH|ROOF|ENLARGED|STAIR|TOILET|DETAIL|ELEVATION|SECTION|SLAB|DEMOLITION|DEMO\b|MOCK|SITE|FURNITURE/;
/** An architectural floor plan: an A-sheet whose title names a level and is not a ceiling, finish, roof or detail plan. */
export const isArchPlan = (s: { number: string | null; title: string | null }) =>
  isArchitectural(s) && levelOf(s.title).level !== null && !ARCH_NOT_PLAN.test((s.title ?? '').toUpperCase());
/** An electrical (or other trade's) plan to pair with one: a plan naming a level, that is not an architectural sheet. */
export const isTradePlan = (s: { number: string | null; title: string | null; kind: string }) =>
  !isArchitectural(s) && s.kind === 'floor_plan' && levelOf(s.title).level !== null;

/**
 * The architectural plans that may match an electrical plan, best first: the same level (and area, when both name one).
 * Plans of the same level outrank others; the grid lines decide among them, since every level shares the same grid.
 */
export function candidates<T extends { id: string; number: string | null; title: string | null }>(sheet: { title: string | null }, arch: T[]): T[] {
  const k = levelOf(sheet.title);
  const score = (a: T) => { const ak = levelOf(a.title); return (ak.level === k.level ? 2 : 0) + (k.area && ak.area === k.area ? 1 : 0) - (k.area && ak.area && ak.area !== k.area ? 1 : 0); };
  return [...arch].sort((a, b) => score(b) - score(a));
}
export const sameLevel = (a: { title: string | null }, b: { title: string | null }) => { const x = levelOf(a.title), y = levelOf(b.title); return x.level !== null && x.level === y.level; };
