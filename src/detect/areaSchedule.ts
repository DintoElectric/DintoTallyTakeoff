// Reading a schedule from areas the estimator boxed on the drawing. Nothing outside the boxes is read (the schedules
// beside it, the notes, the title block), nor anything in the sheet's ignore areas, so a column that is not needed is
// left out by drawing an ignore area over it. The header block inside the boxes gives the columns (stacked headers and
// group labels like "C.B." over "TRIP" and "POLES" included); the estimator picks the Type and Description columns and
// every other column read goes into the item's details under its header. A row starts at each type code; text wrapping
// onto the next lines stays with it; a section heading inside the table ("TWIST LOCK TYPE W/ GROUND") is kept as the
// rows' section, not read as a row.
import type { PageRun } from './pageRuns.ts';

export interface Box { x0: number; y0: number; x1: number; y1: number }   // normalized 0..1, as shown
export interface VLine { x: number; y0: number; y1: number }               // a vertical ruling line, points
interface Word { s: string; x0: number; x1: number; y: number; h: number }  // points
export interface AreaColumn { header: string; x0: number; x1: number; sample: string }
export interface AreaTable { columns: AreaColumn[]; lines: Word[][] }
export interface AreaRow { cells: string[]; section: string | null }

// The words schedule headers are made of (fixtures, receptacles and devices, equipment, panels). Only used to tell the
// header block from a title above it and the rows below it; any header still names its column, known words or not.
const HEADER_WORD = /^(type|code|mark|tag|symbol|label|id|item|no|number|location|area|room|descriptions?|lamps?|cct|cri|driver|ballast|lumens?|mounting|mtg|height|wattage|watts?|voltage|volts?|phase|wire|wires|basis|of|design|manufacturer|mfr|catalog|cat|model|remarks|notes?|comments|see|finish|optics|dimming|qty|quantity|input|color|temp|nema|class|config|configuration|c\.?b\.?|cb|breaker|trip|amps?|poles?|circuit|ckt|branch|wiring|conductors?|size|ground|grd|gnd|conduit|cond|panel|load|kva|va|hp|fla|mca|mocp|rating|fuse|fused|disconnect|starter|enclosure|equipment|unit|served|by|feeder|from|to|and|or|\/|#|-)$/i;
const tokens = (s: string) => s.split(/\s+/).map((t) => t.replace(/^[(\[]+|[)\],:]+$/g, '')).filter(Boolean);
const isCode = (s: string) => /^[A-Z0-9][A-Z0-9\-./]{0,11}$/i.test(s.trim()) && !HEADER_WORD.test(s.trim());

function lines(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const hs = sorted.map((w) => w.h).sort((a, b) => a - b);
  const tol = 0.6 * (hs[Math.floor(hs.length / 2)] || 6);
  const out: Word[][] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(w.y - last[last.length - 1].y) <= tol) last.push(w); else out.push([w]);
  }
  return out.map((l) => l.sort((a, b) => a.x0 - b.x0));
}
/** The share of a line's words that are header words. */
const headerShare = (l: Word[]) => { const t = l.flatMap((w) => tokens(w.s)); return t.length ? t.filter((x) => HEADER_WORD.test(x)).length / t.length : 0; };
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * The columns and data lines of the schedule the boxes point at, or null when no header is found in them. A box needs only
 * the header and a row or two: the read follows the columns down to the end of the table (its ruling lines, or the first
 * big gap). Several boxes add their columns together (one box per column, or one box across them all).
 */
export function readAreaTable(runs: PageRun[], boxIn: Box | Box[], opts: { pageW: number; pageH: number; skip?: (x: number, y: number) => boolean; vlines?: VLine[] }): AreaTable | null {
  const { pageW: W, pageH: H } = opts;
  const boxes = (Array.isArray(boxIn) ? boxIn : [boxIn]).map((b) => ({ x0: Math.min(b.x0, b.x1) * W, x1: Math.max(b.x0, b.x1) * W, y0: Math.min(b.y0, b.y1) * H, y1: Math.max(b.y0, b.y1) * H }));
  if (!boxes.length) return null;
  const words: Word[] = runs
    .filter((r) => !r.rotated && r.str.trim() && !opts.skip?.(r.cx, r.cy))
    .map((r) => ({ s: r.str.replace(/\s+/g, ' ').trim(), x0: (r.cx - r.w / 2) * W, x1: (r.cx + r.w / 2) * W, y: r.cy * H, h: Math.max(1, r.h * H) }));
  const mid = (w: Word) => (w.x0 + w.x1) / 2;
  const inBoxes = (w: Word) => boxes.some((b) => mid(w) >= b.x0 && mid(w) <= b.x1 && w.y >= b.y0 && w.y <= b.y1);
  const boxed = lines(words.filter(inBoxes));
  if (!boxed.length) return null;

  // The header block: from the first line near the top that is mostly header words (a title above it is not), down
  // through the lines right below it that are too (stacked headers: TYPE / CODE, C.B. over TRIP / POLES).
  // (the lines of a stacked header can sit a little apart: group lines that are close; the group with most header words wins)
  const hs = boxed.flat().map((w) => w.h).sort((a, b) => a - b);
  const h0 = hs[Math.floor(hs.length / 2)] || 6;
  let hi = -1, last = -1, bestScore = 0;
  for (let i = 0; i < Math.min(12, boxed.length); i++) {
    if (headerShare(boxed[i]) < 0.5) continue;
    let j = i;
    while (boxed[j + 1] && boxed[j + 1][0].y - boxed[j][0].y < 4 * h0 && headerShare(boxed[j + 1]) >= 0.5) j++;
    const score = boxed.slice(i, j + 1).flat().reduce((n, w) => n + tokens(w.s).filter((t) => HEADER_WORD.test(t)).length, 0);
    if (score > bestScore) { bestScore = score; hi = i; last = j; }
    i = j;
  }
  if (hi < 0) return null;
  const head = boxed.slice(hi, last + 1).flat();
  const hy0 = Math.min(...head.map((w) => w.y)), headerBottom = Math.max(...head.map((w) => w.y)) + 0.5 * h0;

  // Column edges: the table's vertical lines through the first rows below the header (the header's own cells can be
  // merged under a group label), else halfway between header labels.
  // (several rows: a section heading row is one merged cell, with no column lines through it)
  const after = lines(words.filter((w) => w.y > headerBottom && boxes.some((b) => mid(w) >= b.x0 - 20 && mid(w) <= b.x1 + 20))).slice(0, 6);
  const probes = after.length ? after.map((l) => l[0].y) : [headerBottom + h0];
  const probeY = probes[0];
  const crossing = (opts.vlines ?? []).filter((v) => probes.some((y) => v.y0 - 2 <= y && v.y1 + 2 >= y));
  const edges: number[] = [];
  for (const x of [...new Set(crossing.map((v) => Math.round(v.x)))].sort((a, b) => a - b)) if (!edges.length || x - edges[edges.length - 1] > 3) edges.push(x);
  let cols: AreaColumn[] = [];
  if (edges.length >= 2) {
    // each interval between lines with header words in it is a column; a header word over several columns (a group label) heads each
    for (let i = 0; i + 1 < edges.length; i++) {
      const x0 = edges[i], x1 = edges[i + 1];
      const hs = head.filter((w) => overlap(w.x0, w.x1, x0, x1) > 0.3 * Math.max(1, w.x1 - w.x0) || (mid(w) > x0 && mid(w) < x1));
      if (hs.length && boxes.some((b) => overlap(b.x0, b.x1, x0, x1) > 0)) cols.push({ header: hs.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' '), x0, x1, sample: '' });
    }
  }
  if (cols.length === 0) {
    // no ruling: header words that overlap side by side make one column (stacked labels share a column)
    const spans = head.map((w) => ({ x0: w.x0, x1: w.x1, ws: [w] })).sort((a, b) => a.x0 - b.x0);
    const merged: typeof spans = [];
    for (const s of spans) { const m = merged[merged.length - 1]; if (m && s.x0 < m.x1 + 0.6 * h0) { m.x1 = Math.max(m.x1, s.x1); m.ws.push(...s.ws); } else merged.push({ ...s, ws: [...s.ws] }); }
    cols = merged.map((m, i) => {
      const box = boxes.find((b) => mid(m.ws[0]) >= b.x0 && mid(m.ws[0]) <= b.x1) ?? boxes[0];
      return {
        header: m.ws.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' '),
        x0: i > 0 ? (merged[i - 1].x1 + m.x0) / 2 : box.x0,
        x1: i < merged.length - 1 ? (m.x1 + merged[i + 1].x0) / 2 : box.x1,
        sample: '',
      };
    });
  }
  cols.sort((a, b) => a.x0 - b.x0);
  if (!cols.length) return null;

  // the bottom of the table: where its lines end, else the first gap well beyond its own row spacing; never above a box's bottom
  const inCols = (w: Word) => cols.some((c) => mid(w) > c.x0 && mid(w) < c.x1);
  const below = lines(words.filter((w) => inCols(w) && w.y > headerBottom));
  let bottom = Math.max(...boxes.map((b) => b.y1));
  const runDown = (x: number) => {
    const segs = (opts.vlines ?? []).filter((v) => Math.abs(v.x - x) < 1.5).sort((a, b) => a.y0 - b.y0);
    let end = -1;
    // breaks are bridged up to a heading row's height (column lines stop where a section heading spans the table)
    for (const v of segs) { if (end < 0) { if (v.y1 > headerBottom - h0 && v.y0 < probeY + 6 * h0) end = v.y1; } else if (v.y0 <= end + 6 * h0) end = Math.max(end, v.y1); }
    return end;
  };
  const ends = cols.flatMap((c) => [runDown(c.x0), runDown(c.x1)]).filter((e) => e > hy0).sort((a, b) => a - b);
  if (ends.length >= 2) bottom = Math.max(bottom, ends[ends.length - 1] + 1);   // the line reaching furthest: the table's frame
  else {
    const gaps = below.slice(1, 12).map((l, i) => l[0].y - below[i][0].y).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3 * h0;
    const limit = Math.max(6 * h0, 3 * typical);
    let prev = headerBottom;
    for (const l of below) { if (l[0].y - prev > limit) break; prev = l[0].y; }
    bottom = Math.max(bottom, prev + 0.5 * h0);
  }
  const data = below.filter((l) => l[0].y <= bottom);
  const table: AreaTable = { columns: cols, lines: data };
  // a sample of each column, to recognize it by (a heading that starts in a column to its left is not a sample)
  for (let c = 0; c < cols.length; c++) cols[c].sample = data.flatMap((l) => l.filter((w) => colOf(table, w) === c && w.x0 >= cols[c].x0 - 2).map((w) => w.s)).join(' ').slice(0, 60);
  return table;
}

/** The column a word belongs to: the one its extent overlaps most. */
function colOf(t: AreaTable, w: Word): number {
  let best = -1, most = 0;
  t.columns.forEach((c, i) => { const o = overlap(c.x0, c.x1, w.x0, w.x1); if (o > most) { most = o; best = i; } });
  return best;
}

/**
 * The rows: a row starts at each line with a code in the key (Type) column; the lines after it belong to it. A line with
 * other text in the key column ("NON-TWIST LOCK TYPE W/ GROUND") is a section heading: the rows after it carry it.
 */
export function areaRows(t: AreaTable, keyCol: number): AreaRow[] {
  const rows: { words: Word[][]; section: string | null }[] = [];
  let section: string | null = null, inSection = false;
  for (const l of t.lines) {
    // what starts in the key column: a type code, or a heading that runs on across the columns
    const kc = t.columns[keyCol];
    const key = l.filter((w) => colOf(t, w) === keyCol || (w.x0 >= kc.x0 - 2 && w.x0 < kc.x1 && w.x1 > kc.x1));
    const keyText = key.map((w) => w.s).join(' ').trim();
    if (keyText && isCode(keyText)) { rows.push({ words: t.columns.map(() => []), section }); inSection = false; }
    else if (keyText) {
      // a heading (consecutive heading lines join: a heading can wrap)
      const text = l.map((w) => w.s).join(' ').replace(/\s+/g, ' ').trim();
      section = inSection && section ? `${section} ${text}` : text;
      inSection = true;
      continue;
    }
    const row = rows[rows.length - 1];
    if (!row) continue;   // text above the first type is not a row
    for (const w of l) { const c = colOf(t, w); if (c >= 0) row.words[c].push(w); }
  }
  return rows.map((r) => ({ cells: r.words.map((cell) => cell.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' ').replace(/\s+/g, ' ').trim()), section: r.section }));
}

/** A header as a label: "BASIS OF DESIGN" -> "Basis of design", "NEMA CLASS" -> "NEMA class"; "(SEE NOTES)" dropped. */
const KEEP_CAPS = /^(NEMA|C\.?B\.?|CKT|KVA|VA|HP|FLA|MCA|MOCP|CCT|CRI|LED|AFF|GFI|GFCI|UL|DC|AC|ID)$/;
export function headerLabel(h: string): string {
  const words = h.replace(/\(\s*SEE[^)]*\)/gi, '').replace(/\s+/g, ' ').trim().split(' ');
  return words.map((w, i) => (KEEP_CAPS.test(w.replace(/[(),:]/g, '')) ? w : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

/** "NON-TWIST LOCK TYPE W/ GROUND" -> "Non-twist lock type w/ ground": a section heading as a category name. */
export const sectionName = (s: string) => { const t = s.replace(/\s+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

export interface ColumnChoice { type: number | null; description: number | null; extra: number[] }

/** Which columns are the Type and the Description, from the header names (and what was picked before); every other column is read too. */
export function suggestColumns(cols: AreaColumn[], remembered: { type?: string; description?: string; skip?: string[] } = {}): ColumnChoice {
  const find = (prev: string | undefined, re: RegExp, not: number[] = []) => {
    let i = prev ? cols.findIndex((c, k) => !not.includes(k) && c.header.toUpperCase() === prev.toUpperCase()) : -1;
    if (i < 0) i = cols.findIndex((c, k) => !not.includes(k) && re.test(c.header));
    return i >= 0 ? i : null;
  };
  const type = find(remembered.type, /^(fixture\s+)?(type|mark|tag|symbol|label|id|designation|item)\b/i);
  const description = find(remembered.description, /descr/i, type === null ? [] : [type]);
  const skip = new Set((remembered.skip ?? []).map((s) => s.toUpperCase()));
  const extra = cols.map((_, i) => i).filter((i) => i !== type && i !== description && !skip.has(cols[i].header.toUpperCase()));
  return { type, description, extra };
}

/** The item a row becomes: its code, its description, and a details line with every other column read, under its header. */
export function rowToItem(row: AreaRow, choice: ColumnChoice, cols: AreaColumn[]): { code: string; name: string; spec: string | null; section: string | null } | null {
  const cell = (i: number | null) => (i === null ? '' : (row.cells[i] ?? '').trim());
  const code = cell(choice.type).toUpperCase();
  if (!code) return null;
  const name = cell(choice.description) || code;
  const spec = choice.extra.map((i) => (cell(i) ? `${headerLabel(cols[i].header)}: ${cell(i)}` : '')).filter(Boolean).join(' · ');
  return { code: code.slice(0, 40), name: name.length > 200 ? `${name.slice(0, 197)}…` : name, spec: spec ? (spec.length > 500 ? `${spec.slice(0, 497)}…` : spec) : null, section: row.section };
}
