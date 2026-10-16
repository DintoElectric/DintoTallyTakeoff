// Named count areas: polygons an estimator draws on a sheet and names ("Lab A", "Corridor"). Every area with the
// same name is the same area, so counts add up across polygons and across sheets. Used by the app and the server.
import { pointInPolygon, type ZonePoint } from './zones.ts';

export interface AreaRow { id: string; sheet_id: string; name: string; points: ZonePoint[] }
export const MAX_AREA_NAME = 60;

/** Trims and collapses spaces. Throws Error with a plain message. */
export function cleanAreaName(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Give the area a name.');
  const n = v.replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('Give the area a name.');
  if (n.length > MAX_AREA_NAME) throw new Error(`Area names can be up to ${MAX_AREA_NAME} characters.`);
  return n;
}

/** "Lab A" and "lab a" are the same area. */
export const areaKey = (name: string) => name.trim().toLowerCase();

export interface AssignInput { sheet_id: string; item_type_id: string; x: number; y: number; flagged?: boolean }
export interface AreaCountRow { sheet_id: string; area: string | null; item_type_id: string; n: number; flagged: number }

/**
 * Counts per sheet, per area name, per item. A count inside two areas with different names is counted in both;
 * inside two polygons with the same name it is counted once for that name. A count in no area has area = null.
 */
export function assignAreas(dets: AssignInput[], areas: AreaRow[]): AreaCountRow[] {
  const canonical = new Map<string, string>();
  const bySheet = new Map<string, { key: string; points: ZonePoint[] }[]>();
  for (const a of areas) {
    const k = areaKey(a.name);
    if (!canonical.has(k)) canonical.set(k, a.name);
    (bySheet.get(a.sheet_id) ?? bySheet.set(a.sheet_id, []).get(a.sheet_id)!).push({ key: k, points: a.points });
  }
  const acc = new Map<string, AreaCountRow>();
  const add = (sheet: string, area: string | null, item: string, flagged: boolean) => {
    const id = `${sheet}\u0000${area ?? ''}\u0000${item}`;
    const r = acc.get(id) ?? { sheet_id: sheet, area, item_type_id: item, n: 0, flagged: 0 };
    r.n++;
    if (flagged) r.flagged++;
    acc.set(id, r);
  };
  for (const d of dets) {
    const hit = new Set<string>();
    for (const a of bySheet.get(d.sheet_id) ?? []) if (!hit.has(a.key) && pointInPolygon(d.x, d.y, a.points)) hit.add(a.key);
    if (hit.size === 0) add(d.sheet_id, null, d.item_type_id, !!d.flagged);
    else for (const k of hit) add(d.sheet_id, canonical.get(k)!, d.item_type_id, !!d.flagged);
  }
  return [...acc.values()];
}

/** Distinct area names, case-insensitively, in alphabetical order. */
export function areaNames(areas: { name: string }[]): string[] {
  const m = new Map<string, string>();
  for (const a of areas) if (!m.has(areaKey(a.name))) m.set(areaKey(a.name), a.name);
  return [...m.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
