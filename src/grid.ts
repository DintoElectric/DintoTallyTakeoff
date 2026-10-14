// Uniform grid over normalized page coordinates so hit-testing among thousands of
// markers stays instant (spec 2.10).
export interface Point { id: string; x: number; y: number }

export class GridIndex {
  private cells = new Map<number, Point[]>();
  private cellSize: number;
  constructor(points: Iterable<Point>, cellSize = 0.02) {
    this.cellSize = cellSize;
    for (const p of points) {
      const k = this.key(this.cx(p.x), this.cx(p.y));
      const list = this.cells.get(k);
      if (list) list.push(p);
      else this.cells.set(k, [p]);
    }
  }
  private cx(v: number) { return Math.floor(v / this.cellSize); }
  private key(cx: number, cy: number) { return cx * 100003 + cy; }

  /** Nearest point within (rx, ry) of (x, y) (radii in normalized units, independent per axis). */
  nearest(x: number, y: number, rx: number, ry: number): Point | null {
    let best: Point | null = null;
    let bestD = Infinity;
    const x0 = this.cx(x - rx), x1 = this.cx(x + rx), y0 = this.cx(y - ry), y1 = this.cx(y + ry);
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const p of list) {
          const dx = (p.x - x) / rx, dy = (p.y - y) / ry;
          const d = dx * dx + dy * dy;
          if (d <= 1 && d < bestD) { best = p; bestD = d; }
        }
      }
    }
    return best;
  }

  inRect(xa: number, ya: number, xb: number, yb: number): Point[] {
    const xl = Math.min(xa, xb), xh = Math.max(xa, xb), yl = Math.min(ya, yb), yh = Math.max(ya, yb);
    const out: Point[] = [];
    for (let i = this.cx(xl); i <= this.cx(xh); i++) {
      for (let j = this.cx(yl); j <= this.cx(yh); j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const p of list) if (p.x >= xl && p.x <= xh && p.y >= yl && p.y <= yh) out.push(p);
      }
    }
    return out;
  }
}
