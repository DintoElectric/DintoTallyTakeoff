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

import { classify, signatureInBox, signatureAt as sigAt, similarity as sim } from '../src/detect/shapeMatch.ts';
import type { Prim } from '../src/detect/primitives.ts';
const prim = (x0: number, y0: number, x1: number, y1: number, n: number, fill: boolean, lum = 0): Prim => ({ x0, y0, x1, y1, n, fill, lum });
// A 36x3 fixture drawn as doubled lines; the EM/OPEN variant adds a filled wedge and a triangle outline.
const fixture = (ox: number, oy: number, vertical = false): Prim[] => {
  const r = (x0: number, y0: number, x1: number, y1: number, n: number, f: boolean) => (vertical ? prim(oy + y0, ox + x0, oy + y1, ox + x1, n, f) : prim(ox + x0, oy + y0, ox + x1, oy + y1, n, f));
  return [r(0, 0, 36, 0, 2, false), r(0, 3, 36, 3, 2, false), r(0, 0, 0, 3, 2, false), r(36, 0, 36, 3, 2, false)];
};
const wedge = (ox: number, oy: number, vertical = false): Prim[] => (vertical
  ? [prim(oy, ox, oy + 3, ox + 34.6, 4, true), prim(oy, ox, oy + 3, ox + 34.6, 3, false)]
  : [prim(ox, oy, ox + 34.6, oy + 3, 4, true), prim(ox, oy, ox + 34.6, oy + 3, 3, false)]);

test('shape match: wedge variant vs plain, learned from boxed examples', () => {
  const page = [...fixture(100, 100), ...fixture(300, 100), ...wedge(300, 100), ...fixture(500, 200), ...wedge(500, 200), ...fixture(700, 200)];
  const plain = { id: 'plain', sig: signatureInBox(page, { x0: 96, y0: 96, x1: 140, y1: 106 }) };
  const em = { id: 'em', sig: signatureInBox(page, { x0: 296, y0: 96, x1: 340, y1: 106 }) };
  const at = (x: number, y: number) => sigAt(page, x, y);
  assert.equal(classify(at(520, 215), [plain, em])?.id, 'em');     // another wedge fixture, different place
  assert.equal(classify(at(720, 215), [plain, em])?.id, 'plain');
  assert.equal(classify(at(720, 215), [plain, em])?.certain, false); // plain is decided by absence, so it is flagged
  assert.equal(classify(at(520, 215), [plain, em])?.certain, true);
});

test('shape match: a rotated (vertical) wedge fixture is still recognised', () => {
  const page = [...fixture(300, 100), ...wedge(300, 100), ...fixture(100, 100), ...fixture(500, 300, true), ...wedge(500, 300, true)];
  const plain = { id: 'plain', sig: signatureInBox(page, { x0: 96, y0: 96, x1: 140, y1: 106 }) };
  const em = { id: 'em', sig: signatureInBox(page, { x0: 296, y0: 96, x1: 340, y1: 106 }) };
  // the vertical fixture occupies x 300..303, y 500..536; its tag sits beside it
  assert.equal(classify(sigAt(page, 320, 518), [plain, em])?.id, 'em');
});

test('shape match: gray hatching and long walls are ignored', () => {
  const noise = [prim(0, 0, 500, 0, 2, false, 0), prim(0, 0, 30, 30, 2, false, 0.67), prim(10, 10, 20, 20, 4, true, 0.9)];
  assert.equal(sigAt(noise, 20, 20).length, 0);
  assert.equal(sim([], []), 1);
});

import { markRoomNumbers } from '../src/detect/tagScan.ts';
const hit = (code: string, x: number, y: number) => ({ code, x, y, kind: 'tag' as const, h: 0.0044 });
test('room numbers: a name directly above a one-off code marks it as a room', () => {
  const runs = [pr('SHAFT', 0.4, 0.4, 0.02), pr('X06', 0.4, 0.405, 0.015)];
  const out = markRoomNumbers([hit('X06', 0.4, 0.405)], runs);
  assert.equal(out[0].kind, 'room');
});
test('room numbers: repeated codes and codes with no name above stay fixtures', () => {
  const runs = [pr('SHAFT', 0.4, 0.4, 0.02)];
  const rep = markRoomNumbers([hit('B13', 0.4, 0.405), hit('B13', 0.2, 0.2), hit('B13', 0.6, 0.6)], runs);
  assert.ok(rep.every((h) => h.kind === 'tag'));
  assert.equal(markRoomNumbers([hit('D2', 0.8, 0.8)], runs)[0].kind, 'tag');
});
test('room numbers: a leading zero in the digits marks a room (X06)', () => {
  assert.equal(markRoomNumbers([hit('X07', 0.1, 0.1)], [])[0].kind, 'room');
});

import { parseSchedulePage, resolveSimilar, firstSentence, shortName, categoryFor, specLine } from '../src/detect/scheduleParse.ts';
// A small copy of the real table layout (page 3000 x 2000 pt). `dx` shifts the whole table sideways.
function scheduleRuns(dx = 0): PageRun[] {
  const r = (str: string, x0: number, x1: number, y: number): PageRun => ({ str, cx: (x0 + x1 + 2 * dx) / 2 / 3000, cy: y / 2000, w: (x1 - x0) / 3000, h: 9 / 2000, rotated: false });
  const row = (y: number, code: string, mtg: string, desc: string[], lm: string, cct: string, w: string, mfr: string[], cat: string[]) => [
    r(code, 419, 431, y), r(mtg, 473, 494, y), ...desc.map((d, i) => r(d, 515, 1040, y + i * 12)),
    r(lm, 1086, 1129, y), r(cct, 1188, 1217, y), r('-', 1283, 1286, y), r(w, 1359, 1370, y), r('UNV', 1405, 1426, y), r('0-10V/1%', 1439, 1484, y),
    ...mfr.map((m, i) => r(m, 1540, 1600, y + i * 46)), ...cat.map((c, i) => r(c, 1666, i === 0 ? 1892 : 1707, y + i * 46)),
  ];
  return [
    r('TYPE', 411, 438, 177), r('MTG.', 471, 497, 177), r('DESCRIPTION', 743, 813, 177), r('DELIVERED LUMENS OR', 1047, 1168, 178), r('LAMP NO. DESIGNATION', 1046, 1172, 190),
    r('COLOR/CCT', 1172, 1232, 184), r('OPTICS', 1266, 1304, 184), r('WATTAGE', 1338, 1390, 171), r('(W)', 1357, 1374, 183), r('VOLTS', 1398, 1432, 177),
    r('DIMMING', 1465, 1510, 171), r('PROTOCOL/RANGE', 1439, 1535, 183), r('MANUFACTURER', 1558, 1644, 177), r('CATALOG NUMBER', 1730, 1826, 177),
    ...row(204, 'A1', 'REC', ['LED 2X2 FLAT PANEL TROFFER, NOMINAL 3 INCH RECESS DEPTH, INTEGRAL DRIVER, FOR INSTALLATION', 'IN ACT CEILINGS.'], '4,800 LM', '3000K', '45', ['LITHONIA', 'COLUMBIA LIGHTING'], ['EPANL-2X2-4800LM-MVOLT', 'SCALER']),
    ...row(294, 'A1A', 'REC', ['SIMILAR TO FIXTURE TYPE A1, EXCEPT WITH DIFFERENT COLOR TEMPERATURE AND CRI.'], '5,150 LM', '4000K', '54', ['LITHONIA'], ['CPX-2X2-6000LM']),
    ...row(383, 'B12B', 'PEND', ['REMOVED FROM PROJECT'], '-', '-', '-', ['-'], ['-']),
    r('A.', 2160, 2167, 200), r('FOR ELECTRICAL SYMBOLS', 2180, 2420, 200), // notes column to the right: must be ignored
  ];
}
for (const dx of [0, 340]) {
  test(`schedule: reads rows, columns and removed types (table shifted ${dx}pt)`, () => {
    const rows = resolveSimilar(parseSchedulePage(scheduleRuns(dx), 3000, 2000));
    assert.deepEqual(rows.map((x) => x.code), ['A1', 'A1A', 'B12B']);
    const a1 = rows[0];
    assert.equal(a1.name, 'LED 2X2 FLAT PANEL TROFFER');
    assert.equal(a1.mounting, 'REC'); assert.equal(a1.lumens, '4,800 LM'); assert.equal(a1.cct, '3000K'); assert.equal(a1.watts, '45');
    assert.equal(a1.volts, 'UNV'); assert.equal(a1.dimming, '0-10V/1%');
    assert.equal(a1.manufacturer, 'LITHONIA'); assert.deepEqual(a1.alternates, ['COLUMBIA LIGHTING']);
    assert.equal(a1.catalog, 'EPANL-2X2-4800LM-MVOLT');
    assert.equal(rows[1].similarTo, 'A1');
    assert.match(rows[1].name, /^LED 2X2 FLAT PANEL TROFFER, except with different color temperature/);
    assert.equal(rows[2].removed, true);
    assert.equal(specLine(a1), '4,800 LM · 3000K · 45 W · LITHONIA EPANL-2X2-4800LM-MVOLT');
  });
}
test('schedule: a page without a schedule header returns nothing', () => {
  assert.deepEqual(parseSchedulePage([pr('B13'), pr('NOTES')], 3000, 2000), []);
});
test('schedule: names and categories', () => {
  assert.equal(firstSentence('LED WALL PACK, 8 INCH, U.L. LISTED FOR WET LOCATIONS. REFER TO PLANS.'), 'LED WALL PACK, 8 INCH, U.L. LISTED FOR WET LOCATIONS.');
  assert.equal(shortName('LED INDUSTRIAL STRIP PENDANT, NOMINAL 4 FOOT LONG X 3 INCH WIDE, STEEL HOUSING, FROSTED LENS, INTEGRAL DRIVER', false), 'LED INDUSTRIAL STRIP PENDANT');
  assert.equal(shortName('THERMOPLASTIC LED EXIT SIGN. PROVIDE MOUNTING, FACES AND CHEVRONS AS INDICATED ON DRAWINGS.', false), 'THERMOPLASTIC LED EXIT SIGN.');
  assert.equal(categoryFor('REC/SURF'), 'Recessed'); assert.equal(categoryFor('PEND'), 'Pendant'); assert.equal(categoryFor(''), 'Other');
});
