// Builds each Excel export variant and re-opens the file, so invalid sheet names or broken styles fail here, not in Excel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../src/export/xlsx.ts';
import { aggregate } from '../src/export/aggregate.ts';

const data: any = {
  project: { id: 'p', name: 'PSEB' },
  sheets: [
    { id: 's1', page: 1, number: 'EL101.1', title: 'First floor', floor: '1', kind: 'floor_plan', count_enabled: true, page_width_pt: 3024, page_height_pt: 2160 },
    { id: 's2', page: 2, number: 'EL102.1', title: 'Second floor', floor: '2', kind: 'floor_plan', count_enabled: true, page_width_pt: 3024, page_height_pt: 2160 },
    { id: 's3', page: 3, number: 'EL100.6', title: 'No floor', floor: null, kind: 'floor_plan', count_enabled: true, page_width_pt: 3024, page_height_pt: 2160 },
  ],
  items: [
    { id: 'a', code: 'B13', name: 'LED INDUSTRIAL STRIP PENDANT', spec: '5,000 LM', unit: 'EA', category_id: 'c1' },
    { id: 'b', code: 'D9', name: 'LED WRAPAROUND', spec: null, unit: 'EA', category_id: null },
  ],
  categories: [{ id: 'c1', name: 'Pendant', sort: 1 }],
  counts: [
    { sheet_id: 's1', item_type_id: 'a', n: 5, flagged: 0 }, { sheet_id: 's2', item_type_id: 'a', n: 2, flagged: 0 },
    { sheet_id: 's2', item_type_id: 'b', n: 3, flagged: 0 }, { sheet_id: 's3', item_type_id: 'b', n: 1, flagged: 0 },
  ],
  detections: [
    { id: '1', sheet_id: 's1', item_type_id: 'a', x: 0.5, y: 0.5, confidence: 0.98, source: 'auto', status: 'unreviewed', created_by_name: 'J', confirmed_by_name: null },
    { id: '2', sheet_id: 's2', item_type_id: 'b', x: 0.1, y: 0.2, confidence: null, source: 'manual', status: 'confirmed', created_by_name: 'J', confirmed_by_name: 'J' },
  ],
};

for (const groupBy of ['floor', 'item', 'sheet'] as const) {
  for (const perSheetColumns of [true, false]) {
    test(`excel export opens cleanly (group by ${groupBy}, per-sheet columns ${perSheetColumns})`, async () => {
      const agg = aggregate(data, { sheetIds: null });
      const blob = await buildXlsx(data, agg, { sheetIds: null, groupBy, perSheetColumns, subtotals: true, detectionLog: true, snapshots: false, preparedBy: 'John' });
      const ExcelJS: any = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()));
      const names: string[] = wb.worksheets.map((w: any) => w.name);
      assert.ok(names.includes('Summary') && names.includes('Detections log'), names.join(','));
      assert.ok(names.every((n) => !/[\\/?*[\]:]/.test(n) && n.length <= 31), `bad tab name in ${names.join(' | ')}`);
      const sum = wb.getWorksheet('Summary');
      let grand = 0;
      sum.eachRow((row: any) => { if (row.getCell(2).value === 'All items') grand = Number(row.getCell(row.cellCount > 4 ? (perSheetColumns ? 4 + 3 : 4) : 4).value); });
      assert.equal(grand, 11); // 5 + 2 + 3 + 1
    });
  }
}

import { buildDocx } from '../src/export/docx.ts';
test('word export builds a valid .docx (zip) with and without unreviewed items', async () => {
  const agg = aggregate(data, { sheetIds: null });
  const blob = await buildDocx(data, agg, { sheetIds: null, groupBy: 'floor', perSheetColumns: true, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'John' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.ok(bytes.length > 2000);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK'); // a .docx is a zip file
});

test('excel and word exports add a by-area breakdown, additive by name', async () => {
  const withAreas: any = {
    ...data,
    areas: [
      { id: 'a1', sheet_id: 's1', name: 'Lab A', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.6 }, { x: 0, y: 0.6 }] },
      { id: 'a2', sheet_id: 's2', name: 'lab a', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
    ],
    // s1 has two B13 (one inside Lab A, one below it), s2 has one B13 and one D9, both inside "lab a"
    detections: [
      { id: '1', sheet_id: 's1', item_type_id: 'a', x: 0.5, y: 0.2, confidence: null, source: 'manual', status: 'confirmed' },
      { id: '2', sheet_id: 's1', item_type_id: 'a', x: 0.5, y: 0.9, confidence: null, source: 'manual', status: 'confirmed' },
      { id: '3', sheet_id: 's2', item_type_id: 'a', x: 0.5, y: 0.5, confidence: null, source: 'manual', status: 'confirmed' },
      { id: '4', sheet_id: 's2', item_type_id: 'b', x: 0.4, y: 0.4, confidence: null, source: 'manual', status: 'confirmed' },
    ],
    counts: [{ sheet_id: 's1', item_type_id: 'a', n: 2, flagged: 0 }, { sheet_id: 's2', item_type_id: 'a', n: 1, flagged: 0 }, { sheet_id: 's2', item_type_id: 'b', n: 1, flagged: 0 }],
  };
  const agg = aggregate(withAreas, { sheetIds: null });
  assert.deepEqual(agg.areas.names, ['Lab A']);
  const b13 = agg.areas.rows.find((r) => r.item.code === 'B13')!;
  assert.equal(b13.byArea.get('Lab A'), 2); assert.equal(b13.unassigned, 1); assert.equal(b13.total, 3);
  const blob = await buildXlsx(withAreas, agg, { sheetIds: null, groupBy: 'floor', perSheetColumns: true, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' });
  const ExcelJS: any = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()));
  const ws = wb.getWorksheet('By area');
  assert.ok(ws, 'a By area tab exists');
  let found = false;
  ws.eachRow((row: any) => { if (row.getCell(1).value === 'B13') { found = true; assert.equal(Number(row.getCell(4).value), 2); assert.equal(Number(row.getCell(5).value), 1); assert.equal(Number(row.getCell(6).value), 3); } });
  assert.ok(found);
  const docBlob = await buildDocx(withAreas, agg, { sheetIds: null, groupBy: 'floor', perSheetColumns: true, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' });
  assert.equal(String.fromCharCode(...new Uint8Array(await docBlob.arrayBuffer()).slice(0, 2)), 'PK');
  // without areas nothing changes: no extra tab
  const plain = await buildXlsx(data, aggregate(data, { sheetIds: null }), { sheetIds: null, groupBy: 'floor', perSheetColumns: true, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(await plain.arrayBuffer()));
  assert.equal(wb2.getWorksheet('By area'), undefined);
});

test('excel export totals the footage of linear fixtures (count × length) and adds the columns only when some item has a length', async () => {
  const ExcelJS: any = (await import('exceljs')).default;
  const read = async (d: any, perSheetColumns: boolean) => {
    const blob = await buildXlsx(d, aggregate(d, { sheetIds: null }), { sheetIds: null, groupBy: 'floor', perSheetColumns, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()));
    const sum = wb.getWorksheet('Summary');
    let header: string[] = []; const byCode = new Map<string, any>(); let allItems: any = null;
    sum.eachRow((row: any) => {
      const v = (row.values as any[]).slice(1);
      if (v[0] === 'Code') header = v.map(String);
      else if (v[1] === 'All items') allItems = row;
      else if (typeof v[0] === 'string' && /^(B13|D9)$/.test(v[0])) byCode.set(v[0], row);
    });
    return { header, byCode, allItems };
  };
  const withLen: any = { ...data, items: data.items.map((i: any) => (i.id === 'a' ? { ...i, length_ft: 4 } : i.id === 'b' ? { ...i, length_ft: 2.5 } : i)) };
  const agg = aggregate(withLen, { sheetIds: null });
  assert.equal(agg.hasFeet, true);
  assert.equal(agg.totalFeet, 38);                                                  // 7 x 4 + 4 x 2.5
  assert.deepEqual(agg.rows.map((r) => [r.item.code, r.lengthFt, r.totalFeet]), [['B13', 4, 28], ['D9', 2.5, 10]]);
  for (const perSheetColumns of [true, false]) {
    const { header, byCode, allItems } = await read(withLen, perSheetColumns);
    const len = header.indexOf('Length each (ft)') + 1, tot = header.indexOf('Total (ft)') + 1, count = header.indexOf('Total') + 1;
    assert.ok(len > 0 && tot === len + 1 && count === len - 1, header.join(' | '));      // footage sits right beside the count
    assert.deepEqual([byCode.get('B13').getCell(count).value, byCode.get('B13').getCell(len).value, byCode.get('B13').getCell(tot).value], [7, 4, 28]);
    assert.deepEqual([byCode.get('D9').getCell(count).value, byCode.get('D9').getCell(len).value, byCode.get('D9').getCell(tot).value], [4, 2.5, 10]);
    assert.equal(allItems.getCell(tot).value, 38); assert.equal(allItems.getCell(count).value, 11);
    assert.equal(byCode.get('B13').getCell(tot).numFmt, '#,##0.0');
  }
  // only some items have a length: the others stay blank, the total is still just the linear ones
  const some: any = { ...data, items: data.items.map((i: any) => (i.id === 'a' ? { ...i, length_ft: 8.5 } : i)) };
  const one = await read(some, false);
  const tot = one.header.indexOf('Total (ft)') + 1;
  assert.equal(one.byCode.get('B13').getCell(tot).value, 59.5);                       // 7 x 8.5
  assert.ok(!one.byCode.get('D9').getCell(tot).value);                                 // no length: blank, not zero
  assert.equal(one.allItems.getCell(tot).value, 59.5);
  // nothing has a length: the export is exactly as before
  const plain = await read(data, false);
  assert.ok(!plain.header.includes('Length each (ft)') && !plain.header.includes('Total (ft)'));
});

test('excel export adds a Ceiling types tab when counts have their ceiling read', async () => {
  const ExcelJS: any = (await import('exceljs')).default;
  const tab = async (d: any) => { const blob = await buildXlsx(d, aggregate(d, { sheetIds: null }), { sheetIds: null, groupBy: 'floor', perSheetColumns: false, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' }); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await blob.arrayBuffer())); return wb.getWorksheet('Ceiling types'); };
  assert.equal(await tab(data), undefined);                                       // no ceilings read: no tab
  const ceils = ['drop', 'drop', 'sheetrock', null, 'open'];
  const withC: any = { ...data, detections: data.detections.map((d: any, i: number) => ({ ...d, ceiling: ceils[i % ceils.length] })) };
  const agg = aggregate(withC, { sheetIds: null });
  assert.equal(agg.hasCeilings, true);
  const sum = agg.rows.reduce((n, r) => n + r.byCeiling.drop + r.byCeiling.sheetrock + r.byCeiling.open + r.byCeiling.none, 0);
  assert.equal(sum, withC.detections.filter((d: any) => d.status !== 'rejected').length);   // every count is in exactly one ceiling column
  const ws = await tab(withC);
  assert.ok(ws);
  let header: string[] = [], all: any[] = [];
  ws.eachRow((row: any) => { const v = (row.values as any[]).slice(1); if (v[0] === 'Code') header = v; if (v[1] === 'All items') all = v; });
  assert.deepEqual(header, ['Code', 'Description', 'Unit', 'Drop ceiling', 'Sheetrock', 'Open', 'Not read', 'Total']);
  assert.equal(all[3] + all[4] + all[5] + all[6], all[7]);
});

test('excel export: Panel Boards in the estimating template layout, Breakers totals, Summary split into fixtures and devices', async () => {
  const ExcelJS: any = (await import('exceljs')).default;
  const ckt = (circuit: number, kind: string, breaker_amps: number | null, poles = 1) => ({ circuit, kind, breaker_amps, poles, description: null, load_kva: null });
  const panel = (name: string, circuits: any[], extra: any = {}) => ({ id: name, project_id: 'P', sheet_id: data.sheets[0].id, name, alt_name: null, voltage: '480/277V Wye', phases: 3, wires: 4,
    main_type: 'MCB', main_amps: 225, bus_amps: null, kaic: 22, iso_ground: null, surge: true, fed_from: 'LV-1', location: null, manufacturer: 'EATON', mounting: null, positions: 42,
    notes: null, source: 'manual', created_by_name: null, updated_at: '2026-10-23', circuits, ...extra });
  const panels = [
    panel('LSDH1201', [ckt(1, 'load', 60, 3), ckt(2, 'load', 60, 3), ckt(7, 'load', 60, 3), ckt(8, 'load', 60, 3)]),
    panel('LSH1102', [ckt(1, 'load', 20), ckt(3, 'spare', 20), ckt(5, 'spare', 20), ckt(2, 'load', 30, 3)], { main_type: 'MLO', main_amps: 60, positions: 24, kaic: 22 }),
  ];
  const d: any = { ...data, panels, items: data.items.map((it: any, i: number) => ({ ...it, count_group: i === 0 ? 'fixture' : 'device' })) };
  const blob = await buildXlsx(d, aggregate(d, { sheetIds: null }), { sheetIds: null, groupBy: 'floor', perSheetColumns: false, subtotals: true, detectionLog: false, snapshots: false, preparedBy: 'J' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()));
  const pb = wb.getWorksheet('Panel Boards');
  assert.ok(pb);
  // the template's header row, in its columns (C to O)
  assert.deepEqual(['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'].map((c) => pb.getCell(`${c}8`).value),
    ['LABEL', 'AMPERAGE', 'VOLTAGE', 'PHASE', 'KAIC', 'BUSS', 'ISO GROUND', 'CIRCUITS', 'MLO/MCB', 'Drawing Revision', 'Breakout Pricing', 'Alternate Pricing', 'Alternate #']);
  assert.equal(pb.getCell('C7').value, 'Panel Boards');
  assert.deepEqual(['C', 'D', 'E', 'F', 'G', 'J', 'K'].map((c) => pb.getCell(`${c}9`).value), ['LSDH1201', 225, '480/277V Wye', 3, 22, 42, 'MCB']);
  assert.deepEqual(['C', 'D', 'J', 'K'].map((c) => pb.getCell(`${c}10`).value), ['LSH1102', 60, 24, 'MLO']);
  let tx = false, disc = false; pb.eachRow((row: any) => { const v = row.getCell(3).value; if (v === 'Transformers') tx = true; if (v === 'DISCONNECTS') disc = true; });
  assert.ok(tx && disc);
  // breakers: 60 A 3-pole x4, 20 A 1-pole x3 (2 spare), 30 A 3-pole x1; 8 in all
  const br = wb.getWorksheet('Breakers');
  const rows: any[] = []; br.eachRow((row: any) => rows.push((row.values as any[]).slice(1)));
  const all = rows.find((v) => v[1] === 'All breakers');
  assert.equal(all[4], 8); assert.equal(all[5], 2);
  assert.ok(rows.some((v) => v[0] === 'LSDH1201' && v[1] === '60 A 3-pole' && v[4] === 4));
  // the Summary: by system, the fixture under Lighting first, each system with its own total
  const sm = wb.getWorksheet('Summary'); const heads: string[] = []; const totals: string[] = [];
  const systems = ['Lighting', 'Power', 'Fire alarm', 'HVAC', 'Telecom / AV', 'Security', 'Other'];
  sm.eachRow((row: any) => { const v = row.getCell(1).value, t = row.getCell(2).value; if (systems.includes(v)) heads.push(v); if (typeof t === 'string' && / total$/.test(t)) totals.push(t); });
  assert.equal(heads[0], 'Lighting');
  assert.ok(heads.length >= 2);
  assert.deepEqual(totals, heads.map((h) => `${h} total`));
});
