import type { PDFPageProxy } from 'pdfjs-dist';
import { BASE_MAX_PX } from '../../shared/limits.ts';
import type { ItemStyle } from './DrawingView.tsx';
import { drawMarker, paperPalette } from './markerDraw.ts';

export interface SnapshotMarker { x: number; y: number; itemId: string; unreviewed: boolean }

/**
 * Renders one sheet with its markers to a PNG at print resolution, within the same pixel
 * caps as the viewer. One sheet at a time; the canvas is released straight after (spec 2.14).
 */
export async function renderSnapshot(
  page: PDFPageProxy, markers: SnapshotMarker[], styles: Map<string, ItemStyle>, targetWidthPx = 2400,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(targetWidthPx / vp1.width, Math.sqrt(BASE_MAX_PX / (vp1.width * vp1.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
  const ctx = canvas.getContext('2d')!;
  const size = Math.max(14, Math.round(canvas.width / 150)); // readable at the printed size
  for (const m of markers) {
    const st = styles.get(m.itemId) ?? { shape: 'circle' as const, glyph: null };
    drawMarker(ctx, paperPalette, st.shape, st.glyph, m.x * canvas.width, m.y * canvas.height, { size, active: true, flagged: m.unreviewed });
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  const w = canvas.width, h = canvas.height;
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not draw the sheet image.');
  return { png: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}
