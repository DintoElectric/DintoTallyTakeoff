// Exclusion zones: areas of a sheet whose counts are ignored (the part past a matchline, or any area the
// estimator outlines). Points are normalized 0..1 on the displayed page. Shared by the app and the server.

export interface ZonePoint { x: number; y: number }
export interface Zone { points: ZonePoint[] }

export const MAX_ZONES = 40;
export const MAX_ZONE_POINTS = 80;

/** Checks a list of zones coming from a client. Throws Error with a plain message. */
export function validateZones(v: unknown): Zone[] {
  if (!Array.isArray(v)) throw new Error('Zones must be a list.');
  if (v.length > MAX_ZONES) throw new Error(`A sheet can have at most ${MAX_ZONES} zones.`);
  return v.map((z, i) => {
    const pts = (z as { points?: unknown })?.points;
    if (!Array.isArray(pts) || pts.length < 3 || pts.length > MAX_ZONE_POINTS) throw new Error(`Zone ${i + 1} needs between 3 and ${MAX_ZONE_POINTS} corner points.`);
    return {
      points: pts.map((p) => {
        const { x, y } = (p ?? {}) as { x?: unknown; y?: unknown };
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          throw new Error(`Zone ${i + 1} has a corner point outside the sheet.`);
        }
        return { x, y };
      }),
    };
  });
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(x: number, y: number, pts: ZonePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const inZones = (x: number, y: number, zones: Zone[]) => zones.some((z) => pointInPolygon(x, y, z.points));

export const rectZone = (x0: number, y0: number, x1: number, y1: number): Zone => ({
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});
