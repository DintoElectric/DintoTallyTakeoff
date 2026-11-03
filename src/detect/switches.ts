// Lighting control switches: the "$" symbol with its letters beside it ($DOS, $D2, $OS, $LV). The letters are often the
// same as a fixture's tag (a D2 dimmer switch and a D2 downlight), so switches are found first, from the drawn "$", and their
// letters are taken away from the ordinary tag reading: a switch's D2 is never counted as fixture D2.
// On these drawings the "$" is linework, not text: an S drawn as a run of tiny curve pieces, with a stroke through it, upright
// or turned on its side where the wall runs up the sheet.
import type { PageRun } from './pageRuns.ts';
import type { Region } from './tagScan.ts';

interface Shape { x0: number; y0: number; x1: number; y1: number; n?: number; lum?: number }
export interface SwitchHit { code: string; x: number; y: number; h: number; letters: PageRun[] }   // x, y: normalized

/** The switches on a sheet: each drawn "$" (upright, turned on its side along a wall, or at an angle), with its letters. */
export function findSwitches(prims: Shape[], runs: PageRun[], W: number, H: number, region: Region): SwitchHit[] {
  // the tiny curve pieces an S is drawn with, on a coarse grid for quick lookups
  const C = 8, grid = new Map<string, Shape[]>();
  for (const p of prims) {
    if ((p.lum ?? 0) >= 0.3 || Math.hypot(p.x1 - p.x0, p.y1 - p.y0) > 2.5) continue;
    const k = `${Math.floor((p.x0 + p.x1) / 2 / C)}:${Math.floor((p.y0 + p.y1) / 2 / C)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const near = (x: number, y: number) => { const out: Shape[] = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${Math.floor(x / C) + dx}:${Math.floor(y / C) + dy}`) ?? [])); return out; };
  // The strokes: dark straight lines as long as the letters beside them, at any angle. A sloping line's box does not say
  // which way it slopes, so both diagonals are tried (only one finds an S).
  const strokes: [number, number, number, number][] = [];
  for (const p of prims) {
    if ((p.lum ?? 0) >= 0.3 || (p.n ?? 2) !== 2) continue;
    const w = p.x1 - p.x0, h = p.y1 - p.y0, len = Math.hypot(w, h);
    if (len < 5 || len > 14) continue;
    if (w < 0.6) strokes.push([(p.x0 + p.x1) / 2, p.y0, (p.x0 + p.x1) / 2, p.y1]);        // upright
    else if (h < 0.6) strokes.push([p.x0, (p.y0 + p.y1) / 2, p.x1, (p.y0 + p.y1) / 2]);   // on its side
    else { strokes.push([p.x0, p.y0, p.x1, p.y1]); strokes.push([p.x0, p.y1, p.x1, p.y0]); }   // at an angle
  }
  const found: SwitchHit[] = [];
  const options: { sw: number; run: PageRun; d: number }[] = [];   // the letters each switch could have, and how far
  const done: { x: number; y: number }[] = [];
  for (const [ax, ay, bx, by] of strokes) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2, h = Math.hypot(bx - ax, by - ay);
    if (mx < region.x0 * W || mx > region.x1 * W || my < region.y0 * H || my > region.y1 * H) continue;
    if (done.some((d) => Math.abs(d.x - mx) < 2 && Math.abs(d.y - my) < 2)) continue;   // the same "$" drawn twice
    // Measured in the stroke's own frame (u along it, v across it), so a "$" on its side is judged as an upright one:
    // curve pieces in both halves, the curve narrow (2.5 to 5.5 points; a receptacle's circle is about 10), shorter than
    // the stroke (which sticks out at both ends), and crossing it near its middle (an S passes the centre; a circle doesn't).
    const ux = (bx - ax) / h, uy = (by - ay) / h;
    const curve = near(mx, my).map((p) => { const cx = (p.x0 + p.x1) / 2 - mx, cy = (p.y0 + p.y1) / 2 - my; return { u: cx * ux + cy * uy, v: -cx * uy + cy * ux }; })
      .filter((q) => Math.abs(q.v) <= 6 && Math.abs(q.u) <= h / 2 + 2);
    const top = curve.filter((q) => q.u < 0).length, bottom = curve.length - top;
    if (curve.length < 10 || top < 3 || bottom < 3) continue;
    const vs = curve.map((q) => q.v), us = curve.map((q) => q.u);
    const width = Math.max(...vs) - Math.min(...vs), height = Math.max(...us) - Math.min(...us);
    // (at mid-height an S is only at the centre, crossing the stroke; a circle, even a small inner one, also reaches out to both sides)
    const mid = curve.filter((q) => Math.abs(q.u) < h * 0.15);
    const middle = mid.length > 0 && mid.every((q) => Math.abs(q.v) <= 2.2);
    if (width < 2.5 || width > 5.5 || height > h * 0.9 || height < h * 0.5 || !middle) continue;
    done.push({ x: mx, y: my });
    // Its letters: the nearest small text around it, on any side (DOS, D2, OS, VS, LV), turned with it or not. Smaller than
    // tag text (a fixture tag beside a switch is not its letters), shaped like a switch code (not a room or circuit number),
    // and not inside a circle: a circled VS or OS is a ceiling sensor of its own, never a switch's letters.
    const dist = (r: PageRun) => { const rw = (r.rotated ? r.h * H : r.w * W) / 2, rh = (r.rotated ? r.w * W : r.h * H) / 2; return Math.hypot(Math.max(Math.abs(r.cx * W - mx) - rw, 0), Math.max(Math.abs(r.cy * H - my) - rh, 0)); };
    for (const r of runs) if (Math.min(r.h * H, r.rotated ? r.h * H : 99) <= 8.8 && /^[A-Z]{1,3}\d?$/.test(r.str.trim()) && dist(r) <= 22 && !circled(r)) options.push({ sw: found.length, run: r, d: dist(r) });
    found.push({ code: '$', x: mx / W, y: my / H, h: h / H, letters: [] });
  }
  // Each label belongs to one switch: the closest pairs first (two switches side by side do not share one "VS"; the
  // other one is a plain "$", or takes its own label).
  const taken = new Set<PageRun>();
  for (const o of options.sort((a, b) => a.d - b.d)) {
    const sw = found[o.sw];
    if (sw.letters.length || taken.has(o.run)) continue;
    sw.letters = [o.run]; sw.code = `$${o.run.str.trim()}`; taken.add(o.run);
  }
  return found;

  /** Text inside a drawn circle (a ceiling sensor's letters): small curve pieces all the way round it. */
  function circled(r: PageRun): boolean {
    const x = r.cx * W, y = r.cy * H, half = Math.max(r.w * W, r.h * H) / 2;
    const bins = new Set<number>();
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const p of grid.get(`${Math.floor(x / C) + dx}:${Math.floor(y / C) + dy}`) ?? []) {
      const px = (p.x0 + p.x1) / 2 - x, py = (p.y0 + p.y1) / 2 - y, d = Math.hypot(px, py);
      if (d >= half * 0.9 && d <= half + 7) bins.add(Math.floor(((Math.atan2(py, px) + Math.PI) / (2 * Math.PI)) * 8) % 8);
    }
    return bins.size >= 7;
  }
}
