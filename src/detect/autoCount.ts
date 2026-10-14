// Auto-count: scan sheets for fixture/device tags, then write the matches as unreviewed detections.
import type { Detection, DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { BATCH_MAX_OPS } from '../../shared/limits.ts';
import { api } from '../auth/api.ts';
import { loadFilePdf } from '../viewer/pdf.ts';
import { extractRuns } from './pageRuns.ts';
import { scanTags, type TagHit, type TagKind } from './tagScan.ts';

export const CONF_TAG = 0.98;   // exact tag text: not flagged
export const CONF_SHORT = 0.7;  // short letter-only codes: always flagged for review

export interface SheetScan { sheet: SheetRow; hits: TagHit[]; error?: string }

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
      const hits = scanTags(await extractRuns(page));
      page.cleanup();
      out.push({ sheet, hits });
    } catch (e) {
      out.push({ sheet, hits: [], error: e instanceof Error ? e.message : 'could not read this sheet' });
    }
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }
  onProgress(sheets.length, sheets.length, '');
  return out;
}

export interface CodeRow { code: string; kind: TagKind; total: number; bySheet: Map<string, number> }
export function discover(scans: SheetScan[]): CodeRow[] {
  const m = new Map<string, CodeRow>();
  for (const sc of scans) {
    for (const h of sc.hits) {
      const r = m.get(h.code) ?? { code: h.code, kind: h.kind, total: 0, bySheet: new Map() };
      r.total++;
      r.bySheet.set(sc.sheet.id, (r.bySheet.get(sc.sheet.id) ?? 0) + 1);
      m.set(h.code, r);
    }
  }
  return [...m.values()].sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind === 'tag' ? -1 : 1) || a.code.localeCompare(b.code));
}

const NEAR = 0.004; // existing confirmed counts within this distance block a duplicate

/**
 * Writes the scan for one sheet. Re-running replaces earlier unreviewed auto results for the same items,
 * and never touches manual or confirmed counts (a hit next to one of those is skipped, not doubled).
 */
export async function writeSheet(scan: SheetScan, itemByCode: Map<string, ItemTypeRow>, include: Set<string>): Promise<number> {
  const mine = scan.hits.filter((h) => include.has(h.code) && itemByCode.has(h.code));
  const items = new Set(mine.map((h) => itemByCode.get(h.code)!.id));
  const existing = await api<{ detections: Detection[] }>(`/sheets/${scan.sheet.id}/detections`);
  const ops: unknown[] = [];
  const keep: Detection[] = [];
  for (const d of existing.detections) {
    if (items.has(d.item_type_id) && d.source === 'auto' && d.status === 'unreviewed') ops.push({ op: 'delete', id: d.id });
    else if (items.has(d.item_type_id)) keep.push(d);
  }
  let added = 0;
  for (const h of mine) {
    const item = itemByCode.get(h.code)!;
    if (keep.some((d) => d.item_type_id === item.id && Math.abs(d.x - h.x) < NEAR * 3 && Math.abs(d.y - h.y) < NEAR * 3)) continue;
    ops.push({ op: 'add', detection: {
      id: crypto.randomUUID(), item_type_id: item.id, x: Math.min(1, Math.max(0, h.x)), y: Math.min(1, Math.max(0, h.y)),
      bbox: null, confidence: h.kind === 'tag' ? CONF_TAG : CONF_SHORT, source: 'auto', status: 'unreviewed',
    } });
    added++;
  }
  for (let i = 0; i < ops.length; i += BATCH_MAX_OPS) {
    await api(`/sheets/${scan.sheet.id}/detections/batch`, { body: { ops: ops.slice(i, i + BATCH_MAX_OPS) } });
  }
  return added;
}
