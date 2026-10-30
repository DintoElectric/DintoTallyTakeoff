// Lighting control switches: the "$" symbol with its letters beside it ($DOS, $D2, $OS, $LV). The letters are often the
// same as a fixture's tag (a D2 dimmer switch and a D2 downlight), so switches are found first, from the drawn "$", and their
// letters are taken away from the ordinary tag reading: a switch's D2 is never counted as fixture D2.
// On these drawings the "$" is linework, not text: an S drawn as a run of tiny curve pieces, with a vertical stroke through it.
import type { PageRun } from './pageRuns.ts';
import type { Region } from './tagScan.ts';

interface Shape { x0: number; y0: number; x1: number; y1: number; n?: number; lum?: number }
export interface SwitchHit { code: string; x: number; y: number; h: number; letters: PageRun[] }   // x, y: normalized

/** The switches on a sheet: each drawn "$", with the letters just to its right as its code ("$" alone when there are none). */
export function findSwitches(prims: Shape[], runs: PageRun[], W: number, H: number, region: Region): SwitchHit[] {
  // the vertical strokes: dark, upright, as tall as the letters next to them
  const bars = prims.filter((p) => (p.lum ?? 0) < 0.3 && p.x1 - p.x0 < 0.6 && p.y1 - p.y0 >= 5 && p.y1 - p.y0 <= 14);
  // the tiny curve pieces an S is drawn with, on a coarse grid for quick lookups
  const C = 8, grid = new Map<string, Shape[]>();
  for (const p of prims) {
    if ((p.lum ?? 0) >= 0.3 || Math.hypot(p.x1 - p.x0, p.y1 - p.y0) > 2.5) continue;
    const k = `${Math.floor((p.x0 + p.x1) / 2 / C)}:${Math.floor((p.y0 + p.y1) / 2 / C)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const near = (x: number, y: number) => { const out: Shape[] = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${Math.floor(x / C) + dx}:${Math.floor(y / C) + dy}`) ?? [])); return out; };
  const found: SwitchHit[] = [];
  const done: { x: number; y: number }[] = [];
  for (const b of bars) {
    const x = (b.x0 + b.x1) / 2, y0 = b.y0, y1 = b.y1, ym = (y0 + y1) / 2;
    if (x < region.x0 * W || x > region.x1 * W || ym < region.y0 * H || ym > region.y1 * H) continue;
    if (done.some((d) => Math.abs(d.x - x) < 2 && Math.abs(d.y - ym) < 2)) continue;   // the same "$" drawn twice
    // An S around the stroke, not a circle (a receptacle or junction box is a circle with a line through it): curve pieces
    // in both halves, the curve narrow (2.5 to 5.5 points; a circle is about 10), shorter than the stroke (which sticks out
    // above and below it), and crossing the stroke near its middle (an S passes through the centre; a circle doesn't).
    const h = y1 - y0;
    const curve = near(x, ym).filter((p) => { const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2; return Math.abs(cx - x) <= 6 && cy >= y0 - 2 && cy <= y1 + 2; });
    const top = curve.filter((p) => (p.y0 + p.y1) / 2 < ym).length, bottom = curve.length - top;
    if (curve.length < 10 || top < 3 || bottom < 3) continue;
    const cxs = curve.map((p) => (p.x0 + p.x1) / 2), cys = curve.map((p) => (p.y0 + p.y1) / 2);
    const width = Math.max(...cxs) - Math.min(...cxs), height = Math.max(...cys) - Math.min(...cys);
    const middle = curve.filter((p) => Math.abs((p.y0 + p.y1) / 2 - ym) < h * 0.15).some((p) => Math.abs((p.x0 + p.x1) / 2 - x) <= 2.5);
    if (width < 2.5 || width > 5.5 || height > h * 0.9 || height < h * 0.5 || !middle) continue;
    done.push({ x, y: ym });
    // Its letters: the nearest small upright text around it, on any side (beside it, below, above: DOS, D2, OS, VS, LV).
    // Smaller than tag text (a fixture tag beside a switch is not its letters), and shaped like a switch code: up to three
    // letters and a digit (not a room number, not a circuit number).
    const dist = (r: PageRun) => { const rx = Math.max((r.cx - r.w / 2) * W - x, 0, x - (r.cx + r.w / 2) * W), ry = Math.max((r.cy - r.h / 2) * H - ym, 0, ym - (r.cy + r.h / 2) * H); return Math.hypot(rx, ry); };
    const cands = runs.filter((r) => !r.rotated && r.h * H <= 8.8 && /^[A-Z]{1,3}\d?$/.test(r.str.trim()) && dist(r) <= 22).sort((a, b) => dist(a) - dist(b));
    const letters = cands.length ? [cands[0]] : [];
    found.push({ code: `$${letters.map((r) => r.str.trim()).join('')}`, x: x / W, y: ym / H, h: h / H, letters });
  }
  return found;
}
