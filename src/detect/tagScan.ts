// Finds fixture and device tags (B13, XL4, OS, ...) in a sheet's text and counts them.
// CAD plans label every fixture and device with its tag, so counting tags counts the items.
import type { PageRun } from './pageRuns.ts';

// Letters then 1 or 2 digits then optional letters: B13, B24RC, A21A, XL4, EM2, TFS43*
export const TAG_RE = /^[A-Z]{1,3}\d{1,2}[A-Z]{0,2}\*?$/;
// Short letter-only device codes (OS, VS, S, J, LD ...). Ambiguous, so they are only counted when
// the text run is exactly the code, and they are reported at lower confidence.
export const SHORT_RE = /^[A-Z]{1,3}$/;

export interface Region { x0: number; y0: number; x1: number; y1: number }
/** Plan area: leaves out the title block and notes column on the right, and the drawing border. */
export const DEFAULT_COUNT_REGION: Region = { x0: 0.02, y0: 0.03, x1: 0.82, y1: 0.97 };

export type TagKind = 'tag' | 'short';
export interface TagHit { code: string; x: number; y: number; kind: TagKind }

/** "B13B13B13" is 3 hits of B13. Returns the repeated unit and its count, or null. */
export function splitRepeats(s: string): { unit: string; n: number } | null {
  for (let L = 2; L <= s.length / 2; L++) {
    if (s.length % L) continue;
    const unit = s.slice(0, L);
    if (TAG_RE.test(unit) && unit.repeat(s.length / L) === s) return { unit, n: s.length / L };
  }
  return null;
}

/** Longest-first split of a joined string using codes known to exist on the sheet. */
function splitByKnown(s: string, known: string[]): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const code = known.find((k) => s.startsWith(k, i));
    if (!code) return null;
    out.push(code);
    i += code.length;
  }
  return out;
}

export function scanTags(runs: PageRun[], region: Region = DEFAULT_COUNT_REGION): TagHit[] {
  const inside = (r: PageRun) => r.cx >= region.x0 && r.cx <= region.x1 && r.cy >= region.y0 && r.cy <= region.y1;
  const live = runs.filter(inside);

  // Codes that appear on their own somewhere on the sheet help split strings the CAD export joined together.
  const whole = new Set<string>();
  for (const r of live) { const s = r.str.trim(); if (TAG_RE.test(s)) whole.add(s); }
  const known = [...whole].sort((a, b) => b.length - a.length);

  const hits: TagHit[] = [];
  for (const r of live) {
    const s = r.str.trim();
    // Positions of sub-tokens are spread along the run in proportion to character offsets.
    const along = (offset: number, len: number) => ({
      x: r.rotated ? r.cx : r.cx - r.w / 2 + ((offset + len / 2) / s.length) * r.w,
      y: r.rotated ? r.cy - (r.w * 0) : r.cy,
    });
    if (TAG_RE.test(s)) { hits.push({ code: s, x: r.cx, y: r.cy, kind: 'tag' }); continue; }
    if (SHORT_RE.test(s)) { hits.push({ code: s, x: r.cx, y: r.cy, kind: 'short' }); continue; }
    const rep = splitRepeats(s);
    if (rep) {
      for (let i = 0; i < rep.n; i++) hits.push({ code: rep.unit, ...along(i * rep.unit.length, rep.unit.length), kind: 'tag' });
      continue;
    }
    // Runs like "B13 B13B13B13" or "A17 A17": split on spaces, then repeat/known-split each part.
    let offset = 0;
    for (const part of s.split(/(\s+)/)) {
      const p = part;
      if (p.trim() && !/\s/.test(p)) {
        if (TAG_RE.test(p)) hits.push({ code: p, ...along(offset, p.length), kind: 'tag' });
        else {
          const rp = splitRepeats(p);
          if (rp) for (let i = 0; i < rp.n; i++) hits.push({ code: rp.unit, ...along(offset + i * rp.unit.length, rp.unit.length), kind: 'tag' });
          else if (/^[A-Z0-9*]+$/.test(p) && /\d/.test(p)) {
            const sp = splitByKnown(p, known);
            if (sp) { let o = offset; for (const c of sp) { hits.push({ code: c, ...along(o, c.length), kind: 'tag' }); o += c.length; } }
          }
        }
      }
      offset += p.length;
    }
  }
  return hits;
}

export interface TagSummary { code: string; kind: TagKind; count: number }
export function summarize(hits: TagHit[]): TagSummary[] {
  const m = new Map<string, TagSummary>();
  for (const h of hits) {
    const e = m.get(h.code) ?? { code: h.code, kind: h.kind, count: 0 };
    e.count++;
    m.set(h.code, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
