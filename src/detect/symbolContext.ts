// What surrounds a symbol: the label printed beside it ("180°", "360°", "F"), a word saying how it is mounted ("PM"), and the
// mounting lines drawn off its ring. Cameras are the case that needs it: one ring symbol, drawn for several camera types,
// and for each of them as a ceiling, wall or pole mount. The ring is much the same; what is beside it is not.
//
// Every camera has its type printed as a stack beside it: the type over its ID ("360°" over "01-43", "F" over "01-07").
// That is how cameras are found here: from the label, so a camera is counted whatever variant of the symbol was drawn,
// however it is turned, and whatever size or colour it is.
import type { Prim } from './primitives.ts';
import type { TextMark } from './symbolSearch.ts';

export type Mount = 'ceiling' | 'wall' | 'pole';
export interface Ring { x: number; y: number; r: number }

export interface SymbolContext {
  /** The type printed beside the symbol: "180", "360" (from "180°") or "F"; null when nothing like that is there. */
  kind: string | null;
  mount: Mount;
  /** Where the mount came from: a word on the drawing, or the lines drawn off the ring. */
  mountFrom: 'text' | 'lines' | 'none';
  ring: Ring | null;
  words: string[];
}

const DEGREES = /^(\d{2,3})\s*°$/;
// A device ID as printed under a camera's type: "01-43", "C12", "CAM-12". Never bare digits ("F" over "75" is a strobe's candela rating).
const ID = /^(?:[A-Z]{1,4}[-.]?\d{1,3}|\d{1,3}[-.]\d{1,3})(?:[-.]\d{1,3})?$/;
// Words that say how a thing is mounted. Whatever is written beats what is guessed from the lines.
const MOUNT_WORDS: [RegExp, Mount][] = [[/^PM$/i, 'pole'], [/^(WM|WALL)$/i, 'wall'], [/^(CLG|CEILING)$/i, 'ceiling']];

// ---------- short straight segments, indexed by position ----------
interface Seg { ax: number; ay: number; bx: number; by: number; mx: number; my: number; len: number }
const CELL = 32;
export interface SegIndex { near(x: number, y: number, reachX: number, reachY?: number): Seg[] }
const indexes = new WeakMap<Prim[], SegIndex>();

/** The straight 2-point segments of a page (the pieces a ring is drawn from, and the lines that come off it), by position. */
export function segIndex(prims: Prim[]): SegIndex {
  const known = indexes.get(prims);
  if (known) return known;
  const grid = new Map<string, Seg[]>();
  for (const p of prims) {
    if (p.n !== 2 || !p.pts || p.pts.length < 4) continue;
    const [ax, ay, bx, by] = p.pts;
    const s: Seg = { ax, ay, bx, by, mx: (ax + bx) / 2, my: (ay + by) / 2, len: Math.hypot(bx - ax, by - ay) };
    const k = `${Math.floor(s.mx / CELL)},${Math.floor(s.my / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(s);
  }
  const ix: SegIndex = {
    near(x, y, rx, ry = rx) {
      const out: Seg[] = [];
      for (let i = Math.floor((x - rx) / CELL); i <= Math.floor((x + rx) / CELL); i++)
        for (let j = Math.floor((y - ry) / CELL); j <= Math.floor((y + ry) / CELL); j++)
          for (const s of grid.get(`${i},${j}`) ?? []) if (Math.abs(s.mx - x) <= rx && Math.abs(s.my - y) <= ry) out.push(s);
      return out;
    },
  };
  indexes.set(prims, ix);
  return ix;
}
const asIndex = (src: Prim[] | SegIndex): SegIndex => (Array.isArray(src) ? segIndex(src) : src);

// ---------- rings ----------
const BIN = 0.6;

/**
 * Finds the rings in a region: every short segment of a ring is a chord of its circle, so each votes for the centres that lie
 * at a ring-sized distance along its normal; a real ring's dozens of segments all vote for the same spot.
 * Returns the centres with their votes, strongest first, one per ring.
 */
export function ringCentres(src: Prim[] | SegIndex, cx: number, cy: number, rx: number, ry = rx): { x: number; y: number; votes: number }[] {
  const ix = asIndex(src);
  const votes = new Map<string, number>();
  for (const s of ix.near(cx, cy, rx + 16, ry + 16)) {
    if (s.len < 1 || s.len > 6) continue;
    const nx = -(s.by - s.ay) / s.len, ny = (s.bx - s.ax) / s.len;
    for (let R = 7; R <= 15.01; R += 0.5) for (const sign of [-1, 1]) {
      const x = Math.round(s.mx + sign * R * nx), y = Math.round(s.my + sign * R * ny);
      if (Math.abs(x - cx) > rx || Math.abs(y - cy) > ry) continue;
      const k = `${x},${y}`;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
  }
  // smooth over the neighbouring points, then keep the peaks
  const smooth = new Map<string, number>();
  for (const [k] of votes) { const [x, y] = k.split(',').map(Number); let t = 0; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) t += votes.get(`${x + i},${y + j}`) ?? 0; smooth.set(k, t); }
  const peaks = [...smooth].filter(([, v]) => v >= 120)   // a camera's ring: about 280 votes; a round symbol that is not drawn from dozens of segments: far fewer
  .map(([k, v]) => { const [x, y] = k.split(',').map(Number); return { x, y, votes: v }; }).sort((a, b) => b.votes - a.votes);
  const kept: { x: number; y: number; votes: number }[] = [];
  for (const p of peaks) if (!kept.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 7)) kept.push(p);
  return kept;
}

/**
 * The ring around (x, y): the centre (within `slack` points of the guess) and outer radius where the most short segment ends
 * lie on one circle. A ring is dozens of segments of a couple of points each, so it stands out. Null if there is none.
 */
export function fitRing(src: Prim[] | SegIndex, x: number, y: number, slack = 8): Ring | null {
  const ix = asIndex(src);
  const pieces = ix.near(x, y, slack + 24).filter((s) => s.len <= 6);
  if (pieces.length < 16) return null;
  const ends: number[] = [];
  for (const s of pieces) ends.push(s.ax, s.ay, s.bx, s.by);
  let best: { x: number; y: number; r: number; n: number } | null = null;
  const search = (cx0: number, cy0: number, half: number, step: number) => {
    for (let dx = -half; dx <= half + 1e-9; dx += step) for (let dy = -half; dy <= half + 1e-9; dy += step) {
      const cx = cx0 + dx, cy = cy0 + dy;
      const hist = new Map<number, number>();
      for (let i = 0; i < ends.length; i += 2) {
        const r = Math.hypot(ends[i] - cx, ends[i + 1] - cy);
        if (r < 4 || r > 24) continue;
        const b = Math.round(r / BIN);
        hist.set(b, (hist.get(b) ?? 0) + 1);
      }
      for (const [b, n] of hist) { const m = n + (hist.get(b - 1) ?? 0) * 0.5 + (hist.get(b + 1) ?? 0) * 0.5; if (!best || m > best.n) best = { x: cx, y: cy, r: b * BIN, n: m }; }
    }
  };
  search(x, y, slack, slack > 3 ? 1 : 0.5);
  if (!best) return null;
  search((best as { x: number }).x, (best as { y: number }).y, 1, 0.25);
  const b = best as { x: number; y: number; r: number; n: number };
  if (b.n < 28) return null;   // a ring of dozens of segments (a camera's has over 50 on its outer ring), not a few pieces that happen to curve
  // The radius: a symbol can have two rings (a camera does), and what is mounted to it starts on the outer one. So of the radii
  // that are well supported, take the largest.
  const hist = new Map<number, number>();
  for (let i = 0; i < ends.length; i += 2) { const r = Math.hypot(ends[i] - b.x, ends[i + 1] - b.y); if (r >= 4 && r <= 24) { const k = Math.round(r / BIN); hist.set(k, (hist.get(k) ?? 0) + 1); } }
  let top = 0;
  for (const [k, n] of hist) { const m = n + (hist.get(k - 1) ?? 0) * 0.5 + (hist.get(k + 1) ?? 0) * 0.5; if (m > top) top = m; }
  let outer = Math.round(b.r / BIN);
  for (const [k, n] of hist) { const m = n + (hist.get(k - 1) ?? 0) * 0.5 + (hist.get(k + 1) ?? 0) * 0.5; if (m >= top * 0.55 && m >= 12 && k > outer) outer = k; }
  const near: number[] = [];
  for (let i = 0; i < ends.length; i += 2) { const r = Math.hypot(ends[i] - b.x, ends[i + 1] - b.y); if (Math.abs(r - outer * BIN) <= 1) near.push(r); }
  return { x: b.x, y: b.y, r: near.length ? near.reduce((a, c) => a + c, 0) / near.length : outer * BIN };
}

/** Lines that start on the ring and run straight out from it: the mounting lines a wall camera has. */
export function mountingLines(src: Prim[] | SegIndex, ring: Ring): number {
  const found: { x: number; y: number }[] = [];
  for (const s of asIndex(src).near(ring.x, ring.y, ring.r + 30)) {
    if (s.len < 2.5 || s.len > 40) continue;
    for (const [px, py, qx, qy] of [[s.ax, s.ay, s.bx, s.by], [s.bx, s.by, s.ax, s.ay]] as const) {
      const r1 = Math.hypot(px - ring.x, py - ring.y), r2 = Math.hypot(qx - ring.x, qy - ring.y);
      if (Math.abs(r1 - ring.r) > 1.3 || r2 < ring.r + 2.5) continue;   // one end on the ring, the other clearly outside it
      const dx = (qx - px) / s.len, dy = (qy - py) / s.len, rx = (px - ring.x) / r1, ry = (py - ring.y) / r1;
      if (dx * rx + dy * ry < 0.82) continue;                              // running outward, not along the ring
      if (!found.some((f) => Math.hypot(f.x - px, f.y - py) < 1.2)) found.push({ x: px, y: py });
    }
  }
  return found.length;
}

/**
 * How a symbol at `ring` is mounted: a word beside it (PM, WM...) first, then the lines drawn off the ring. `others` are the
 * other rings nearby: a word nearer to one of those belongs to it.
 */
export function mountOf(ring: Ring, src: Prim[] | SegIndex, texts: TextMark[], others: Ring[] = []): { mount: Mount; from: SymbolContext['mountFrom']; words: string[] } {
  const mine = (t: TextMark) => Math.hypot(t.x - ring.x, t.y - ring.y) <= Math.min(...others.map((o) => Math.hypot(t.x - o.x, t.y - o.y)), 1e9) + 0.01;
  const near = texts
    .filter((t) => Math.abs(t.x - ring.x) <= ring.r + 62 && Math.abs(t.y - ring.y) <= ring.r + 16 && mine(t))
    .map((t) => ({ s: t.s.trim(), dx: t.x - ring.x, dy: t.y - ring.y, d: Math.hypot(t.x - ring.x, t.y - ring.y) }))
    .filter((t) => t.s.length > 0)
    .sort((a, b) => a.d - b.d);
  const said = near.filter((t) => Math.abs(t.dx) <= ring.r + 46 && Math.abs(t.dy) <= ring.r + 8).map((t) => MOUNT_WORDS.find(([re]) => re.test(t.s))?.[1]).find(Boolean);
  const words = near.slice(0, 6).map((t) => t.s);
  if (said) return { mount: said, from: 'text', words };
  if (mountingLines(src, ring) > 0) return { mount: 'wall', from: 'lines', words };
  return { mount: 'ceiling', from: 'none', words };
}

/** The type, mounting word and mounting lines around a symbol centred (about) at c. */
export function contextOf(c: { x: number; y: number }, src: Prim[] | SegIndex, texts: TextMark[]): SymbolContext {
  const ring = fitRing(src, c.x, c.y);
  const cx = ring?.x ?? c.x, cy = ring?.y ?? c.y, R = ring?.r ?? 12;
  // The type is the label stack beside the symbol: the type over its ID. Prefer a label that has an ID directly below it.
  const labelAt = (t: { s: string }) => { const s = t.s.trim(); const m = DEGREES.exec(s); return m ? m[1] : s === 'F' ? 'F' : null; };
  const pool = texts.filter((t) => Math.abs(t.x - cx) <= R + 62 && Math.abs(t.y - cy) <= R + 32 && labelAt(t) !== null).map((t) => ({ ...t, d: Math.hypot(t.x - cx, t.y - cy) })).sort((a, b) => a.d - b.d);
  const stacked = pool.find((t) => texts.some((u) => ID.test(u.s.trim()) && Math.abs(u.x - t.x) <= 26 && u.y > t.y + 2 && u.y - t.y <= 22));
  const label = stacked ?? pool.find((t) => Math.abs(t.y - cy) <= R + 8);
  const m = ring ? mountOf(ring, src, texts) : { mount: 'ceiling' as Mount, from: 'none' as const, words: [] as string[] };
  return { kind: label ? labelAt(label) : null, mount: m.mount, mountFrom: m.from, ring, words: m.words };
}

// ---------- cameras, found from their labels ----------
export interface CameraHit {
  kind: string;            // "180", "360" or "F"
  mount: Mount;
  mountFrom: SymbolContext['mountFrom'];
  x: number; y: number;    // the symbol's centre, in points (the label's position when no ring was found)
  ring: Ring | null;
  label: { x: number; y: number };
}

/**
 * Cameras on a page, found from the label printed beside each: a type ("180°", "360°", or "F" over an ID). The ring next to the
 * label is the camera; its surroundings say how it is mounted. A label with no ring near it is still a camera (the symbol may
 * be drawn some other way), so it is kept, with the mount unknown (ceiling) and no ring.
 */
export function findCameras(prims: Prim[], texts: TextMark[]): CameraHit[] {
  const ix = segIndex(prims);
  const idsBelow = (t: { x: number; y: number }) => texts.some((u) => ID.test(u.s.trim()) && Math.abs(u.x - t.x) <= 26 && u.y > t.y + 2 && u.y - t.y <= 22);
  const seeds: { kind: string; x: number; y: number }[] = [];
  for (const t of texts) {
    const s = t.s.trim(); const m = DEGREES.exec(s);
    if (m) seeds.push({ kind: m[1], x: t.x, y: t.y });
    else if (s === 'F' && idsBelow(t)) seeds.push({ kind: 'F', x: t.x, y: t.y });
  }
  // Each label's nearest ring (within reach on either side of it); a ring belongs to the nearest label.
  const pairs: { seed: number; ring: Ring; d: number }[] = [];
  seeds.forEach((sd, i) => {
    for (const c of ringCentres(ix, sd.x, sd.y + 6, 78, 38)) {
      const fit = fitRing(ix, c.x, c.y, 2);
      if (!fit || fit.r < 8 || fit.r > 18) continue;
      pairs.push({ seed: i, ring: fit, d: Math.hypot(fit.x - sd.x, fit.y - sd.y) });
    }
  });
  pairs.sort((a, b) => a.d - b.d);
  const owner = new Map<number, Ring>();
  const taken: Ring[] = [];
  for (const p of pairs) {
    if (owner.has(p.seed) || taken.some((r) => Math.hypot(r.x - p.ring.x, r.y - p.ring.y) < 8)) continue;
    owner.set(p.seed, p.ring); taken.push(p.ring);
  }
  const out: CameraHit[] = [];
  seeds.forEach((sd, i) => {
    const ring = owner.get(i) ?? null;
    // A degree sign turns up in plenty of notes ("45° elbow", a "90°" dimension beside a pipe drawn as a ring). A camera's type
    // always has its ID directly under it; that stack is the evidence, whether or not a ring is found beside it.
    if (!idsBelow(sd)) return;
    if (ring) {
      const m = mountOf(ring, ix, texts, taken.filter((r) => r !== ring));
      out.push({ kind: sd.kind, mount: m.mount, mountFrom: m.from, x: ring.x, y: ring.y, ring, label: { x: sd.x, y: sd.y } });
    } else out.push({ kind: sd.kind, mount: 'ceiling', mountFrom: 'none', x: sd.x, y: sd.y, ring: null, label: { x: sd.x, y: sd.y } });
  });
  return out;
}

/** The code a bucket is counted under, and its name: "180-WALL" / "180° camera, wall mounted". Long enough not to be mistaken for another. */
export const MOUNT_CODE: Record<Mount, string> = { ceiling: 'CLG', wall: 'WALL', pole: 'PM' };
export const MOUNT_LABEL: Record<Mount, string> = { ceiling: 'ceiling mounted', wall: 'wall mounted', pole: 'pole mounted (PM)' };
export const cameraCode = (kind: string, mount: Mount) => `${kind}-${MOUNT_CODE[mount]}`;
export const cameraName = (kind: string, mount: Mount) => `${kind === 'F' ? 'Fixed (F)' : `${kind}°`} camera, ${MOUNT_LABEL[mount]}`;
/** The marker shape tells the mounting at a glance. */
export const MOUNT_SHAPE: Record<Mount, 'circle' | 'square' | 'diamond'> = { ceiling: 'circle', wall: 'square', pole: 'diamond' };
export const groupCode = (c: SymbolContext) => cameraCode(c.kind ?? '', c.mount);
export const groupName = (c: SymbolContext) => cameraName(c.kind ?? '', c.mount);
