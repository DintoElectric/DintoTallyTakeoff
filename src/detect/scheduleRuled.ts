// Reads a fixture schedule drawn as a ruled table: horizontal lines between rows, vertical lines between columns.
// The lines give the exact grid, so rows whose type tag sits in the middle of a tall row are read correctly,
// and a second table on the same sheet with no header of its own is read with the first table's columns.
import type { PageRun } from './pageRuns.ts';
import type { Prim } from './primitives.ts';
import { TAG_RE } from './tagScan.ts';
import { clean, resolveSimilar, shortName, type ScheduleRow } from './scheduleParse.ts';

const HYPHEN_TAG = /^[A-Z]{1,4}-[A-Z0-9]{1,4}$/;
/** Type tags: B13, BC-14, RL-2X; and, when the first column is a SYMBOL/MARK number, plain numbers (1..24). */
export const isScheduleTag = (s: string, numeric = false) => TAG_RE.test(s) || HYPHEN_TAG.test(s) || (numeric && /^\d{1,3}[A-Z]?$/.test(s));

interface Cell { s: string; x0: number; x1: number; cx: number; y: number }
interface Table { x0: number; x1: number; ys: number[]; xs: number[] }
type Key = 'code' | 'nema' | 'catalogN' | 'breaker' | 'location' | 'description' | 'manufacturer' | 'catalog' | 'finish' | 'lumens' | 'watts' | 'lamp' | 'volts' | 'driver' | 'notes' | 'mounting' | 'other';

const cluster = (vals: number[], tol: number): number[] => {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
};

export function findTables(prims: Prim[], pageW: number): Table[] {
  const minWidth = pageW * 0.12; // a schedule table is at least about an eighth of the sheet wide
  const horiz = prims.filter((p) => !p.fill && p.n === 2 && p.y1 - p.y0 < 1.5 && p.x1 - p.x0 > 300 && p.lum < 0.5);
  const vert = prims.filter((p) => !p.fill && p.n === 2 && p.x1 - p.x0 < 1.5 && p.y1 - p.y0 > 100 && p.lum < 0.5);
  const groups = new Map<string, { x0: number; x1: number; ys: number[] }>();
  for (const h of horiz) {
    const k = `${Math.round(h.x0 / 6)}|${Math.round(h.x1 / 6)}`;
    const g = groups.get(k) ?? { x0: h.x0, x1: h.x1, ys: [] };
    g.ys.push(h.y0);
    groups.set(k, g);
  }
  const tables: Table[] = [];
  for (const g of groups.values()) {
    const ys = cluster(g.ys, 1.5);
    if (ys.length < 3 || g.x1 - g.x0 < minWidth) continue;
    const top = ys[0], bottom = ys[ys.length - 1];
    const xs = cluster(
      vert.filter((v) => v.x0 >= g.x0 - 2 && v.x0 <= g.x1 + 2 && v.y1 >= bottom - 6 && v.y0 <= top + (bottom - top) * 0.5).map((v) => v.x0),
      1.5,
    );
    if (xs.length >= 4) tables.push({ x0: g.x0, x1: g.x1, ys, xs });
  }
  return tables.sort((a, b) => a.x0 - b.x0);
}

const colOf = (xs: number[], x: number): number => {
  for (let i = 0; i < xs.length - 1; i++) if (x >= xs[i] - 1 && x < xs[i + 1]) return i;
  return -1;
};

function keyFor(header: string, index: number): Key {
  const h = header.toUpperCase();
  if (index === 0) return 'code';
  if (/NEMA/.test(h)) return 'nema';
  if (/CAT\.?\s*NO\.?$/.test(h)) return 'catalogN';        // "HUBBELL CAT. No.": one column per maker
  if (/^C\.?B\.?$/.test(h)) return 'breaker';
  if (/MANUFACTURER|MFR/.test(h)) return 'manufacturer';
  if (/CATALOG|MODEL|PART/.test(h)) return 'catalog';
  if (/DESCRIPTION/.test(h)) return 'description';
  if (/LOCATION|AREA|ROOM/.test(h)) return 'location';
  if (/FINISH|COLOR/.test(h)) return 'finish';
  if (/LUMEN/.test(h)) return 'lumens';
  if (/WATT/.test(h)) return 'watts';
  if (/VOLT/.test(h)) return 'volts';
  if (/DRIVER|DIMM|BALLAST/.test(h)) return 'driver';
  if (/NOTE|REMARK|COMMENT/.test(h)) return 'notes';
  if (/MTG|MOUNT/.test(h)) return 'mounting';
  if (/^TYPE$|LAMP/.test(h)) return 'lamp';
  return 'other';
}

/** Mounting from the description, so fixtures can be grouped (Recessed, Pendant, Surface, Wall, Exit signs ...). */
export function mountingFromDescription(d: string): string {
  const t = d.toUpperCase();
  if (/\bEXIT\b/.test(t)) return 'EXIT';
  if (/WALL[ -]?MOUNTED|WALL ?PACK|SCONCE/.test(t)) return 'WALL';
  if (/RECESS/.test(t)) return 'REC';
  if (/PENDANT/.test(t)) return 'PEND';
  if (/TRACK/.test(t)) return 'TRACK';
  if (/SURFACE|CHAIN|UNDER-?COUNTER|HIGH BAY/.test(t)) return 'SURF';
  return '';
}

const normLumens = (s: string) => {
  const t = clean(s);
  if (/^\d[\d,.]*(\/\d[\d,.]*)?$/.test(t)) return `${t} LM`;
  if (/^\d[\d,.]*\/LF$/i.test(t)) return t.replace(/\/LF$/i, ' LM/LF');
  return t;
};
const normWatts = (s: string) => {
  const t = clean(s);
  if (/^\d[\d,.]*\/LF$/i.test(t)) return t.replace(/\/LF$/i, ' W/LF');
  return t;
};
/** Wrapped catalog numbers: a line ending in "-" or "/" continues without a space; otherwise a space. */
const joinCatalog = (lines: string[]) => lines.reduce((acc, l) => (acc ? acc + (/[-/]$/.test(acc) ? '' : ' ') + l : l), '');

export function parseRuledSchedule(runs: PageRun[], prims: Prim[], pageW: number, pageH: number): ScheduleRow[] {
  const cells: Cell[] = runs
    .filter((r) => r.str.trim() && !r.rotated)
    .map((r) => ({ s: r.str.trim(), x0: (r.cx - r.w / 2) * pageW, x1: (r.cx + r.w / 2) * pageW, cx: r.cx * pageW, y: r.cy * pageH }));
  const tables = findTables(prims, pageW);
  if (!tables.length) return [];

  // Data bands of a table: between consecutive row lines, with a type tag in the first column.
  const bands = (t: Table, numeric = false) => {
    const first = [t.xs[0], t.xs[1]];
    const out: { y0: number; y1: number; tag: Cell }[] = [];
    for (let i = 0; i < t.ys.length - 1; i++) {
      const y0 = t.ys[i], y1 = t.ys[i + 1];
      const tag = cells
        .filter((c) => c.y > y0 && c.y < y1 && c.cx >= first[0] && c.cx < first[1] && isScheduleTag(c.s, numeric))
        .sort((a, b) => a.y - b.y)[0];
      if (tag) out.push({ y0, y1, tag });
    }
    return out;
  };

  // The template: the table that has a header row (TYPE or SYMBOL ... DESCRIPTION) above its first data band.
  let template: { t: Table; keys: Key[]; headers: string[]; numeric: boolean } | null = null;
  for (const t of tables) {
    for (const numeric of [false, true]) {
      const b = bands(t, numeric);
      if (!b.length) continue;
      const headerCells = cells.filter((c) => c.y > t.ys[0] - 4 && c.y < b[0].y0 && c.x0 >= t.x0 - 2 && c.x1 <= t.x1 + 2);
      const headers = t.xs.slice(0, -1).map((_, i) => clean(headerCells.filter((c) => colOf(t.xs, c.cx) === i).sort((p, q) => p.y - q.y || p.x0 - q.x0).map((c) => c.s).join(' ')));
      const keys = headers.map((h, i) => keyFor(h, i));
      const first = numeric ? /^(SYMBOL|MARK|NO\.?)$/i : /TYPE/i;
      if (keys.includes('description') && first.test(headers[0])) { template = { t, keys, headers, numeric }; break; }
    }
    if (template) break;
  }
  if (!template) return [];

  const rows: ScheduleRow[] = [];
  for (const t of tables) {
    // A table with the same number of columns is read with the template's meaning of each column.
    if (t.xs.length !== template.t.xs.length) continue;
    for (const band of bands(t, template.numeric)) {
      const inBand = cells.filter((c) => c.y > band.y0 && c.y < band.y1 && c.x0 >= t.x0 - 2 && c.x1 <= t.x1 + 4);
      const by = (k: Key) => inBand.filter((c) => template!.keys[colOf(t.xs, c.cx)] === k).sort((p, q) => (Math.abs(p.y - q.y) < 3 ? p.x0 - q.x0 : p.y - q.y));
      const text = (k: Key) => clean(by(k).map((c) => c.s).join(' '));
      const desc = text('description');
      const lampText = text('lamp');
      const cct = /\((\d{3,4}K)\)/i.exec(lampText)?.[1] ?? '';
      const nema = text('nema');
      const makers = template!.keys.map((k, i) => (k === 'catalogN' ? i : -1)).filter((i) => i >= 0).map((i) => ({
        mfr: template!.headers[i].replace(/\s*CAT\.?\s*NO\.?$/i, '').trim(),
        v: clean(inBand.filter((c) => colOf(t.xs, c.cx) === i).map((c) => c.s).join(' ')),
      })).filter((m) => m.v && !/^[-–—]+$/.test(m.v));
      const mfrLines = by('manufacturer').map((c) => c.s).filter((s) => !/^OR APPROVED EQUAL$/i.test(s));
      const sim = /^(?:SIMILAR TO|SAME AS) (?:FIXTURE )?TYPE ([A-Z0-9-]+)/.exec(desc);
      const mounting = text('mounting') || mountingFromDescription(desc);
      const breaker = text('breaker');
      rows.push({
        code: band.tag.s, mounting, name: nema ? `NEMA ${nema}, ${desc}` : shortName(desc, !!sim), description: desc,
        lumens: normLumens(text('lumens')), cct, optics: '', watts: normWatts(text('watts')), volts: text('volts'), dimming: text('driver'),
        manufacturer: makers[0]?.mfr ?? mfrLines[0] ?? '', alternates: makers.length ? makers.slice(1).map((m) => `${m.mfr} ${m.v}`) : mfrLines.slice(1),
        catalog: makers[0]?.v ?? joinCatalog(by('catalog').map((c) => c.s)),
        ...(nema ? { category: 'Special purpose receptacles', spec: [makers[0] ? `${makers[0].mfr} ${makers[0].v}` : '', breaker].filter(Boolean).join(' · ') } : {}),
        removed: /REMOVED FROM PROJECT|DELETED/i.test(desc), similarTo: sim ? sim[1] : null,
        location: text('location').replace(/[,;\s]+$/, ''), finish: text('finish'),
      });
    }
  }
  // A type listed twice keeps its first row.
  const seen = new Set<string>();
  return resolveSimilar(rows.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true))));
}
