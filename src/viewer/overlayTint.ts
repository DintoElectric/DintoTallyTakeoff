// The architectural plan drawn over a sheet: its lines in orange, its paper clear. A pixel's ink is how dark it is times how
// opaque it is, so both white paper and clear (unpainted) pixels stay clear: a page that failed to draw shows nothing, never a
// sheet of solid orange.
export const OVERLAY_INK: [number, number, number] = [232, 110, 20];

/** Recolours the pixels in place; returns the share of the page left orange (a floor plan's lines cover well under half). */
export function tintOverlay(d: Uint8ClampedArray | Uint8Array): number {
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dark = (1 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255) * (d[i + 3] / 255);
    const a = dark < 0.18 ? 0 : Math.min(255, Math.round(dark * 300));
    d[i] = OVERLAY_INK[0]; d[i + 1] = OVERLAY_INK[1]; d[i + 2] = OVERLAY_INK[2]; d[i + 3] = a;
    if (a) ink++;
  }
  return ink / (d.length / 4 || 1);
}

/** Whether a drawn plan looks right: some lines, and not most of the page (a blank or broken render). */
export const overlayLooksRight = (inkShare: number) => inkShare > 0.002 && inkShare < 0.6;
