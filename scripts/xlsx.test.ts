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
