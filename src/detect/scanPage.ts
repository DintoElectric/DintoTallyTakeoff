// The per-page scan used by Auto-count: tags, drawing notes (hexagons), room numbers, and matchlines.
import { findGridBubbles, inBubble, type GridBubble } from './gridBubbles.ts';
import { cameraCode, cameraName, findCameras, MOUNT_CODE, MOUNT_SHAPE } from './symbolContext.ts';
import { darkSmall } from './symbolSearch.ts';
import { findTriangles, triangleCode, triangleName } from './triangles.ts';
import { ceilingIndex } from './ceiling.ts';
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
    const { prims, width, height } = await extractPrims(page, OPS, { keepPoints: true }); // the points show a camera's mounting lines
    const R = DEFAULT_COUNT_REGION;
    const notes = findHexNotes(prims, runs, width, height).filter((n) => n.x >= R.x0 && n.x <= R.x1 && n.y >= R.y0 && n.y <= R.y1);
    const insideHex = (h: TagHit) => notes.some((n) => Math.abs(h.x - n.x) <= (n.r * 1.05) / width && Math.abs(h.y - n.y) <= (n.r * 0.95) / height);
    hits = hits.filter((h) => !insideHex(h));
    // Grid-line bubbles: their letters and numbers look like tags. Flagged, so the estimator can see what was left out.
    bubbles = findGridBubbles(prims, runs, width, height);
    for (const h of hits) if (inBubble(h.x, h.y, bubbles)) h.grid = true;
    // Cameras are counted from the label printed beside them (a type over an ID: "360°" over "01-43", "F" over "01-07"): they
    // have no tag to read, and the symbol is drawn in several variants and turned every way. How each is mounted is read from
    // what is written beside it (PM) and the mounting lines off its ring, and it is counted under its own code ("360-WALL").
    const marks = runs.filter((m) => m.str.trim()).map((m) => ({ s: m.str, x: m.cx * width, y: m.cy * height }));
    const cams = findCameras(darkSmall(prims), marks).filter((c) => c.x / width >= R.x0 && c.x / width <= R.x1 && c.y / height >= R.y0 && c.y / height <= R.y1);
    // the "F" printed as a camera's type is not a count of the F item
    hits = hits.filter((h) => !(h.code === 'F' && cams.some((c) => Math.abs(h.x * width - c.label.x) < 6 && Math.abs(h.y * height - c.label.y) < 6)));
    for (const c of cams) hits.push({ code: cameraCode(c.kind, c.mount), x: c.x / width, y: c.y / height, kind: 'camera', name: cameraName(c.kind, c.mount), shape: MOUNT_SHAPE[c.mount], glyph: `${c.kind}${MOUNT_CODE[c.mount][0]}`, conf: c.ring ? 0.95 : 0.6 }); // glyph: 360W, 180P, FC (type and mounting)
    // Outlets drawn as a triangle with a label beside it ("2", "4", "WAP", "IPC"): the triangle and its label are the device,
    // a circle around it makes it the ceiling version, and a hollow triangle is another device again. The label's own text hit
    // (a WAP or M4 read as a tag) is replaced by the outlet, placed on the triangle, so nothing is counted twice.
    const dark = darkSmall(prims);
    const outlets = findTriangles(dark, marks, knownCodes ? new Set([...knownCodes].map((c) => c.toUpperCase())) : undefined).filter((t) => t.label && t.x / width >= R.x0 && t.x / width <= R.x1 && t.y / height >= R.y0 && t.y / height <= R.y1);
    hits = hits.filter((h) => !outlets.some((t) => t.labelAt && Math.abs(h.x * width - t.labelAt.x) < 3 && Math.abs(h.y * height - t.labelAt.y) < 3));
    for (const t of outlets) {
      const code = triangleCode(t);
      if (code) hits.push({ code, x: t.x / width, y: t.y / height, kind: 'outlet', name: triangleName(t), shape: t.circled ? 'circle' : t.solid ? 'square' : 'diamond', glyph: (t.label ?? '').toUpperCase().slice(0, 8), conf: 0.95 });
    }
    for (const n of notes) hits.push({ code: n.label, x: n.x, y: n.y, kind: 'note' });
    // On a ceiling plan, the ceiling each count sits in (drop grid, sheetrock speckle, or open), from the room's texture.
    // (guarded on its own: whatever happens reading ceilings, the notes, cameras and outlets above are kept)
    try {
      const ceilings = ceilingIndex(prims);
      if (ceilings.hasTextures) for (const h of hits) { const c = ceilings.at(h.x * width, h.y * height); if (c) h.ceiling = c; }
    } catch (e) { console.warn('Reading ceiling types failed for a sheet; counts are kept without them', e); }
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
