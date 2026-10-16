// Reads a fixture schedule page (a table of fixture types) from its text positions.
// Columns are found from the header row; each fixture type (A1, B13, XL4 ...) is one row.
import type { PageRun } from './pageRuns.ts';
import { TAG_RE } from './tagScan.ts';

export interface ScheduleRow {
  code: string;
  mounting: string;
  name: string;          // first sentence of the description
  description: string;   // full description text
  lumens: string; cct: string; optics: string; watts: string; volts: string; dimming: string;
  manufacturer: string;
  alternates: string[];  // other listed manufacturers
  catalog: string;
  removed: boolean;
  similarTo: string | null; // "SIMILAR TO FIXTURE TYPE A1" -> "A1"
}

interface Cell { s: string; x0: number; x1: number; cx: number; y: number; h: number }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** First sentence of a description, without splitting on "U.L." style abbreviations. */
export function firstSentence(text: string, max = 190): string {
  const t = clean(text);
  const re = /\.(?=\s+[A-Z]{3,}|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (/\b[A-Z]\.[A-Z]\.$/.test(t.slice(0, m.index + 1))) continue; // U.L.
    const s = t.slice(0, m.index + 1);
    return s.length <= max ? s : cut(s, max);
  }
  return t.length <= max ? t : cut(t, max);
}
/** "LED 2X2 FLAT PANEL TROFFER" from a long description; "similar to" rows keep their first sentence. */
export function shortName(desc: string, similar: boolean): string {
  const d = clean(desc);
  if (similar || d.length <= 60) return firstSentence(d, 120);
  const sentence = firstSentence(d, 120);
  if (sentence.length <= 60 && sentence.endsWith('.')) return sentence;
  const comma = d.indexOf(',');
  return comma >= 12 && comma <= 80 ? d.slice(0, comma) : firstSentence(d, 90);
}
const cut = (s: string, max: number) => `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;

export function parseSchedulePage(runs: PageRun[], pageW: number, pageH: number): ScheduleRow[] {
  const cells: Cell[] = runs
    .filter((r) => r.str.trim() && !r.rotated)
    .map((r) => ({ s: r.str.trim(), x0: (r.cx - r.w / 2) * pageW, x1: (r.cx + r.w / 2) * pageW, cx: r.cx * pageW, y: r.cy * pageH, h: r.h * pageH }));

  // ----- header row -----
  const find = (re: RegExp, near?: number) => cells.filter((c) => re.test(c.s) && (near === undefined || Math.abs(c.y - near) < 40)).sort((a, b) => a.y - b.y)[0];
  const type = cells.filter((c) => c.s === 'TYPE').find((t) => cells.some((c) => /^DESCRIPTION$/.test(c.s) && Math.abs(c.y - t.y) < 6));
  if (!type) return [];
  const row = (re: RegExp) => find(re, type.y);
  const mtg = row(/^MTG\.?$/), desc = row(/^DESCRIPTION$/), mfr = row(/^MANUFACTURER$/), cat = row(/^CATALOG NUMBER$/);
  if (!mtg || !desc || !mfr || !cat) return [];
  // Some headers are two cells ("DIMMING" over "PROTOCOL/RANGE"): use the span of all of them.
  const union = (re: RegExp): Cell | undefined => {
    const ms = cells.filter((c) => re.test(c.s) && Math.abs(c.y - type.y) < 40);
    if (!ms.length) return undefined;
    const x0 = Math.min(...ms.map((c) => c.x0)), x1 = Math.max(...ms.map((c) => c.x1));
    return { s: ms[0].s, x0, x1, cx: (x0 + x1) / 2, y: Math.max(...ms.map((c) => c.y)), h: ms[0].h };
  };
  const lum = union(/^DELIVERED LUMENS|^LAMP NO\. DESIGNATION|^LUMENS/), cct = union(/COLOR\/CCT|^CCT$/), opt = union(/^OPTICS$/);
  const watt = union(/^WATTAGE$|^\(W\)$/), volt = union(/^VOLTS$/), dim = union(/^(DIMMING|PROTOCOL\/RANGE)$/);
  const headerBottom = Math.max(...[type, mtg, desc, mfr, cat, lum, cct, opt, watt, volt, dim].filter((c): c is Cell => !!c).map((c) => c.y)) + 5; // tag rows start clearly below the last header line

  const descLeft = mtg.x1 + 8;
  const lumLeft = lum ? lum.x0 - 6 : (cct ?? opt)!.x0 - 60;
  const typeRight = mtg.x0 - 5;
  const tableRight = cat.x1 + 140;
  // Centered columns (lumens .. dimming): a cell belongs to the header whose span holds its center, else the nearest.
  type Key = 'lumens' | 'cct' | 'optics' | 'watts' | 'volts' | 'dimming';
  const centered: { key: Key; h: Cell }[] = [
    ...(lum ? [{ key: 'lumens' as const, h: lum }] : []), ...(cct ? [{ key: 'cct' as const, h: cct }] : []), ...(opt ? [{ key: 'optics' as const, h: opt }] : []),
    ...(watt ? [{ key: 'watts' as const, h: watt }] : []), ...(volt ? [{ key: 'volts' as const, h: volt }] : []), ...(dim ? [{ key: 'dimming' as const, h: dim }] : []),
  ];
  // Manufacturer and catalog cells are left-aligned: find the two left edges the cells cluster on.
  const rightStart = (dim ? dim.cx + 30 : mfr.cx - 120);

  // ----- rows: one per tag found in the type column -----
  const body = cells.filter((c) => c.y > headerBottom && c.x1 < tableRight && c.x0 > type.x0 - 30);
  const tags = body.filter((c) => c.x1 <= typeRight + 4 && TAG_RE.test(c.s)).sort((a, b) => a.y - b.y);
  if (tags.length === 0) return [];
  const rightCells = body.filter((c) => c.x0 >= rightStart);
  const bins = new Map<number, number>();
  for (const c of rightCells) { const k = Math.round(c.x0 / 6) * 6; bins.set(k, (bins.get(k) ?? 0) + 1); }
  const peaks = [...bins.entries()].sort((x, y) => y[1] - x[1]);
  const first = peaks[0]?.[0] ?? mfr.x0;
  const second = peaks.find(([k]) => Math.abs(k - first) > 50)?.[0] ?? cat.x0 - 60;
  const mfrCatBoundary = (first + second) / 2;
  const wrapWidth = Math.max(...rightCells.filter((c) => c.x0 >= mfrCatBoundary).map((c) => c.x1), cat.x1);

  const out: ScheduleRow[] = [];
  tags.forEach((t, i) => {
    const y0 = t.y - 5;
    const y1 = i + 1 < tags.length ? tags[i + 1].y - 5 : y0 + 1e5;
    const mine = body.filter((c) => c.y >= y0 && c.y < y1 && c !== t);
    // The last row has no next tag: stop at the first large vertical gap in the description column.
    let rows = mine;
    if (i + 1 === tags.length) {
      const ys = [...new Set(mine.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
      let end = ys[ys.length - 1];
      for (let k = 1; k < ys.length; k++) if (ys[k] - ys[k - 1] > 70) { end = ys[k - 1]; break; }
      rows = mine.filter((c) => c.y <= end + 4);
    }
    const byLine = (a: Cell, b: Cell) => a.y - b.y || a.x0 - b.x0;
    const mounting = clean(rows.filter((c) => c.x0 >= typeRight && c.x1 < descLeft).sort(byLine).map((c) => c.s).join(''));
    const desc = rows.filter((c) => c.x0 >= descLeft && c.x0 < lumLeft).sort(byLine).map((c) => c.s).join(' ');
    const col: Record<string, Cell[]> = {};
    for (const c of rows) {
      if (c.x0 < lumLeft) continue;
      let key: string;
      if (c.x0 >= rightStart) key = c.x0 < mfrCatBoundary ? 'manufacturer' : 'catalog';
      else {
        const inSpan = centered.filter((k) => c.cx >= k.h.x0 - 4 && c.cx <= k.h.x1 + 4);
        const pool = inSpan.length ? inSpan : centered;
        key = pool.reduce((m, k) => (Math.abs(c.cx - k.h.cx) < Math.abs(c.cx - m.h.cx) ? k : m)).key;
      }
      (col[key] ??= []).push(c);
    }
    const text = (k: string) => clean((col[k] ?? []).sort(byLine).map((c) => c.s).join(' '));
    // Manufacturer lines: the first is the basis of design, the rest are alternates.
    const mfrLines = (col.manufacturer ?? []).sort(byLine).map((c) => c.s);
    // Catalog numbers wrap at the column edge: a line that reaches the edge continues on the next one.
    const catLines = (col.catalog ?? []).sort(byLine);
    let catalog = '';
    for (let k = 0; k < catLines.length; k++) {
      // A line that stopped short of the edge wrapped at a space; one that hit the edge wrapped mid-word.
      const prevShort = k > 0 && catLines[k - 1].x1 < wrapWidth - 14;
      catalog += (catalog && prevShort ? ' ' : '') + catLines[k].s;
      const open = (catalog.match(/\[/g) ?? []).length > (catalog.match(/\]/g) ?? []).length;
      const atEdge = catLines[k].x1 >= wrapWidth - 14;
      // A wrapped continuation sits one text line below; alternate manufacturers' numbers sit a whole row lower.
      const next = catLines[k + 1];
      const adjacent = !!next && next.y - catLines[k].y <= Math.max(18, catLines[k].h * 1.9);
      if (!((atEdge || open) && adjacent)) break;
    }
    const d = clean(desc);
    const sim = /^(?:SIMILAR TO|SAME AS) (?:FIXTURE )?TYPE ([A-Z]{1,3}\d{1,2}[A-Z]{0,2})/.exec(d);
    out.push({
      code: t.s, mounting, name: shortName(d, !!sim), description: d,
      lumens: text('lumens'), cct: text('cct'), optics: text('optics'), watts: text('watts'), volts: text('volts'), dimming: text('dimming'),
      manufacturer: mfrLines[0] ?? '', alternates: mfrLines.slice(1), catalog,
      removed: /^REMOVED FROM PROJECT/.test(d), similarTo: sim ? sim[1] : null,
    });
  });
  return out;
}

/** Library-ready one-line spec: "4,800 LM · 3000K · 45 W · LITHONIA EPANL-…" (max 200 characters). */
export function specLine(r: ScheduleRow): string {
  const bits = [r.lumens, r.cct, r.watts && (/[A-Za-z]/.test(r.watts) ? r.watts : `${r.watts} W`), clean(`${r.manufacturer} ${r.catalog}`)].filter((x) => x && x !== '-' && x !== 'N/A');
  const s = bits.join(' · ');
  return s.length <= 200 ? s : `${s.slice(0, 197)}…`;
}

const MOUNT_NAMES: Record<string, string> = { REC: 'Recessed', PEND: 'Pendant', SURF: 'Surface', WALL: 'Wall', TRACK: 'Track', SUSP: 'Suspended' };
/** Category from the mounting column (REC/SURF counts as recessed). */
export function categoryFor(mounting: string): string {
  const first = mounting.split('/')[0].trim().toUpperCase();
  return MOUNT_NAMES[first] ?? 'Other';
}

/**
 * "A1A: SIMILAR TO FIXTURE TYPE A1, EXCEPT WITH DIFFERENT COLOR TEMPERATURE" becomes
 * "LED 2X2 FLAT PANEL TROFFER, except with different color temperature", using the parent type's name.
 */
export function resolveSimilar(rows: ScheduleRow[]): ScheduleRow[] {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const done = new Set<string>();
  const resolve = (r: ScheduleRow, depth = 0): string => {
    if (!r.similarTo || done.has(r.code) || depth > 5) return r.name;
    const parent = byCode.get(r.similarTo);
    if (!parent || parent.removed) return r.name;
    const diff = clean(r.description.replace(/^(?:SIMILAR TO|SAME AS) (?:FIXTURE )?TYPE [A-Z]{1,3}\d{1,2}[A-Z]{0,2}[,.]?\s*/, '').replace(/\.$/, ''));
    const base = resolve(parent, depth + 1);
    done.add(r.code);
    const name = diff ? `${base}, ${diff.toLowerCase()}` : base;
    r.name = name.length <= 190 ? name : cut(name, 190);
    return r.name;
  };
  rows.forEach((r) => resolve(r));
  return rows;
}
