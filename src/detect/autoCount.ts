// Auto-count: scan sheets for fixture/device tags, then write the matches as unreviewed detections.
import type { Detection, DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { BATCH_MAX_OPS } from '../../shared/limits.ts';
import { api } from '../auth/api.ts';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';
import type { Zone } from '../../shared/zones.ts';
import { scanPage } from './scanPage.ts';
import { planSheetWrite } from './writePlan.ts';
export { CONF_AMBIGUOUS, CONF_EMERGENCY, CONF_NORMAL_SPLIT, CONF_ROOMISH, CONF_SHORT, CONF_TAG } from './writePlan.ts';
import type { TagHit, TagKind } from './tagScan.ts';


export interface SheetScan { sheet: SheetRow; hits: TagHit[]; zones: Zone[]; error?: string }

export async function scanSheets(
  sheets: SheetRow[], files: DrawingFileRow[], onProgress: (done: number, total: number, label: string) => void, signal?: AbortSignal,
): Promise<SheetScan[]> {
  const fileById = new Map(files.map((f) => [f.id, f]));
  const out: SheetScan[] = [];
  for (let i = 0; i < sheets.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const sheet = sheets[i];
    onProgress(i, sheets.length, sheet.number ?? `page ${sheet.page}`);
    try {
      const f = fileById.get(sheet.file_id);
      if (!f) throw new Error('drawing file missing');
      const pdf = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
      const page = await pdf.getPage(sheet.page);
      const { hits, zones } = await scanPage(page, pdfjs.OPS, sheet.number, sheet.exclusion_zones ?? null);
      page.cleanup();
      out.push({ sheet, hits, zones });
    } catch (e) {
      out.push({ sheet, hits: [], zones: [], error: e instanceof Error ? e.message : 'could not read this sheet' });
    }
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  onProgress(sheets.length, sheets.length, '');
  return out;
}

export interface CodeRow { code: string; kind: TagKind; total: number; bySheet: Map<string, number> }
const KIND_RANK: Record<TagKind, number> = { note: 0, tag: 1, short: 2, room: 3 };
export function discover(scans: SheetScan[]): CodeRow[] {
  const m = new Map<string, CodeRow & { rooms: number; real: number; notes: number }>();
  for (const sc of scans) {
    for (const h of sc.hits) {
      const r = m.get(h.code) ?? { code: h.code, kind: h.kind, total: 0, bySheet: new Map(), rooms: 0, real: 0, notes: 0 };
      r.total++;
      if (h.kind === 'room') r.rooms++;
      if (h.kind === 'tag') r.real++;
      if (h.kind === 'note') r.notes++;
      r.bySheet.set(sc.sheet.id, (r.bySheet.get(sc.sheet.id) ?? 0) + 1);
      m.set(h.code, r);
    }
  }
  // A code is a room number only if EVERY occurrence looks like one (EM2 is a fixture even if one hit sits under a room name).
  const rows = [...m.values()].map(({ rooms, real, notes, ...r }) => ({ ...r, kind: (notes > 0 && notes >= r.total - rooms ? 'note' : rooms === r.total ? 'room' : real > 0 ? 'tag' : 'short') as TagKind }));
  return rows.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.total - a.total || a.code.localeCompare(b.code));
}

/**
 * Writes the scan for one sheet. Re-running replaces earlier unreviewed auto results for every item found on the
 * sheet, never touches manual counts, and (with ignorePast) also removes earlier automatic counts that lie past a matchline.
 */
export async function writeSheet(
  scan: SheetScan, itemByCode: Map<string, ItemTypeRow>, include: Set<string>, opts: { ambiguous: Set<string>; clearItemIds: Set<string>; dropItemIds?: Set<string>; reset?: false | 'auto' | 'all'; ignorePast: boolean },
): Promise<{ added: number; removedPast: number; removedDropped: number; erased: number }> {
  const existing = await api<{ detections: Detection[] }>(`/sheets/${scan.sheet.id}/detections`);
  const itemIdByCode = new Map<string, string>();
  for (const c of include) { const it = itemByCode.get(c); if (it) itemIdByCode.set(c, it.id); }
  const plan = planSheetWrite({ hits: scan.hits, zones: scan.zones, existing: existing.detections, itemIdByCode, ambiguous: opts.ambiguous, clearItemIds: opts.clearItemIds, dropItemIds: opts.dropItemIds, reset: opts.reset ?? false, ignorePast: opts.ignorePast, newId: () => crypto.randomUUID() });
  for (let i = 0; i < plan.ops.length; i += BATCH_MAX_OPS) {
    await api(`/sheets/${scan.sheet.id}/detections/batch`, { body: { ops: plan.ops.slice(i, i + BATCH_MAX_OPS) } });
  }
  return { added: plan.added, removedPast: plan.removedPast, removedDropped: plan.removedDropped, erased: plan.erased };
}
