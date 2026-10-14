import test from 'node:test';
import assert from 'node:assert/strict';
import { readTitleBlock, readScale, inferKind, inferFloor, floorLabel, type TextRun } from '../src/upload/titleBlock.ts';
import { GridIndex } from '../src/detect/grid.ts';
import { aggregate } from '../src/export/aggregate.ts';

const run = (str: string, x: number, y: number, h = 0.01, w = 0.05): TextRun => ({ str, x, y, w, h });

test('reads sheet number and title from a bottom-right title block', () => {
  const runs = [
    run('SHEET NUMBER', 0.8, 0.86, 0.008),
    run('E-201', 0.82, 0.9, 0.03),
    run('SECOND FLOOR', 0.72, 0.93, 0.015),
    run('LIGHTING PLAN', 0.72, 0.95, 0.015),
    run('DRAWN BY', 0.6, 0.9, 0.008),
    run('12/04/2025', 0.6, 0.92, 0.01),
    run('E-999', 0.1, 0.1, 0.05), // outside the region: must be ignored
  ];
  const r = readTitleBlock(runs);
  assert.equal(r.number, 'E-201');
  assert.match(r.title ?? '', /SECOND FLOOR/);
  assert.match(r.title ?? '', /LIGHTING PLAN/);
  assert.equal(r.unsure, false);
});

test('no matching text means unsure and blank', () => {
  assert.deepEqual(readTitleBlock([run('hello', 0.7, 0.7)]), { number: null, title: null, unsure: true });
  assert.equal(readTitleBlock([]).unsure, true);
});

test('number variants', () => {
  for (const n of ['E101', 'E-101.1', 'ES-001', 'E-001A']) {
    assert.equal(readTitleBlock([run(n, 0.8, 0.9, 0.03), run('POWER PLAN', 0.7, 0.92, 0.015)]).number, n);
  }
});

test('scale', () => {
  assert.equal(readScale([run('SCALE: 1/8" = 1\'-0"', 0.1, 0.1)]), '1/8" = 1\'-0"');
  assert.equal(readScale([run('SCALE 1:100', 0.1, 0.1)]), '1:100');
  assert.equal(readScale([run('NTS', 0.1, 0.1)]), 'NTS');
  assert.equal(readScale([run('nothing', 0.1, 0.1)]), null);
});

test('kind and floor inference', () => {
  assert.equal(inferKind('Electrical Legend and Abbreviations', 'E-001'), 'legend');
  assert.equal(inferKind('Panel Schedules', 'E-601'), 'schedule');
  assert.equal(inferKind('Site Lighting Plan', 'E-050'), 'site_plan');
  assert.equal(inferKind('Level 2 Power Plan', 'E-201'), 'floor_plan');
  assert.equal(inferKind('Risers', 'E-701'), 'other');
  assert.equal(inferFloor('First Floor Lighting Plan', 'E-101', 'floor_plan'), '1');
  assert.equal(inferFloor('Level 3 Power', 'E-301', 'floor_plan'), '3');
  assert.equal(inferFloor('Roof Plan', 'E-501', 'floor_plan'), 'Roof');
  assert.equal(inferFloor('Lighting Plan', 'E-201', 'floor_plan'), '2'); // from the number
  assert.equal(inferFloor('Legend', 'E-001', 'legend'), null);
  assert.equal(inferFloor('Plan', 'E-001', 'floor_plan'), null); // E-001 carries no floor
  assert.equal(floorLabel('2'), 'L2');
  assert.equal(floorLabel('Roof'), 'Roof');
});

test('grid index finds nearest and rectangles', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), x: (i % 100) / 100, y: Math.floor(i / 100) / 50 }));
  const g = new GridIndex(pts);
  assert.equal(g.nearest(0.5, 0.5, 0.004, 0.004)?.id, '2550');
  assert.equal(g.nearest(0.505, 0.505, 0.001, 0.001), null);
  assert.equal(g.inRect(0, 0, 0.095, 0.015).length, 10);
});

test('aggregate: counts come only from detections, totals reconcile', () => {
  const data = {
    project: { id: 'p', name: 'Demo' } as any,
    sheets: [
      { id: 's1', number: 'E-101', title: 'T', floor: '1', kind: 'floor_plan', count_enabled: true, page_width_pt: 100, page_height_pt: 100 },
      { id: 's2', number: 'E-201', title: 'T', floor: '2', kind: 'floor_plan', count_enabled: true, page_width_pt: 100, page_height_pt: 100 },
    ] as any,
    items: [
      { id: 'a', code: 'A', name: 'Troffer', unit: 'EA', category_id: 'c1' },
      { id: 'b', code: 'B', name: 'Duplex', unit: 'EA', category_id: null },
      { id: 'z', code: 'Z', name: 'Unused', unit: 'EA', category_id: null },
    ] as any,
    categories: [{ id: 'c1', name: 'Lighting', sort: 1 }] as any,
    counts: [
      { sheet_id: 's1', item_type_id: 'a', n: 3, flagged: 0 },
      { sheet_id: 's2', item_type_id: 'a', n: 2, flagged: 0 },
      { sheet_id: 's2', item_type_id: 'b', n: 4, flagged: 0 },
    ],
    detections: [
      { id: '1', sheet_id: 's1', item_type_id: 'a', status: 'unreviewed' },
      { id: '2', sheet_id: 's1', item_type_id: 'a', status: 'confirmed' },
      { id: '3', sheet_id: 's1', item_type_id: 'a', status: 'confirmed' },
    ] as any,
  };
  const r = aggregate(data, { sheetIds: null });
  assert.equal(r.rows.length, 2); // zero-count item omitted
  assert.equal(r.grandTotal, 9);
  assert.equal(r.rows.find((x) => x.item.id === 'a')!.total, 5);
  assert.equal(r.unreviewedBySheet.get('s1'), 1);
  assert.deepEqual(r.floors.map((f) => f.floor), ['1', '2']);
  const sel = aggregate(data, { sheetIds: new Set(['s2']) });
  assert.equal(sel.grandTotal, 6);
});

import { scanTags, splitRepeats, summarize } from '../src/detect/tagScan.ts';
import type { PageRun } from '../src/detect/pageRuns.ts';
const pr = (str: string, cx = 0.4, cy = 0.5, w = 0.03): PageRun => ({ str, cx, cy, w, h: 0.005, rotated: false });

test('tag scan: single tags, joined repeats, spaced mixes', () => {
  const hits = scanTags([pr('B13'), pr('B13B13B13B13', 0.5), pr('B13 B7B7', 0.6), pr('A17A17', 0.3)]);
  const c = Object.fromEntries(summarize(hits).map((t) => [t.code, t.count]));
  assert.deepEqual(c, { B13: 6, B7: 2, A17: 2 });
  assert.deepEqual(splitRepeats('B13B13'), { unit: 'B13', n: 2 });
  assert.deepEqual(splitRepeats('XL4XL4XL4'), { unit: 'XL4', n: 3 });
  assert.equal(splitRepeats('B13'), null);
});

test('tag scan: sub-token positions spread along a joined run', () => {
  const hits = scanTags([pr('B13B13B13', 0.5, 0.5, 0.09)]);
  const xs = hits.map((h) => h.x).sort();
  assert.equal(hits.length, 3);
  assert.ok(xs[0] < 0.5 && xs[2] > 0.5 && Math.abs(xs[1] - 0.5) < 1e-9);
});

test('tag scan: sentences and look-alikes are not tags', () => {
  const hits = scanTags([pr('REFER TO SHEET EL101.6 FOR TUNNEL LIGHTING CONTROLS.'), pr('EHLP/1B1/5'), pr('P-18.5'), pr('EL101.1'), pr('S113'), pr('r1, r2e'), pr('1/8" = 1\'-0"')]);
  assert.equal(hits.length, 0);
});

test('tag scan: short letter codes only when the whole run is the code, and marked short', () => {
  const hits = scanTags([pr('OS'), pr('S'), pr('OF THE PLAN'), pr('TO')]);
  const m = Object.fromEntries(summarize(hits).map((t) => [t.code, t.kind]));
  assert.equal(m.OS, 'short'); assert.equal(m.S, 'short');
  assert.ok(!('OF' in m));
});

test('tag scan: title block and notes column are outside the count region', () => {
  const hits = scanTags([pr('B13', 0.4, 0.5), pr('B13', 0.9, 0.5), pr('B13', 0.4, 0.99)]);
  assert.equal(hits.length, 1);
});
