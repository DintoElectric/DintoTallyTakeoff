// Reads a page's text as positioned runs, for any orientation. No DOM needed, so it also runs in tests.

export interface PageRun {
  str: string;
  cx: number; // center, normalized 0..1 on the displayed page (origin top-left)
  cy: number;
  w: number;  // extent along the text direction, normalized to page width
  h: number;  // glyph height, normalized to page height
  rotated: boolean; // not horizontal on the displayed page
}

interface PageLike {
  getViewport(o: { scale: number }): { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
}

export async function extractRuns(page: PageLike): Promise<PageRun[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: PageRun[] = [];
  for (const raw of content.items) {
    const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const len = Math.hypot(a, b) || 1;
    const width = it.width ?? 0;
    const [x1, y1] = vp.convertToViewportPoint(e, f);
    const [x2, y2] = vp.convertToViewportPoint(e + (a / len) * width, f + (b / len) * width);
    const h = Math.hypot(c, d) || it.height || 1;
    const rotated = Math.abs(y2 - y1) > Math.abs(x2 - x1) * 0.2;
    // Center of the run: halfway along the baseline, lifted by half the glyph height.
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    runs.push({
      str: it.str,
      cx: (rotated ? mx - h / 2 : mx) / vp.width,
      cy: (rotated ? my : my - h / 2) / vp.height,
      w: Math.hypot(x2 - x1, y2 - y1) / vp.width,
      h: h / vp.height,
      rotated,
    });
  }
  return runs;
}
