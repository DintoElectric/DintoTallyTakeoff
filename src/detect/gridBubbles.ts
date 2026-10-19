// Grid-line bubbles: the lettered and numbered circles at the ends of the column and row lines (A, B, C... 1, 2, 3...).
// Their labels look like tags or short codes (D, F, H, J, K...), so a count of "F" or "H" would pick them up.
//
// What makes a grid is the pattern, not any one circle: the bubbles are the same size, lined up in a row or column, and
// every one carries a DIFFERENT label. Devices drawn in a row repeat the same symbol, so they are not mistaken for it.
import type { Prim } from './primitives.ts';
import type { PageRun } from './pageRuns.ts';

/** Centre and radii of a bubble, normalized to the page (0..1) like every other position here. */
export interface GridBubble { x: number; y: number; rx: number; ry: number; label: string }

const MIN_D = 14;          // points across: device symbols (a 13.5 pt circle) are smaller; bubbles are drawn bigger so they can be read
const MAX_D = 130;
const ALIGN = 1.6;         // points: bubbles of one grid line up to within this
const SAME_SIZE = 1.6;
const MIN_IN_LINE = 3;     // a grid has at least three lines in a direction
const LABEL_MAX = 5;       // characters
// What a grid label looks like: one or two letters or a one or two digit number, optionally followed by .digits ("D", "12", "E.2", "3.6").
const GRID_LABEL = /^(?:[A-Z]{1,2}|\d{1,2})(?:\.\d{1,2})?$/;
const SPACING = 1.5;       // bubbles of a grid never touch; sub-grid lines can sit under two diameters from their neighbours

interface Cand { cx: number; cy: number; d: number; label: string }

export function findGridBubbles(prims: Prim[], runs: PageRun[], width: number, height: number): GridBubble[] {
  const marks = runs
    .map((r) => ({ s: r.str.trim(), x: r.cx * width, y: r.cy * height }))
    .filter((m) => m.s.length > 0 && m.s.length <= LABEL_MAX);
  if (marks.length === 0) return [];
  const CELL = 64;
  const grid = new Map<string, typeof marks>();
  for (const m of marks) { const k = `${Math.floor(m.x / CELL)},${Math.floor(m.y / CELL)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(m); }
  const marksNear = (x: number, y: number, r: number) => {
    const out: typeof marks = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
      for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++)
        for (const m of grid.get(`${i},${j}`) ?? []) if (Math.hypot(m.x - x, m.y - y) <= r) out.push(m);
    return out;
  };

  // 1. Round shapes with a short label inside them.
  const cands: Cand[] = [];
  for (const p of prims) {
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    if (w < MIN_D || w > MAX_D || Math.abs(w - h) > Math.max(1.5, w * 0.06) || p.n < 4) continue;
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    const inside = marksNear(cx, cy, (w / 2) * 0.8).sort((a, b) => a.x - b.x);
    const label = inside.map((m) => m.s).join('');
    if (inside.length === 0 || inside.length > 2 || label.length > LABEL_MAX || !GRID_LABEL.test(label)) continue;
    // drawn twice on top of itself (CAD does this): once
    if (cands.some((c) => Math.abs(c.cx - cx) < 1 && Math.abs(c.cy - cy) < 1 && c.label === label)) continue;
    cands.push({ cx, cy, d: w, label });
  }
  if (cands.length < MIN_IN_LINE) return [];

  // 2. Same-size bubbles lined up in a column (same x) or a row (same y), with mostly different labels.
  const accepted = new Set<Cand>();
  const lines = (axis: 'cx' | 'cy', across: 'cx' | 'cy') => {
    const sorted = [...cands].sort((a, b) => a.d - b.d);
    // bucket by size
    const sizes: Cand[][] = [];
    for (const c of sorted) { const last = sizes[sizes.length - 1]; if (last && Math.abs(c.d - last[0].d) <= SAME_SIZE) last.push(c); else sizes.push([c]); }
    for (const group of sizes) {
      if (group.length < MIN_IN_LINE) continue;
      group.sort((a, b) => a[axis] - b[axis] || a[across] - b[across]);
      let run: Cand[] = [];
      const flush = () => {
        // members spaced out (not overlapping), then at least three different labels, nearly all different
        const spaced = run.filter((c, i) => i === 0 || Math.abs(c[across] - run[i - 1][across]) >= c.d * SPACING);
        const labels = new Set(spaced.map((c) => c.label));
        if (spaced.length >= MIN_IN_LINE && labels.size >= MIN_IN_LINE && labels.size >= spaced.length * 0.75) for (const c of spaced) accepted.add(c);
        run = [];
      };
      for (const c of group) {
        if (run.length && Math.abs(c[axis] - run[0][axis]) > ALIGN) flush();
        run.push(c);
      }
      flush();
    }
  };
  lines('cx', 'cy'); // a column of bubbles (the lettered lines down a side)
  lines('cy', 'cx'); // a row of bubbles (the numbered lines along the top or bottom)

  return [...accepted].map((c) => ({ x: c.cx / width, y: c.cy / height, rx: c.d / 2 / width, ry: c.d / 2 / height, label: c.label }));
}

/** True when a point (normalized) is inside one of the bubbles. A little generous, since a label's centre can sit off the bubble's. */
export function inBubble(x: number, y: number, bubbles: GridBubble[]): boolean {
  return bubbles.some((b) => ((x - b.x) / (b.rx * 1.25)) ** 2 + ((y - b.y) / (b.ry * 1.25)) ** 2 <= 1);
}
