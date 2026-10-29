// Measuring, on one sheet, the fixtures whose length is left to the drawings (see fixtureLength.ts). The sheet's own
// known-length fixtures are measured too, but only as evidence of which scale the plan is drawn at.
import { inZones, type Zone } from '../../shared/zones.ts';
import type { PageRun } from './pageRuns.ts';
import { extractSegments, type OpsLike } from './primitives.ts';
import { buildRuns, findBodies, measureTags, scaleMarks, segmentGrid } from './fixtureLength.ts';
import type { TagHit } from './tagScan.ts';

type PageLike = Parameters<typeof extractSegments>[0];

/** Adds lengthFt / lengthSure / lengthWhy to the hits of `measured` codes. `known`: codes with a stated length, in feet. */
export async function measureSheet(page: PageLike, OPS: OpsLike, runs: PageRun[], hits: TagHit[], zones: Zone[], measured: Set<string>, known: Map<string, number>): Promise<void> {
  const up = (c: string) => c.toUpperCase();
  const targets = hits.filter((h) => !h.grid && (h.kind === 'tag' || h.kind === 'short') && (measured.has(up(h.code)) || known.has(up(h.code))));
  if (!targets.some((h) => measured.has(up(h.code)))) return;      // nothing to measure on this sheet
  const { segments, width: W, height: H, ink } = await extractSegments(page, OPS);
  const bodies = findBodies(buildRuns(segments));
  const result = measureTags(
    targets.map((h, i) => ({ id: i, x: h.x * W, y: h.y * H, known: known.get(up(h.code)) ?? null })),
    bodies, scaleMarks(runs, W, H),
    { past: (x, y) => inZones(x / W, y / H, zones), ink: ink.at, grid: segmentGrid(segments), notes: hits.filter((h) => h.kind === 'note').map((h) => [h.x * W, h.y * H] as [number, number]) },
  );
  targets.forEach((h, i) => {
    if (!measured.has(up(h.code))) return;
    const r = result.get(i)!;
    h.lengthFt = r.feet; h.lengthSure = r.sure; h.lengthWhy = r.why;
  });
}
