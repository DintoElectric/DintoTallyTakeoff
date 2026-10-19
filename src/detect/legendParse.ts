// Reads a symbol legend: each entry is a symbol with letters in it (FACP, CR, MM, TC ...) and its description beside it.
// The letters become the item's code and the description its name, so the devices a legend defines can be counted.
import type { PageRun } from './pageRuns.ts';
import { clean, type ScheduleRow } from './scheduleParse.ts';

interface Cell { s: string; x0: number; x1: number; y: number; h: number }

const LABEL = /^[A-Z][A-Z0-9/&.\-]{0,6}$/;                       // FACP, MM, FA/BAS, I/O, RTU-1
const NOT_LABELS = new Set([
  'NOTE', 'NOTES', 'TYP', 'NTS', 'AND', 'OR', 'THE', 'NO', 'NO.', 'SEE', 'FOR', 'ALL', 'ONE', 'TWO', 'NEW', 'EX', 'AS', 'TO', 'BY', 'OF', 'AT', 'IN', 'ON',
  // words from the table headings that sit beside a legend
  'N/A', 'NA', 'SYMBOL', 'LEGEND', 'CONDUIT', 'DEVICE', 'TYPE', 'DESCRIPTION', 'FURNISHED', 'INSTALLED', 'QTY', 'SIZE', 'COMMENTS', 'MARK', 'TAG',
]);
const NOT_DESCRIPTION = /^(DEVICE TYPE|DESCRIPTION|ENCLOSURE TYPE|OUTLET TYPE|BACKBOX SIZE|CONDUIT SIZE|COMMENTS|NOTES|REFER|SEE |X = |FURNISHED|INSTALLED)/;
const isLabel = (s: string) => LABEL.test(s) && !NOT_LABELS.has(s) && /[A-Z]/.test(s);
const alphaShare = (s: string) => (s.match(/[A-Za-z]/g)?.length ?? 0) / s.length;
// A description is words, upper case, not a note about a letter ("M" INDICATES ...) and not a parenthesised reference.
const isDescription = (s: string) => s.length >= 8 && alphaShare(s) >= 0.7 && !/^["“#(]/.test(s) && !isLabel(s) && !NOT_DESCRIPTION.test(s) && s === s.toUpperCase();
const isHeading = (s: string) => /^[A-Z][A-Z &/,'-]{3,50}:$/.test(s);
const title = (s: string) => { const t = s.replace(/:$/, '').toLowerCase(); return t[0].toUpperCase() + t.slice(1); };

/** "FIRE ALARM LEGEND" -> "Fire alarm"; "ELECTRICAL LEGEND AND ABBREVIATIONS" -> "Electrical". */
export function legendCategory(sheetTitle: string | null): string {
  const t = clean((sheetTitle ?? '').replace(/\b(LEGENDS?|AND|ABBREVIATIONS?|SYMBOLS?|GENERAL|NOTES|SCHEDULES?)\b/gi, ' ').replace(/[,&]/g, ' '));
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : 'Legend';
}

/** Electrical and low-voltage legends (E, FA, SE, T ...) are the ones whose devices this app counts; other disciplines' are listed unticked. */
export const isCountableDiscipline = (sheetNumber: string | null) => /^(E|ES|ESL|EQ|FA|SE|SES|T|TE|TS|M)[-.\d]/i.test((sheetNumber ?? '').trim());

/** Legend entries from one page. `fallbackCategory` names the group when no heading sits above an entry. */
export function parseLegendPage(runs: PageRun[], pageW: number, pageH: number, fallbackCategory = 'Legend'): ScheduleRow[] {
  const cells: Cell[] = runs.filter((r) => r.str.trim() && !r.rotated).map((r) => {
    const s = clean(r.str);
    const w = r.w * pageW;
    return { s, x0: r.cx * pageW - w / 2, x1: r.cx * pageW + w / 2, y: r.cy * pageH, h: r.h * pageH };
  }).filter((c) => c.x0 < pageW * 0.88 && c.x1 > pageW * 0.025); // the title block strip and the grid letters in the margins are not part of a legend
  // The abbreviation list is a column of "AFF  ABOVE FINISHED FLOOR" pairs: not devices.
  const abbrev = cells.filter((c) => /ABBREVIATIONS/.test(c.s) && c.s.length < 60);
  const byHeading = (c: Cell) => abbrev.some((a) => c.y > a.y && c.x0 >= a.x0 - 30 && c.x0 <= a.x0 + 330);
  // An abbreviation list has no heading on some sheets, but it is recognisable: four or more entries stacked one text
  // line apart in one column. Device entries have a symbol drawn beside them and are spaced much wider.
  const dense = new Set<Cell>();
  const labelCells = cells.filter((c) => isLabel(c.s));
  const cols = new Map<number, Cell[]>();
  for (const c of labelCells) { const k = Math.round(c.x0 / 6); (cols.get(k) ?? cols.set(k, []).get(k)!).push(c); }
  for (const list of cols.values()) {
    list.sort((a, b) => a.y - b.y);
    let run: Cell[] = [];
    const flush = () => { if (run.length >= 4) run.forEach((c) => dense.add(c)); run = []; };
    for (const c of list) { if (run.length && c.y - run[run.length - 1].y > Math.max(run[run.length - 1].h, c.h) * 2.3) flush(); run.push(c); }
    flush();
  }
  const inAbbrev = (c: Cell) => byHeading(c) || dense.has(c);
  const headings = cells.filter((c) => isHeading(c.s));
  const GAP_MIN = 10, GAP_MAX = 170; // a symbol sits between its letters and the description; words in a sentence do not leave that room

  // Descriptions as blocks: a first line and any lines under it at the same left edge ("... PROVIDED BY DIVISION 26").
  const descs = cells.filter((c) => isDescription(c.s)).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const labels = cells.filter((c) => isLabel(c.s) && !inAbbrev(c));
  const labelsLeftOf = (d: Cell) => labels.filter((l) => d.x0 - l.x1 >= GAP_MIN && d.x0 - l.x1 <= GAP_MAX && Math.abs(l.y - d.y) <= Math.max(13, d.h * 1.4));
  interface Block { lines: Cell[]; x0: number; y0: number; y1: number; own: Set<Cell> }
  const blocks: Block[] = [];
  for (const d of descs) {
    const mine = labelsLeftOf(d);
    const open = blocks.find((b) => Math.abs(b.x0 - d.x0) <= 6 && d.y > b.y1 && d.y - b.y1 <= d.h * 1.9);
    // The line carries on the entry above unless it has a symbol of its own. A symbol set between the two lines of one
    // wrapped description is that entry's own, not a new one.
    if (open && mine.every((l) => open.own.has(l))) { open.lines.push(d); open.y1 = d.y; mine.forEach((l) => open.own.add(l)); }
    else blocks.push({ lines: [d], x0: d.x0, y0: d.y, y1: d.y, own: new Set(mine) });
  }
  // Each set of letters belongs to the nearest block to its right; a block takes the longest set (AD over the J symbol).
  const owner = new Map<Block, Cell[]>();
  for (const l of labels) {
    const row = Math.max(13, l.h * 1.4);
    let best: Block | null = null, bd = Infinity;
    for (const b of blocks) {
      const gap = b.x0 - l.x1;
      if (gap < GAP_MIN || gap > GAP_MAX || l.y < b.y0 - row || l.y > b.y1 + row) continue;
      const d = (l.y < b.y0 ? b.y0 - l.y : l.y > b.y1 ? l.y - b.y1 : 0) + gap * 0.05;
      if (d < bd) { bd = d; best = b; }
    }
    if (best) (owner.get(best) ?? owner.set(best, []).get(best)!).push(l);
  }
  const out: ScheduleRow[] = [];
  const seen = new Set<string>();
  for (const [b, ls] of owner) {
    const L = ls.sort((x, y) => y.s.length - x.s.length || x.x0 - y.x0)[0];
    const name = b.lines[0].s.slice(0, 120);
    const more = b.lines.slice(1).map((c) => c.s);
    const key = `${L.s}|${name}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // the nearest heading above, in the same column ("INITIATING DEVICES:")
    const head = headings.filter((h) => h.y < L.y && h.y > L.y - 700 && h.x0 <= L.x0 + 10 && h.x0 >= L.x0 - 90).sort((x, y) => y.y - x.y)[0];
    out.push({
      code: L.s, mounting: '', name, description: [name, ...more].join(' '), lumens: '', cct: '', optics: '', watts: '', volts: '', dimming: '',
      manufacturer: '', alternates: [], catalog: '', removed: false, similarTo: null,
      key, category: head ? title(head.s) : fallbackCategory, spec: more.join(' ').slice(0, 200),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}
