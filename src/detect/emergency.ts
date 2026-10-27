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
  for (const t of tags) { t.labels = []; t.suffixes ??= []; }
  for (const r of runs) {
    const s = r.str.trim();
    // A short word standing right after a tag on the same line ("BR-22   LS") is a suffix of that tag.
    if (/^[A-Z]{1,3}$/.test(s)) {
      const lx = r.cx * pageW, ly = r.cy * pageH;
      let best: TagHit | null = null, bd = Infinity;
      for (const t of tags) {
        const dx = lx - t.x * pageW, dy = ly - t.y * pageH;
        if (dx > 8 && dx < 40 && Math.abs(dy) <= 4 && dx < bd) { bd = dx; best = t; }
      }
      if (best) { if (!best.suffixes!.includes(s)) best.suffixes!.push(s); continue; }
    }
    if (!s || s.length > 14 || !/\d/.test(s) || isTag.has(s)) continue;
    if (/^(P-|EL\d|\d+\/\d+")/.test(s)) continue; // grid lines, sheet numbers, scales
    const lx = r.cx * pageW, ly = r.cy * pageH;
    let best: TagHit | null = null, bd = Infinity;
    for (const t of tags) { const d = Math.hypot(t.x * pageW - lx, t.y * pageH - ly); if (d < bd) { bd = d; best = t; } }
    if (best && bd < OWNER_RADIUS) best.labels!.push(s);
  }
}

export interface MarkerCandidate { pattern: string; partner: string | null; count: number; examples: string[]; likely?: boolean } // partner null: no normal twin found; likely: a plain emergency mark (/EM), ticked to begin with

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
  // Words written right after the tag on its own line ("BR-22 LS"): offered as possibilities, never pre-ticked,
  // because the same place is used for other meanings too (NL = night light, CR = critical).
  const sfx = new Map<string, { n: number; codes: Set<string>; ex: string[] }>();
  for (const h of hits) {
    if (h.kind !== 'tag' && h.kind !== 'short') continue;   // (letter-only types marked "Z/EM" count too)
    for (const w of h.suffixes ?? []) {
      const e = sfx.get(w) ?? { n: 0, codes: new Set<string>(), ex: [] };
      e.n++; e.codes.add(h.code);
      if (e.ex.length < 3) e.ex.push(`${h.code} ${w}`);
      sfx.set(w, e);
    }
  }
  for (const [w, e] of sfx) {
    if (SENTENCE_WORD.test(w)) continue;                        // "E40 TO …": a note's sentence, not a mark
    const slash = w.startsWith('/');                            // "D3/EM": a mark the engineer joined to the tag
    if ((e.n >= 5 || (slash && e.n >= 3)) && e.codes.size >= 2) out.push({ pattern: `+${w}`, partner: null, count: e.n, examples: e.ex.map((x) => (slash ? x.replace(' /', '/') : x)), likely: /^\/?(EM|E|EMER|EMERG)$/.test(w) });
  }
  return out.sort((a, b) => Number(a.partner === null && !a.likely) - Number(b.partner === null && !b.likely) || b.count - a.count);
}

// Words of a sentence that can follow a tag in a note ("E40 TO …", "E24 OF …"): never an emergency mark.
const SENTENCE_WORD = /^(TO|BE|OF|IN|AND|OR|THE|AT|ON|BY|FOR|AS|IS|IT|NO|SEE|ALL|ARE|AN|A|IF|SO|UP|PER|WITH|FROM|NOT|ANY|EACH|ONE|TWO|NEW|TYP|ETC|SHALL|THIS|THAT)$/;

/** True if any label owned by this fixture matches a confirmed emergency marker. */
export function isEmergency(h: TagHit, markers: Set<string>): boolean {
  return !!h.labels?.some((raw) => labelPatterns(raw).some((p) => markers.has(p))) || !!h.suffixes?.some((w) => markers.has(`+${w}`));
}

/**
 * Parses the estimator's own markers: comma-separated, # stands for digits ("EM#, NL"). A mark of letters only, or with a
 * slash ("/EM", "EM", "NL"), also matches the same letters written right after the tag, joined by a slash or a space.
 */
export function parseCustomMarkers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const s = normalizeLabel(raw);
    if (!s) continue;
    out.push(s);
    const letters = /^\/?([A-Z]{1,5})$/i.exec(s);
    if (letters) { const w = letters[1].toUpperCase(); out.push(`+/${w}`, `+${w}`); }
  }
  return [...new Set(out)];
}

export const EMERGENCY_KEY = '\u0001EM';
/** The tag an emergency version of a fixture is stored under: B13 -> B13E (the schedule's own convention). */
export function emergencyCode(code: string, markers?: Set<string>): string {
  // Drawings that write the marker after the tag (BR-22 LS) name the emergency version the same way: BR-22LS.
  // (a mark joined by a slash names it as the drawing does: D3/EM)
  const all = markers ? [...markers] : [];
  const suffix = all.find((m) => m.startsWith('+/')) ?? all.find((m) => m.startsWith('+'));
  return suffix ? `${code}${suffix.slice(1)}` : `${code}E`;
}
