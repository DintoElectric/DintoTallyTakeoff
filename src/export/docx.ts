import type { ExportData, SheetRow } from '../../shared/types.ts';
import { floorLabel } from '../upload/titleBlock.ts';
import type { Agg } from './aggregate.ts';
import type { ExportOptions } from './types.ts';

const INK = '292B31';      // neutral-900 ink
const PAPER = 'F3F5FE';    // neutral-100 paper
const HEAD = 'E4E7F5';
const TOTAL = 'D2CEFD';
const MUTED = '75798C';
const FONT = 'Calibri';

export interface SnapshotResult { png: Uint8Array; width: number; height: number }

export async function buildDocx(
  data: ExportData, agg: Agg, opts: ExportOptions,
  getSnapshot?: (sheet: SheetRow) => Promise<SnapshotResult | null>,
  onProgress?: (text: string) => void,
): Promise<Blob> {
  const d = await import('docx'); // loaded only when someone exports
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, BorderStyle, ImageRun, PageOrientation, PageBreak } = d;

  const run = (text: string, o: { bold?: boolean; size?: number; color?: string; caps?: boolean } = {}) =>
    new TextRun({ text, font: FONT, bold: o.bold, size: o.size ?? 20, color: o.color ?? INK, allCaps: o.caps });
  const para = (text: string, o: { bold?: boolean; size?: number; color?: string; caps?: boolean; after?: number; before?: number } = {}) =>
    new Paragraph({ children: [run(text, o)], spacing: { after: o.after ?? 80, before: o.before ?? 0 } });

  const thin = { style: BorderStyle.SINGLE, size: 4, color: 'CFD3E5' };
  const borders = { top: thin, bottom: thin, left: thin, right: thin };
  const cell = (text: string, o: { bold?: boolean; right?: boolean; fill?: string; color?: string } = {}) =>
    new TableCell({
      borders,
      shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
      margins: { top: 50, bottom: 50, left: 90, right: 90 },
      children: [new Paragraph({ alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [run(text, { bold: o.bold, size: 18, color: o.color })] })],
    });
  const table = (header: string[], rows: { cells: string[]; total?: boolean }[], rightFrom: number) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, { bold: true, fill: HEAD, right: i >= rightFrom })) }),
        ...rows.map((r) => new TableRow({ children: r.cells.map((c, i) => cell(c, { bold: r.total, fill: r.total ? TOTAL : undefined, right: i >= rightFrom })) })),
      ],
    });

  const label = (s: SheetRow) => s.number ?? `p${s.page}`;
  const prepared = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const kids: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  /* header block */
  kids.push(para('Electrical takeoff · Fixture & device counts', { size: 18, color: MUTED, caps: true, after: 40 }));
  kids.push(para(data.project.name, { bold: true, size: 52, after: 60 }));
  const meta = [`${agg.sheets.length} counted sheet${agg.sheets.length === 1 ? '' : 's'}`, `Prepared ${prepared}`, opts.preparedBy ? `by ${opts.preparedBy}` : ''].filter(Boolean).join(' · ');
  kids.push(para(meta, { size: 20, color: MUTED, after: 240 }));

  /* item table: by floor */
  kids.push(para('Counts by item', { bold: true, size: 28, after: 100 }));
  const floorCols = agg.floors;
  kids.push(table(
    ['Code', 'Description', ...floorCols.map((f) => (f.floor ? floorLabel(f.floor) : 'No floor')), 'Total'],
    [
      ...agg.rows.map((r) => ({
        cells: [r.item.code, r.item.name + (r.item.spec ? ` (${r.item.spec})` : ''),
          ...floorCols.map((f) => { const n = f.rows.find((x) => x.item.id === r.item.id)?.total; return n ? String(n) : '–'; }), String(r.total)],
      })),
      { cells: ['', 'All items', ...floorCols.map((f) => String(f.total)), String(agg.grandTotal)], total: true },
    ],
    2,
  ));

  /* per-floor tables: by sheet (areas are not captured yet) */
  const cats = [...new Set(agg.rows.map((r) => r.item.category_id))].sort((a, b) => agg.categoryOrder(a) - agg.categoryOrder(b));
  for (const f of agg.floors) {
    kids.push(para(`${f.floor ? floorLabel(f.floor) : 'No floor set'} · by sheet`, { bold: true, size: 24, before: 280, after: 100 }));
    const catTotal = (sheetId: string, cat: string | null) => agg.rows.filter((r) => r.item.category_id === cat).reduce((s, r) => s + (r.bySheet.get(sheetId) ?? 0), 0);
    const rows = f.sheets.map((s) => ({ cells: [`${label(s)}${s.title ? ` — ${s.title}` : ''}`, ...cats.map((c) => String(catTotal(s.id, c) || '–')), String(agg.bySheetTotal.get(s.id) ?? 0)] }));
    rows.push({ cells: ['Floor total', ...cats.map((c) => String(f.sheets.reduce((n, s) => n + catTotal(s.id, c), 0) || '–')), String(f.total)], total: true } as never);
    kids.push(table(['Sheet', ...cats.map((c) => agg.categoryName(c)), 'Total'], rows as { cells: string[]; total?: boolean }[], 1));
  }

  /* marked-up sheet snapshots */
  if (opts.snapshots && getSnapshot) {
    let i = 0;
    const withCounts = agg.sheets.filter((s) => (agg.bySheetTotal.get(s.id) ?? 0) > 0);
    for (const s of withCounts) {
      i++;
      onProgress?.(`Drawing sheet ${i} of ${withCounts.length}…`);
      let snap: SnapshotResult | null = null;
      try { snap = await getSnapshot(s); } catch { snap = null; }
      kids.push(new Paragraph({ children: [new PageBreak()] }));
      kids.push(para(`${label(s)}${s.title ? ` — ${s.title}` : ''}`, { bold: true, size: 24, after: 100 }));
      if (snap) {
        const k = Math.min(880 / snap.width, 520 / snap.height);
        kids.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: snap.png, transformation: { width: Math.round(snap.width * k), height: Math.round(snap.height * k) } })] }));
      } else {
        kids.push(para("This sheet couldn't be drawn for the report.", { color: MUTED }));
      }
    }
  }

  /* appendix: unreviewed items */
  if (agg.unreviewedTotal > 0) {
    const itemById = new Map(data.items.map((i) => [i.id, i]));
    kids.push(new Paragraph({ children: [new PageBreak()] }));
    kids.push(para('Appendix: unreviewed items', { bold: true, size: 28, after: 100 }));
    kids.push(para(`${agg.unreviewedTotal} counted detection${agg.unreviewedTotal === 1 ? ' has' : 's have'} not been reviewed. They are included in the totals above.`, { color: MUTED, after: 120 }));
    for (const s of agg.sheets) {
      const n = agg.unreviewedBySheet.get(s.id);
      if (!n) continue;
      const per = new Map<string, number>();
      for (const det of data.detections) if (det.sheet_id === s.id && det.status === 'unreviewed') per.set(det.item_type_id, (per.get(det.item_type_id) ?? 0) + 1);
      const text = [...per].map(([id, c]) => `${itemById.get(id)?.code ?? '?'} ×${c}`).join(', ');
      kids.push(para(`${label(s)}: ${n} unreviewed (${text})`, { after: 60 }));
    }
  } else {
    kids.push(para('All counted detections have been reviewed.', { size: 18, color: MUTED, before: 240 }));
  }

  const doc = new Document({
    creator: opts.preparedBy || 'Tally',
    title: `${data.project.name} · Fixture & device counts`,
    background: { color: PAPER },
    styles: { default: { document: { run: { font: FONT, color: INK, size: 20 } } } },
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children: kids }],
  });
  return Packer.toBlob(doc);
}
