import type { ExportData } from '../../shared/types.ts';
import { floorLabel } from '../upload/titleBlock.ts';
import type { Agg } from './aggregate.ts';
import type { ExportOptions } from './types.ts';

const INK = 'FF292B31';
const HEAD_FILL = 'FFE4E7F5'; // neutral-200
const TOTAL_FILL = 'FFD2CEFD'; // accent-300, the highlighted "All items" row
const FLAG_FILL = 'FFE7E5FE'; // accent-200, unreviewed marker
const MUTED = 'FF75798C';

const sheetLabel = (s: { floor: string | null; number: string | null; page: number }) => `${floorLabel(s.floor)} · ${s.number ?? `p${s.page}`}`;
const safeTab = (n: string) => n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

export async function buildXlsx(data: ExportData, agg: Agg, opts: ExportOptions): Promise<Blob> {
  const mod: any = await import('exceljs'); // loaded only when someone exports
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = opts.preparedBy || 'Tally';
  wb.created = new Date();

  const prepared = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const style = (row: any, o: { bold?: boolean; fill?: string; color?: string; size?: number } = {}) => {
    row.font = { name: 'Calibri', bold: !!o.bold, color: { argb: o.color ?? INK }, size: o.size ?? 11 };
    if (o.fill) row.eachCell({ includeEmpty: true }, (c: any) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } }; });
  };
  const setup = (ws: any, headerRow: number, lastCol: number, filterTo?: number) => {
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}` };
    if (filterTo && filterTo > headerRow) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: filterTo, column: lastCol } };
  };
  const headerStyle = (row: any, rightFrom = 0) => {
    style(row, { bold: true, fill: HEAD_FILL });
    row.alignment = { vertical: 'middle', wrapText: true };
    row.eachCell((c: any, i: number) => { if (rightFrom && i >= rightFrom) c.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }; });
    row.height = 32;
  };
  const title = (ws: any, text: string, sub: string) => {
    ws.addRow([text]); style(ws.lastRow, { bold: true, size: 15 });
    ws.addRow([sub]); style(ws.lastRow, { color: MUTED });
    ws.addRow([]);
  };

  /* ---------- Summary: item x sheet ---------- */
  {
    const ws = wb.addWorksheet(safeTab('Summary'));
    const sheetCols = opts.perSheetColumns ? agg.sheets : [];
    const showUnrev = agg.unreviewedTotal > 0;
    title(ws, data.project.name, `Electrical takeoff · Fixture & device counts · Prepared ${prepared}`);
    const header = ['Code', 'Description', 'Unit', ...sheetCols.map(sheetLabel), 'Total', ...(showUnrev ? ['Unreviewed'] : [])];
    const hr = ws.addRow(header);
    const hdrRowNo = hr.number;
    headerStyle(hr, 4);
    const nCols = header.length;
    for (const r of agg.rows) {
      const row = ws.addRow([r.item.code, r.item.name + (r.item.spec ? `\n${r.item.spec}` : ''), r.item.unit,
        ...sheetCols.map((s) => r.bySheet.get(s.id) ?? ''), r.total, ...(showUnrev ? [r.unreviewed || ''] : [])]);
      style(row);
      row.alignment = { vertical: 'top', wrapText: true };
      row.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right', vertical: 'top' }; });
      if (showUnrev && r.unreviewed > 0) row.getCell(nCols).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FLAG_FILL } };
    }
    const lastItemRow = ws.lastRow.number;
    ws.addRow([]);
    const tot = ws.addRow(['', 'All items', '', ...sheetCols.map((s) => agg.bySheetTotal.get(s.id) ?? 0), agg.grandTotal, ...(showUnrev ? [agg.unreviewedTotal || ''] : [])]);
    style(tot, { bold: true, fill: TOTAL_FILL });
    tot.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right' }; });
    if (showUnrev) {
      ws.addRow([]);
      for (const s of agg.sheets) {
        const n = agg.unreviewedBySheet.get(s.id);
        if (n) { ws.addRow([`⚠ ${n} unreviewed detection${n === 1 ? '' : 's'} on ${s.number ?? `page ${s.page}`} are included in these counts.`]); style(ws.lastRow, { color: MUTED }); }
      }
    }
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 42; ws.getColumn(3).width = 8;
    for (let i = 4; i <= nCols; i++) ws.getColumn(i).width = 13;
    setup(ws, hdrRowNo, nCols, lastItemRow);
  }

  /* ---------- grouped tab ---------- */
  {
    const name = opts.groupBy === 'floor' ? 'By floor and area' : opts.groupBy === 'item' ? 'By item' : 'By sheet';
    const ws = wb.addWorksheet(safeTab(name)); // Excel forbids \ / ? * [ ] : in tab names
    title(ws, data.project.name, `${name} · Prepared ${prepared}`);
    const hdr = opts.groupBy === 'item' ? ['Item', 'Description', 'Sheet', 'Count'] : opts.groupBy === 'sheet' ? ['Sheet', 'Code', 'Description', 'Count'] : ['Floor', 'Code', 'Description', 'Count'];
    const hr = ws.addRow(hdr);
    headerStyle(hr, 4);
    const hdrNo = hr.number;
    const group = (label: string) => { const r = ws.addRow([label]); style(r, { bold: true, fill: 'FFF3F5FE' }); r.eachCell({ includeEmpty: true }, (c: any) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FE' } }; }); };
    const line = (cells: (string | number)[]) => { const r = ws.addRow(cells); style(r); r.getCell(4).alignment = { horizontal: 'right' }; };
    const sub = (label: string, n: number) => { if (!opts.subtotals) return; const r = ws.addRow(['', '', label, n]); style(r, { bold: true }); r.getCell(4).alignment = { horizontal: 'right' }; };

    if (opts.groupBy === 'floor') {
      for (const f of agg.floors) {
        const label = f.floor ? (floorLabel(f.floor)) : 'No floor set';
        group(f.floor && /^\d+$/.test(f.floor) ? `${label} (Level ${f.floor})` : label);
        for (const r of f.rows) line(['', r.item.code, r.item.name, r.total]);
        sub(`Subtotal ${label}`, f.total);
      }
    } else if (opts.groupBy === 'item') {
      for (const r of agg.rows) {
        group(`${r.item.code} · ${r.item.name}`);
        for (const s of agg.sheets) { const n = r.bySheet.get(s.id); if (n) line([r.item.code, r.item.name, sheetLabel(s), n]); }
        sub(`Subtotal ${r.item.code}`, r.total);
      }
    } else {
      for (const s of agg.sheets) {
        group(`${sheetLabel(s)}${s.title ? ` — ${s.title}` : ''}`);
        for (const r of agg.rows) { const n = r.bySheet.get(s.id); if (n) line(['', r.item.code, r.item.name, n]); }
        sub(`Subtotal ${s.number ?? `page ${s.page}`}`, agg.bySheetTotal.get(s.id) ?? 0);
      }
    }
    ws.addRow([]);
    const t = ws.addRow(['', '', 'All items', agg.grandTotal]);
    style(t, { bold: true, fill: TOTAL_FILL });
    t.getCell(4).alignment = { horizontal: 'right' };
    ws.getColumn(1).width = 28; ws.getColumn(2).width = 14; ws.getColumn(3).width = 44; ws.getColumn(4).width = 10;
    setup(ws, hdrNo, 4);
  }

  /* ---------- by named area ---------- */
  if (agg.areas.names.length > 0) {
    const ws = wb.addWorksheet(safeTab('By area'));
    title(ws, data.project.name, `Counts by named area · Prepared ${prepared}`);
    const header = ['Code', 'Description', 'Unit', ...agg.areas.names, 'Not in any area', 'Total'];
    const hr = ws.addRow(header);
    headerStyle(hr, 4);
    const hdrNo = hr.number;
    for (const r of agg.areas.rows) {
      const row = ws.addRow([r.item.code, r.item.name, r.item.unit, ...agg.areas.names.map((n) => r.byArea.get(n) ?? ''), r.unassigned || '', r.total]);
      style(row);
      row.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right' }; });
    }
    const last = ws.lastRow.number;
    ws.addRow([]);
    const tot = ws.addRow(['', 'All items', '', ...agg.areas.names.map((n) => agg.areas.totals.byArea.get(n) ?? 0), agg.areas.totals.unassigned, agg.areas.totals.total]);
    style(tot, { bold: true, fill: TOTAL_FILL });
    tot.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right' }; });
    ws.addRow([]);
    ws.addRow(['Areas with the same name are one area: their counts are added together. A count inside two differently named areas appears under both, so the area columns can add up to more than Total.']);
    style(ws.lastRow, { color: MUTED });
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 42; ws.getColumn(3).width = 8;
    for (let i = 4; i <= header.length; i++) ws.getColumn(i).width = 14;
    setup(ws, hdrNo, header.length, last);
  }

  /* ---------- detections log ---------- */
  if (opts.detectionLog) {
    const ws = wb.addWorksheet(safeTab('Detections log'));
    title(ws, data.project.name, `One row per detection · Prepared ${prepared}`);
    const hr = ws.addRow(['Sheet', 'Item code', 'Item', 'X (pt)', 'Y (pt)', 'Confidence', 'Status', 'Source', 'Confirmed by']);
    headerStyle(hr, 4);
    const hdrNo = hr.number;
    const itemById = new Map(data.items.map((i) => [i.id, i]));
    const shMap = new Map(agg.sheets.map((s) => [s.id, s]));
    let last = hdrNo;
    for (const d of data.detections) {
      const s = shMap.get(d.sheet_id);
      const it = itemById.get(d.item_type_id);
      if (!s || !it) continue;
      const row = ws.addRow([s.number ?? `p${s.page}`, it.code, it.name, Math.round(d.x * s.page_width_pt * 10) / 10, Math.round(d.y * s.page_height_pt * 10) / 10,
        d.confidence ?? '', d.status === 'unreviewed' ? 'Unreviewed' : 'Confirmed', d.source === 'auto' ? 'Auto' : 'Manual', d.confirmed_by_name ?? '']);
      style(row);
      if (d.confidence !== null) row.getCell(6).numFmt = '0%';
      if (d.status === 'unreviewed') row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FLAG_FILL } };
      last = row.number;
    }
    [10, 11, 36, 10, 10, 12, 13, 10, 24].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    setup(ws, hdrNo, 9, last);
  }

  const buf: ArrayBuffer = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

