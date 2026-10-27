// Reading a schedule from an area the estimator boxed on the drawing. Nothing outside the box is read (the relay
// schedules beside it, the notes, the title block), nor anything in the sheet's ignore areas. The header row inside
// the box gives the columns; the estimator picks which columns are the Type, Description, Driver and Basis of design,
// and every other column is skipped. A row starts at each type code; text wrapping onto the next lines stays with it.
import type { PageRun } from './pageRuns.ts';

export interface Box { x0: number; y0: number; x1: number; y1: number }   // normalized 0..1, as shown
export interface VLine { x: number; y0: number; y1: number }               // a vertical ruling line, points
interface Word { s: string; x0: number; x1: number; y: number; h: number }  // points
export interface AreaColumn { header: string; x0: number; x1: number; sample: string }
export interface AreaTable { columns: AreaColumn[]; lines: Word[][] }

export type Field = 'type' | 'description' | 'driver' | 'basis';
export const FIELDS: { key: Field; label: string; match: RegExp }[] = [
  { key: 'type', label: 'Type', match: /^(fixture\s+)?(type|mark|tag|symbol|label|id|designation)\b/i },
  { key: 'description', label: 'Description', match: /descr/i },
  { key: 'driver', label: 'Driver', match: /driver|ballast/i },
  { key: 'basis', label: 'Basis of design', match: /basis|manufacturer|\bmfr\b|catalog|model/i },
];

// words that headers of fixture and device schedules are made of
const HEADER_WORD = /^(type|mark|tag|symbol|label|id|location|descriptions?|lamps?|cct|driver|ballast|lumens?|mounting|mtg\.?|wattage|watts?|voltage|volts?|basis|of|design|manufacturer|mfr\.?|catalog|cat\.?|model|remarks|notes?|comments|finish|optics|dimming|qty|quantity|input|color|temp\.?|cri|\/|#|no\.?)$/i;

const isCode = (s: string) => /^[A-Z0-9][A-Z0-9\-./]{0,11}$/i.test(s.trim()) && !HEADER_WORD.test(s.trim());

function lines(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const hs = sorted.map((w) => w.h).sort((a, b) => a - b);
  const tol = 0.6 * (hs[Math.floor(hs.length / 2)] || 6);
  const out: Word[][] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(w.y - last[0].y) <= tol) last.push(w); else out.push([w]);
  }
  return out.map((l) => l.sort((a, b) => a.x0 - b.x0));
}
const vocab = (l: Word[]) => l.reduce((n, w) => n + w.s.split(/\s+/).filter((t) => HEADER_WORD.test(t)).length, 0);

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
    .map((r) => ({ s: r.str.trim(), x0: (r.cx - r.w / 2) * W, x1: (r.cx + r.w / 2) * W, y: r.cy * H, h: Math.max(1, r.h * H) }));
  const mid = (w: Word) => (w.x0 + w.x1) / 2;
  const inBoxes = (w: Word) => boxes.some((b) => mid(w) >= b.x0 && mid(w) <= b.x1 && w.y >= b.y0 && w.y <= b.y1);
  const boxed = lines(words.filter(inBoxes));
  if (!boxed.length) return null;
  // the header: near the top of the boxes, the line with the most header words (one is enough: a box around one column)
  let hi = -1, best = 0;
  for (let i = 0; i < Math.min(8, boxed.length); i++) { const v = vocab(boxed[i]); if (v > best) { best = v; hi = i; } }
  if (hi < 0) return null;
  let head = [...boxed[hi]];
  const h0 = Math.max(...boxed[hi].map((w) => w.h));
  // a header written over two lines ("BASIS OF" / "DESIGN"): take the next line too when it is close and also header words
  let last = hi;
  while (boxed[last + 1] && boxed[last + 1][0].y - boxed[last][0].y < 1.6 * h0 && vocab(boxed[last + 1]) >= Math.max(1, boxed[last + 1].length * 0.6)) { last++; head = head.concat(boxed[last]); }
  const hy = boxed[hi][0].y, headerBottom = boxed[last][0].y + 0.5 * h0;
  // The table's vertical lines through the header row (often drawn a row at a time, so a piece as tall as the header counts).
  const crossing = (opts.vlines ?? []).filter((v) => v.y0 - 2 <= hy && v.y1 + 2 >= hy && v.y1 - v.y0 > 0.8 * h0);
  const edges: number[] = [];
  for (const x of [...new Set(crossing.map((v) => Math.round(v.x)))].sort((a, b) => a - b)) if (!edges.length || x - edges[edges.length - 1] > 3) edges.push(x);
  // header labels: words close together make one label
  head.sort((a, b) => a.x0 - b.x0);
  const labels: { words: Word[]; x0: number; x1: number }[] = [];
  for (const w of head) {
    const l = labels[labels.length - 1];
    if (l && w.x0 - l.x1 < 1.2 * h0 && !edges.some((e) => e > l.x1 && e < w.x0)) { l.words.push(w); l.x1 = Math.max(l.x1, w.x1); } else labels.push({ words: [w], x0: w.x0, x1: w.x1 });
  }
  // each label's column reaches out to the table's lines on either side; without lines, halfway to the next label (or the box)
  const cols: AreaColumn[] = [];
  labels.forEach((l, i) => {
    const c = (l.x0 + l.x1) / 2;
    const left = edges.filter((e) => e <= l.x0 + 1).pop(), right = edges.find((e) => e >= l.x1 - 1);
    const box = boxes.find((b) => c >= b.x0 && c <= b.x1)!;
    const x0 = left ?? (i > 0 ? (labels[i - 1].x1 + l.x0) / 2 : box.x0);
    const x1 = right ?? (i < labels.length - 1 ? (l.x1 + labels[i + 1].x0) / 2 : box.x1);
    const same = cols.find((k) => Math.abs(k.x0 - x0) < 2 && Math.abs(k.x1 - x1) < 2);   // two labels between the same lines: one column
    const text = l.words.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' ');
    if (same) same.header = `${same.header} ${text}`; else cols.push({ header: text, x0, x1, sample: '' });
  });
  cols.sort((a, b) => a.x0 - b.x0);
  // the bottom of the table: where its lines end, else the first big gap between lines of text; never above a box's bottom
  const inCols = (w: Word) => cols.some((c) => mid(w) > c.x0 && mid(w) < c.x1);
  const below = lines(words.filter((w) => inCols(w) && w.y > headerBottom));
  let bottom = Math.max(...boxes.map((b) => b.y1));
  const runDown = (x: number) => {
    const segs = (opts.vlines ?? []).filter((v) => Math.abs(v.x - x) < 1.5).sort((a, b) => a.y0 - b.y0);
    let end = -1;
    for (const v of segs) { if (end < 0) { if (v.y0 - 2 <= hy && v.y1 + 2 >= hy) end = v.y1; } else if (v.y0 <= end + Math.max(3, h0)) end = Math.max(end, v.y1); }   // small breaks where lines meet are bridged
    return end;
  };
  const ends = cols.flatMap((c) => [runDown(c.x0), runDown(c.x1)]).filter((e) => e > hy).sort((a, b) => a - b);
  if (ends.length >= 2) bottom = Math.max(bottom, ends[Math.floor(ends.length / 2)] + 1);
  else {
    // stop at a gap well beyond this table's own row spacing (the blank space before notes or the next table)
    const gaps = below.slice(1, 12).map((l, i) => l[0].y - below[i][0].y).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3 * h0;
    const limit = Math.max(6 * h0, 3 * typical);
    let prev = headerBottom;
    for (const l of below) { if (l[0].y - prev > limit) break; prev = l[0].y; }
    bottom = Math.max(bottom, prev + 0.5 * h0);
  }
  const data = below.filter((l) => l[0].y <= bottom);
  const table: AreaTable = { columns: cols, lines: data };
  // a sample of each column: its first few words, to recognize it by
  for (let c = 0; c < cols.length; c++) cols[c].sample = data.flatMap((l) => l.filter((w) => colOf(table, w) === c).map((w) => w.s)).join(' ').slice(0, 60);
  return table;
}

/** The column a word belongs to: the one its extent overlaps most. */
function colOf(t: AreaTable, w: Word): number {
  let best = -1, most = 0;
  t.columns.forEach((c, i) => { const o = Math.min(c.x1, w.x1) - Math.max(c.x0, w.x0); if (o > most) { most = o; best = i; } });
  return best;
}

/** The rows: a row starts at each line with a code in the key (Type) column; the lines after it, until the next code, belong to it. */
export function areaRows(t: AreaTable, keyCol: number): string[][] {
  const rows: Word[][][] = [];
  for (const l of t.lines) {
    const key = l.filter((w) => colOf(t, w) === keyCol);
    const starts = key.length > 0 && isCode(key.map((w) => w.s).join(' '));
    if (starts) rows.push(t.columns.map(() => []));
    const row = rows[rows.length - 1];
    if (!row) continue;   // text above the first type (a sub-heading) is not a row
    for (const w of l) { const c = colOf(t, w); if (c >= 0) row[c].push(w); }
  }
  return rows.map((r) => r.map((cell) => cell.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' ').replace(/\s+/g, ' ').trim()));
}

/** Which column holds each field, from the header names (and what was picked before for the same header names). */
export function suggestColumns(cols: AreaColumn[], remembered: Partial<Record<Field, string>> = {}): Record<Field, number | null> {
  const out = {} as Record<Field, number | null>;
  const taken = new Set<number>();
  for (const f of FIELDS) {
    const prev = remembered[f.key];
    let i = prev ? cols.findIndex((c, k) => !taken.has(k) && c.header.toUpperCase() === prev.toUpperCase()) : -1;
    if (i < 0) i = cols.findIndex((c, k) => !taken.has(k) && f.match.test(c.header));
    out[f.key] = i >= 0 ? i : null;
    if (i >= 0) taken.add(i);
  }
  return out;
}

/** The item a row becomes: code, description, and a spec line holding the driver and the basis of design. */
export function rowToItem(row: string[], cols: Record<Field, number | null>): { code: string; name: string; spec: string | null } | null {
  const get = (f: Field) => (cols[f] === null ? '' : (row[cols[f] as number] ?? '').trim());
  const code = get('type').toUpperCase();
  if (!code) return null;
  const name = get('description') || code;
  const parts = [get('driver') && `Driver: ${get('driver')}`, get('basis') && `Basis of design: ${get('basis')}`].filter(Boolean) as string[];
  const spec = parts.join(' · ');
  return { code: code.slice(0, 40), name: name.length > 200 ? `${name.slice(0, 197)}…` : name, spec: spec ? (spec.length > 500 ? `${spec.slice(0, 497)}…` : spec) : null };
}
