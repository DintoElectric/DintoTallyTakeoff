// Details drawn beside the plan (an enlarged callout, a section) repeat fixtures and tags that are already on the plan, so
// their tags are left out of the count, as the part past a matchline is. A sheet's views are islands of linework with blank
// paper between them; the main plan is the largest, and its scale is the one written under it. Another island with its own
// title and scale just below it, at a different scale, is a detail. (A partial plan at the plan's own scale is counted.)
import type { Zone } from '../../shared/zones.ts';
import type { PageRun } from './pageRuns.ts';
import { scaleMarks } from './fixtureLength.ts';
import type { Region } from './tagScan.ts';

interface Box { x0: number; y0: number; x1: number; y1: number }
export interface DetailView extends Box { inPerFt: number }   // points

/** The detail views on a sheet (islands at another scale than the main plan), in points. */
export function findDetailViews(prims: Box[], runs: PageRun[], W: number, H: number, region: Region): DetailView[] {
  const C = 12, cols = Math.ceil(W / C), rows = Math.ceil(H / C);
  const ink = new Uint8Array(cols * rows);
  const rx0 = region.x0 * W, rx1 = region.x1 * W, ry0 = region.y0 * H, ry1 = region.y1 * H;
  for (const p of prims) {
    // the frame, the title block and lines across the whole sheet are not part of any view
    if (p.x1 - p.x0 > 0.5 * W || p.y1 - p.y0 > 0.5 * H) continue;
    if (p.x1 < rx0 || p.x0 > rx1 || p.y1 < ry0 || p.y0 > ry1) continue;
    const a = Math.max(0, Math.floor(p.x0 / C)), b = Math.min(cols - 1, Math.floor(p.x1 / C));
    const c = Math.max(0, Math.floor(p.y0 / C)), d = Math.min(rows - 1, Math.floor(p.y1 / C));
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) ink[y * cols + x] = 1;
  }
  // islands: cells within two cells (24 points) of each other belong together
  const seen = new Int32Array(cols * rows).fill(-1);
  const islands: (Box & { n: number })[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i] || seen[i] >= 0) continue;
    const id = islands.length;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 };
    const stack = [i]; seen[i] = id;
    while (stack.length) {
      const k = stack.pop()!; const x = k % cols, y = (k - x) / cols;
      box.n++; box.x0 = Math.min(box.x0, x * C); box.x1 = Math.max(box.x1, (x + 1) * C); box.y0 = Math.min(box.y0, y * C); box.y1 = Math.max(box.y1, (y + 1) * C);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (ink[j] && seen[j] < 0) { seen[j] = id; stack.push(j); }
      }
    }
    islands.push(box);
  }
  if (islands.length < 2) return [];
  const main = islands.reduce((a, b) => (b.n > a.n ? b : a));
  const marks = scaleMarks(runs, W, H);
  if (!marks.length) return [];
  // The plan's scale: the one written closest to the plan's bottom edge (its title can sit to the left of the plan).
  const toBottom = (m: { x: number; y: number }) => Math.hypot(m.x < main.x0 ? main.x0 - m.x : m.x > main.x1 ? m.x - main.x1 : 0, m.y - main.y1);
  const mainMark = marks.reduce((a, b) => (toBottom(b) < toBottom(a) ? b : a));
  if (toBottom(mainMark) > 250) return [];   // not sure which scale the plan is at: nothing is left out
  const mainScale = mainMark.inPerFt;
  // Each title at another scale: the islands just above it, within the width of its underline, are that detail (a section
  // can fall apart into several small islands; they are gathered under their title).
  const out: DetailView[] = [];
  for (const m of marks) {
    if (m.inPerFt === mainScale) continue;
    const line = prims.filter((p) => p.y1 - p.y0 < 1.5 && p.x1 - p.x0 > 80 && p.x1 - p.x0 < 0.5 * W && Math.abs(p.y0 - m.y) < 22 && p.x0 <= m.x + 20 && p.x1 >= m.x - 20)
      .sort((a, b) => Math.abs(a.y0 - m.y) - Math.abs(b.y0 - m.y))[0];
    const bx0 = (line?.x0 ?? m.x - 150) - 40, bx1 = (line?.x1 ?? m.x + 400) + 40;
    // (up to 450 points above, but not past the title of the view above it in the same column)
    const above = marks.filter((o) => o !== m && o.y < m.y - 30 && o.x >= bx0 && o.x <= bx1).map((o) => o.y);
    const top = Math.max(m.y - 450, ...above.map((y) => y + 30));
    const parts = islands.filter((b) => b !== main && (b.x0 + b.x1) / 2 >= bx0 && (b.x0 + b.x1) / 2 <= bx1 && b.y1 <= m.y + 30 && b.y0 >= top - 20);
    if (!parts.length) continue;
    const box = { x0: Math.min(...parts.map((b) => b.x0)), y0: Math.min(...parts.map((b) => b.y0)), x1: Math.max(...parts.map((b) => b.x1)), y1: Math.max(...parts.map((b) => b.y1)) };
    // (the main plan never falls inside a detail)
    if (box.x1 > main.x0 && box.x0 < main.x1 && box.y1 > main.y0 && box.y0 < main.y1) { box.x1 = Math.min(box.x1, main.x0 - 1); if (box.x1 <= box.x0) continue; }
    out.push({ ...box, inPerFt: m.inPerFt });
  }
  return out;
}

/** The detail views as zones (normalized rectangles, a little larger than the drawing), to dim and leave out like matchline areas. */
export const detailZones = (views: Box[], W: number, H: number): Zone[] =>
  views.map((v) => {
    const x0 = Math.max(0, (v.x0 - 8) / W), y0 = Math.max(0, (v.y0 - 8) / H), x1 = Math.min(1, (v.x1 + 8) / W), y1 = Math.min(1, (v.y1 + 8) / H);
    return { points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
  });
