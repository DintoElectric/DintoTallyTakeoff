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
      // Points are kept only for what a symbol search can use: dark paint and a small shape (a dense page has 300,000 shapes).
      const out: number[] | null = opts.keepPoints && pts.length <= 160 && (FILL.has(paint) ? fillL : strokeL) <= 0.35 ? [] : null;
      for (let j = 0; j < pts.length; j += 2) {
        const X = ctm[0] * pts[j] + ctm[2] * pts[j + 1] + ctm[4];
        const Y = ctm[1] * pts[j] + ctm[3] * pts[j + 1] + ctm[5];
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        if (out) out.push(X, Y);
      }
      const fill = FILL.has(paint);
      const prim: Prim = { x0, y0, x1, y1, n: pts.length / 2, fill, lum: fill ? fillL : strokeL };
      if (out && x1 - x0 <= 60 && y1 - y0 <= 60) prim.pts = out;
      prims.push(prim);
    }
  }
  return { prims, width: vp.width, height: vp.height };
}
