// A page's text fingerprint, for finding the same drawing uploaded twice. Compares the set of text strings on the
// page, so a re-export with a different plot stamp still matches, and a revised drawing scores lower.
import type { PageRun } from './pageRuns.ts';

const STAMP = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b.*\b(AM|PM)\b|autodesk docs|\.rvt\b|\.dwg\b|plotted|plot date|printed/i;

export function pageFingerprint(runs: PageRun[]): Set<string> {
  const out = new Set<string>();
  for (const r of runs) {
    const s = r.str.replace(/\s+/g, ' ').trim().toUpperCase();
    if (s.length < 3 || STAMP.test(s)) continue;
    out.add(s);
  }
  return out;
}

/** 0..1: shared strings over all strings. Two empty pages are not "the same". */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (big.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}
