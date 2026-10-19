// Reads schedules laid out by position: a header row over columns, one line of text per row, no ruled grid.
// The column edges come from the short line segments drawn under the header (one per column), so tables side by
// side on one sheet stay apart and each table keeps its own columns.
import type { PageRun } from './pageRuns.ts';
import type { Prim } from './primitives.ts';
import { clean } from './scheduleParse.ts';

export interface TextTable { title: string; headers: string[]; xs: number[]; rows: string[][]; headerY: number }
interface Cell { s: string; x0: number; x1: number; cx: number; y: number }
interface Cand { xs: number[]; ys: number[] }

/** Column edges: abutting line segments at the same height form a chain; each segment is one column. */
function findCandidates(prims: Prim[], pageW: number): Cand[] {
  const segs = prims.filter((p) => !p.fill && p.n === 2 && p.y1 - p.y0 < 1.5 && p.x1 - p.x0 > 25 && p.lum < 0.5);
  const byY = new Map<number, Prim[]>();
  for (const s of segs) { const k = Math.round(s.y0 * 2) / 2; (byY.get(k) ?? byY.set(k, []).get(k)!).push(s); }
  const groups = new Map<string, Cand>();
  for (const [y, list] of byY) {
    list.sort((a, b) => a.x0 - b.x0);
    let chain: Prim[] = [];
    const flush = () => {
      if (chain.length >= 3 && chain[chain.length - 1].x1 - chain[0].x0 >= pageW * 0.1) {
        const xs = [chain[0].x0, ...chain.map((c) => c.x1)];
        const key = xs.map((x) => Math.round(x)).join(',');
        const g = groups.get(key) ?? { xs, ys: [] };
        g.ys.push(y);
        groups.set(key, g);
      }
      chain = [];
    };
    for (const s of list) {
      if (chain.length && Math.abs(s.x0 - chain[chain.length - 1].x1) > 1.5) flush();
      chain.push(s);
    }
    flush();
  }
  // Two tables with the same columns, one above the other, share a signature: split them where the lines jump.
  const out: Cand[] = [];
  for (const g of groups.values()) {
    const ys = [...g.ys].sort((a, b) => a - b);
    let cur: number[] = [];
    for (const y of ys) {
      if (cur.length && y - cur[cur.length - 1] > 70) { out.push({ xs: g.xs, ys: cur }); cur = []; }
      cur.push(y);
    }
    if (cur.length) out.push({ xs: g.xs, ys: cur });
  }
  return out;
}

const colOf = (xs: number[], x: number) => { for (let i = 0; i < xs.length - 1; i++) if (x >= xs[i] - 1 && x < xs[i + 1]) return i; return -1; };
const looksLikeHeader = (texts: string[]) => texts.length >= 3 && texts.every((t) => !/\d/.test(t.replace(/#/g, '')));

export function readTextTables(runs: PageRun[], prims: Prim[], pageW: number, pageH: number): TextTable[] {
  const cells: Cell[] = runs.filter((r) => r.str.trim() && !r.rotated)
    .map((r) => ({ s: r.str.trim(), x0: (r.cx - r.w / 2) * pageW, x1: (r.cx + r.w / 2) * pageW, cx: r.cx * pageW, y: r.cy * pageH }));
  const cands = findCandidates(prims, pageW);
  const clusterRows = (list: Cell[]) => {
    const rows: Cell[][] = [];
    for (const c of [...list].sort((a, b) => a.y - b.y)) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last[0].y - c.y) <= 3.5) last.push(c); else rows.push([c]);
    }
    return rows;
  };
  const out: (TextTable & { x0: number; x1: number })[] = [];
  for (const cand of cands) {
    const xs = cand.xs, x0 = xs[0], x1 = xs[xs.length - 1], top = Math.min(...cand.ys);
    const inX = cells.filter((c) => c.cx >= x0 - 1 && c.cx <= x1 + 1);
    // Header row: the first row above (or just under) the first line with text in 3+ columns and no digits.
    const near = inX.filter((c) => c.y > top - 90 && c.y < top + 45);
    let header: { y: number; texts: string[] } | null = null;
    for (const row of clusterRows(near)) {
      const texts = xs.slice(0, -1).map((_, i) => clean(row.filter((c) => colOf(xs, c.cx) === i).sort((a, b) => a.x0 - b.x0).map((c) => c.s).join(' ')));
      const filled = texts.filter(Boolean);
      if (looksLikeHeader(filled)) { header = { y: row[0].y, texts }; break; }
    }
    if (!header) continue;
    // The heading is usually just above the header, but a table with a tall multi-line header can sit further below it.
    const head = (maxUp: number) => cells.filter((c) => /SCHEDULE/i.test(c.s) && c.s.length <= 90 && c.y < header!.y && c.y > header!.y - maxUp && c.cx >= x0 - 120 && c.cx <= x1 + 120).sort((a, b) => b.y - a.y)[0]?.s ?? '';
    const title = clean(head(80) || head(420));
    out.push({ title, headers: header.texts, xs, rows: [], headerY: header.y, x0, x1 });
  }
  // Rows: below the header, down to the next table in the same columns, or the grand total.
  for (const t of out) {
    const overlap = (o: { x0: number; x1: number }) => Math.min(t.x1, o.x1) - Math.max(t.x0, o.x0) > (t.x1 - t.x0) * 0.5;
    const below = out.filter((o) => o !== t && o.headerY > t.headerY + 30 && overlap(o)).map((o) => o.headerY - 30);
    const endY = Math.min(pageH * 0.97, ...below);
    const body = cells.filter((c) => c.cx >= t.x0 - 1 && c.cx <= t.x1 + 1 && c.y > t.headerY + 6 && c.y < endY);
    const grid: string[][] = [];
    for (const row of clusterRows(body)) {
      const cols = t.xs.slice(0, -1).map((_, i) => clean(row.filter((c) => colOf(t.xs, c.cx) === i).sort((a, b) => a.x0 - b.x0).map((c) => c.s).join(' ')));
      const filled = cols.filter(Boolean).length;
      if (/^(grand\s+)?total\b/i.test(cols[0]) || /\btotal\s*:/i.test(cols[0])) { if (/^grand/i.test(cols[0])) break; continue; }
      if (!cols[0] || filled < 2 || /^level\b/i.test(cols[0])) continue;
      grid.push(cols);
    }
    t.rows = grid;
  }
  return out.map(({ x0: _a, x1: _b, ...t }) => t);
}
