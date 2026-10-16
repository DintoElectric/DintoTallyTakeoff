// Matchlines mark where one sheet's plan ends and the neighbouring sheet's begins. Each is labelled at both
// ends: the word MATCHLINE, the neighbour's sheet number on the neighbour's side, and this sheet's number on
// its own side. Anything past the line (on the neighbour's side) belongs to the other sheet and is not counted.
import type { PageRun } from './pageRuns.ts';
import { inZones, rectZone, type Zone } from '../../shared/zones.ts';
export type { Zone } from '../../shared/zones.ts';

export type Side = 'above' | 'below' | 'left' | 'right';
export interface Matchline {
  orientation: 'h' | 'v';
  pos: number;       // normalized y of a horizontal line, or x of a vertical one
  from: number;      // extent along the line (normalized)
  to: number;
  exclude: Side;     // the side that belongs to the neighbouring sheet
  neighbour: string;
}

const SHEET_NO = /^[A-Z]{1,3}\d{2,4}(?:\.\d+)?$/;
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/**
 * `ownSheet` is this sheet's number (for example "EL101.1"). Without it the side cannot be told, so nothing is
 * returned. Labels such as "1/EL102.1" (matchlines between two details on one sheet) are skipped.
 */
export function findMatchlines(runs: PageRun[], ownSheet: string | null): Matchline[] {
  if (!ownSheet) return [];
  const own = norm(ownSheet);
  const words = runs.filter((r) => /^MATCH\s*LINE$/i.test(r.str.trim()));
  const sheetLabels = runs.filter((r) => SHEET_NO.test(norm(r.str)));
  type Hit = { w: PageRun; neighbour: string; side: Side };
  const hits: Hit[] = [];
  for (const w of words) {
    // Labels stacked on the line's two sides sit within ~0.03 of the word on the cross axis, and level with it along the line.
    const near = sheetLabels.filter((l) => (w.rotated ? Math.abs(l.cy - w.cy) < 0.03 && Math.abs(l.cx - w.cx) < 0.03 : Math.abs(l.cx - w.cx) < 0.03 && Math.abs(l.cy - w.cy) < 0.03));
    const neighbour = near.find((l) => norm(l.str) !== own);
    if (!neighbour || !near.some((l) => norm(l.str) === own)) continue;
    const side: Side = w.rotated ? (neighbour.cx < w.cx ? 'left' : 'right') : neighbour.cy < w.cy ? 'above' : 'below';
    hits.push({ w, neighbour: norm(neighbour.str), side });
  }
  // Two words on the same line (same position and side) are its two ends.
  const lines: Matchline[] = [];
  const used = new Set<Hit>();
  for (const a of hits) {
    if (used.has(a)) continue;
    const h = !a.w.rotated;
    const posOf = (x: Hit) => (h ? x.w.cy : x.w.cx);
    const alongOf = (x: Hit) => (h ? x.w.cx : x.w.cy);
    const mates = hits.filter((b) => !used.has(b) && b.w.rotated === a.w.rotated && b.side === a.side && b.neighbour === a.neighbour && Math.abs(posOf(b) - posOf(a)) < 0.012);
    mates.forEach((m) => used.add(m));
    const along = mates.map(alongOf);
    const half = (h ? a.w.w : a.w.w) / 2;
    lines.push({
      orientation: h ? 'h' : 'v',
      pos: mates.reduce((s, m) => s + posOf(m), 0) / mates.length,
      from: Math.min(...along) - half,
      to: Math.max(...along) + half,
      exclude: a.side,
      neighbour: a.neighbour,
    });
  }
  return lines;
}

const ON_LINE = 0.0015; // marks this close to the line (about 3 pt) are on it, and are kept

/**
 * The area past each matchline, as zones. A horizontal line is taken to run the full width of the sheet: the
 * neighbouring sheet's content lies past it wherever the line itself stops (checked against estimator-counted
 * fixtures: no counted fixture falls in the extra area). A vertical line keeps its own extent, plus a margin.
 */
export function zonesFromMatchlines(lines: Matchline[]): Zone[] {
  return lines.map((l) => {
    if (l.orientation === 'h') {
      return l.exclude === 'above' ? rectZone(0, 0, 1, Math.max(0, l.pos - ON_LINE)) : rectZone(0, Math.min(1, l.pos + ON_LINE), 1, 1);
    }
    const a = Math.max(0, l.from - 0.06), b = Math.min(1, l.to + 0.06);
    return l.exclude === 'left' ? rectZone(0, a, Math.max(0, l.pos - ON_LINE), b) : rectZone(Math.min(1, l.pos + ON_LINE), a, 1, b);
  });
}

/** True if the point lies past a matchline, on the neighbouring sheet's side. */
export function isPastMatchline(x: number, y: number, lines: Matchline[]): boolean {
  return inZones(x, y, zonesFromMatchlines(lines));
}
