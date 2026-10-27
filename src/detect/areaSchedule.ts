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

/** The columns and data lines of the schedule inside the box, or null when no header row is found in it. */
export function readAreaTable(runs: PageRun[], box: Box, opts: { pageW: number; pageH: number; skip?: (x: number, y: number) => boolean; vlines?: VLine[] }): AreaTable | null {
  const { pageW: W, pageH: H } = opts;
  const bx0 = Math.min(box.x0, box.x1), bx1 = Math.max(box.x0, box.x1), by0 = Math.min(box.y0, box.y1), by1 = Math.max(box.y0, box.y1);
  const words: Word[] = runs
    .filter((r) => !r.rotated && r.str.trim() && r.cx >= bx0 && r.cx <= bx1 && r.cy >= by0 && r.cy <= by1 && !opts.skip?.(r.cx, r.cy))
    .map((r) => ({ s: r.str.trim(), x0: (r.cx - r.w / 2) * W, x1: (r.cx + r.w / 2) * W, y: r.cy * H, h: Math.max(1, r.h * H) }));
  const ls = lines(words);
  if (!ls.length) return null;
  // the header: the line near the top of the box with the most header words (a title above it has few)
  let hi = -1, best = 1;
  for (let i = 0; i < Math.min(8, ls.length); i++) { const v = vocab(ls[i]); if (v > best) { best = v; hi = i; } }
  if (hi < 0) return null;
  // a header written over two lines ("BASIS OF" / "DESIGN"): take the next line too when it is close and also header words
  let head = [...ls[hi]];
  const h0 = Math.max(...ls[hi].map((w) => w.h));
  let last = hi;
  while (ls[last + 1] && ls[last + 1][0].y - ls[last][0].y < 1.6 * h0 && vocab(ls[last + 1]) >= Math.max(1, ls[last + 1].length * 0.6)) { last++; head = head.concat(ls[last]); }
  const hy = ls[hi][0].y;
  // header labels: words close together make one label
  head.sort((a, b) => a.x0 - b.x0);
  const labels: { text: string[]; x0: number; x1: number }[] = [];
  for (const w of head) {
    const l = labels[labels.length - 1];
    if (l && w.x0 - l.x1 < 1.2 * h0) { l.text.push(w.s); l.x1 = Math.max(l.x1, w.x1); } else labels.push({ text: [w.s], x0: w.x0, x1: w.x1 });
  }
  // column edges: the table's vertical lines through the header, when it is ruled (often drawn a row at a time, so a
  // piece only as tall as the header row counts); else halfway between labels
  const xs = [...new Set((opts.vlines ?? []).filter((v) => v.y0 - 2 <= hy && v.y1 + 2 >= hy && v.x >= bx0 * W - 2 && v.x <= bx1 * W + 2 && v.y1 - v.y0 > 0.8 * h0).map((v) => Math.round(v.x)))].sort((a, b) => a - b);
  // the box's own sides close the outer columns (a schedule's last ruling line can sit outside the box)
  const all = [...xs, Math.round(bx0 * W), Math.round(bx1 * W)].sort((a, b) => a - b);
  const edges: number[] = [];
  for (const x of all) if (!edges.length || x - edges[edges.length - 1] > 3) edges.push(x);
  const cols: AreaColumn[] = [];
  if (xs.length >= 2) {
    // each header word goes in the column its middle is in (labels can run across a ruling line when they are close)
    for (let i = 0; i + 1 < edges.length; i++) {
      const inside = head.filter((w) => (w.x0 + w.x1) / 2 > edges[i] && (w.x0 + w.x1) / 2 < edges[i + 1]);
      if (inside.length) cols.push({ header: inside.sort((a, b) => a.y - b.y || a.x0 - b.x0).map((w) => w.s).join(' '), x0: edges[i], x1: edges[i + 1], sample: '' });
    }
  }
  if (cols.length < 2) {
    cols.length = 0;
    labels.forEach((l, i) => cols.push({
      header: l.text.join(' '),
      x0: i === 0 ? bx0 * W : (labels[i - 1].x1 + l.x0) / 2,
      x1: i === labels.length - 1 ? bx1 * W : (l.x1 + labels[i + 1].x0) / 2,
      sample: '',
    }));
  }
  const headerBottom = ls[last][0].y + 0.5 * h0;
  const data = ls.filter((l) => l[0].y > headerBottom);
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
