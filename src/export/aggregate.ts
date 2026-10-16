// All exported numbers come from here, and from nothing but the detection counts the
// server returned at the moment the user clicked Export (spec 2.14).
import type { CategoryRow, ExportData, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { areaKey, areaNames, assignAreas } from '../../shared/areas.ts';

export interface AggOptions { sheetIds: Set<string> | null }

export interface ItemRowAgg {
  item: ItemTypeRow;
  bySheet: Map<string, number>;
  total: number;
  unreviewed: number;
}

export interface FloorAgg {
  floor: string | null;
  sheets: SheetRow[];
  rows: { item: ItemTypeRow; total: number; bySheet: Map<string, number> }[];
  total: number;
}

/** Counts broken out by named area. A count inside two differently named areas appears under both. */
export interface AreaAgg {
  names: string[];
  rows: { item: ItemTypeRow; byArea: Map<string, number>; unassigned: number; total: number }[];
  totals: { byArea: Map<string, number>; unassigned: number; total: number };
}

export interface Agg {
  areas: AreaAgg;
  sheets: SheetRow[];
  rows: ItemRowAgg[];
  grandTotal: number;
  bySheetTotal: Map<string, number>;
  unreviewedBySheet: Map<string, number>;
  unreviewedTotal: number;
  floors: FloorAgg[];
  categoryName: (id: string | null) => string;
  categoryOrder: (id: string | null) => number;
}

const NAMED_ORDER = ['Basement', 'Ground'];
export function floorRank(f: string | null): number {
  if (f === null || f === '') return 1e6;
  if (/^\d+$/.test(f)) return 10 + Number(f);
  const i = NAMED_ORDER.indexOf(f);
  if (i >= 0) return i;
  if (f === 'Roof') return 5e5;
  if (f === 'Site') return 6e5;
  return 4e5;
}

const sheetOrder = (a: SheetRow, b: SheetRow) =>
  (a.number ?? '\uffff').localeCompare(b.number ?? '\uffff', undefined, { numeric: true }) || a.page - b.page;

export function aggregate(data: ExportData, opts: AggOptions): Agg {
  const withCounts = new Set(data.counts.filter((c) => c.n > 0).map((c) => c.sheet_id));
  const sheets = data.sheets
    .filter((s) => (s.count_enabled || withCounts.has(s.id)) && (!opts.sheetIds || opts.sheetIds.has(s.id)))
    .sort(sheetOrder);
  const sheetSet = new Set(sheets.map((s) => s.id));

  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const rowsMap = new Map<string, ItemRowAgg>();
  const bySheetTotal = new Map<string, number>();
  let grandTotal = 0;
  for (const c of data.counts) {
    if (!sheetSet.has(c.sheet_id) || c.n <= 0) continue;
    const item = itemById.get(c.item_type_id);
    if (!item) continue;
    let row = rowsMap.get(item.id);
    if (!row) rowsMap.set(item.id, (row = { item, bySheet: new Map(), total: 0, unreviewed: 0 }));
    row.bySheet.set(c.sheet_id, (row.bySheet.get(c.sheet_id) ?? 0) + c.n);
    row.total += c.n;
    grandTotal += c.n;
    bySheetTotal.set(c.sheet_id, (bySheetTotal.get(c.sheet_id) ?? 0) + c.n);
  }

  const unreviewedBySheet = new Map<string, number>();
  let unreviewedTotal = 0;
  for (const d of data.detections) {
    if (d.status !== 'unreviewed' || !sheetSet.has(d.sheet_id)) continue;
    unreviewedBySheet.set(d.sheet_id, (unreviewedBySheet.get(d.sheet_id) ?? 0) + 1);
    unreviewedTotal += 1;
    const row = rowsMap.get(d.item_type_id);
    if (row) row.unreviewed += 1;
  }

  const catById = new Map<string, CategoryRow>(data.categories.map((c) => [c.id, c]));
  const categoryName = (id: string | null) => (id && catById.get(id)?.name) || 'Uncategorized';
  const categoryOrder = (id: string | null) => {
    const c = id ? catById.get(id) : undefined;
    return c ? c.sort : 1e6;
  };

  const rows = [...rowsMap.values()].sort(
    (a, b) => categoryOrder(a.item.category_id) - categoryOrder(b.item.category_id) || a.item.code.localeCompare(b.item.code, undefined, { numeric: true }),
  );

  const floorMap = new Map<string | null, FloorAgg>();
  for (const s of sheets) {
    const key = s.floor && s.floor.trim() ? s.floor : null;
    let f = floorMap.get(key);
    if (!f) floorMap.set(key, (f = { floor: key, sheets: [], rows: [], total: 0 }));
    f.sheets.push(s);
  }
  for (const f of floorMap.values()) {
    const ids = new Set(f.sheets.map((s) => s.id));
    for (const r of rows) {
      let total = 0;
      const bySheet = new Map<string, number>();
      for (const [sid, n] of r.bySheet) if (ids.has(sid)) { total += n; bySheet.set(sid, n); }
      if (total > 0) f.rows.push({ item: r.item, total, bySheet });
      f.total += total;
    }
  }
  const floors = [...floorMap.values()].sort((a, b) => floorRank(a.floor) - floorRank(b.floor));

  // Counts per named area (additive by name, across the included sheets).
  const areaRowsIn = (data.areas ?? []).filter((a) => sheetSet.has(a.sheet_id));
  const names = areaNames(areaRowsIn);
  const areaAgg: AreaAgg = { names, rows: [], totals: { byArea: new Map(), unassigned: 0, total: grandTotal } };
  if (names.length > 0) {
    const assigned = assignAreas(data.detections.filter((d) => sheetSet.has(d.sheet_id)), areaRowsIn);
    for (const r of rows) {
      const byArea = new Map<string, number>();
      let unassigned = 0;
      for (const a of assigned) {
        if (a.item_type_id !== r.item.id) continue;
        if (a.area === null) unassigned += a.n;
        else byArea.set(a.area, (byArea.get(a.area) ?? 0) + a.n);
      }
      areaAgg.rows.push({ item: r.item, byArea, unassigned, total: r.total });
      for (const [k, v] of byArea) areaAgg.totals.byArea.set(k, (areaAgg.totals.byArea.get(k) ?? 0) + v);
      areaAgg.totals.unassigned += unassigned;
    }
  }
  void areaKey;
  return { areas: areaAgg, sheets, rows, grandTotal, bySheetTotal, unreviewedBySheet, unreviewedTotal, floors, categoryName, categoryOrder };
}

export function safeFileName(name: string, fallback = 'Takeoff'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || fallback;
}
