// The per-page scan used by Auto-count: tags, drawing notes (hexagons), room numbers, and matchlines.
import { findGridBubbles, inBubble, type GridBubble } from './gridBubbles.ts';
import { extractRuns, type PageRun } from './pageRuns.ts';
import { extractPrims, type OpsLike } from './primitives.ts';
import { findHexNotes } from './notes.ts';
import { findMatchlines, zonesFromMatchlines, type Matchline } from './matchlines.ts';
import { inZones, type Zone } from '../../shared/zones.ts';
import { DEFAULT_COUNT_REGION, scanTags, type TagHit } from './tagScan.ts';
import { attachLabels } from './emergency.ts';

type PageForRuns = Parameters<typeof extractRuns>[0];
type PageForPrims = Parameters<typeof extractPrims>[0];

export interface PageScan { hits: TagHit[]; lines: Matchline[]; zones: Zone[]; autoZones: Zone[]; runs: PageRun[]; bubbles: GridBubble[] }

const pageSize = async (page: { getViewport(o: { scale: number }): { width: number; height: number } }) => { const v = page.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; };

/**
 * `sheetNumber` is this sheet's own number (needed to tell which side of a matchline is the neighbour's).
 * `handZones` are the estimator's own exclusion zones for the sheet; null means use the ones found from the matchlines.
 */
export async function scanPage(page: PageForRuns & PageForPrims, OPS: OpsLike, sheetNumber: string | null, handZones: Zone[] | null = null, knownCodes?: Set<string>): Promise<PageScan> {
  const runs = await extractRuns(page);
  let hits = scanTags(runs, undefined, knownCodes);
  let bubbles: GridBubble[] = [];
  // Drawing notes: hexagons with a label inside. A tag-looking label inside a hexagon (EM2, EX3) is a note, not a device.
  try {
    const { prims, width, height } = await extractPrims(page, OPS);
    const R = DEFAULT_COUNT_REGION;
    const notes = findHexNotes(prims, runs, width, height).filter((n) => n.x >= R.x0 && n.x <= R.x1 && n.y >= R.y0 && n.y <= R.y1);
    const insideHex = (h: TagHit) => notes.some((n) => Math.abs(h.x - n.x) <= (n.r * 1.05) / width && Math.abs(h.y - n.y) <= (n.r * 0.95) / height);
    hits = hits.filter((h) => !insideHex(h));
    // Grid-line bubbles: their letters and numbers look like tags. Flagged, so the estimator can see what was left out.
    bubbles = findGridBubbles(prims, runs, width, height);
    for (const h of hits) if (inBubble(h.x, h.y, bubbles)) h.grid = true;
    for (const n of notes) hits.push({ code: n.label, x: n.x, y: n.y, kind: 'note' });
  } catch (e) {
    console.warn('Drawing-note detection failed for a sheet; counting tags only', e);
  }
  // Matchlines: everything past one belongs to the neighbouring sheet.
  // The printed labels beside each fixture (circuit, zone, panel) are how emergency fixtures are told apart.
  const dims = await pageSize(page);
  attachLabels(hits, runs, dims.w, dims.h);
  const lines = findMatchlines(runs, sheetNumber);
  const autoZones = zonesFromMatchlines(lines);
  const zones = handZones ?? autoZones;
  for (const h of hits) if (inZones(h.x, h.y, zones)) h.past = true;
  return { hits, lines, zones, autoZones, runs, bubbles };
}
