// Reads sheet number, title and scale from a page's text, and suggests kind and floor.
// Everything here is a *suggestion*; the sheet index lets the estimator correct it (spec 2.9).
import type { SheetKind } from '../../shared/types.ts';

/** A text run in normalized page coordinates (0..1, origin top-left of the displayed page). */
export interface TextRun {
  str: string;
  x: number; // left
  y: number; // top
  w: number;
  h: number; // approximate glyph height (relative to page height)
}

export interface Region { x0: number; y0: number; x1: number; y1: number }
export const DEFAULT_TITLE_REGION: Region = { x0: 0.5, y0: 0.5, x1: 1, y1: 1 }; // bottom-right quarter

// E-101, E101, E-101.1, ES-001, E-001A, ED101
export const SHEET_NUMBER_RE = /^[A-Z]{1,3}[-.\s]?\d{1,3}(?:\.\d{1,2})?[A-Z]?$/;

const LABEL_WORDS = /^(sheet|sheet no\.?|sheet number|title|project|drawn|drawn by|checked|checked by|date|scale|job|job no\.?|revision|rev|no\.?|issue|issued|approved|designed|client|owner|architect|engineer|consultant|seal|key plan|north|copyright|©)\b/i;

const inRegion = (r: TextRun, g: Region) => {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return cx >= g.x0 && cx <= g.x1 && cy >= g.y0 && cy <= g.y1;
};

interface Line { text: string; y: number; h: number; x: number }

function toLines(runs: TextRun[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { runs: TextRun[]; y: number; h: number }[] = [];
  for (const r of sorted) {
    const l = lines.find((ln) => Math.abs(ln.y - r.y) < Math.max(ln.h, r.h) * 0.5);
    if (l) {
      l.runs.push(r);
      l.h = Math.max(l.h, r.h);
    } else lines.push({ runs: [r], y: r.y, h: r.h });
  }
  return lines.map((l) => {
    const rs = l.runs.sort((a, b) => a.x - b.x);
    return { text: rs.map((r) => r.str.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' '), y: l.y, h: l.h, x: rs[0].x };
  });
}

export interface TitleRead {
  number: string | null;
  title: string | null;
  unsure: boolean;
}

export function readTitleBlock(all: TextRun[], region: Region = DEFAULT_TITLE_REGION): TitleRead {
  const runs = all.filter((r) => r.str.trim() && inRegion(r, region));
  if (!runs.length) return { number: null, title: null, unsure: true };

  // Sheet number: the largest text matching the pattern.
  const cands = runs
    .map((r) => ({ r, s: r.str.trim().toUpperCase() }))
    .filter(({ s }) => SHEET_NUMBER_RE.test(s));
  if (!cands.length) return { number: null, title: null, unsure: true };
  const maxH = Math.max(...cands.map((c) => c.r.h));
  const biggest = cands.filter((c) => c.r.h >= maxH * 0.92);
  // Ties: prefer the one nearest the bottom-right corner (where sheet numbers live).
  biggest.sort((a, b) => (b.r.y + b.r.x) - (a.r.y + a.r.x));
  const pick = biggest[0];
  const number = pick.s.replace(/\s+/g, '');
  let unsure = biggest.length > 1 && new Set(biggest.map((b) => b.s)).size > 1;

  // Title: nearby lines of reasonable size that are not labels, dates, or the number itself.
  const lines = toLines(runs);
  const numLine = lines.find((l) => l.text.toUpperCase().includes(pick.s)) ?? null;
  const numY = numLine ? numLine.y : pick.r.y;
  const median = [...lines].map((l) => l.h).sort((a, b) => a - b)[Math.floor(lines.length / 2)] ?? pick.r.h;
  const minH = Math.max(pick.r.h * 0.4, median * 0.9);
  const candidates = lines
    .filter((l) => l !== numLine)
    .filter((l) => l.text.length >= 3 && /[A-Za-z]{3}/.test(l.text))
    .filter((l) => !LABEL_WORDS.test(l.text))
    .filter((l) => !/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(l.text))
    .filter((l) => l.h >= minH)
    .sort((a, b) => Math.abs(a.y - numY) - Math.abs(b.y - numY))
    .slice(0, 2)
    .sort((a, b) => a.y - b.y);
  const title = candidates.length ? candidates.map((c) => c.text).join(' ').slice(0, 200) : null;
  if (!title) unsure = true;
  return { number, title, unsure };
}

/** Scale text such as 1/8" = 1'-0", 1:100, NTS. Blank if nothing is found. */
export function readScale(all: TextRun[]): string | null {
  const text = all.map((r) => r.str).join(' ').replace(/\s+/g, ' ');
  const arch = text.match(/\b(\d+\s*\/\s*\d+|\d+)\s*["”]\s*=\s*1\s*['’]\s*-?\s*0?\s*["”]?/);
  if (arch) return `${arch[1].replace(/\s+/g, '')}" = 1'-0"`;
  const ratio = text.match(/\bscale\s*:?\s*(1\s*:\s*\d+)/i) ?? text.match(/\b(1\s*:\s*\d{2,4})\b/);
  if (ratio) return ratio[1].replace(/\s+/g, '');
  if (/\bN\.?T\.?S\.?\b|NOT TO SCALE/i.test(text)) return 'NTS';
  return null;
}

export function inferKind(title: string | null, number: string | null): SheetKind {
  const t = `${title ?? ''}`.toLowerCase();
  if (/\b(legend|symbols?|abbreviations?)\b/.test(t)) return 'legend';
  if (/\bschedules?\b/.test(t)) return 'schedule';
  if (/\bsite\b/.test(t)) return 'site_plan';
  if (/\b(plan|floor|level|lighting|power)\b/.test(t)) return 'floor_plan';
  if (!t && number && /^E?[-.\s]?[1-9]\d\d/i.test(number)) return 'floor_plan';
  return 'other';
}

const ORDINALS: Record<string, string> = {
  first: '1', '1st': '1', second: '2', '2nd': '2', third: '3', '3rd': '3', fourth: '4', '4th': '4',
  fifth: '5', '5th': '5', sixth: '6', '6th': '6', seventh: '7', '7th': '7', eighth: '8', '8th': '8',
};

/** Floor from the title, else from the first digit of the sheet number (E-2xx suggests level 2). */
export function inferFloor(title: string | null, number: string | null, kind: SheetKind): string | null {
  const t = (title ?? '').toLowerCase();
  if (/\bbasement\b|\blower level\b/.test(t)) return 'Basement';
  if (/\broof\b/.test(t)) return 'Roof';
  if (/\bground\b/.test(t)) return 'Ground';
  let m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|\d(?:st|nd|rd|th))\s+(?:floor|level)\b/);
  if (m) return ORDINALS[m[1]] ?? null;
  m = t.match(/\b(?:floor|level|lvl)\s*0?(\d{1,2})\b/) ?? t.match(/\bL0?(\d{1,2})\b/i);
  if (m) return String(Number(m[1]));
  if (kind === 'floor_plan' && number) {
    const d = number.match(/\d/);
    // E-2xx: the first digit of a three-digit number. E-001 style numbers carry no floor.
    const three = number.match(/(\d)\d\d/);
    if (d && three && three[1] !== '0') return three[1];
  }
  return null;
}

/** Label used in exports: "L2" for numeric floors, the name otherwise. */
export function floorLabel(floor: string | null): string {
  if (!floor) return '—';
  return /^\d+$/.test(floor) ? `L${floor}` : floor;
}

export const FLOOR_OPTIONS = ['Basement', 'Ground', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Roof', 'Site'];
