// Auto-count: scan sheets for fixture/device tags, then write the matches as unreviewed detections.
import type { GridBubble } from './gridBubbles.ts';
import type { Detection, DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { BATCH_MAX_OPS } from '../../shared/limits.ts';
import { api } from '../auth/api.ts';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';
import type { Zone } from '../../shared/zones.ts';
import { scanPage } from './scanPage.ts';
import { measureSheet } from './measureSheet.ts';
import { planSheetWrite } from './writePlan.ts';
export { CONF_AMBIGUOUS, CONF_EMERGENCY, CONF_NORMAL_SPLIT, CONF_ROOMISH, CONF_SHORT, CONF_TAG } from './writePlan.ts';
import type { TagHit, TagKind } from './tagScan.ts';


export interface SheetScan { sheet: SheetRow; hits: TagHit[]; zones: Zone[]; bubbles?: GridBubble[]; error?: string }

export async function scanSheets(
  sheets: SheetRow[], files: DrawingFileRow[], onProgress: (done: number, total: number, label: string) => void, signal?: AbortSignal, knownCodes?: Set<string>,
  measure?: { measured: Set<string>; known: Map<string, number> },   // fixtures to measure on the plans, and the stated lengths of the others
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
      const { hits, zones, bubbles, runs } = await scanPage(page, pdfjs.OPS, sheet.number, sheet.exclusion_zones ?? null, knownCodes);
      if (measure && measure.measured.size) {
        try { await measureSheet(page, pdfjs.OPS, runs, hits, zones, measure.measured, measure.known); }
        catch (e) { console.warn('Measuring fixtures failed for a sheet; they are counted without lengths', e); }
      }
      page.cleanup();
      out.push({ sheet, hits, zones, bubbles });
    } catch (e) {
      out.push({ sheet, hits: [], zones: [], error: e instanceof Error ? e.message : 'could not read this sheet' });
    }
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  onProgress(sheets.length, sheets.length, '');
  return out;
}

export { discover, type CodeRow } from './codeRows.ts';
import { type CodeRow } from './codeRows.ts';

/**
 * Writes the scan for one sheet. Re-running replaces earlier unreviewed auto results for every item found on the
 * sheet, never touches manual counts, and (with ignorePast) also removes earlier automatic counts that lie past a matchline.
 */
export async function writeSheet(
  scan: SheetScan, itemByCode: Map<string, ItemTypeRow>, include: Set<string>, opts: { ambiguous: Set<string>; clearItemIds: Set<string>; dropItemIds?: Set<string>; reset?: false | 'auto' | 'all'; ignorePast: boolean; leaveOutGrid?: boolean },
): Promise<{ added: number; removedPast: number; removedDropped: number; removedGrid: number; erased: number }> {
  const existing = await api<{ detections: Detection[] }>(`/sheets/${scan.sheet.id}/detections`);
  const itemIdByCode = new Map<string, string>();
  for (const c of include) { const it = itemByCode.get(c); if (it) itemIdByCode.set(c, it.id); }
  const plan = planSheetWrite({ hits: scan.hits, zones: scan.zones, existing: existing.detections, itemIdByCode, ambiguous: opts.ambiguous, clearItemIds: opts.clearItemIds, dropItemIds: opts.dropItemIds, reset: opts.reset ?? false, ignorePast: opts.ignorePast, leaveOutGrid: opts.leaveOutGrid === true, bubbles: scan.bubbles ?? [], newId: () => crypto.randomUUID() });
  for (let i = 0; i < plan.ops.length; i += BATCH_MAX_OPS) {
    await api(`/sheets/${scan.sheet.id}/detections/batch`, { body: { ops: plan.ops.slice(i, i + BATCH_MAX_OPS) } });
  }
  return { added: plan.added, removedPast: plan.removedPast, removedDropped: plan.removedDropped, removedGrid: plan.removedGrid, erased: plan.erased };
}
