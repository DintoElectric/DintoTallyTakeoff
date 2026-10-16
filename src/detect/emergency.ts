// Emergency vs normal fixtures. Each engineer marks them differently, so nothing here is a fixed list:
// the labels printed beside fixtures are collected, matched pairs ("3" and "3es", "r2" and "r2e", "HLP/..." and
// "EHLP/...") are proposed as emergency markers, and the estimator confirms them once.
import type { TagHit } from './tagScan.ts';

/** Digits become #: "3es" -> "#es", "EHLP/1B1/5" -> "EHLP/#B#/#". */
export const normalizeLabel = (s: string) => s.trim().replace(/\d+/g, '#');

/** A label can hold several parts ("r1, r2e"); each part counts, as does the whole. */
export function labelPatterns(raw: string): string[] {
  const parts = raw.split(/,\s*/).map(normalizeLabel).filter(Boolean);
  return [...new Set([normalizeLabel(raw), ...parts])];
}

export const OWNER_RADIUS = 50; // points: a label belongs to the fixture tag nearest to it, within this distance

/** Attaches to each fixture tag the printed labels nearest to it (each label belongs to one tag only). */
export function attachLabels(hits: TagHit[], runs: { str: string; cx: number; cy: number }[], pageW: number, pageH: number): void {
  const tags = hits.filter((h) => h.kind === 'tag');
  const isTag = new Set(hits.map((h) => h.code));
  for (const t of tags) t.labels = [];
  for (const r of runs) {
    const s = r.str.trim();
    if (!s || s.length > 14 || !/\d/.test(s) || isTag.has(s)) continue;
    if (/^(P-|EL\d|\d+\/\d+")/.test(s)) continue; // grid lines, sheet numbers, scales
    const lx = r.cx * pageW, ly = r.cy * pageH;
    let best: TagHit | null = null, bd = Infinity;
    for (const t of tags) { const d = Math.hypot(t.x * pageW - lx, t.y * pageH - ly); if (d < bd) { bd = d; best = t; } }
    if (best && bd < OWNER_RADIUS) best.labels!.push(s);
  }
}

export interface MarkerCandidate { pattern: string; partner: string | null; count: number; examples: string[] } // partner null: no normal twin found

const stripE = (p: string): string | null => {
  if (/es$/i.test(p) && p.length > 2) return p.slice(0, -2); // "#es" -> "#"
  if (/#e$/i.test(p)) return p.slice(0, -1);                  // "r#e" -> "r#"
  if (/^E[A-Z]/.test(p)) return p.slice(1);                   // "EHLP/#B#/#" -> "HLP/#B#/#"
  return null;
};

/**
 * Candidate emergency markers: a label pattern that is another common pattern plus an E ("#es" beside "#",
 * "r#e" beside "r#", "EHLP/#B#/#" beside "HLP/#B#/#"). Both must be common, so stray text is not proposed.
 */
export function discoverMarkers(hits: TagHit[], minCount = 3): MarkerCandidate[] {
  const freq = new Map<string, number>();
  const ex = new Map<string, Set<string>>();
  for (const h of hits) {
    if (h.kind !== 'tag' || !h.labels) continue;
    const seen = new Set<string>();
    for (const raw of h.labels) for (const p of labelPatterns(raw)) {
      if (!seen.has(p)) { seen.add(p); freq.set(p, (freq.get(p) ?? 0) + 1); }
      const s = ex.get(p) ?? new Set<string>(); if (s.size < 4) s.add(raw.trim()); ex.set(p, s);
    }
  }
  const out: MarkerCandidate[] = [];
  for (const [p, c] of freq) {
    if (c < minCount) continue;
    const base = stripE(p);
    if (base && base !== p && (freq.get(base) ?? 0) >= minCount) out.push({ pattern: p, partner: base, count: c, examples: [...(ex.get(p) ?? [])] });
    // A panel-style label starting with E (EPP/#B#/#) with no normal twin: offered as a possibility, never pre-ticked.
    else if (/^E[A-Z]{1,5}\//.test(p)) out.push({ pattern: p, partner: null, count: c, examples: [...(ex.get(p) ?? [])] });
  }
  return out.sort((a, b) => Number(a.partner === null) - Number(b.partner === null) || b.count - a.count);
}

/** True if any label owned by this fixture matches a confirmed emergency marker. */
export function isEmergency(h: TagHit, markers: Set<string>): boolean {
  return !!h.labels?.some((raw) => labelPatterns(raw).some((p) => markers.has(p)));
}

/** Parses the estimator's own markers: comma-separated, # stands for digits ("EM#, NL"). */
export function parseCustomMarkers(text: string): string[] {
  return text.split(',').map((s) => normalizeLabel(s)).filter((s) => s.length > 0);
}

export const EMERGENCY_KEY = '\u0001EM';
/** The tag an emergency version of a fixture is stored under: B13 -> B13E (the schedule's own convention). */
export const emergencyCode = (code: string) => `${code}E`;
