// Measuring fixtures whose length is left to the drawings ("specified in 1" increments", "length per plans"): perimeter slots,
// tape lights, continuous runs. On a lighting plan the electrical work is drawn dark over a screened background, and a linear
// fixture is a pair of parallel lines a few points apart (a slot drawn as a long thin outline), straight or following a curve.
// Each fixture's tag sits beside it; the fixture's length is the pair's length, at the scale written for that view.
import type { Segment } from './primitives.ts';

type Pt = [number, number];
/** A run: dark linework followed end to end, through gentle bends (an arc) but not round a corner. */
export interface Run { pts: Pt[]; length: number; x0: number; y0: number; x1: number; y1: number; w: number; dashed: boolean }   // w: heaviest stroke; dashed: part of a dashed line
/** A fixture body: two runs side by side. Its length is theirs. */
export interface Body { a: Run; b: Run; length: number; gap: number }
export interface Measured { length: number | null; feet: number | null; sure: boolean; body: Body | null; why?: string }

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const lenOf = (pts: Pt[]) => pts.slice(1).reduce((n, p, i) => n + dist(p, pts[i]), 0);
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** The distance from a point to a run. */
export function toRun(p: Pt, r: Run): number {
  let best = Infinity;
  for (let i = 1; i < r.pts.length; i++) best = Math.min(best, segDist(p, r.pts[i - 1], r.pts[i]));
  return best;
}
const box = (pts: Pt[]) => ({ x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) });

/**
 * Runs from segments: duplicates dropped (CAD exports draw a line several times), collinear pieces joined into one line, then
 * lines joined end to end where they meet at a gentle bend (the short chords of an arc), and stopped at a corner.
 */
export let JOIN_GAP = 0.6;   // the largest gap bridged between pieces of one straight line
export const setJoinGap = (g: number) => { JOIN_GAP = g; };
export function buildRuns(segs: Segment[]): Run[] {
  // 1. collinear pieces: grouped by direction and offset, their spans along the line merged
  const groups = new Map<string, { ang: number; off: number; spans: [number, number, number][] }>();   // spans: from, to, stroke weight
  for (const s of segs) {
    let dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const L = Math.hypot(dx, dy);
    if (L < 0.3) continue;
    let ang = Math.atan2(dy, dx);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI - 1e-6) ang = 0;
    dx = Math.cos(ang); dy = Math.sin(ang);
    const off = -s.x0 * dy + s.y0 * dx;                       // perpendicular offset of the line
    const t0 = s.x0 * dx + s.y0 * dy, t1 = s.x1 * dx + s.y1 * dy;
    const key = `${Math.round(ang * 400)}:${Math.round(off * 2)}`;
    const g = groups.get(key) ?? groups.set(key, { ang, off, spans: [] }).get(key)!;
    g.spans.push([Math.min(t0, t1), Math.max(t0, t1), s.w ?? 0]);
  }
  const lines: { a: Pt; b: Pt; w: number; dashed: boolean }[] = [];
  for (const g of groups.values()) {
    const dx = Math.cos(g.ang), dy = Math.sin(g.ang);
    const at = (t: number): Pt => [t * dx - g.off * dy, t * dy + g.off * dx];
    g.spans.sort((p, q) => p[0] - q[0]);
    const merged: [number, number, number][] = [];
    for (const s of g.spans) {
      const cur = merged[merged.length - 1];
      if (cur && s[0] <= cur[1] + JOIN_GAP) { cur[1] = Math.max(cur[1], s[1]); cur[2] = Math.max(cur[2], s[2]); }
      else merged.push([s[0], s[1], s[2]]);
    }
    // three or more pieces in a row with short gaps between them: a dashed line (a matchline, an area boundary)
    let dashed = false;
    for (let k = 2; k < merged.length && !dashed; k++) if (merged[k][0] - merged[k - 1][1] < 20 && merged[k - 1][0] - merged[k - 2][1] < 20) dashed = true;
    for (const m of merged) lines.push({ a: at(m[0]), b: at(m[1]), w: m[2], dashed });
  }
  // 2. lines joined end to end at gentle bends (an arc's chords), each end used once
  const key = (p: Pt) => `${Math.round(p[0] * 1.5)}:${Math.round(p[1] * 1.5)}`;
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => { for (const p of [l.a, l.b]) { const k = key(p); (ends.get(k) ?? ends.set(k, []).get(k)!).push(i); } });
  const used = new Set<number>();
  const runs: Run[] = [];
  const bend = (p: Pt, q: Pt, r: Pt) => {
    const a1 = Math.atan2(q[1] - p[1], q[0] - p[0]), a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let d = Math.abs(a1 - a2); if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let pts: Pt[] = [lines[i].a, lines[i].b];
    let w = lines[i].w, dashed = lines[i].dashed;
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? pts[pts.length - 1] : pts[0];
        const prev = forward ? pts[pts.length - 2] : pts[1];
        const next = (ends.get(key(tip)) ?? []).filter((j) => !used.has(j));
        if (next.length !== 1) break;                         // a junction or the end: the run stops
        const l = lines[next[0]];
        const far = key(l.a) === key(tip) ? l.b : l.a;
        if (bend(prev, tip, far) > 0.45) break;               // a corner (about 26°), not an arc's bend
        used.add(next[0]);
        w = Math.max(w, l.w); dashed = dashed || l.dashed;
        pts = forward ? [...pts, far] : [far, ...pts];
      }
    }
    const L = lenOf(pts);
    if (L >= 4) runs.push({ pts, length: L, ...box(pts), w, dashed });
  }
  return runs;
}

/**
 * Fixture bodies: two runs of about the same length lying side by side a steady 1.5 to 10 points apart (a slot or tape light
 * drawn as a long thin outline). A lone line is left out: it is more likely a circuit, a homerun or an edge of something else.
 */
export function findBodies(runs: Run[]): Body[] {
  const bodies: Body[] = [];
  const sorted = [...runs].sort((p, q) => p.x0 - q.x0);
  const taken = new Set<Run>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (taken.has(a) || a.length < 8) continue;
    let best: { b: Run; gap: number } | null = null;
    for (let j = i + 1; j < sorted.length && sorted[j].x0 <= a.x1 + 10; j++) {
      const b = sorted[j];
      if (taken.has(b) || b.y0 > a.y1 + 10 || b.y1 < a.y0 - 10) continue;
      if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.8) continue;
      // steady spacing: sample a's points (and midpoints) against b
      const samples: Pt[] = [];
      for (let k = 0; k < a.pts.length; k++) { samples.push(a.pts[k]); if (k) samples.push([(a.pts[k][0] + a.pts[k - 1][0]) / 2, (a.pts[k][1] + a.pts[k - 1][1]) / 2]); }
      const ds = samples.map((p) => toRun(p, b));
      const mean = ds.reduce((n, d) => n + d, 0) / ds.length;
      const spread = Math.max(...ds) - Math.min(...ds);
      if (mean < 1.5 || mean > 10 || spread > Math.max(1.5, 0.35 * mean)) continue;
      if (!best || mean < best.gap) best = { b, gap: mean };
    }
    if (best) { taken.add(a); taken.add(best.b); bodies.push({ a, b: best.b, length: (a.length + best.b.length) / 2, gap: best.gap }); }
  }
  // a heavy single line is a fixture too (a tape light or channel drawn as one bold stroke); a dashed one is not
  // (at least 16 points: shorter heavy strokes are the edges of note hexagons and symbols)
  for (const r of runs) if (!taken.has(r) && !r.dashed && r.w >= 1.6 && r.length >= 16) bodies.push({ a: r, b: r, length: r.length, gap: 0 });
  return bodies;
}

/** Paper inches per foot, from a scale written on the sheet: 1/8" = 1'-0" -> 0.125; 1/4" = 1'-0" -> 0.25. */
export function scaleOf(text: string): number | null {
  const m = /(\d+)\s*\/\s*(\d+)\s*"\s*=\s*1\s*'\s*-?\s*0\s*"/.exec(text) ?? /(\d+)()\s*"\s*=\s*1\s*'\s*-?\s*0\s*"/.exec(text);
  if (!m) return null;
  const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return v > 0 && v <= 3 ? v : null;
}

/**
 * Whether each end of a fixture outline is closed: a slot or bar drawn as an outline has a short line joining its two sides at
 * each end. An end left open is where something drawn over the run cut it, so the fixture may go on past it.
 */
export function openEnds(body: Body, segs: { near(x: number, y: number): Segment[] }): number {
  if (body.a === body.b) return 0;                            // a single heavy line has no sides to join
  const a = body.a.pts, b = body.b.pts;
  let open = 0;
  for (const ea of [a[0], a[a.length - 1]]) {
    const eb = [b[0], b[b.length - 1]].reduce((m, p) => (dist(p, ea) < dist(m, ea) ? p : m));
    const capped = segs.near(ea[0], ea[1]).some((s) => {
      const p: Pt = [s.x0, s.y0], q: Pt = [s.x1, s.y1];
      // a line from near this side's end to near the other side's end (or past it: an outline drawn as one closed shape)
      return (segDist(ea, p, q) < 1.6 && segDist(eb, p, q) < 1.6 && Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1])) < body.gap * 3 + 3);
    });
    if (!capped) open++;
  }
  return open;
}
/** The segments near a point, from a grid: for checking the ends of outlines quickly. */
export function segmentGrid(segs: Segment[]): { near(x: number, y: number): Segment[] } {
  const C = 8, grid = new Map<string, Segment[]>();
  for (const s of segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / C));
    const seen = new Set<string>();
    for (let k = 0; k <= n; k++) { const key = `${Math.floor((s.x0 + ((s.x1 - s.x0) * k) / n) / C)}:${Math.floor((s.y0 + ((s.y1 - s.y0) * k) / n) / C)}`; if (!seen.has(key)) { seen.add(key); (grid.get(key) ?? grid.set(key, []).get(key)!).push(s); } }
  }
  return { near: (x, y) => { const out = new Set<Segment>(); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of grid.get(`${Math.floor(x / C) + dx}:${Math.floor(y / C) + dy}`) ?? []) out.add(s); return [...out]; } };
}

export interface ScaleMark { x: number; y: number; inPerFt: number }
/** The scales written on a sheet (under each view's title, and in the title block), where they are, in points. */
export function scaleMarks(runs: { str: string; cx: number; cy: number }[], W: number, H: number): ScaleMark[] {
  const out: ScaleMark[] = [];
  for (const r of runs) { const s = scaleOf(r.str); if (s) out.push({ x: r.cx * W, y: r.cy * H, inPerFt: s }); }
  return out;
}

export interface TagAt { id: number; x: number; y: number; known?: number | null }   // points; known: the stated length, ft

/**
 * Each tag's fixture and its length in feet (nearest foot). All tags are matched together, closest first, a body to one tag,
 * so a variable fixture's tag cannot take the outline of a known-length fixture beside it. The scale: the one written on the
 * sheet; with views at several scales (a plan and an enlarged callout), the main one is the scale that makes the sheet's own
 * known-length fixtures come out right, and another scale applies only within its view (the area above its title). A
 * measurement is sure when its fixture is clearly the nearest and its scale is certain.
 */
export function measureTags(tags: TagAt[], allBodies: Body[], scales: ScaleMark[], opts: { reach?: number; past?: (x: number, y: number) => boolean; ink?: (x: number, y: number) => boolean; grid?: { near(x: number, y: number): Segment[] }; notes?: Pt[] } = {}): Map<number, Measured> {
  const reach = opts.reach ?? 48;
  // not fixtures: an outline inside a drawing-note hexagon (its edges look like a short slot), or one under 16 points (about 2 ft)
  const bodies = allBodies.filter((b) => b.length >= 16 && !(opts.notes ?? []).some((n) => b.a.pts.some((p) => dist(p, n) < 14)));
  const out = new Map<number, Measured>();
  const pairs: { t: TagAt; body: Body; d: number }[] = [];
  for (const t of tags) for (const body of bodies) {
    const d = Math.min(toRun([t.x, t.y], body.a), toRun([t.x, t.y], body.b));
    if (d <= reach) pairs.push({ t, body, d });
  }
  pairs.sort((p, q) => p.d - q.d);
  const tagDone = new Set<number>(), bodyDone = new Set<Body>();
  const matched: { t: TagAt; body: Body; d: number; clear: boolean }[] = [];
  for (const p of pairs) {
    if (tagDone.has(p.t.id) || bodyDone.has(p.body)) continue;
    tagDone.add(p.t.id); bodyDone.add(p.body);
    matched.push({ ...p, clear: true });
  }
  // doubtful when another outline nearly as close went to no tag at all (an outline claimed by its own tag casts no doubt)
  for (const m of matched) {
    const rival = pairs.find((q) => q.t.id === m.t.id && q.body !== m.body && !bodyDone.has(q.body) && q.d <= m.d * 1.6 + 4);
    m.clear = !rival;
  }
  // the scale for each tag
  const distinct = [...new Set(scales.map((s) => s.inPerFt))];
  const right = (inPerFt: number) => matched.filter((m) => m.t.known && Math.round(m.body.length / 72 / inPerFt) === m.t.known).length;
  const evidence = new Map(distinct.map((s) => [s, right(s)]));
  const main = distinct.length ? distinct.reduce((a, b) => ((evidence.get(b) ?? 0) > (evidence.get(a) ?? 0) ? b : a)) : null;
  const certain = distinct.length === 1 || (main !== null && (evidence.get(main) ?? 0) >= 3);
  const inView = (s: ScaleMark, x: number, y: number) => x >= s.x - 200 && x <= s.x + 700 && y >= s.y - 450 && y <= s.y + 10;
  const scaleFor = (x: number, y: number): { s: number | null; own: boolean } => {
    const own = scales.find((s) => s.inPerFt !== main && inView(s, x, y));
    return own ? { s: own.inPerFt, own: true } : { s: main, own: false };
  };
  for (const m of matched) {
    const { s, own } = scaleFor(m.t.x, m.t.y);
    if (s === null) { out.set(m.t.id, { length: m.body.length, feet: null, sure: false, body: m.body, why: 'no scale written on the sheet' }); continue; }
    const feet = Math.round(m.body.length / 72 / s);
    // a fixture running to a matchline may go on on the next sheet: what is drawn here may be only part of it
    const ends = [m.body.a.pts[0], m.body.a.pts[m.body.a.pts.length - 1]];
    const cut = ends.some((e, i) => {
      const o = ends[1 - i]; const L = dist(e, o) || 1; const ux = (e[0] - o[0]) / L, uy = (e[1] - o[1]) / L;
      if (opts.past && [4, 12, 24].some((k) => opts.past!(e[0] + ux * k, e[1] + uy * k))) return true;
      // or the drawing stops at its end: blank paper beyond it, where the view's edge cut it off
      if (opts.ink) { const beyond: Pt[] = []; for (const k of [12, 22, 32]) for (const s of [-16, 0, 16]) beyond.push([e[0] + ux * k - uy * s, e[1] + uy * k + ux * s]); if (beyond.every((q) => !opts.ink!(q[0], q[1]))) return true; }
      return false;
    });
    // an outline left open at an end: something drawn over the run cut it there, so the fixture may go on
    const broken = !!opts.grid && openEnds(m.body, opts.grid) > 0;
    const single = m.body.a === m.body.b;                       // drawn as one heavy line: easily cut by what crosses it
    const sure = m.clear && feet >= 1 && certain && !own && !cut && !broken && !single;
    out.set(m.t.id, { length: m.body.length, feet: feet >= 1 ? feet : null, sure, body: m.body, why: sure ? undefined : cut ? 'it runs to a matchline or the edge of the view: part of it may be on another sheet' : broken ? 'its outline is open at an end: something drawn over it may hide the rest' : single ? 'drawn as a single line: check the length' : !m.clear ? 'another fixture is about as close' : own ? 'in a view at another scale' : !certain ? 'the sheet has views at several scales' : 'too short to measure' });
  }
  for (const t of tags) if (!out.has(t.id)) out.set(t.id, { length: null, feet: null, sure: false, body: null, why: 'no fixture outline found beside the tag' });
  return out;
}
