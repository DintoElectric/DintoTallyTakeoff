import type { ExportData } from '../../shared/types.ts';
import { floorLabel } from '../upload/titleBlock.ts';
import type { Agg } from './aggregate.ts';
import { countGroupOf, GROUP_LABEL, GROUPS } from '../../shared/countGroup.ts';
import { SYSTEMS, SYSTEM_LABEL, systemOf } from '../../shared/systems.ts';
import { breakerCounts, breakerLabel, circuitStats, sumBreakers } from '../../shared/panels.ts';
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
    const showFeet = agg.hasFeet; // linear fixtures: footage beside the count
    const header = ['Code', 'Description', 'Unit', ...sheetCols.map(sheetLabel), 'Total', ...(showFeet ? ['Length each (ft)', 'Total (ft)'] : []), ...(showUnrev ? ['Unreviewed'] : [])];
    const hr = ws.addRow(header);
    const hdrRowNo = hr.number;
    headerStyle(hr, 4);
    const nCols = header.length;
    // By system (Lighting with its controls, Power, Fire alarm, HVAC ...), each under its heading with its own total; no
    // headings when there is only one system.
    const sections = SYSTEMS.map((g) => [g, agg.rows.filter((r) => systemOf(r.item, data.categories) === g)] as const).filter(([, rows]) => rows.length > 0);
    for (const [g, rows] of sections) {
     if (sections.length > 1) {
      const h = ws.addRow([SYSTEM_LABEL[g]]);
      style(h, { bold: true });
      for (let c = 1; c <= nCols; c++) h.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FE' } };
     }
     for (const r of rows) {
      const row = ws.addRow([r.item.code, r.item.name + (r.item.spec ? `\n${r.item.spec}` : ''), r.item.unit,
        ...sheetCols.map((s) => r.bySheet.get(s.id) ?? ''), r.total, ...(showFeet ? [r.lengthFt ?? '', r.totalFeet ?? ''] : []), ...(showUnrev ? [r.unreviewed || ''] : [])]);
      style(row);
      row.alignment = { vertical: 'top', wrapText: true };
      row.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right', vertical: 'top' }; });
      if (showFeet) { const c0 = 4 + sheetCols.length + 1; row.getCell(c0).numFmt = '#,##0.0'; row.getCell(c0 + 1).numFmt = '#,##0.0'; } // Length each, Total (ft)
      if (showUnrev && r.unreviewed > 0) row.getCell(nCols).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FLAG_FILL } };
     }
     if (sections.length > 1) {
      // the system's total, per sheet and overall
      const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
      const st = ws.addRow(['', `${SYSTEM_LABEL[g]} total`, '', ...sheetCols.map((sh) => sum((r) => r.bySheet.get(sh.id) ?? 0)), sum((r) => r.total),
        ...(showFeet ? ['', sum((r) => r.totalFeet ?? 0) || ''] : []), ...(showUnrev ? [sum((r) => r.unreviewed) || ''] : [])]);
      style(st, { bold: true });
      st.eachCell((c: any, i: number) => { if (i >= 4) c.alignment = { horizontal: 'right' }; });
      if (showFeet) st.getCell(4 + sheetCols.length + 2).numFmt = '#,##0.0';
      ws.addRow([]);
     }
    }
    const lastItemRow = ws.lastRow.number;
    ws.addRow([]);
    const tot = ws.addRow(['', 'All items', '', ...sheetCols.map((s) => agg.bySheetTotal.get(s.id) ?? 0), agg.grandTotal, ...(showFeet ? ['', agg.totalFeet] : []), ...(showUnrev ? [agg.unreviewedTotal || ''] : [])]);
    style(tot, { bold: true, fill: TOTAL_FILL });
    if (showFeet) tot.getCell(4 + sheetCols.length + 2).numFmt = '#,##0.0';
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

  /* ---------- Panel Boards: the estimating template's layout (Panel Boards, Transformers, Disconnects) ---------- */
  const panels = data.panels ?? [];
  if (panels.length) {
    const ws = wb.addWorksheet(safeTab('Panel Boards'));
    const sheetNo = (id: string | null) => { const sh = data.sheets.find((x) => x.id === id); return sh ? sh.number ?? `Page ${sh.page}` : ''; };
    const widths: Record<string, number> = { A: 3, B: 3, C: 12, D: 10.9, E: 15.1, F: 16.9, G: 11, H: 12.3, I: 18, J: 9.3, K: 11.3, L: 16.4, M: 15.6, N: 16, O: 10.9, P: 14 };
    for (const [k, w] of Object.entries(widths)) ws.getColumn(k).width = w;
    const RED = 'FFDA9694';
    ws.mergeCells('C3:G5');
    ws.getCell('C3').value = `${data.project.name} · Panel boards · Prepared ${prepared}`;
    ws.getCell('C3').font = { bold: true, size: 13 }; ws.getCell('C3').alignment = { vertical: 'middle', wrapText: true };
    const band = (rowNo: number, text: string) => {
      ws.mergeCells(`C${rowNo}:P${rowNo}`);
      const c = ws.getCell(`C${rowNo}`); c.value = text; c.font = { bold: true, size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } }; c.alignment = { horizontal: 'center' };
    };
    const note = (rowNo: number, text: string) => { ws.mergeCells(`C${rowNo}:P${rowNo}`); const c = ws.getCell(`C${rowNo}`); c.value = text; c.font = { italic: true, size: 10 }; };
    const head = (rowNo: number, cells: string[]) => {
      cells.forEach((t, i) => { if (!t) return; const c = ws.getCell(rowNo, 3 + i); c.value = t; c.font = { bold: true, size: 9 }; c.alignment = { horizontal: 'center', wrapText: true }; c.border = { bottom: { style: 'thin' } }; });
    };
    const TAIL = ['Drawing Revision', 'Breakout Pricing', 'Alternate Pricing', 'Alternate #'];
    band(7, 'Panel Boards');
    head(8, ['LABEL', 'AMPERAGE', 'VOLTAGE', 'PHASE', 'KAIC', 'BUSS', 'ISO GROUND', 'CIRCUITS', 'MLO/MCB', ...TAIL, 'SCHEDULE SHEET']);
    let r = 9;
    for (const p of [...panels].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const st = circuitStats(p, p.circuits);
      const vals = [p.name, p.main_amps ?? p.bus_amps ?? '', p.voltage ?? '', p.phases ?? '', p.kaic ?? '', p.bus_amps ?? '',
        p.iso_ground == null ? '' : p.iso_ground ? 'Yes' : 'No', st.positions || '', p.main_type ?? '', '', '', '', '', sheetNo(p.sheet_id)];
      vals.forEach((v, i) => { const c = ws.getCell(r, 3 + i); c.value = v as never; c.font = { size: 10 }; c.alignment = { horizontal: i === 0 ? 'left' : 'center' }; });
      r++;
    }
    r++;
    note(r++, '***Confirm counts per drawings***');
    note(r++, '***Breakers per Panel schedules*** (see the Breakers tab)');
    note(r++, '***Spares/Attic Stock per Drawings and Specifications if applicable***');
    r++;
    band(r++, 'Transformers');
    head(r++, ['LABEL', 'KVA', 'INPUT VOLTAGE', 'OUTPUT VOLTAGE', 'NEMA TYPE', 'WINDINGS', 'MOUNTING', '', '', ...TAIL]);
    r += 2;
    note(r++, '***Confirm counts per drawings***');
    note(r++, '***Spares/Attic Stock per Drawings and Specifications if applicable***');
    r++;
    band(r++, 'DISCONNECTS');
    head(r++, ['LABEL', 'VOLTAGE', 'PHASE', 'AMPERAGE', 'NEMA TYPE', 'ISO GROUND', 'FUSED/NON FUSED', 'FUSE SIZE', 'SHUNT TRIP', ...TAIL]);
    r += 2;
    note(r++, '***Confirm counts per drawings***');
    note(r++, '***Spares/Attic Stock per Drawings and Specifications if applicable***');
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    /* ---------- Breakers: circuits per panel, breakers by panel and size, project totals ---------- */
    const wb2 = wb.addWorksheet(safeTab('Breakers'));
    title(wb2, data.project.name, `Panel circuits and breakers · Prepared ${prepared}`);
    const ch = wb2.addRow(['Panel', 'Circuits (positions)', 'Used', 'Spare', 'Space', 'Breakers']);
    headerStyle(ch, 2);
    for (const p of [...panels].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const st = circuitStats(p, p.circuits);
      const row = wb2.addRow([p.name, st.positions || '', st.used, st.spare, st.space, st.breakers]); style(row);
      row.eachCell((c: any, i: number) => { if (i >= 2) c.alignment = { horizontal: 'right' }; });
    }
    wb2.addRow([]);
    const bh = wb2.addRow(['Panel', 'Breaker', 'Amps', 'Poles', 'Quantity', 'Of which spare']);
    headerStyle(bh, 3);
    for (const p of [...panels].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      for (const b of breakerCounts(p.circuits)) {
        const row = wb2.addRow([p.name, breakerLabel(b.amps, b.poles), b.amps, b.poles, b.qty, b.spares || '']); style(row);
        row.eachCell((c: any, i: number) => { if (i >= 3) c.alignment = { horizontal: 'right' }; });
      }
    }
    wb2.addRow([]);
    const th = wb2.addRow(['All panels', 'Breaker', 'Amps', 'Poles', 'Quantity', 'Of which spare']);
    headerStyle(th, 3);
    const all = sumBreakers(panels.map((p) => breakerCounts(p.circuits)));
    for (const b of all) {
      const row = wb2.addRow(['', breakerLabel(b.amps, b.poles), b.amps, b.poles, b.qty, b.spares || '']); style(row);
      row.eachCell((c: any, i: number) => { if (i >= 3) c.alignment = { horizontal: 'right' }; });
    }
    const tot = wb2.addRow(['', 'All breakers', '', '', all.reduce((n, b) => n + b.qty, 0), all.reduce((n, b) => n + b.spares, 0) || '']);
    style(tot, { bold: true, fill: TOTAL_FILL });
    wb2.addRow([]);
    wb2.addRow(['A spare is a breaker with nothing on it yet and is counted; a space is an empty position and is not. Each breaker counts once, whatever its poles.']);
    style(wb2.lastRow, { color: MUTED });
    wb2.getColumn(1).width = 16; wb2.getColumn(2).width = 18; for (let i = 3; i <= 6; i++) wb2.getColumn(i).width = 14;
  }

  /* ---------- by ceiling type ---------- */
  if (agg.hasCeilings) {
    const ws = wb.addWorksheet(safeTab('Ceiling types'));
    title(ws, data.project.name, `Counts by the ceiling they sit in · Prepared ${prepared}`);
    const header = ['Code', 'Description', 'Unit', 'Drop ceiling', 'Sheetrock', 'Open', 'Not read', 'Total'];
    const hr = ws.addRow(header);
    headerStyle(hr, 4);
    const hdrNo = hr.number;
    const sum = { drop: 0, sheetrock: 0, open: 0, none: 0, total: 0 };
    for (const r of agg.rows) {
      const c = r.byCeiling;
      const n = c.drop + c.sheetrock + c.open + c.none;   // the row adds up across the ceiling columns
      if (n === 0) continue;
      const row = ws.addRow([r.item.code, r.item.name, r.item.unit, c.drop || '', c.sheetrock || '', c.open || '', c.none || '', n]);
      style(row);
      row.eachCell((cell: any, i: number) => { if (i >= 4) cell.alignment = { horizontal: 'right' }; });
      sum.drop += c.drop; sum.sheetrock += c.sheetrock; sum.open += c.open; sum.none += c.none; sum.total += n;
    }
    const last = ws.lastRow.number;
    ws.addRow([]);
    const tot = ws.addRow(['', 'All items', '', sum.drop, sum.sheetrock, sum.open, sum.none, sum.total]);
    style(tot, { bold: true, fill: TOTAL_FILL });
    tot.eachCell((cell: any, i: number) => { if (i >= 4) cell.alignment = { horizontal: 'right' }; });
    ws.addRow([]);
    ws.addRow(['Read from the ceiling plan: a grid is a drop ceiling, a speckle of dashes is sheetrock, neither is open. "Not read": the count was made before ceilings were read, or its sheet shows no ceiling textures.']);
    style(ws.lastRow, { color: MUTED });
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 42; ws.getColumn(3).width = 8;
    for (let i = 4; i <= header.length; i++) ws.getColumn(i).width = 13;
    setup(ws, hdrNo, header.length, last);
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
    const CEIL: Record<string, string> = { drop: 'Drop ceiling', sheetrock: 'Sheetrock', open: 'Open' };
    const hr = ws.addRow(['Sheet', 'Item code', 'Item', 'X (pt)', 'Y (pt)', 'Confidence', 'Status', 'Source', 'Confirmed by', ...(agg.hasCeilings ? ['Ceiling'] : [])]);
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
        d.confidence ?? '', d.status === 'unreviewed' ? 'Unreviewed' : 'Confirmed', d.source === 'auto' ? 'Auto' : 'Manual', d.confirmed_by_name ?? '', ...(agg.hasCeilings ? [d.ceiling ? CEIL[d.ceiling] : ''] : [])]);
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

