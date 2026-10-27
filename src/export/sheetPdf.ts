// One drawing as a PDF: the original page, copied as it is (vector, full quality), with the counts drawn on it as
// vector markers when asked, and optionally a page listing the counts.
import type { MarkerShape } from '../../shared/types.ts';

export interface SheetMark { x: number; y: number; shape: MarkerShape } // x, y: 0..1 across the page as it is shown

export interface CountList {
  title: string;      // "Yale OML · E1.01 LIGHTING PLAN"
  subtitle: string;   // "Counts on this sheet · Prepared Oct 27, 2026"
  groups: { name: string; rows: { code: string; name: string; n: number }[] }[];
}

export interface SheetPdfInput {
  source: Uint8Array;                                  // the drawing set the sheet is in
  pageIndex: number;                                   // 0-based page of the sheet in that set
  viewport: { width: number; height: number };         // the page as shown (rotation applied), in points
  toPdfPoint: (vx: number, vy: number) => number[];    // a shown point to the PDF page's own coordinates (pdf.js convertToPdfPoint)
  marks?: SheetMark[] | null;                          // the counts to draw; none: a clean copy of the drawing
  list?: CountList | null;                             // a page listing the counts
}

// The app's accent, as on screen: a clear outline with a light tint, so the tag or symbol underneath stays readable.
const INK = { r: 0x5d / 255, g: 0x52 / 255, b: 0x94 / 255 };

/** pdf-lib's standard fonts can only write Windows-1252 text; anything else becomes "?". */
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export const winAnsi = (s: string) => [...s].map((c) => (c.charCodeAt(0) <= 0xff || WIN_EXTRA.includes(c) ? c : '?')).join('');

/** The marker outline in shown coordinates, as points around (x, y); null for a circle. */
function outline(shape: MarkerShape, x: number, y: number, s: number): [number, number][] | null {
  switch (shape) {
    case 'circle': return null;
    case 'square': return [[x - s / 2, y - s / 2], [x + s / 2, y - s / 2], [x + s / 2, y + s / 2], [x - s / 2, y + s / 2]];
    case 'rect': return [[x - s * 0.65, y - s * 0.4], [x + s * 0.65, y - s * 0.4], [x + s * 0.65, y + s * 0.4], [x - s * 0.65, y + s * 0.4]];
    case 'diamond': return [[x, y - s * 0.62], [x + s * 0.62, y], [x, y + s * 0.62], [x - s * 0.62, y]];
  }
}

export async function buildSheetPdf(input: SheetPdfInput): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const src = await PDFDocument.load(input.source, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [input.pageIndex]);
  // The markups on the PDF (Bluebeam stamps, clouds, notes) are left out, as the app hides them: the drawing as Tally shows it.
  const { PDFName } = await import('pdf-lib');
  page.node.delete(PDFName.of('Annots'));
  out.addPage(page);

  if (input.marks?.length) {
    const ink = rgb(INK.r, INK.g, INK.b);
    // a constant size on paper: about 0.2" on a 30" x 42" sheet, never tiny on a small one
    const s = Math.min(18, Math.max(9, Math.min(input.viewport.width, input.viewport.height) * 0.0065));
    for (const m of input.marks) {
      const vx = m.x * input.viewport.width, vy = m.y * input.viewport.height;
      const pts = outline(m.shape, vx, vy, s);
      if (!pts) {
        const [cx, cy] = input.toPdfPoint(vx, vy);
        page.drawCircle({ x: cx, y: cy, size: s / 2, color: ink, opacity: 0.16, borderColor: ink, borderWidth: 1.2, borderOpacity: 1 });
        continue;
      }
      // An SVG path drawn at (0, 0) has its y flipped, so each PDF point (X, Y) is written as (X, -Y).
      const d = pts.map(([px, py], i) => { const [X, Y] = input.toPdfPoint(px, py); return `${i ? 'L' : 'M'} ${X.toFixed(2)} ${(-Y).toFixed(2)}`; }).join(' ') + ' Z';
      page.drawSvgPath(d, { x: 0, y: 0, color: ink, opacity: 0.16, borderColor: ink, borderWidth: 1.2, borderOpacity: 1 });
    }
  }

  if (input.list) {
    const font = await out.embedFont(StandardFonts.Helvetica);
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const W = 792, H = 612, M = 48, ROW = 16;                  // US Letter, landscape
    const dark = rgb(0.16, 0.17, 0.2), muted = rgb(0.45, 0.46, 0.5), rule = rgb(0.85, 0.86, 0.9);
    const fit = (t: string, f: typeof font, size: number, max: number) => {
      let s = winAnsi(t);
      while (s.length > 1 && f.widthOfTextAtSize(s, size) > max) s = s.slice(0, -2) + '…';
      return s;
    };
    let p = out.addPage([W, H]);
    let y = H - M;
    const head = (cont: boolean) => {
      p.drawText(fit(input.list!.title + (cont ? ' (continued)' : ''), bold, 14, W - 2 * M), { x: M, y, size: 14, font: bold, color: dark }); y -= 18;
      p.drawText(fit(input.list!.subtitle, font, 10, W - 2 * M), { x: M, y, size: 10, font, color: muted }); y -= 26;
      p.drawText('CODE', { x: M, y, size: 8, font: bold, color: muted });
      p.drawText('DESCRIPTION', { x: M + 90, y, size: 8, font: bold, color: muted });
      const c = 'COUNT'; p.drawText(c, { x: W - M - bold.widthOfTextAtSize(c, 8), y, size: 8, font: bold, color: muted });
      y -= 6; p.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rule }); y -= ROW - 4;
    };
    const room = () => { if (y < M + ROW) { p = out.addPage([W, H]); y = H - M; head(true); } };
    head(false);
    let total = 0;
    for (const g of input.list.groups) {
      if (!g.rows.length) continue;
      room();
      if (input.list.groups.filter((x) => x.rows.length).length > 1) { p.drawText(winAnsi(g.name), { x: M, y, size: 10, font: bold, color: dark }); y -= ROW; }
      for (const r of g.rows) {
        room();
        p.drawText(fit(r.code, bold, 10, 84), { x: M, y, size: 10, font: bold, color: dark });
        p.drawText(fit(r.name, font, 10, W - 2 * M - 90 - 60), { x: M + 90, y, size: 10, font, color: dark });
        const n = String(r.n); p.drawText(n, { x: W - M - font.widthOfTextAtSize(n, 10), y, size: 10, font, color: dark });
        total += r.n; y -= ROW;
      }
      y -= 4;
    }
    room();
    p.drawLine({ start: { x: M, y: y + ROW - 4 }, end: { x: W - M, y: y + ROW - 4 }, thickness: 0.6, color: rule });
    p.drawText('All counts', { x: M + 90, y, size: 10, font: bold, color: dark });
    const t = String(total); p.drawText(t, { x: W - M - bold.widthOfTextAtSize(t, 10), y, size: 10, font: bold, color: dark });
  }
  out.setProducer('Tally');
  return out.save();
}

/** A file name from the sheet: "E1.01 LIGHTING PLAN - counts.pdf". */
export function sheetPdfName(number: string | null, title: string | null, page: number, withCounts: boolean): string {
  const base = [number, title].filter(Boolean).join(' ') || `Page ${page}`;
  return `${base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)}${withCounts ? ' - counts' : ''}.pdf`;
}
