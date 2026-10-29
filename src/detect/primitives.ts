// Reads the vector drawing of a page: every painted path with its position, size and color.
// Estimator markups (annotations) are skipped so only the drawing itself is used.

export interface Prim {
  x0: number; y0: number; x1: number; y1: number; // bounding box in PDF points, displayed orientation, origin top-left
  n: number;       // number of points in the path
  fill: boolean;
  lum: number;     // luminance 0 (black) .. 1 (white) of the paint that is visible (fill if filled, else stroke)
  pts?: number[];  // the path's points as x,y pairs (curves: their end points), only kept for small shapes when asked for
}

export interface OpsLike {
  save: number; restore: number; transform: number; constructPath: number;
  setFillRGBColor: number; setStrokeRGBColor: number; beginAnnotation: number; endAnnotation: number;
  fill: number; eoFill: number; fillStroke: number; eoFillStroke: number; closeFillStroke: number; closeEOFillStroke: number;
}

interface PageLike {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getOperatorList(o?: { annotationMode?: number }): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
}

const mul = (m: number[], n: number[]) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

function lumOf(hex: unknown): number {
  const m = typeof hex === 'string' ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
  if (!m) return 0; // unknown color: treat as black, the usual CAD default
  return (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255;
}

/** `keepPoints` also keeps the points of small shapes (a symbol search needs them to tell a turned symbol from another). */
export async function extractPrims(page: PageLike, OPS: OpsLike, opts: { keepPoints?: boolean } = {}): Promise<{ prims: Prim[]; width: number; height: number }> {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList({ annotationMode: 0 });
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = vp.transform.slice();
  const stack: [number[], number, number][] = [];
  let fillL = 0, strokeL = 0, inAnnotation = false;
  const prims: Prim[] = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i];
    const a = ol.argsArray[i] as unknown[];
    if (f === OPS.beginAnnotation) { inAnnotation = true; continue; }
    if (f === OPS.endAnnotation) { inAnnotation = false; continue; }
    if (inAnnotation) continue;
    if (f === OPS.save) stack.push([ctm.slice(), fillL, strokeL]);
    else if (f === OPS.restore) { const t = stack.pop(); if (t) [ctm, fillL, strokeL] = t; }
    else if (f === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (f === OPS.setFillRGBColor) fillL = lumOf(a[0]);
    else if (f === OPS.setStrokeRGBColor) strokeL = lumOf(a[0]);
    else if (f === OPS.constructPath) {
      const paint = a[0] as number;
      const d = (a[1] as ArrayLike<number>[])[0];
      if (!d) continue;
      const pts: number[] = [];
      let k = 0;
      while (k < d.length) {
        const op = d[k++];
        if (op === 0 || op === 1) { pts.push(d[k], d[k + 1]); k += 2; }
        else if (op === 2) { pts.push(d[k + 4], d[k + 5]); k += 6; }
        else if (op === 3) { pts.push(d[k + 2], d[k + 3]); k += 4; }
        else if (op === 4) { /* close */ }
        else break;
      }
      if (pts.length < 4) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let j = 0; j < pts.length; j += 2) {
        const X = ctm[0] * pts[j] + ctm[2] * pts[j + 1] + ctm[4];
        const Y = ctm[1] * pts[j] + ctm[3] * pts[j + 1] + ctm[5];
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
      const fill = FILL.has(paint);
      const prim: Prim = { x0, y0, x1, y1, n: pts.length / 2, fill, lum: fill ? fillL : strokeL };
      // Points are kept only for what a symbol search can use: dark paint and a small shape (a dense page has 500,000 shapes,
      // so this is checked before anything is allocated).
      if (opts.keepPoints && pts.length <= 160 && prim.lum <= 0.35 && x1 - x0 <= 60 && y1 - y0 <= 60) {
        const out: number[] = new Array(pts.length);
        for (let j = 0; j < pts.length; j += 2) {
          out[j] = ctm[0] * pts[j] + ctm[2] * pts[j + 1] + ctm[4];
          out[j + 1] = ctm[1] * pts[j] + ctm[3] * pts[j + 1] + ctm[5];
        }
        prim.pts = out;
      }
      prims.push(prim);
    }
  }
  return { prims, width: vp.width, height: vp.height };
}

/** A straight piece of dark linework (a curve comes as several), in PDF points as displayed. */
export interface Segment { x0: number; y0: number; x1: number; y1: number; w?: number }   // w: stroke weight in points (0 for a fill)

/**
 * The dark linework of a page as straight segments: the electrical work (fixtures, devices, circuits) is drawn dark while the
 * architectural background is screened gray, so only paint darker than `maxLum` is kept. Curves are split into short pieces,
 * so an arc's length can be added up. Used to measure fixtures whose length is left to the drawings.
 */
/** Where a sheet has linework of any shade, in 10-point cells: tells where the drawing stops and blank paper begins. */
export interface Ink { at(x: number, y: number): boolean }

export async function extractSegments(page: PageLike, OPS: OpsLike & { setLineWidth?: number }, opts: { maxLum?: number; keepLight?: boolean } = {}): Promise<{ segments: Segment[]; light: Segment[]; width: number; height: number; ink: Ink }> {
  let lineW = 1;
  const maxLum = opts.maxLum ?? 0.2;
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList({ annotationMode: 0 });
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = vp.transform.slice();
  const stack: [number[], number, number, number][] = [];
  let fillL = 0, strokeL = 0, inAnnotation = false;
  const segments: Segment[] = [];
  const light: Segment[] = [];   // the lighter linework (walls, ceiling grid), when asked for
  const CELL = 10, cols = Math.ceil(vp.width / CELL) + 1, rows = Math.ceil(vp.height / CELL) + 1;
  const inked = new Uint8Array(cols * rows);
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / CELL));
    for (let s = 0; s <= n; s++) {
      const cx = Math.floor((x0 + ((x1 - x0) * s) / n) / CELL), cy = Math.floor((y0 + ((y1 - y0) * s) / n) / CELL);
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) inked[cy * cols + cx] = 1;
    }
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i];
    const a = ol.argsArray[i] as unknown[];
    if (f === OPS.beginAnnotation) { inAnnotation = true; continue; }
    if (f === OPS.endAnnotation) { inAnnotation = false; continue; }
    if (inAnnotation) continue;
    if (f === OPS.save) stack.push([ctm.slice(), fillL, strokeL, lineW]);
    else if (f === OPS.restore) { const t = stack.pop(); if (t) [ctm, fillL, strokeL, lineW] = t; }
    else if (f === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (f === OPS.setFillRGBColor) fillL = lumOf(a[0]);
    else if (f === OPS.setStrokeRGBColor) strokeL = lumOf(a[0]);
    else if (OPS.setLineWidth !== undefined && f === OPS.setLineWidth) lineW = a[0] as number;
    else if (f === OPS.constructPath) {
      const filled = FILL.has(a[0] as number);
      const lum = filled ? fillL : strokeL;
      const w = filled ? 0 : lineW * Math.hypot(ctm[0], ctm[1]);
      const keep = lum <= maxLum;                             // dark: kept as segments; any shade: marked as ink
      const d = (a[1] as ArrayLike<number>[])[0];
      if (!d) continue;
      const T = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      let start: [number, number] | null = null, at: [number, number] | null = null, raw: [number, number] = [0, 0];
      const add = (p: [number, number]) => {
        if (at && (p[0] !== at[0] || p[1] !== at[1])) { mark(at[0], at[1], p[0], p[1]); if (keep) segments.push({ x0: at[0], y0: at[1], x1: p[0], y1: p[1], w }); else if (opts.keepLight) light.push({ x0: at[0], y0: at[1], x1: p[0], y1: p[1], w }); }
        at = p;
      };
      let k = 0;
      while (k < d.length) {
        const op = d[k++];
        if (op === 0) { raw = [d[k], d[k + 1]]; at = T(raw[0], raw[1]); start = at; k += 2; }
        else if (op === 1) { raw = [d[k], d[k + 1]]; add(T(raw[0], raw[1])); k += 2; }
        else if (op === 2 || op === 3) {
          const c = op === 2 ? [d[k], d[k + 1], d[k + 2], d[k + 3], d[k + 4], d[k + 5]] : [raw[0], raw[1], d[k], d[k + 1], d[k + 2], d[k + 3]];
          for (let s = 1; s <= 8; s++) {
            const t = s / 8, u = 1 - t;
            add(T(u * u * u * raw[0] + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * c[4], u * u * u * raw[1] + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5]));
          }
          raw = [c[4], c[5]]; k += op === 2 ? 6 : 4;
        }
        else if (op === 4) { if (start) add(start); }
        else break;
      }
    }
  }
  const at = (x: number, y: number) => { const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL); return cx >= 0 && cy >= 0 && cx < cols && cy < rows && inked[cy * cols + cx] === 1; };
  return { segments, light, width: vp.width, height: vp.height, ink: { at } };
}
