// The highlighter's strokes: what is saved of a freehand drag.
/**
 * A freehand stroke with the points it does not need left out (on a near-straight run, every point but the ends): what is
 * saved is the same stroke, a small fraction of the points a drag records.
 */
export function simplifyStroke(pts: [number, number][], tol = 0.0004): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len; if (d > fd) { fd = d; far = i; } }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length > 2000 ? out.filter((_, i) => i % Math.ceil(out.length / 2000) === 0 || i === out.length - 1) : out;
}
