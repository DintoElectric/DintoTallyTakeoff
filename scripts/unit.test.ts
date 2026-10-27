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

import { findMatchlines, isPastMatchline } from '../src/detect/matchlines.ts';
import { findHexNotes } from '../src/detect/notes.ts';
// Page 1000 x 1000 pt, so normalized = pt / 1000.
const word = (str: string, x: number, y: number, rotated = false): PageRun => ({ str, cx: x / 1000, cy: y / 1000, w: 0.06, h: 0.01, rotated });
test('matchlines: the neighbour sheet number shows which side is past the line', () => {
  // Line at y=100. EL101.2 (neighbour) sits above it, EL101.1 (this sheet) below it, at both ends.
  const runs = [word('MATCHLINE', 100, 100), word('EL101.2', 100, 87), word('EL101.1', 100, 113), word('MATCHLINE', 700, 100), word('EL101.2', 700, 87), word('EL101.1', 700, 113)];
  const lines = findMatchlines(runs, 'EL101.1');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].exclude, 'above'); assert.equal(lines[0].neighbour, 'EL101.2');
  assert.equal(isPastMatchline(0.4, 0.05, lines), true);   // above the line, within its span
  assert.equal(isPastMatchline(0.4, 0.5, lines), false);   // the sheet's own side
  assert.equal(isPastMatchline(0.4, 0.099, lines), false); // right on the line is kept
  assert.equal(isPastMatchline(0.95, 0.05, lines), true);  // a horizontal line is taken to run the full width of the sheet
  // The same labels read from the neighbour's point of view flip the side.
  assert.equal(findMatchlines(runs, 'EL101.2')[0].exclude, 'below');
});
test('matchlines: a vertical line, an unknown own sheet, and detail references are handled', () => {
  const v = [word('MATCHLINE', 130, 200, true), word('EL102.3', 117, 200, true), word('EL102.1', 143, 200, true), word('MATCHLINE', 130, 600, true), word('EL102.3', 117, 600, true), word('EL102.1', 143, 600, true)];
  const lines = findMatchlines(v, 'EL102.1');
  assert.equal(lines[0].orientation, 'v'); assert.equal(lines[0].exclude, 'left');
  assert.equal(isPastMatchline(0.05, 0.4, lines), true); assert.equal(isPastMatchline(0.5, 0.4, lines), false);
  assert.deepEqual(findMatchlines(v, null), []);
  assert.deepEqual(findMatchlines([word('MATCHLINE', 100, 100), word('1/EL102.1', 100, 87), word('2/EL102.1', 100, 113)], 'EL102.1'), []);
});
// A hexagon drawn as six separate line segments (side 8pt), as the CAD export does it.
function hexSegments(cx: number, cy: number, s = 8): Prim[] {
  const h = (s * Math.sqrt(3)) / 2, hs = s / 2;
  const seg = (x0: number, y0: number, x1: number, y1: number) => prim(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), 2, false);
  return [seg(cx - hs, cy - h, cx + hs, cy - h), seg(cx - hs, cy + h, cx + hs, cy + h), seg(cx - s, cy, cx - hs, cy - h), seg(cx - s, cy, cx - hs, cy + h), seg(cx + hs, cy - h, cx + s, cy), seg(cx + hs, cy + h, cx + s, cy)];
}
test('drawing notes: finds hexagons and reads the label inside; ignores a plain circle and an empty hexagon', () => {
  const prims = [...hexSegments(200, 300), ...hexSegments(400, 300), ...hexSegments(600, 300), prim(790, 290, 810, 310, 13, false)];
  const run = (str: string, x: number, y: number): PageRun => ({ str, cx: x / 1000, cy: y / 1000, w: 0.01, h: 0.01, rotated: false });
  const notes = findHexNotes(prims, [run('1A', 200, 300), run('EM2', 400, 302), run('7', 790, 300)], 1000, 1000);
  assert.deepEqual(notes.map((n) => n.label).sort(), ['1A', 'EM2']); // the empty hexagon and the circle with "7" are not notes
  assert.ok(Math.abs(notes[0].x - 0.2) < 0.002 || Math.abs(notes[0].x - 0.4) < 0.002);
});

import { planSheetWrite, CONF_TAG } from '../src/detect/writePlan.ts';
import { zonesFromMatchlines, type Matchline } from '../src/detect/matchlines.ts';
const line: Matchline = { orientation: 'h', pos: 0.1, from: 0, to: 1, exclude: 'above', neighbour: 'EL101.2' };
const lineZones = zonesFromMatchlines([line]);
const det = (id: string, item: string, y: number, source: 'auto' | 'manual', status: 'unreviewed' | 'confirmed' | 'rejected', x = 0.5) =>
  ({ id, sheet_id: 's', item_type_id: item, x, y, bbox: null, confidence: 0.98, source, status } as any);
const base = { zones: lineZones, itemIdByCode: new Map([['B13', 'itB13'], ['D9', 'itD9']]), ambiguous: new Set<string>(), clearItemIds: new Set(['itB13', 'itD9']), newId: () => 'new' };

test('re-run: an item whose every mark is past the matchline still has its old counts cleared', () => {
  // Every D9 on the sheet is above the line (past it). Before the fix, nothing cleared the earlier D9 count.
  const plan = planSheetWrite({ ...base, ignorePast: true, hits: [{ code: 'D9', x: 0.5, y: 0.05, kind: 'tag', past: true }, { code: 'B13', x: 0.5, y: 0.5, kind: 'tag' }],
    existing: [det('old-d9', 'itD9', 0.05, 'auto', 'unreviewed')] });
  assert.ok(plan.ops.some((o) => o.op === 'delete' && o.id === 'old-d9'));
  assert.equal(plan.added, 1); // only the B13 on the sheet's own side
});
test('re-run: confirmed automatic counts past a matchline are removed; manual counts and counts on the sheet are kept', () => {
  const existing = [det('conf-past', 'itB13', 0.05, 'auto', 'confirmed'), det('manual-past', 'itB13', 0.06, 'manual', 'confirmed', 0.3), det('conf-ok', 'itB13', 0.5, 'auto', 'confirmed')];
  const on = planSheetWrite({ ...base, ignorePast: true, hits: [], existing });
  assert.deepEqual(on.ops.filter((o) => o.op === 'delete').map((o: any) => o.id), ['conf-past']);
  assert.equal(on.removedPast, 1);
  const off = planSheetWrite({ ...base, ignorePast: false, hits: [], existing });
  assert.equal(off.ops.length, 0); // box unticked: nothing past the line is touched
});
test('re-run: a mark past the line is not added, one beside a confirmed count is not doubled, notes are not flagged', () => {
  const plan = planSheetWrite({ ...base, ignorePast: true, itemIdByCode: new Map([['B13', 'itB13'], ['14', 'itNote']]), clearItemIds: new Set(['itB13', 'itNote']),
    hits: [{ code: 'B13', x: 0.5, y: 0.05, kind: 'tag', past: true }, { code: 'B13', x: 0.2, y: 0.5, kind: 'tag' }, { code: '14', x: 0.7, y: 0.6, kind: 'note' }],
    existing: [det('conf', 'itB13', 0.5, 'auto', 'confirmed', 0.2)] });
  const adds = plan.ops.filter((o) => o.op === 'add') as any[];
  assert.deepEqual(adds.map((a) => a.detection.item_type_id), ['itNote']); // the B13 at y=.5 already has a confirmed count
  assert.equal(adds[0].detection.confidence, CONF_TAG);
});

import { attachLabels, discoverMarkers, isEmergency, labelPatterns, normalizeLabel, parseCustomMarkers, emergencyCode } from '../src/detect/emergency.ts';
const fix = (code: string, x: number, y: number, labels: string[] = []) => ({ code, x, y, kind: 'tag' as const, labels });
test('emergency: label patterns turn numbers into #, and split lists', () => {
  assert.equal(normalizeLabel('3es'), '#es'); assert.equal(normalizeLabel('EHLP/1B1/12'), 'EHLP/#B#/#');
  assert.deepEqual(labelPatterns('r1, r2e').sort(), ['r#', 'r#, r#e', 'r#e'].sort());
  assert.deepEqual(parseCustomMarkers('EM2, NL'), ['EM#', 'NL']);
  assert.equal(emergencyCode('B13'), 'B13E');
});
test('emergency: markers are proposed only as pairs (a plain label beside the same label plus E)', () => {
  const hits = [
    ...[1, 2, 3, 4].map((n) => fix('B7', 0.1 * n, 0.1, [`${n}`])),            // normal circuits: 1, 2, 3, 4
    ...[3, 5, 7, 9].map((n) => fix('B7', 0.1 * n, 0.5, [`${n}es`])),          // emergency circuits: 3es, 5es ...
    ...[1, 2, 3].map((n) => fix('B3', 0.1 * n, 0.8, [`S${n}`])),              // room-ish labels with no partner
    fix('D1', 0.9, 0.9, ['EM-lonely']),                                        // a one-off is never proposed
  ];
  const c = discoverMarkers(hits);
  assert.deepEqual(c.map((m) => [m.pattern, m.partner]), [['#es', '#']]);
  // A panel-style label starting with E and no normal twin is offered as a possibility (partner null), after the sure ones.
  const withEpp = discoverMarkers([...hits, ...[1, 2, 3].map((n) => fix('D9', 0.2 * n, 0.3, ['EPP/1B1/7']))]);
  assert.deepEqual(withEpp.map((m) => [m.pattern, m.partner]), [['#es', '#'], ['EPP/#B#/#', null]]);
  assert.equal(c[0].count, 4);
  const markers = new Set(c.map((m) => m.pattern));
  assert.equal(isEmergency(hits[4], markers), true); assert.equal(isEmergency(hits[0], markers), false);
  assert.equal(isEmergency(hits[8], new Set(parseCustomMarkers('EM-lonely'))), false); // custom markers are matched by pattern
});
test('emergency: each printed label belongs to the one nearest fixture, not to every fixture around it', () => {
  const a = fix('B7', 0.100, 0.5), b = fix('B7', 0.130, 0.5); // 30pt apart on a 1000pt page
  const runs = [{ str: '3es', cx: 0.1, cy: 0.52 }, { str: '4', cx: 0.133, cy: 0.52 }, { str: '9es', cx: 0.5, cy: 0.5 }, { str: 'B7', cx: 0.11, cy: 0.5 }, { str: 'EL101.1', cx: 0.1, cy: 0.5 }];
  attachLabels([a, b], runs, 1000, 1000);
  assert.deepEqual(a.labels, ['3es']); assert.deepEqual(b.labels, ['4']); // the far "9es" and the tag/sheet-number text are ignored
});
test('count confidence can be set per hit (emergency 0.95, normal-of-split 0.9)', () => {
  const plan = planSheetWrite({ hits: [{ code: 'B7', x: 0.5, y: 0.5, kind: 'tag', conf: 0.95 }, { code: 'B7', x: 0.2, y: 0.5, kind: 'tag' }], zones: [], existing: [], itemIdByCode: new Map([['B7', 'it']]), ambiguous: new Set(), clearItemIds: new Set(), ignorePast: true, newId: () => 'n' });
  assert.deepEqual((plan.ops as any[]).map((o) => o.detection.confidence), [0.95, CONF_TAG]);
});

import { inZones, pointInPolygon, rectZone, validateZones } from '../shared/zones.ts';
test('zones: point-in-polygon works for rectangles, triangles and L shapes', () => {
  assert.equal(pointInPolygon(0.5, 0.5, rectZone(0, 0, 1, 1).points), true);
  assert.equal(pointInPolygon(1.2, 0.5, rectZone(0, 0, 1, 1).points), false);
  const tri = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  assert.equal(pointInPolygon(0.2, 0.2, tri), true); assert.equal(pointInPolygon(0.8, 0.8, tri), false);
  const L = [{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 0.6, y: 0.4 }, { x: 0.3, y: 0.4 }, { x: 0.3, y: 1 }, { x: 0, y: 1 }];
  assert.equal(pointInPolygon(0.1, 0.8, L), true); assert.equal(pointInPolygon(0.5, 0.8, L), false);
  assert.equal(inZones(0.5, 0.5, []), false);
});
test('zones: a diagonal zone (like the estimators\' blue strip) excludes only its own side', () => {
  const strip = { points: [{ x: 0, y: 0 }, { x: 1, y: 0.4 }, { x: 1, y: 0.6 }, { x: 0, y: 0.2 }] };
  assert.equal(inZones(0.5, 0.3, [strip]), true);   // inside the strip
  assert.equal(inZones(0.5, 0.05, [strip]), false); // above it
  assert.equal(inZones(0.5, 0.7, [strip]), false);  // below it
});
test('zones: automatic zones from matchlines (full width above/below; a vertical line keeps its span)', () => {
  const z = zonesFromMatchlines([{ orientation: 'h', pos: 0.4, from: 0.2, to: 0.6, exclude: 'above', neighbour: 'X' }, { orientation: 'v', pos: 0.13, from: 0.1, to: 0.6, exclude: 'left', neighbour: 'Y' }]);
  assert.equal(inZones(0.95, 0.2, z), true);   // far right of the line's labels, still past it
  assert.equal(inZones(0.5, 0.45, z), false);  // the sheet's own side
  assert.equal(inZones(0.05, 0.3, z), true);   // left of the vertical line, along its span
  assert.equal(inZones(0.05, 0.9, z), false);  // left of it but well below the line's span
  assert.equal(inZones(0.5, 0.3995, z), false); // right on the horizontal line: kept
});
test('zones: the server rejects malformed zones', () => {
  assert.deepEqual(validateZones([]), []);
  assert.equal(validateZones([rectZone(0, 0, 1, 0.1)]).length, 1);
  assert.throws(() => validateZones('x'), /list/);
  assert.throws(() => validateZones([{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]), /3 and/);
  assert.throws(() => validateZones([{ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }] }]), /outside/);
  assert.throws(() => validateZones([{ points: [{ x: 0, y: 0 }, { x: 'a', y: 0 }, { x: 1, y: 1 }] }]), /outside/);
  assert.throws(() => validateZones(Array.from({ length: 41 }, () => rectZone(0, 0, 1, 1))), /at most/);
});

test('short codes: earlier automatic counts of a dropped item are removed (any status), manual counts are kept', () => {
  const existing = [det('s-unrev', 'itS', 0.5, 'auto', 'unreviewed'), det('s-conf', 'itS', 0.6, 'auto', 'confirmed'), det('s-manual', 'itS', 0.7, 'manual', 'confirmed'), det('b-keep', 'itB13', 0.5, 'auto', 'confirmed', 0.2)];
  const plan = planSheetWrite({ ...base, ignorePast: true, hits: [], existing, dropItemIds: new Set(['itS']) });
  assert.deepEqual(plan.ops.filter((o) => o.op === 'delete').map((o: any) => o.id).sort(), ['s-conf', 's-unrev']);
  assert.equal(plan.removedDropped, 2);
});

test('start fresh: erases earlier automatic counts of every status (and every item); hand-placed counts stay unless asked', () => {
  const existing = [det('a-unrev', 'itB13', 0.5, 'auto', 'unreviewed', 0.1), det('a-conf', 'itB13', 0.5, 'auto', 'confirmed', 0.2), det('a-other-item', 'itOther', 0.5, 'auto', 'confirmed', 0.3), det('m1', 'itB13', 0.5, 'manual', 'confirmed', 0.8)];
  const hits = [{ code: 'B13', x: 0.1, y: 0.5, kind: 'tag' as const }, { code: 'B13', x: 0.8, y: 0.5, kind: 'tag' as const }];
  const auto = planSheetWrite({ ...base, ignorePast: true, hits, existing, reset: 'auto' });
  assert.deepEqual(auto.ops.filter((o) => o.op === 'delete').map((o: any) => o.id).sort(), ['a-conf', 'a-other-item', 'a-unrev']);
  assert.equal(auto.erased, 3);
  assert.equal(auto.added, 1); // the B13 at x=0.1 is re-added; the one at x=0.8 sits on the hand-placed count, so it is not doubled
  const all = planSheetWrite({ ...base, ignorePast: true, hits, existing, reset: 'all' });
  assert.equal(all.erased, 4); assert.equal(all.added, 2);
  const none = planSheetWrite({ ...base, ignorePast: true, hits, existing, reset: false });
  assert.equal(none.erased, 0); // without the option the old behaviour is unchanged: confirmed counts stay
  assert.ok(!none.ops.some((o: any) => o.op === 'delete' && o.id === 'a-conf'));
});

import { areaNames, assignAreas, cleanAreaName } from '../shared/areas.ts';
const A = (id: string, sheet: string, name: string, x0: number, y0: number, x1: number, y1: number) => ({ id, sheet_id: sheet, name, points: rectZone(x0, y0, x1, y1).points });
test('areas: names are cleaned, and "Lab A" / "lab  a" are the same area', () => {
  assert.equal(cleanAreaName('  Lab   A '), 'Lab A');
  assert.throws(() => cleanAreaName('   '), /name/); assert.throws(() => cleanAreaName('x'.repeat(61)), /60/); assert.throws(() => cleanAreaName(5), /name/);
  assert.deepEqual(areaNames([{ name: 'Lab A' }, { name: 'lab a' }, { name: 'B2' }, { name: 'B10' }]), ['B2', 'B10', 'Lab A']);
});
test('areas: two polygons with the same name add up, across sheets too; a count in no area is reported separately', () => {
  const areas = [A('1', 's1', 'A', 0, 0, 0.5, 0.5), A('2', 's1', 'a', 0.5, 0.5, 1, 1), A('3', 's2', 'A', 0, 0, 1, 1), A('4', 's1', 'B', 0.4, 0, 1, 0.5)];
  const dets = [
    { sheet_id: 's1', item_type_id: 'x', x: 0.1, y: 0.1 },   // in the first A polygon
    { sheet_id: 's1', item_type_id: 'x', x: 0.7, y: 0.7 },   // in the second A polygon (named "a")
    { sheet_id: 's1', item_type_id: 'x', x: 0.45, y: 0.1 },  // inside A and B at once: counted in both
    { sheet_id: 's1', item_type_id: 'x', x: 0.2, y: 0.9 },   // in no area
    { sheet_id: 's2', item_type_id: 'x', x: 0.3, y: 0.3 },
  ];
  const rows = assignAreas(dets, areas);
  const total = (area: string | null) => rows.filter((r) => r.area === area).reduce((n, r) => n + r.n, 0);
  assert.equal(total('A'), 4);  // 2 polygons on sheet 1 plus the overlap plus the one on sheet 2
  assert.equal(total('B'), 1);
  assert.equal(total(null), 1);
  // a count inside two polygons of the SAME name is counted once for that name
  const twice = assignAreas([{ sheet_id: 's1', item_type_id: 'x', x: 0.5, y: 0.5 }], [A('1', 's1', 'A', 0, 0, 0.6, 0.6), A('2', 's1', 'A', 0.4, 0.4, 1, 1)]);
  assert.equal(twice.length, 1); assert.equal(twice[0].n, 1);
});

import { parseRuledSchedule, mountingFromDescription } from '../src/detect/scheduleRuled.ts';
import type { Prim as PrimT } from '../src/detect/primitives.ts';
// A ruled schedule like E0.3: row lines and column lines, a header row, and a second table with no header beside it.
function ruledPage(): { runs: PageRun[]; prims: PrimT[] } {
  const W = 3000, H = 2000;
  const run = (str: string, x0: number, x1: number, y: number): PageRun => ({ str, cx: (x0 + x1) / 2 / W, cy: y / H, w: (x1 - x0) / W, h: 9 / H, rotated: false });
  const hl = (x0: number, x1: number, y: number): PrimT => ({ x0, y0: y, x1, y1: y, n: 2, fill: false, lum: 0 });
  const vl = (x: number, y0: number, y1: number): PrimT => ({ x0: x, y0, x1: x, y1, n: 2, fill: false, lum: 0 });
  const cols = [100, 150, 250, 400, 500, 560]; // TYPE | LOCATION | DESCRIPTION | MANUFACTURER | CATALOG
  const colsR = cols.map((c) => c + 700);
  const rowsL = [100, 140, 260, 330], rowsR = [100, 190, 300];
  const prims: PrimT[] = [];
  for (const y of rowsL) prims.push(hl(100, 560, y));
  for (const x of cols) prims.push(vl(x, 100, 330));
  for (const y of rowsR) prims.push(hl(800, 1260, y));
  for (const x of colsR) prims.push(vl(x, 100, 300));
  const runs: PageRun[] = [
    run('TYPE', 105, 140, 120), run('LOCATION', 160, 240, 120), run('DESCRIPTION', 300, 350, 120), run('MANUFACTURER', 410, 490, 120), run('CATALOG NUMBER', 505, 555, 120),
    // left table: the tag sits in the MIDDLE of a tall row (y=200 in a row spanning 140-260)
    run('EX-1', 105, 130, 200), run('BOH, HALL,', 155, 235, 200), run('SURFACE MOUNTED LED STRIPLIGHT, WHITE', 255, 395, 170), run('INTEGRAL DRIVER.', 255, 330, 183),
    run('LITHONIA', 410, 460, 200), run('OR APPROVED EQUAL', 410, 495, 213), run('ABC-100-', 505, 550, 190), run('MVOLT-WH', 505, 550, 203),
    run('BC-14', 105, 130, 295), run('CORRIDOR', 155, 215, 295), run('RECESSED 2X2 FLAT PANEL', 255, 395, 295), run('EUREKA', 410, 450, 295), run('XYZ-1', 505, 540, 295),
    // right table has no header of its own
    run('RL-2X', 805, 835, 145), run('LOBBY', 855, 900, 145), run('RECESSED LINEAR LIGHTSLOT', 955, 1095, 145), run('MARK', 1110, 1150, 145), run('S4RD-LOP-', 1205, 1255, 140), run('LENGTH', 1205, 1240, 153),
    run('XW-1', 805, 830, 250), run('EXTERIOR', 855, 905, 250), run('SURFACE MOUNTED WET LOCATION WALLPACK', 955, 1095, 250), run('LITHONIA', 1110, 1160, 250), run('WDGE2', 1205, 1245, 250),
    run('WALK-IN', 160, 200, 210), // looks like a tag but sits in the LOCATION column: not a type
  ];
  return { runs, prims };
}
test('ruled schedule: tags centred in tall rows, wrapped catalog numbers, a headerless second table', () => {
  const { runs, prims } = ruledPage();
  const rows = parseRuledSchedule(runs, prims, 3000, 2000);
  assert.deepEqual(rows.map((r) => r.code), ['EX-1', 'BC-14', 'RL-2X', 'XW-1']);
  const ex = rows[0];
  assert.equal(ex.manufacturer, 'LITHONIA'); assert.deepEqual(ex.alternates, []); // "OR APPROVED EQUAL" is not an alternate
  assert.equal(ex.catalog, 'ABC-100-MVOLT-WH');   // a line ending in "-" continues with no space
  assert.match(ex.description, /^SURFACE MOUNTED LED STRIPLIGHT, WHITE INTEGRAL DRIVER\.$/);
  assert.equal(rows[2].catalog, 'S4RD-LOP-LENGTH'); assert.equal(rows[2].manufacturer, 'MARK');
  assert.equal(rows[2].location, 'LOBBY'); assert.equal(rows[3].mounting, 'WALL');
});
test('ruled schedule: a page without row and column lines, or without a header, gives nothing', () => {
  const { runs, prims } = ruledPage();
  assert.deepEqual(parseRuledSchedule(runs, [], 3000, 2000), []);
  assert.deepEqual(parseRuledSchedule(runs.filter((r) => r.str !== 'DESCRIPTION'), prims, 3000, 2000), []);
  assert.equal(mountingFromDescription('PENDANT MOUNTED, DIRECT/INDIRECT LINEAR'), 'PEND');
  assert.equal(mountingFromDescription('UNIVERSAL MOUNT, EDGELIT LED EXIT SIGN'), 'EXIT');
  assert.equal(mountingFromDescription('SURFACE MOUNTED, WET LOCATION RATED LED WALLPACK'), 'WALL');
});
test('schedule names: a mounting phrase is not a name', () => {
  assert.equal(shortName('PENDANT MOUNTED, DIRECT/INDIRECT LINEAR LED PENDANT WITH STANDARD DOWNLIGHT DISTRIBUTION AND BATWING UPLIGHT DISTRIBUTION', false).startsWith('PENDANT MOUNTED, DIRECT/INDIRECT'), true);
  assert.match(shortName('SURFACE OR CHAIN MOUNTED, NOMINAL 3" X 3" X 4\'L LED STRIPLIGHT WITH WHITE STEEL HOUSING, DIFFUSING LENS AND INTEGRAL DRIVER. PROVIDE CHAIN MOUNT AS REQUIRED', false), /STRIPLIGHT WITH WHITE STEEL HOUSING$/);
});

test('hyphenated tags are counted only when they are in the library; grid labels and room words are not', () => {
  const runs = [pr('BR-22', 0.3, 0.3), pr('BR-22', 0.4, 0.3), pr('P-9', 0.2, 0.2), pr('WALK-IN', 0.5, 0.5), pr('RL-2X', 0.6, 0.6)];
  assert.equal(scanTags(runs).filter((h) => h.code.includes('-')).length, 0);                         // no library: nothing
  const hits = scanTags(runs, undefined, new Set(['BR-22', 'RL-2X']));
  assert.deepEqual(summarize(hits).map((t) => `${t.code}:${t.count}`).sort(), ['BR-22:2', 'RL-2X:1']); // P-9 and WALK-IN are ignored
});
test('a short word after a tag in the same run is kept as that tag\'s suffix', () => {
  const [h] = scanTags([pr('BR-22 LS', 0.3, 0.3, 0.06)], undefined, new Set(['BR-22']));
  assert.equal(h.code, 'BR-22'); assert.deepEqual(h.suffixes, ['LS']);
});
test('emergency suffix: a word right after the tag on its own line is found, one elsewhere is not', () => {
  const tag = { code: 'BR-22', x: 0.3, y: 0.5, kind: 'tag' as const };
  const runs = [{ str: 'LS', cx: 0.3 + 21 / 1000, cy: 0.5 }, { str: 'S', cx: 0.3 + 21 / 1000, cy: 0.5 + 30 / 1000 }, { str: 'VC', cx: 0.9, cy: 0.9 }];
  attachLabels([tag], runs, 1000, 1000);
  assert.deepEqual(tag.suffixes, ['LS']);
});
test('emergency suffix: proposed only when it repeats across fixture types, never pre-ticked, and named like the drawing', () => {
  const fx = (code: string, w?: string) => ({ code, x: 0.1, y: 0.1, kind: 'tag' as const, labels: [] as string[], suffixes: w ? [w] : [] });
  const hits = [...Array(4).fill(0).map(() => fx('BR-22', 'LS')), ...Array(3).fill(0).map(() => fx('SD-12', 'LS')), fx('BR-22'), fx('BC-14', 'NL')];
  const c = discoverMarkers(hits);
  assert.deepEqual(c.map((m) => [m.pattern, m.partner, m.count]), [['+LS', null, 7]]); // NL appears once: not proposed
  assert.equal(isEmergency(hits[0], new Set(['+LS'])), true); assert.equal(isEmergency(hits[7], new Set(['+LS'])), false);
  assert.equal(emergencyCode('BR-22', new Set(['+LS'])), 'BR-22LS'); assert.equal(emergencyCode('B13', new Set(['#es'])), 'B13E');
});

import { readLabeledTitle } from '../src/upload/titleBlock.ts';
const T = (str: string, x: number, y: number, h = 0.006) => ({ str, x, y, w: str.length * 0.004, h });
test('labelled title block: the sheet title is read under CONTENT:, not the copyright line next to the number', () => {
  const runs = [
    T('CONTENT:', 0.892, 0.800), T('ELECTRICAL LIGHTING FIXTURE', 0.894, 0.811), T('SCHEDULE', 0.894, 0.821), T('DRAWN BY:', 0.892, 0.850), T('Author', 0.96, 0.850),
    T('E0.3', 0.925, 0.925, 0.02), T('Project Phase', 0.892, 0.955), T('100% CONSTRUCTION DOCUMENTS', 0.892, 0.965), T('COPYRIGHT © 2026 BY LAVALLEE BRENSINGER PLLC.', 0.89, 0.985),
  ];
  const tb = readTitleBlock(runs);
  assert.equal(tb.number, 'E0.3'); assert.equal(tb.title, 'ELECTRICAL LIGHTING FIXTURE SCHEDULE'); assert.equal(tb.unsure, false);
  assert.equal(inferKind(tb.title, tb.number), 'schedule');
});
test('labelled title block: a title that ends in NORTH keeps it; a block without a label is read as before', () => {
  const runs = [T('CONTENT:', 0.892, 0.800), T('ELECTRICAL LEVEL 1 LIGHTING PLAN -', 0.894, 0.811), T('NORTH', 0.894, 0.821), T('DRAWN BY:', 0.892, 0.850), T('E1.01A', 0.925, 0.925, 0.02)];
  assert.equal(readLabeledTitle(runs), 'ELECTRICAL LEVEL 1 LIGHTING PLAN - NORTH');
  assert.equal(readLabeledTitle([T('E1.01A', 0.925, 0.925, 0.02), T('LIGHTING PLAN', 0.9, 0.9)]), null);
});

import { readTextTables } from '../src/detect/scheduleText.ts';
import { textTablesToRows, initials, parseTextSchedules } from '../src/detect/scheduleDevices.ts';
// A position-laid-out schedule: header cells with a short line segment under each column, rows as plain text lines.
function textPage() {
  const W = 3000, H = 2000;
  const run = (str: string, x0: number, x1: number, y: number): PageRun => ({ str, cx: (x0 + x1) / 2 / W, cy: y / H, w: (x1 - x0) / W, h: 9 / H, rotated: false });
  const seg = (x0: number, x1: number, y: number): PrimT => ({ x0, y0: y, x1, y1: y, n: 2, fill: false, lum: 0 });
  const prims: PrimT[] = [], runs: PageRun[] = [];
  const table = (ox: number, oy: number, title: string, rows: string[][]) => {
    const xs = [ox, ox + 250, ox + 350, ox + 450, ox + 600];
    for (const y of [oy + 40, oy + 60, oy + 80]) for (let i = 0; i < 4; i++) prims.push(seg(xs[i], xs[i + 1], y));
    runs.push(run(title, ox + 100, ox + 480, oy), run('OUTLET TYPE', ox + 60, ox + 160, oy + 30), run('SUBSCRIPT', ox + 260, ox + 330, oy + 30), run('DEVICE QUANTITY', ox + 355, ox + 445, oy + 30), run('DATA CABLES', ox + 470, ox + 560, oy + 30));
    rows.forEach((r, k) => r.forEach((txt, c) => { if (txt) runs.push(run(txt, xs[c] + 5, xs[c] + 5 + txt.length * 4.2, oy + 52 + k * 20)); }));
  };
  table(100, 100, 'COMMUNICATIONS OUTLET COUNT SCHEDULE - TSER ROOM', [
    ['STANDARD 1-PORT IP CAMERA OUTLET - CEILING MOUNTED', 'IPC', '25', '25'], ['STANDARD 1-PORT IP CAMERA OUTLET - WALL MOUNTED', 'IPC', '14', '14'],
    ['STANDARD 4-PORT TELECOM ABOVE CEILING OUTLET 4AC', '', '2', '8'], ['Grand total: 41', '', '41', '47'],
  ]);
  table(900, 100, 'COMMUNICATIONS OUTLET COUNT SCHEDULE - TDR ROOM', [['STANDARD 1-PORT IP CAMERA OUTLET - CEILING MOUNTED', 'IPC', '17', '17'], ['STANDARD 1-PORT INTERCOM OUTLET', 'IC', '1', '1'], ['Grand total: 18', '', '18', '18']]);
  table(100, 600, 'COMMUNICATIONS BD PARATA OUTLET COUNT SCHEDULE - TSER ROOM', [['STANDARD 2-PORT BD PARATA NETWORK OUTLET', '2', '2', '4'], ['Grand total: 2', '', '2', '4']]);
  return { runs, prims, W, H };
}
test('position-laid-out schedules: side-by-side and stacked tables stay apart, totals are not rows', () => {
  const { runs, prims, W, H } = textPage();
  const t = readTextTables(runs, prims, W, H);
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x.rows.length).sort(), [1, 2, 3]);
  const tser = t.find((x) => /TSER ROOM$/.test(x.title) && x.rows.length === 3)!;
  assert.deepEqual(tser.headers, ['OUTLET TYPE', 'SUBSCRIPT', 'DEVICE QUANTITY', 'DATA CABLES']);
});
test('outlet schedule to library items: same code with different names stays separate, quantities add up across tables, 4AC is split off', () => {
  const { runs, prims, W, H } = textPage();
  const rows = parseTextSchedules(runs, prims, W, H);
  const by = (code: string) => rows.filter((r) => r.code === code);
  assert.equal(by('IPC').length, 2);                                                        // ceiling and wall mounted
  assert.equal(by('IPC').find((r) => /CEILING/.test(r.name))!.count, 42);                    // 25 + 17
  const ac = by('4AC')[0];
  assert.equal(ac.name, 'STANDARD 4-PORT TELECOM ABOVE CEILING OUTLET'); assert.equal(ac.spec, '4-port outlet');
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((r) => r.key)).size, 5);
  assert.ok(rows.every((r) => r.category));
});
test('security device lists: model becomes the code, one item per type+mounting+model, door lists make none', () => {
  const T = (title: string, headers: string[], rows: string[][]) => ({ title, headers, xs: [], rows, headerY: 0 });
  const rows = textTablesToRows([
    T('SECURITY CCTV VIDEO SURVEILLANCE CAMERA SCHEDULE', ['SEQUENTIAL #', 'HEAD-END ROOM', 'CAMERA TYPE', 'CAMERA MOUNTING TYPE', 'BOD MODEL #', 'FRAME RATE + MOTION', 'INSTALLER NOTES'], [
      ['01-01', 'TDR ROOM 1054', '360° FISHEYE INTERIOR', 'CEILING MOUNTED', 'HANWHA XNF-A8014RV', '15 FPS @ 50% MOTION', ''],
      ['01-02', 'TDR ROOM 1054', '360° FISHEYE INTERIOR', 'CEILING MOUNTED', 'HANWHA XNF-A8014RV', '15 FPS @ 50% MOTION', ''],
      ['01-03', 'TDR ROOM 1054', '360° FISHEYE INTERIOR', 'PENDANT MOUNTED', 'HANWHA XNF-A8014RV', '15 FPS @ 50% MOTION', '']]),
    T('SECURITY VIDEO INTERCOM SCHEDULE', ['SEQUENTIAL #', 'HEAD-END ROOM', 'DEVICE TYPE', 'BOD MODEL #', 'RELEASE DOOR(S)', 'INSTALLER NOTES'], [['01-01', 'TDR', 'VIDEO INTERCOM MASTER', '', '1000', ''], ['01-02', 'TDR', 'VIDEO INTERCOM WITH INTEGRATED CARD READER', '', '1001', '']]),
    T('SECURITY EMERGENCY PHONE SCHEDULE', ['SEQUENTIAL #', 'HEAD-END ROOM', 'DEVICE TYPE', 'BOD MODEL #', 'CALL ROUTING', 'INSTALLER NOTES'], [['01-01', 'TSER', 'BLUE LIGHT - TOWER', 'TALKAPHONE', 'OFFICE', '']]),
    T('SECURITY DURESS ALARM SCHEDULE', ['SEQUENTIAL #', 'HEAD-END ROOM', 'DEVICE LOCATION', 'ALARM OUTPUT', 'INSTALLER NOTES'], [['01-01', 'TDR', 'LOBBY', 'OFFICE', 'MOUNTED UNDER DESK'], ['01-02', 'TDR', 'PICK-UP', 'OFFICE', 'MOUNTED UNDER DESK']]),
    T('ACCESS CONTROL DOOR SCHEDULE', ['DOOR OPENING', 'HEAD-END ROOM', 'CARD READER', 'DETAIL NUMBER', 'DOOR HW SET #', 'INSTALLER NOTES'], [['1050.1', 'TDR', '1', '3/SE5.01', '2.0', '']]),
  ]);
  assert.equal(rows.length, 6);                                                                // 2 cameras + 2 intercoms + 1 phone + 1 duress; no door items
  const cams = rows.filter((r) => r.category === 'Cameras');
  assert.deepEqual(cams.map((r) => [r.code, r.name, r.count]), [['XNF-A8014RV', '360° FISHEYE INTERIOR, CEILING MOUNTED', 2], ['XNF-A8014RV', '360° FISHEYE INTERIOR, PENDANT MOUNTED', 1]]);
  assert.equal(cams[0].spec, 'HANWHA XNF-A8014RV · 15 FPS @ 50% MOTION');
  assert.deepEqual(rows.filter((r) => r.category === 'Intercoms').map((r) => r.code), ['VIM', 'VICR']);
  assert.equal(rows.find((r) => r.category === 'Emergency phones')!.spec, 'TALKAPHONE');
  const duress = rows.find((r) => r.name === 'DURESS ALARM')!;
  assert.equal(duress.code, 'DA'); assert.equal(duress.count, 2); assert.equal(duress.spec, 'MOUNTED UNDER DESK');
  assert.equal(initials('MASTER DOOR RELEASE'), 'MDR');
});
// A ruled schedule whose first column is a numbered SYMBOL, with one catalog column per maker.
test('ruled schedule with a SYMBOL column: numbered types, NEMA in the name, first maker as catalog, the rest as alternates', () => {
  const W = 3000, H = 2000;
  const run = (str: string, x0: number, x1: number, y: number): PageRun => ({ str, cx: (x0 + x1) / 2 / W, cy: y / H, w: (x1 - x0) / W, h: 9 / H, rotated: false });
  const hl = (x0: number, x1: number, y: number): PrimT => ({ x0, y0: y, x1, y1: y, n: 2, fill: false, lum: 0 });
  const vl = (x: number, y0: number, y1: number): PrimT => ({ x0: x, y0, x1: x, y1, n: 2, fill: false, lum: 0 });
  const xs = [100, 160, 220, 420, 520, 620, 700];  // SYMBOL | NEMA | DESCRIPTION | HUBBELL | COOPER | C.B.
  const ys = [100, 150, 190, 230, 270];
  const prims: PrimT[] = [...ys.map((y) => hl(100, 700, y)), ...xs.map((x) => vl(x, 100, 270))];
  const runs = [run('SYMBOL', 105, 150, 125), run('NEMA', 170, 205, 125), run('DESCRIPTION', 280, 360, 125), run('HUBBELL CAT. No.', 425, 510, 125), run('COOPER CAT. No.', 525, 610, 125), run('C.B.', 640, 670, 125),
    run('1', 120, 130, 170), run('5-20R', 170, 210, 170), run('20A - 125V, 2P, 3W', 230, 330, 170), run('HBL5361', 430, 480, 170), run('5361', 530, 560, 170), run('20A, 1P', 630, 680, 170),
    run('2', 120, 130, 210), run('5-30R', 170, 210, 210), run('30A - 125V, 2P, 3W', 230, 330, 210), run('HBL9308', 430, 480, 210), run('---', 530, 550, 210), run('30A, 1P', 630, 680, 210),
    run('3', 120, 130, 250), run('L5-20R', 170, 215, 250), run('20A - 125V, TWIST LOCK', 230, 340, 250), run('---', 430, 450, 250), run('AHCL520R', 530, 580, 250), run('20A, 1P', 630, 680, 250)];
  const rows = parseRuledSchedule(runs, prims, W, H);
  assert.deepEqual(rows.map((r) => r.code), ['1', '2', '3']);
  assert.equal(rows[0].name, 'NEMA 5-20R, 20A - 125V, 2P, 3W'); assert.equal(rows[0].category, 'Special purpose receptacles');
  assert.equal(rows[0].manufacturer, 'HUBBELL'); assert.equal(rows[0].catalog, 'HBL5361'); assert.deepEqual(rows[0].alternates, ['COOPER 5361']);
  assert.deepEqual(rows[1].alternates, []);                      // a "---" is no catalog number
  assert.equal(rows[2].manufacturer, 'COOPER');                  // the first maker that has one
  assert.equal(specLine(rows[0]), 'HUBBELL HBL5361 · 20A, 1P');
});
test('a legend with a DEVICE TYPE column is not a schedule: no items from it', () => {
  const legend = { title: 'NURSE CALL LEGEND', headers: ['SYMBOL', 'DEVICE TYPE', 'BACKBOX SIZE'], xs: [], headerY: 0, rows: [['T', 'WALL MOUNTED CORRIDOR DOME LIGHT', '4-11/16"']] };
  assert.deepEqual(textTablesToRows([legend]), []);
  assert.deepEqual(textTablesToRows([{ ...legend, title: '' }]), []);
});

import { pageFingerprint, similarity as simil } from '../src/detect/fingerprint.ts';
import { candidateGroups, defaultRemovals, findDuplicateGroups } from '../src/detect/duplicates.ts';
import { classifySheet, scheduleHeadings } from '../src/detect/scheduleSheets.ts';
const strs = (...s: string[]) => new Set(s);
test('fingerprint: a different plot stamp does not matter, a changed note does, and an empty page is never "the same"', () => {
  const run = (s: string) => ({ str: s, cx: 0, cy: 0, w: 0, h: 0, rotated: false });
  const a = pageFingerprint(['BC-14', 'RECESSED 2X2 LIGHT', '9/3/2026 2:09:49 PM Autodesk Docs://25-098-00.rvt'].map(run));
  const b = pageFingerprint(['BC-14', 'RECESSED 2X2 LIGHT', '9/4/2026 8:00:01 AM Autodesk Docs://25-098-00.rvt'].map(run));
  assert.equal(simil(a, b), 1);
  assert.ok(simil(pageFingerprint(['BC-14', 'RECESSED 2X2 LIGHT', 'NOTE ONE'].map(run)), pageFingerprint(['BC-14', 'RECESSED 2X2 LIGHT', 'NOTE TWO'].map(run))) < 0.99);
  assert.equal(simil(new Set(), new Set()), 0);
});
test('duplicates: identical copies are found, the copy with counts is kept, a revised drawing is left alone', () => {
  const page = (n: number) => Array.from({ length: 100 }, (_, i) => `TEXT ${n} ${i}`);
  const sh = (id: string, number: string | null, file: string, pageNo: number, counts = 0) => ({ id, number, file_id: file, page: pageNo, detection_count: counts });
  const revised = [...page(1).slice(0, 80), ...Array.from({ length: 20 }, (_, i) => `CHANGED ${i}`)]; // 80/120 strings in common = 67%
  const sheets = [sh('a1', 'E0.0', 'f1', 1), sh('a2', 'e0.0', 'f2', 1, 7), sh('a3', 'E0.0 ', 'f3', 1),   // three copies; the middle one has counts
    sh('b1', 'E2.01A', 'f1', 2), sh('b2', 'E2.01A', 'f2', 2),                                           // a different version
    sh('c1', 'E9.9', 'f1', 3), sh('c2', 'E9.9', 'f2', 3),                                                // two unrelated drawings under one number
    sh('d1', null, 'f1', 4), sh('d2', null, 'f2', 4), sh('e1', 'E5.5', 'f1', 5)];                       // no number / a number used once
  const prints = new Map<string, Set<string>>([['a1', strs(...page(1))], ['a2', strs(...page(1))], ['a3', strs(...page(1))], ['b1', strs(...page(1))], ['b2', strs(...revised)],
    ['c1', strs(...page(1))], ['c2', strs(...page(7))], ['e1', strs(...page(1))]]);
  assert.equal(candidateGroups(sheets).length, 3);                        // E0.0 (any spacing/case), E2.01A, E9.9; null numbers and singletons are not compared
  const groups = findDuplicateGroups(sheets, prints, new Map([['f1', 0], ['f2', 1], ['f3', 2]]));
  assert.deepEqual(groups.map((g) => g.number), ['E0.0', 'E2.01A']);       // E9.9: different drawings, nothing to say
  const e00 = groups[0];
  assert.deepEqual(e00.clusters[0].members.map((m) => m.id), ['a2', 'a1', 'a3']);   // the one with counts first, then by file order
  assert.equal(groups[1].clusters.length, 2); assert.ok(groups[1].clusters[1].sim > 0.6 && groups[1].clusters[1].sim < 0.99);
  assert.deepEqual([...defaultRemovals(groups)].sort(), ['a1', 'a3']);       // extras of identical pages only; both versions of E2.01A stay
});
test('schedule sheets: titled ones are marked, plans with only a schedule on them are left to the estimator, non-counting sheets need nothing', () => {
  const sh = (kind: string, title: string | null, count = true) => ({ id: 'x', number: 'E1', title, kind, count_enabled: count });
  assert.deepEqual(classifySheet(sh('schedule', 'ELECTRICAL SCHEDULES')), { id: 'x', why: 'title', detail: 'ELECTRICAL SCHEDULES', preselect: true, setKind: true });
  assert.equal(classifySheet(sh('schedule', 'ELECTRICAL SCHEDULES', false)), null);                    // already marked and not counting
  assert.equal(classifySheet(sh('other', 'COMMUNICATIONS OUTLET COUNT SCHEDULES', false))!.setKind, true); // titled, but its kind is wrong: fix the kind
  assert.equal(classifySheet(sh('legend', 'GENERAL NOTES, LEGEND, AND SCHEDULES'))!.setKind, false);   // a legend stays a legend
  assert.equal(classifySheet(sh('floor_plan', 'LIGHTING PLAN AND FIXTURE SCHEDULE'))!.preselect, false);
  assert.equal(classifySheet(sh('floor_plan', 'LIGHTING PLAN'), { tableTypes: 0, headings: [] }), null);
  assert.equal(classifySheet(sh('floor_plan', 'LIGHTING PLAN', false), { tableTypes: 9, headings: [] }), null);  // not counting: nothing to turn off
  const planWith = classifySheet(sh('floor_plan', 'SITE PLAN'), { tableTypes: 4, headings: [] })!;
  assert.deepEqual([planWith.why, planWith.preselect, planWith.setKind], ['table', false, false]);
  const other = classifySheet(sh('other', 'DETAILS'), { tableTypes: 4, headings: [] })!;
  assert.deepEqual([other.preselect, other.setKind], [true, true]);
  assert.deepEqual(scheduleHeadings(['SITE LIGHTING SCHEDULE', 'REFER TO DRY TYPE TRANSFORMER SCHEDULE', 'SCHEDULE', 'see schedule', 'AREA A EQUIPMENT SCHEDULE (by room)', 'IN SCHEDULE', 'SHOWN IN SCHEDULE', 'SITE LIGHTING SCHEDULE']),
    ['SITE LIGHTING SCHEDULE', 'AREA A EQUIPMENT SCHEDULE (by room)']);
});


import { isCountableDiscipline, legendCategory, parseLegendPage } from '../src/detect/legendParse.ts';
function legendPage() {
  const W = 3000, H = 2000;
  const run = (str: string, x0: number, x1: number, y: number): PageRun => ({ str, cx: (x0 + x1) / 2 / W, cy: y / H, w: (x1 - x0) / W, h: 9.5 / H, rotated: false });
  const runs: PageRun[] = [
    run('INITIATING DEVICES:', 200, 320, 90),
    run('F', 205, 212, 130), run('MANUAL PULL STATION', 240, 345, 130),                         // a symbol letter, a gap, the description
    run('MM', 800, 812, 245), run('MONITOR MODULE', 826, 892, 235),                              // letters set as a subscript, lower than the line
    run('AD', 800, 812, 330), run('J', 830, 836, 330), run('CONNECTION TO AUTOMATIC DOORS.', 860, 1000, 330), // two sets of letters: the specific one wins
    run('FF', 800, 812, 420), run('CONNECTION TO ELECTRIFIED FURNITURE, REQUIREMENTS TO BE', 840, 1100, 410), run('CONFIRMED WITH FURNITURE MANUFACTURER.', 840, 1060, 424), // wrapped: one entry
    run('CR', 1205, 1217, 520), run('CARD READER', 1245, 1310, 520),               // another column, no heading above it
    run('SYMBOL', 205, 240, 600), run('DEVICE TYPE', 270, 340, 600), run('N/A', 205, 225, 640), run('REFER TO DETAILS', 260, 350, 640), // table headings and "N/A": not devices
    // an abbreviation list: four entries stacked a line apart, no heading
    run('AFF', 1500, 1520, 700), run('ABOVE FINISHED FLOOR', 1560, 1680, 700), run('AFG', 1500, 1520, 712), run('ABOVE FINISHED GRADE', 1560, 1680, 712),
    run('AHU', 1500, 1520, 724), run('AIR HANDLING UNIT', 1560, 1660, 724), run('AIC', 1500, 1520, 736), run('AMPERE INTERRUPTING CAPACITY', 1560, 1730, 736),
    // a sentence: words with an ordinary space between them are not symbol and description
    run('SHALL', 1000, 1030, 900), run('DETERMINE', 1034, 1090, 900),
    // the title block strip at the right edge
    run('E', 2800, 2810, 800), run('SPECIALTY', 2840, 2900, 800),
  ];
  return { runs, W, H };
}
test('legend: symbol letters and descriptions are paired; headings name the group; noise is left out', () => {
  const { runs, W, H } = legendPage();
  const rows = parseLegendPage(runs, W, H, 'Fire alarm');
  assert.deepEqual(rows.map((r) => r.code), ['AD', 'CR', 'F', 'FF', 'MM']);
  const by = (c: string) => rows.find((r) => r.code === c)!;
  assert.equal(by('F').name, 'MANUAL PULL STATION'); assert.equal(by('F').category, 'Initiating devices');   // from the heading above
  assert.equal(by('CR').category, 'Fire alarm');                                                              // no heading: the sheet's group
  assert.equal(by('MM').name, 'MONITOR MODULE');                                                              // the subscript sat lower than the line
  assert.equal(by('AD').name, 'CONNECTION TO AUTOMATIC DOORS.');                                              // not "J"
  assert.equal(by('FF').name, 'CONNECTION TO ELECTRIFIED FURNITURE, REQUIREMENTS TO BE');                     // the first line names it ...
  assert.match(by('FF').spec!, /CONFIRMED WITH FURNITURE MANUFACTURER/);                                      // ... the rest is the spec
  assert.ok(!rows.some((r) => ['SYMBOL', 'N/A', 'AFF', 'AFG', 'AHU', 'AIC', 'SHALL', 'E'].includes(r.code)));
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});
test('legend: group names and which disciplines are ticked by default', () => {
  assert.equal(legendCategory('FIRE ALARM LEGEND'), 'Fire alarm');
  assert.equal(legendCategory('ELECTRICAL LEGEND AND ABBREVIATIONS'), 'Electrical');
  assert.equal(legendCategory('GENERAL NOTES, LEGEND, AND ABBREVIATIONS'), 'Legend');
  for (const n of ['E0.0', 'FA0.00', 'SE0.00', 'T0.00', 'ES.01', 'EQ1.00', 'M0.2']) assert.equal(isCountableDiscipline(n), true, n);   // mechanical equipment is counted too
  for (const n of ['G-002', 'A0.05', 'S0.03', 'P0.1', 'C-201', null]) assert.equal(isCountableDiscipline(n), false, String(n));
});

test('equipment schedules: only a first-column tag is equipment, one item per tag, named from the table', () => {
  const T = (title: string, rows: string[][]) => ({ title, headers: ['UNIT NUMBER', 'LOCATION', 'SERVICE', 'CFM'], xs: [], headerY: 0, rows });
  const rows = textTablesToRows([
    T('PACKAGED ROOF TOP UNIT SCHEDULE (DX)', [['RTU-1', 'ROOF', 'RECEIVING', '4,000'], ['RTU-6', 'ROOF', 'PLENUM', '10,000']]),
    T('SEMI CUSTOM ROOF TOP UNIT SCHEDULE (DX) (CONT.)', [['RTU-6', 'R-454B', '350 A', '9']]),            // the same unit, second section, messier columns
    T('FAN SCHEDULE', [['EF-1', 'ROOF', 'GENERAL EXHAUST', '1000'], ['R-454B', 'ROOF', 'X', '1'], ['ADD-01', '09/03/2026', 'x', 'y']]), // a refrigerant name and an addendum number are not equipment
    T('VARIABLE FREQUENCY DRIVE SCHEDULE', [['VFD-1', 'RTU-1', 'SUPPLY FAN', '5']]),                      // RTU-1 here is what the drive serves, not a new unit
    { ...T('', [['EF-9', 'ROOF', 'X', '1']]) },                                                             // a table with no "SCHEDULE" title is not read
  ]);
  assert.deepEqual(rows.map((r) => r.code).sort(), ['EF-1', 'RTU-1', 'RTU-6', 'VFD-1']);
  assert.equal(rows.find((r) => r.code === 'RTU-6')!.name, 'Packaged roof top unit, ROOF, PLENUM');       // the cleaner first reading wins
  assert.equal(rows.find((r) => r.code === 'EF-1')!.category, 'Fan');
  assert.equal(rows.find((r) => r.code === 'VFD-1')!.name, 'Variable frequency drive, RTU-1, SUPPLY FAN');
});

import { stepIndex } from '../src/app/step.ts';
test('stepping through an item\'s counts wraps round and starts sensibly', () => {
  assert.equal(stepIndex(3, -1, 1), 0); assert.equal(stepIndex(3, -1, -1), 2);   // nothing selected yet
  assert.equal(stepIndex(3, 0, 1), 1); assert.equal(stepIndex(3, 2, 1), 0);       // forward, wrapping
  assert.equal(stepIndex(3, 0, -1), 2); assert.equal(stepIndex(3, 2, -1), 1);     // back, wrapping
  assert.equal(stepIndex(1, 0, 1), 0); assert.equal(stepIndex(0, -1, 1), -1);
});

import { itemRank, searchItems } from '../src/app/itemSearch.ts';
test('item search: tags are found however they are typed, codes rank above descriptions, words can come from anywhere', () => {
  const it = (code: string, name: string, spec: string | null = null) => ({ code, name, spec });
  const items = [it('BC-14', "4' strip, chain hung"), it('BC-18', "8' strip, chain hung"), it('BS-8', 'Surface mounted strip light'), it('PR-48', 'Pendant ring', 'LUMENWERX'), it('EX-1', 'Exit sign, single sided'), it('CR', 'Card reader'), it('D9', "4' surface/wet")];
  const codes = (q: string) => searchItems(q, items).map((i) => i.code);
  assert.deepEqual(codes('bc14'), ['BC-14']);
  assert.deepEqual(codes('BC 14'), ['BC-14']);
  assert.deepEqual(codes('bc-14'), ['BC-14']);
  assert.deepEqual(codes('bc'), ['BC-14', 'BC-18']);                       // codes starting with it, in order
  assert.deepEqual(codes('strip'), ['BC-14', 'BC-18', 'BS-8']);              // a word in the description
  assert.deepEqual(codes('exit single'), ['EX-1']);                          // several words, any order, all must be there
  assert.deepEqual(codes('lumenwerx'), ['PR-48']);                           // the spec counts too
  assert.deepEqual(codes('cr'), ['CR']);
  assert.equal(codes('zzz').length, 0);
  assert.equal(searchItems('   ', items).length, items.length);              // nothing typed: everything
  assert.equal(itemRank('d9', items[6]), 0); assert.equal(itemRank('d', items[6]), 1);
  // a code match beats a description match for the same text
  const mixed = [it('X1', 'Has an ex in its words'), it('EX-1', 'Exit sign')];
  assert.deepEqual(searchItems('ex', mixed).map((i) => i.code), ['EX-1', 'X1']);
  assert.deepEqual(searchItems('lights', [it('A', 'x')], () => 'Lights').map((i) => i.code), ['A']);   // the category too
});

import { buildTemplate, darkSmall, dropCounted, findSimilar, orientations } from '../src/detect/symbolSearch.ts';
const P = (x0: number, y0: number, x1: number, y1: number, n: number, fill = false, lum = 0): PrimT => ({ x0, y0, x1, y1, n, fill, lum });
// Devices as drawn on the plans: a square of four separate lines, a circle, and a multi-part symbol.
const square = (ox: number, oy: number, size = 15.7): PrimT[] => [P(ox, oy, ox + size, oy, 2), P(ox, oy + size, ox + size, oy + size, 2), P(ox, oy, ox, oy + size, 2), P(ox + size, oy, ox + size, oy + size, 2)];
const circle = (ox: number, oy: number): PrimT[] => [P(ox, oy, ox + 13.5, oy + 13.5, 18)];
const detector = (ox: number, oy: number): PrimT[] => [P(ox, oy + 8, ox + 15.6, oy + 23.4, 19), P(ox + 6.4, oy + 10.4, ox + 7.6, oy + 15.7, 5), P(ox + 7.6, oy + 15.7, ox + 8.8, oy + 21, 5), P(ox + 6.9, oy, ox + 6.9, oy + 2.3, 2), P(ox + 9.3, oy, ox + 9.3, oy + 6, 2)];
const T_ = (s: string, x: number, y: number) => ({ s, x, y });

test('similar symbols, no letters: a box that is loose, tight or off-centre finds every copy, and nothing that only looks a bit like it', () => {
  const prims: PrimT[] = [];
  for (const [x, y] of [[100, 100], [400, 120], [250, 500], [700, 640]]) prims.push(...detector(x, y));
  prims.push(...detector(100, 100));                                                  // CAD draws a shape twice, on top of itself
  prims.push(P(0, 300, 900, 300, 2), P(50, 0, 50, 900, 2), P(110, 90, 118, 98, 2, false, 0.6), P(500, 50, 515.6, 65.4, 19)); // walls, gray hatching, a bare circle
  const dark = darkSmall(prims);
  for (const box of [{ x0: 98, y0: 98, x1: 118, y1: 126 }, { x0: 90, y0: 90, x1: 130, y1: 140 }, { x0: 104, y0: 104, x1: 128, y1: 130 }]) {
    const t = buildTemplate(dark, [], box)!;
    assert.ok(t.sig.length >= 3);                                                      // an off-centre box can leave out the two small ticks above the circle
    assert.equal(findSimilar(dark, t).length, 4);
  }
  assert.deepEqual(findSimilar(dark, buildTemplate(dark, [], { x0: 498, y0: 48, x1: 518, y1: 68 })!), []);      // a lone circle with no letters: too generic to search for
  assert.equal(buildTemplate(dark, [], { x0: 800, y0: 800, x1: 850, y1: 850 }), null);                          // an empty box
});
test('similar symbols, letters: a plain square is told apart by its letters, and a neighbour cannot lend its letters', () => {
  const prims = [...square(100, 100), ...square(300, 100), ...square(500, 100), ...square(100, 300), ...square(300, 300), ...square(120, 130)]; // the last is unlabelled, right beside the first
  const texts = [T_('CR', 108, 108), T_('CR', 308, 108), T_('CR', 508, 108), T_('DC', 108, 308), T_('DC', 308, 308)];
  const t = buildTemplate(darkSmall(prims), texts, { x0: 92, y0: 92, x1: 124, y1: 124 })!;     // a loose box around the first CR
  assert.deepEqual(t.texts, ['CR']); assert.equal(t.inside, true);
  const found = findSimilar(darkSmall(prims), t, { texts });
  assert.deepEqual(found.map((m) => [Math.round(m.x), Math.round(m.y)]), [[108, 108], [308, 108], [508, 108]]);   // not the DC squares, not the unlabelled one
  const dc = buildTemplate(darkSmall(prims), texts, { x0: 92, y0: 292, x1: 124, y1: 324 })!;
  assert.equal(findSimilar(darkSmall(prims), dc, { texts }).length, 2);
});
test('similar symbols, letters beside the shape: a circle with its letters set below it', () => {
  const prims = [...circle(100, 100), ...circle(300, 100), ...circle(500, 100)];
  const texts = [T_('MM', 107, 118), T_('MM', 307, 118), T_('T', 507, 118), T_('1', 301, 116)];   // the second has a nearer, different label as well; the third is a different device
  const t = buildTemplate(darkSmall(prims), texts, { x0: 90, y0: 90, x1: 130, y1: 130 })!;
  assert.deepEqual(t.texts, ['MM']); assert.equal(t.inside, false);                                // learned the letters beside it, not inside
  assert.equal(findSimilar(darkSmall(prims), t, { texts }).length, 2);                              // the T circle is a different device
});
test('similar symbols: the same device drawn turned or mirrored is found', () => {
  const asym = (ox: number, oy: number, turned: boolean): PrimT[] => turned
    ? [P(ox, oy, ox + 20, oy + 10, 8), P(ox + 2, oy + 2, ox + 6, oy + 8, 4, true)]   // a 10 x 20 box turned to 20 x 10, its filled wedge now at the left
    : [P(ox, oy, ox + 10, oy + 20, 8), P(ox + 2, oy + 2, ox + 8, oy + 6, 4, true)];  // a 10 x 20 box with a filled wedge at the top
  const prims = [...asym(100, 100, false), ...asym(300, 100, true), ...asym(500, 100, false)];
  const t = buildTemplate(darkSmall(prims), [], { x0: 95, y0: 95, x1: 115, y1: 125 })!;
  assert.equal(findSimilar(darkSmall(prims), t).length, 3);
  assert.ok(orientations(t).length >= 4);
});
test('similar symbols: a box holding only a tag finds that tag; several pieces of text are refused; counted ones are skipped', () => {
  const texts = [T_('TS', 100, 100), T_('TS', 300, 100), T_('CR', 500, 100)];
  const t = buildTemplate([], texts, { x0: 95, y0: 95, x1: 115, y1: 108 })!;
  assert.deepEqual([t.sig.length, t.texts], [0, ['TS']]);
  assert.equal(findSimilar([], t, { texts }).length, 2);
  assert.deepEqual(findSimilar([], buildTemplate([], texts, { x0: 95, y0: 95, x1: 520, y1: 108 })!, { texts }), []);
  const m = [{ x: 108, y: 112, score: 1 }, { x: 408, y: 132, score: 1 }, { x: 258, y: 512, score: 1 }];
  assert.deepEqual(dropCounted(m, [{ x: 109, y: 111 }], 9).map((q) => q.x), [408, 258]);
});

import { singleItemOf } from '../src/app/selection.ts';
test('selection: the item of the selected counts, only when they all share one', () => {
  const dets = [{ id: 'a', item_type_id: 'I1' }, { id: 'b', item_type_id: 'I1' }, { id: 'c', item_type_id: 'I2' }];
  assert.equal(singleItemOf(dets, new Set(['a'])), 'I1');
  assert.equal(singleItemOf(dets, new Set(['a', 'b'])), 'I1');       // several of one item: that item
  assert.equal(singleItemOf(dets, new Set(['a', 'c'])), null);       // a mix: no single item
  assert.equal(singleItemOf(dets, new Set()), null);                 // nothing selected
  assert.equal(singleItemOf(dets, new Set(['zzz'])), null);          // an id that is not a count here
});

import { lengthFeetFromText } from '../src/detect/lengthText.ts';
test('fixture length from the schedule: stated lengths are read, ambiguous or variable ones give nothing', () => {
  // the lighting schedule you sent (LBA)
  assert.equal(lengthFeetFromText('SURFACE OR CHAIN MOUNTED, NOMINAL 3" X 3" X 4\'L LED STRIPLIGHT WITH WHITE STEEL HOUSING, DIFFUSING LENS AND INTEGRAL DRIVER.', 'ZL1D-L48-SMR-5000LM-FST-MVOLT-35K-80CRI-WH', '5337 LM'), 4);
  assert.equal(lengthFeetFromText('SURFACE OR CHAIN MOUNTED, NOMINAL 3" X 3" X 8\'L LED STRIPLIGHT WITH WHITE STEEL HOUSING', 'TZL1D-L96-SMR-10000LM'), 8);
  assert.equal(lengthFeetFromText("SURFACE MOUNTED, NOMINAL 8' L STRIP LIGHT WITH WIDE DISTRIBUTION, FROSTED LENS AND INTEGRAL DRIVER.", 'FEM L96 12000LM IMAFL WD'), 8);
  assert.equal(lengthFeetFromText('SEALED AND GASKETED, NOMINAL 2\'X2\' LED FLAT PANEL LUMINAIRE WITH OVERLAPPING DOORFRAME'), null);       // a panel, not a linear fixture
  assert.equal(lengthFeetFromText('RECESSED, NOMINAL 4"W X 4"D, CONTINUOUS LIGHTSLOT WITH SEAMLESS, FLUSH LENS', 'S4RD-LOP-LENGTH', '700 LM/LF'), null);   // per-foot rated: the plans decide
  assert.equal(lengthFeetFromText('UNDER-COUNTER LED STRIP LIGHT', 'LLI-ANG-W-F-3.5W-35K-24V', '240 LM/LF'), null);
  assert.equal(lengthFeetFromText('PENDANT MOUNTED, DIRECT/INDIRECT LINEAR LED PENDANT', 'LPX-4-B-SP-F-F-S8', '776/746 LM'), null);              // no length stated anywhere
  // the PSEB schedule
  assert.equal(lengthFeetFromText('LED 4 INCH DIRECT PENDANT SLOT, NOMINAL 4 INCH WIDE X 5 INCH TALL X 4 FEET LONG, EXTRUDED ALUMINUM HOUSING'), 4);
  assert.equal(lengthFeetFromText('LED DIRECT/INDIRECT PENDANT SLOT WITH MICRO-LOUVER INSERTS, NOMINAL 1-1/2 INCH WIDE X 3 INCH TALL X 8 FOOT LONG EXTRUDED ALUMINUM HOUSING'), 8);
  assert.equal(lengthFeetFromText('LED VAPOR-TIGHT LINEAR PENDANT, NOMINAL 4 FOOT LONG X 5-1/2 INCH TALL. ELECTRICAL CONTRACTOR TO PROVIDE LENGTH OF STAINLESS STEEL HANGER CHAIN AS REQUIRED.', '96-4-L62-8-30-DFR'), 4);   // L62 is not a length
  assert.equal(lengthFeetFromText('LED WRAPAROUND, NOMINAL 4-1/2 INCH WIDE X 4 INCH TALL X 4 FOOT LONG STEEL HOUSING, FIXTURE TO BE WALL-MOUNTED 6 INCHES ABOVE DOOR HEADER.', 'WL4-40L-EZ1'), 4);
  assert.equal(lengthFeetFromText('LED 4 FOOT LINEAR SLOT MODULE FOR USE IN TYPE T2/T3 TRACK SYSTEM, NOMINAL 3/4 INCH TALL X 4 FOOT LONG', 'PIVHLO-FH-4FT-SW-80CRI'), 4);
  assert.equal(lengthFeetFromText('DUAL-CIRCUIT SURFACE MOUNTED LOW VOLTAGE TRACK SYSTEM, NOMINAL 1-1/2 INCH WIDE X 2 INCH TALL X 6 FOOT LONG EXTRUDED ALUMINUM'), 6);
  assert.equal(lengthFeetFromText('LED LINEAR GRAZER, NOMINAL 1-1/2 INCH WIDE, PROVIDE 1 FOOT AND 4 FOOT FIXTURES MOUNTED END-TO-END AS REQUIRED FOR CONTINUOUS RUN LENGTHS INDICATED ON DRAWINGS'), null);
  assert.equal(lengthFeetFromText('LED SURFACE MOUNTED LINEAR GRAZER, PROVIDE 2 FOOT, 3 FOOT, AND 4 FOOT FIXTURES MOUNTED END-TO-END'), null);                  // several lengths: it depends
  assert.equal(lengthFeetFromText('LED 4 INCH DIRECT/INDIRECT PENDANT SLOT, NOMINAL 4 INCH WIDE, PROVIDE CONTINUOUS LENGTHS AS INDICATED ON ARCHITECTURAL DRAWINGS. PROVIDE ANY NOMINAL 6-FOOT FIXTURES AS A SINGLE HOUSING'), null);
  // catalog only
  assert.equal(lengthFeetFromText('LED LINEAR PENDANT', 'PIVS-CR-6FT0IN-UNV'), 6);
  assert.equal(lengthFeetFromText('LED WRAPAROUND STRIP', '75R-4-L50-8-30'), null);                                                                          // L50 is a lumen code
  assert.equal(lengthFeetFromText('LED 2X4 TROFFER, 4 FOOT LONG LAMP'), null);                                                                              // not a linear fixture type
});

import { findGridBubbles, inBubble } from '../src/detect/gridBubbles.ts';
// a page 3000 x 2000 pt; shapes as the extractor reports them, text as normalized runs
const GW = 3000, GH = 2000;
const ring = (cx: number, cy: number, d: number): PrimT => P(cx - d / 2, cy - d / 2, cx + d / 2, cy + d / 2, 5);
const gridRun = (s: string, x: number, y: number) => ({ str: s, cx: x / GW, cy: y / GH, w: 0.004, h: 0.004, rotated: false });
test('grid bubbles: a lettered column and a numbered row are found; repeated devices, a tight key list and a room tag are not', () => {
  const prims: PrimT[] = []; const runs: any[] = [];
  const put = (label: string, x: number, y: number, d: number) => { prims.push(ring(x, y, d)); runs.push(gridRun(label, x, y)); };
  ['D', 'E', 'F', 'G', 'H', 'J', 'K'].forEach((l, i) => put(l, 574, 212 + i * 285, 36));          // the lettered lines down the side
  ['2', '3', '4', '5', '6'].forEach((l, i) => put(l, 800 + i * 300, 90, 36));                       // the numbered lines along the top
  put('H.3', 574, 212 + 4 * 285 + 70, 36);                                                          // a sub-line, under two diameters from its neighbour
  for (let i = 0; i < 6; i++) put('S', 900 + i * 60, 1000, 13.5);                                   // six smoke detectors in a row: same label, small
  for (let i = 0; i < 4; i++) put('S', 1500, 600 + i * 120, 36);                                    // same size as a bubble, in a column, but all the same label
  ['R1', 'R2', 'SF', 'SJ'].forEach((l, i) => put(l, 236, 150 + i * 21, 12));                        // a key list: small and tight
  ['A', 'B', 'C'].forEach((l, i) => put(l, 2000, 300 + i * 40, 36));                                // distinct labels but touching each other: not spaced like a grid
  ['P101', 'P102', 'P103'].forEach((l, i) => put(l, 2400, 400 + i * 200, 36));                      // room tags: not grid labels
  const b = findGridBubbles(prims, runs, GW, GH);
  const labels = b.map((x) => x.label).sort();
  assert.deepEqual(labels, ['2', '3', '4', '5', '6', 'D', 'E', 'F', 'G', 'H', 'H.3', 'J', 'K'].sort());
  // a count whose text sits on a bubble is "in" it; one beside a device is not
  assert.equal(inBubble(574 / GW, (212 + 2 * 285) / GH, b), true);
  assert.equal(inBubble(900 / GW, 1000 / GH, b), false);
  assert.equal(inBubble(1500 / GW, 600 / GH, b), false);
  // only two lines of a grid visible: not enough to call it a grid
  assert.deepEqual(findGridBubbles([ring(100, 100, 36), ring(100, 400, 36)], [gridRun('A', 100, 100), gridRun('B', 100, 400)], GW, GH), []);
});
test('grid bubbles: Auto-count leaves them out and clears earlier automatic counts on them, never hand-placed ones', () => {
  const bubbles = [{ x: 0.2, y: 0.1, rx: 0.006, ry: 0.009, label: 'F' }];
  const base = { zones: [], itemIdByCode: new Map([['F', 'itF'], ['D9', 'itD9']]), ambiguous: new Set<string>(), clearItemIds: new Set<string>(), ignorePast: true, bubbles, newId: () => 'new' } as any;
  const hits = [{ code: 'F', x: 0.2, y: 0.1, kind: 'short', grid: true }, { code: 'F', x: 0.6, y: 0.6, kind: 'short' }, { code: 'D9', x: 0.5, y: 0.5, kind: 'tag' }];
  const existing = [det('grid-auto', 'itF', 0.1, 'auto', 'unreviewed', 0.2), det('grid-confirmed', 'itF', 0.1, 'auto', 'confirmed', 0.2), det('grid-manual', 'itF', 0.1, 'manual', 'confirmed', 0.2), det('real-F', 'itF', 0.6, 'auto', 'confirmed', 0.6)];
  const on = planSheetWrite({ ...base, leaveOutGrid: true, hits, existing });
  assert.equal(on.added, 1);                                                          // the real F at (0.6, 0.6) is already counted (kept); only D9 is new
  assert.deepEqual(on.ops.filter((o: any) => o.op === 'delete').map((o: any) => o.id).sort(), ['grid-auto', 'grid-confirmed']);
  assert.equal(on.removedGrid, 2);                                                    // the hand-placed one stays; so does the real F
  assert.ok(!on.ops.some((o: any) => o.op === 'add' && o.detection.x === 0.2));         // no new count on the bubble
  const off = planSheetWrite({ ...base, leaveOutGrid: false, hits, existing: [existing[3]] });
  assert.equal(off.removedGrid, 0);
  assert.ok(off.ops.some((o: any) => o.op === 'add' && o.detection.x === 0.2));         // switched off: the bubble is counted, as before
  assert.equal(planSheetWrite({ ...base, leaveOutGrid: false, hits: [], existing }).ops.filter((o: any) => o.op === 'delete').length, 0); // and nothing earlier is removed
});

// ---- a camera-like symbol: two rings of tiny segments, solid wedges, and curved outlines whose point count differs on every drawing ----
type Pt = [number, number];
const camPrim = (pts: Pt[], fill = false): PrimT => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), n: pts.length, fill, lum: 0, pts: pts.flat() }; // pts: as extractPrims keeps them
};
/** The symbol's shapes as point lists around (0,0): `wedges` 2 (top and bottom, lens arcs at the sides) or 4; `outlineN` points on each wedge outline. */
function cameraShapes(wedges: 2 | 4, outlineN: number): { pts: Pt[]; fill: boolean }[] {
  const out: { pts: Pt[]; fill: boolean }[] = [];
  for (const [r, count] of [[12.2, 28], [9, 20], [6.5, 16]] as const) for (let k = 0; k < count; k++) { // the rings (the outer one encloses the wedges, as a real camera's does): short straight segments
    const a0 = (k / count) * 2 * Math.PI, a1 = ((k + 1) / count) * 2 * Math.PI;
    out.push({ pts: [[r * Math.cos(a0), r * Math.sin(a0)], [r * Math.cos(a1), r * Math.sin(a1)]], fill: false });
  }
  const wedge = (a: number) => { // a quad (the solid wedge) and its curved outline, on the ring at angle a
    const at = (r: number, da: number): Pt => [r * Math.cos(a + da), r * Math.sin(a + da)];
    out.push({ pts: [at(7.5, -0.45), at(11.3, -0.45), at(11.3, 0.45), at(7.5, 0.45)], fill: true });
    out.push({ pts: Array.from({ length: outlineN }, (_, i) => at(7.5 + 3.8 * Math.abs(Math.sin((i / (outlineN - 1)) * Math.PI)), -0.45 + (0.9 * i) / (outlineN - 1))), fill: false });
  };
  wedge(-Math.PI / 2); wedge(Math.PI / 2);
  if (wedges === 4) { wedge(0); wedge(Math.PI); }
  else for (const a of [0, Math.PI]) out.push({ pts: Array.from({ length: 12 }, (_, i) => [8.5 * Math.cos(a + (i / 11 - 0.5) * 0.9), 8.5 * Math.sin(a + (i / 11 - 0.5) * 0.9)] as Pt), fill: false }); // a thin lens arc
  return out;
}
/** Put a copy on the page: turned by `deg`, optionally mirrored, centred at (cx, cy). */
const plant = (shapes: ReturnType<typeof cameraShapes>, cx: number, cy: number, deg = 0, mirror = false): PrimT[] => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return shapes.map((sh) => camPrim(sh.pts.map(([x, y]): Pt => { const X = mirror ? -x : x; return [cx + c * X - s * y, cy + s * X + c * y]; }), sh.fill));
};

test('similar symbols: a curve is a curve however many points its outline has, and a copy turned by any angle (or mirrored) is found', () => {
  const page: PrimT[] = [
    ...plant(cameraShapes(2, 46), 200, 200),             // the one the user boxes
    ...plant(cameraShapes(2, 10), 400, 200),             // the same symbol, its outlines drawn with 10 points instead of 46
    ...plant(cameraShapes(2, 59), 600, 200, 90),         // a quarter turn
    ...plant(cameraShapes(2, 37), 800, 200, 33),         // turned by an odd amount
    ...plant(cameraShapes(2, 20), 1000, 200, 147, true), // turned and mirrored
    ...plant(cameraShapes(2, 25), 1200, 200, 250),
    ...plant(cameraShapes(4, 46), 200, 400),             // a different device: four wedges
    ...plant(cameraShapes(4, 30), 400, 400, 45),
    P(0, 300, 1500, 300, 2), P(100, 0, 100, 600, 2),     // walls
  ];
  const t = buildTemplate(darkSmall(page), [], { x0: 185, y0: 185, x1: 215, y1: 215 })!;
  assert.ok(t.sig.length >= 40);
  const found = findSimilar(darkSmall(page), t);
  const at = (x: number, y: number) => found.some((m) => Math.hypot(m.x - x, m.y - y) < 8);
  for (const x of [200, 400, 600, 800, 1000, 1200]) assert.ok(at(x, 200), `the two-wedge camera at x=${x} should be found`);
  assert.ok(!at(200, 400) && !at(400, 400), 'the four-wedge camera is a different device');
  assert.equal(found.length, 6);
  // and the other way round: boxing a four-wedge camera finds the four-wedge ones (one of them turned 45 degrees), not the two-wedge ones
  const t4 = buildTemplate(darkSmall(page), [], { x0: 185, y0: 385, x1: 215, y1: 415 })!;
  const found4 = findSimilar(darkSmall(page), t4);
  assert.equal(found4.length, 2);
  assert.ok(found4.some((m) => Math.hypot(m.x - 200, m.y - 400) < 8) && found4.some((m) => Math.hypot(m.x - 400, m.y - 400) < 8));
});
test('similar symbols: a line drawn twice a hair apart counts once, and a small symbol is judged by the plain score', () => {
  const sq = (ox: number, oy: number, dbl = false): PrimT[] => [P(ox, oy, ox + 15.7, oy, 2), P(ox, oy + 15.7, ox + 15.7, oy + 15.7, 2), P(ox, oy, ox, oy + 15.7, 2), P(ox + 15.7, oy, ox + 15.7, oy + 15.7, 2), ...(dbl ? [P(ox + 16.4, oy, ox + 16.4, oy + 15.7, 2)] : [])];
  const page = [...sq(100, 100), ...sq(300, 100, true), ...sq(500, 100)];
  const texts = [{ s: 'CR', x: 108, y: 108 }, { s: 'CR', x: 308, y: 108 }, { s: 'CR', x: 508, y: 108 }];
  const t = buildTemplate(darkSmall(page), texts, { x0: 96, y0: 96, x1: 124, y1: 124 })!;
  assert.equal(t.sig.length, 4);
  assert.equal(findSimilar(darkSmall(page), t, { texts }).length, 3);   // the one with the doubled side is still a CR
  // a box that cuts off one side leaves a 3-shape example; the doubled copy still counts
  const cut = buildTemplate(darkSmall(page), texts, { x0: 96, y0: 96, x1: 112, y1: 124 });
  assert.ok(cut && findSimilar(darkSmall(page), cut, { texts }).length >= 3);
});

import { findCameras, cameraCode, cameraName } from '../src/detect/symbolContext.ts';
import { discover } from '../src/detect/codeRows.ts';
// ---- cameras counted from the label printed beside them ----
const segPrim = (ax: number, ay: number, bx: number, by: number): PrimT => ({ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), n: 2, fill: false, lum: 0, pts: [ax, ay, bx, by] });
/** A camera ring drawn as CAD does: dozens of tiny straight segments, an outer and an inner ring. */
const ringOf = (cx: number, cy: number): PrimT[] => {
  const out: PrimT[] = [];
  for (const [r, count] of [[13.5, 28], [9, 20]] as const) for (let k = 0; k < count; k++) {
    const a0 = (k / count) * 2 * Math.PI, a1 = ((k + 1) / count) * 2 * Math.PI;
    out.push(segPrim(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)));
  }
  return out;
};
/** A mounting line off the ring at `deg`, `len` long. */
const stemAt = (cx: number, cy: number, deg: number, len = 9): PrimT => { const a = (deg * Math.PI) / 180; return segPrim(cx + 13.5 * Math.cos(a), cy + 13.5 * Math.sin(a), cx + (13.5 + len) * Math.cos(a), cy + (13.5 + len) * Math.sin(a)); };
const stack = (cx: number, cy: number, kind: string, id = '01-43') => [{ s: kind, x: cx + 34, y: cy - 6 }, { s: id, x: cx + 34, y: cy + 8 }];

test('cameras: found from the label beside them, and sorted by how they are mounted', () => {
  const prims: PrimT[] = [...ringOf(200, 200), ...ringOf(500, 200), stemAt(500, 200, 90), ...ringOf(800, 200), stemAt(800, 200, 225, 7), ...ringOf(1100, 200), ...ringOf(1400, 200)];
  const texts = [
    ...stack(200, 200, '360°', '01-10'),                                   // a bare ring: ceiling
    ...stack(500, 200, '360°', '01-11'),                                   // a line straight off the ring: wall
    ...stack(800, 200, '180°', '01-12'),                                   // a line off a diagonal: wall
    ...stack(1100, 200, '360°', '01-13'), { s: 'PM', x: 1066, y: 200 },    // PM beside it: pole
    ...stack(1400, 200, 'F', '01-14'),                                     // an F over an ID: a fixed camera
  ];
  const cams = findCameras(prims, texts);
  const codes = cams.map((c) => cameraCode(c.kind, c.mount)).sort();
  assert.deepEqual(codes, ['180-WALL', '360-CLG', '360-PM', '360-WALL', 'F-CLG']);
  const pm = cams.find((c) => c.mount === 'pole')!;
  assert.equal(pm.mountFrom, 'text');
  assert.ok(Math.hypot(pm.x - 1100, pm.y - 200) < 2, 'the position is the ring centre');
  assert.equal(cameraName('180', 'wall'), '180° camera, wall mounted');
});
test('cameras: a word beside the symbol beats the lines, and belongs to the nearer ring', () => {
  const prims = [...ringOf(200, 200), stemAt(200, 200, 180), ...ringOf(330, 200)];
  const texts = [...stack(200, 200, '360°', '01-20'), { s: 'PM', x: 172, y: 200 }, ...stack(330, 200, '360°', '01-21'), { s: 'WM', x: 360, y: 218 }];
  const cams = findCameras(prims, texts).sort((a, b) => a.x - b.x);
  assert.deepEqual(cams.map((c) => [c.mount, c.mountFrom]), [['pole', 'text'], ['wall', 'text']]);   // PM beats the drawn line; WM is the second camera's
});
test('cameras: a degree sign is not a camera without its ID under it (a 90° dimension beside a pipe drawn as a ring)', () => {
  const prims = [...ringOf(200, 200)];
  assert.equal(findCameras(prims, [{ s: '90°', x: 234, y: 194 }]).length, 0);                       // a dimension: no ID under it
  assert.equal(findCameras(prims, [{ s: 'F', x: 234, y: 194 }]).length, 0);                         // a lone F
  assert.equal(findCameras([], [{ s: 'HOT WATER 120°', x: 100, y: 100 }]).length, 0);
  assert.equal(findCameras([], [{ s: 'F', x: 100, y: 100 }, { s: '75', x: 100, y: 112 }]).length, 0);                 // a strobe: F over its candela rating, not an ID
  // a camera whose ring was not found is still counted, from its label stack, with no ring
  const lone = findCameras([], stack(600, 600, '360°', 'C12'));
  assert.equal(lone.length, 1); assert.equal(lone[0].ring, null); assert.equal(lone[0].mount, 'ceiling');
});
test('cameras: Auto-count lists each bucket as its own row, named, with a marker shape that shows the mounting', () => {
  const hit = (code: string, kind: string, name: string, shape: string) => ({ code, kind, x: 0.5, y: 0.5, name, shape, glyph: '36' } as any);
  const rows = discover([{ sheet: { id: 's1' } as any, zones: [], hits: [hit('360-CLG', 'camera', '360° camera, ceiling mounted', 'circle'), hit('360-CLG', 'camera', '360° camera, ceiling mounted', 'circle'), hit('360-WALL', 'camera', '360° camera, wall mounted', 'square')] }]);
  assert.deepEqual(rows.map((r) => [r.code, r.kind, r.total, r.shape]), [['360-CLG', 'camera', 2, 'circle'], ['360-WALL', 'camera', 1, 'square']]);
  assert.equal(rows[0].name, '360° camera, ceiling mounted');
});

test('similar symbols: a symbol with a number beside it is found however it is turned; the number stays upright and must match', () => {
  const tri = (cx: number, cy: number, deg: number): PrimT => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return camPrim(([[0, -5], [5, 4], [-5, 4]] as Pt[]).map(([x, y]): Pt => [cx + c * x - s * y, cy + s * x + c * y]), true); };
  const square = (cx: number, cy: number): PrimT => camPrim([[cx - 5, cy - 5], [cx + 5, cy - 5], [cx + 5, cy + 5], [cx - 5, cy + 5]], true);
  const page = [tri(100, 100, 0), tri(300, 100, 180), tri(500, 100, 35), tri(700, 100, 0), square(900, 100), P(0, 160, 1000, 160, 2)];
  const texts = [
    { s: '2', x: 100, y: 107.5 },   // pointing up, its number just below (the example)
    { s: '2', x: 300, y: 92.5 },    // turned over: pointing down, its number now above
    { s: '2', x: 506, y: 94 },      // turned 35 degrees, the number still upright, as close beside it as in the example
    { s: '3', x: 700, y: 107.5 },   // the same triangle with another number: another device
    { s: '2', x: 900, y: 108.5 },   // a square with a 2: another symbol
  ];
  const t = buildTemplate(darkSmall(page), texts, { x0: 92, y0: 92, x1: 108, y1: 110 })!;
  assert.deepEqual([t.sig.length, t.texts], [1, ['2']]);
  const found = findSimilar(darkSmall(page), t, { texts });
  const at = (x: number) => found.some((m) => Math.abs(m.x - x) < 8 && Math.abs(m.y - 100) < 8);
  assert.ok(at(100) && at(300) && at(500), `pointing up, down and turned: ${JSON.stringify(found.map((m) => [Math.round(m.x), Math.round(m.y)]))}`);
  assert.ok(!at(700) && !at(900), 'another number, or another shape, is not this symbol');
  assert.equal(found.length, 3);
});

import { findTriangles, triangleCode, outletLabel } from '../src/detect/triangles.ts';
// ---- outlets drawn as a triangle with a label beside it ----
/** A triangle as CAD draws it: three separate lines, each twice; a solid one has its black laid over it as a filled box. */
const triangle = (cx: number, cy: number, deg: number, solid: boolean, side = 10.4): PrimT[] => {
  const R = side / Math.sqrt(3); const v = [0, 120, 240].map((k) => { const a = ((deg + 90 + k) * Math.PI) / 180; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  const out: PrimT[] = [];
  for (let i = 0; i < 3; i++) { const [a, b] = [v[i], v[(i + 1) % 3]]; out.push(segPrim(a[0], a[1], b[0], b[1]), segPrim(b[0], b[1], a[0], a[1])); }
  if (solid) { const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]); out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), n: 4, fill: true, lum: 0 }); }
  return out;
};
const circleRing = (cx: number, cy: number, r = 8.4, count = 28): PrimT[] => Array.from({ length: count }, (_, k) => { const a0 = (k / count) * 2 * Math.PI, a1 = ((k + 1) / count) * 2 * Math.PI; return segPrim(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)); });

test('triangle outlets: the triangle and its label are the device; a circle makes it the ceiling version, a hollow one is another device', () => {
  const prims = [
    ...triangle(100, 100, 0, true),                              // solid, "2": TRI-2
    ...triangle(300, 100, 90, true),                             // the same outlet turned: still TRI-2
    ...triangle(500, 100, 0, false),                             // hollow, "4": TRIO-4
    ...triangle(700, 100, 0, true), ...circleRing(700, 100),     // in a circle, "IPC": the ceiling camera outlet
    ...triangle(900, 100, 0, true),                              // plain "IPC": the wall one
    ...triangle(1100, 100, 0, true), ...circleRing(1100, 100),   // "IPC-PM": pendant, already says so
  ];
  const texts = [{ s: '2', x: 100, y: 88 }, { s: '2', x: 312, y: 100 }, { s: '4', x: 500, y: 88 }, { s: 'IPC', x: 718, y: 100 }, { s: 'IPC', x: 918, y: 100 }, { s: 'IPC-PM', x: 1122, y: 100 }];
  const codes = findTriangles(prims, texts).map(triangleCode).sort();
  assert.deepEqual(codes, ['IPC', 'IPC-CLG', 'IPC-PM', 'TRI-2', 'TRI-2', 'TRIO-4']);
});
test('triangle outlets: a revision delta, a flat fire alarm speaker, and words or ratings beside a triangle are not outlets', () => {
  const flat: PrimT[] = [segPrim(486, 107, 477.5, 107), segPrim(477.5, 107, 481.8, 102.8), segPrim(481.8, 102.8, 486, 107)];   // 8.6, 6, 6: a speaker under a strobe
  const prims = [...triangle(100, 100, 0, false, 14), ...flat, ...triangle(700, 100, 0, true), ...triangle(900, 100, 0, true), ...triangle(1100, 100, 0, true)];
  const texts = [{ s: '1', x: 100, y: 101 },   // inside: a revision delta
    { s: '75', x: 482, y: 114 },                // a strobe's candela rating, beside the flat speaker triangle
    { s: '100', x: 700, y: 88 }, { s: 'MORE', x: 900, y: 88 }, { s: 'IPTV', x: 1100, y: 88 }];
  const found = findTriangles(prims, texts);
  assert.deepEqual(found.filter((t) => t.label).map((t) => t.label), []);                                // none without the library
  assert.deepEqual(findTriangles(prims, texts, new Set(['IPTV'])).filter((t) => t.label).map((t) => t.label), ['IPTV']);   // a library code is fine
  assert.ok(outletLabel('2') && outletLabel('F2') && outletLabel('4AC') && outletLabel('WAP') && outletLabel('IPC-PM') && outletLabel('PT4'));
  assert.ok(!outletLabel('100') && !outletLabel('MORE') && !outletLabel('HANGING') && !outletLabel('SHWP-2'));
});

import { ceilingIndex, CEILING_TITLE } from '../src/detect/ceiling.ts';
// ---- the ceiling a fixture sits in, from the room's texture on a ceiling plan ----
test('ceiling types: a grid is a drop ceiling, isolated dashes are sheetrock, neither is open; curves and walls do not fool it', () => {
  const G = 0.49; const L = (x0: number, y0: number, x1: number, y1: number): PrimT => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), n: 2, fill: false, lum: G });
  const prims: PrimT[] = [];
  // a drop ceiling: a 2 ft grid (18 pt) over 0..360 x 0..360
  for (let v = 0; v <= 360; v += 18) { prims.push(L(0, v, 360, v)); prims.push(L(v, 0, v, 360)); }
  // sheetrock: dashes at all angles, each standing alone, over 500..800 x 0..300
  let k = 0; for (let x = 505; x < 800; x += 7) for (let y = 5; y < 300; y += 7) { const a = ((k++ * 37) % 180) * Math.PI / 180; prims.push(L(x, y, x + 1.6 * Math.cos(a) + 0.3, y + 1.6 * Math.sin(a) + 0.3)); }
  // open: nothing, apart from a door swing drawn as a chain of tiny pieces, and a room's two walls each way
  for (let i = 0; i < 20; i++) { const a0 = (i / 20) * Math.PI / 2, a1 = ((i + 1) / 20) * Math.PI / 2; prims.push(L(1000 + 30 * Math.cos(a0), 100 + 30 * Math.sin(a0), 1000 + 30 * Math.cos(a1), 100 + 30 * Math.sin(a1))); }
  prims.push(L(1100, 80, 1200, 80), L(1100, 110, 1200, 110), L(1130, 50, 1130, 150), L(1160, 50, 1160, 150));
  const ci = ceilingIndex(prims);
  assert.equal(ci.hasTextures, true);
  assert.equal(ci.at(180, 180), 'drop');
  assert.equal(ci.at(650, 150), 'sheetrock');
  assert.equal(ci.at(1015, 115), 'open');        // the door swing is not speckle
  assert.equal(ci.at(1145, 95), 'open');         // two walls each way are not a ceiling grid
  // a sheet with no ceiling textures (a power plan) gets no ceiling at all, not "open" everywhere
  const plain: PrimT[] = []; for (let i = 0; i < 600; i++) plain.push(L(i * 3, 0, i * 3, 400));
  assert.equal(ceilingIndex(plain).at(100, 100), null);
});
test('ceiling types: a sheet titled a ceiling plan is read with little texture; an untitled one must be textured all over', () => {
  // texture in one small area of a big sheet: a plan with much outside the work, like PSEB's
  const G = 0.67, LITE = 0.92;
  const L = (x0: number, y0: number, x1: number, y1: number, lum = G): PrimT => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), n: 2, fill: false, lum });
  const prims: PrimT[] = [];
  for (let v = 0; v <= 180; v += 18) prims.push(L(0, v, 180, v));                 // a 2x4 grid: 18 pt one way
  for (let v = 0; v <= 180; v += 36) prims.push(L(v, 0, v, 180));                 // 36 pt the other
  let k = 0; for (let x = 300; x < 480; x += 5) for (let y = 5; y < 180; y += 5) { const a = ((k++ * 41) % 180) * Math.PI / 180; prims.push(L(x, y, x + 0.7 * Math.cos(a) + 0.2, y + 0.7 * Math.sin(a) + 0.2, LITE)); }  // speckle in its own lighter grey, short dashes
  for (let i = 0; i < 600; i++) prims.push(L(600 + i, 1200, 600 + i, 1206));   // the rest of the sheet: walls, no texture (a few % textured, like PSEB)
  assert.equal(ceilingIndex(prims).at(90, 90), null);                             // untitled: too little of the sheet is textured
  const titled = ceilingIndex(prims, { titled: true });
  assert.equal(titled.at(90, 90), 'drop');                                         // 2x4 grid
  assert.equal(titled.at(390, 90), 'sheetrock');                                   // light-grey short speckle
  assert.equal(titled.at(900, 900), 'open');
  assert.ok(CEILING_TITLE.test('REFLECTED CEILING PLAN') && CEILING_TITLE.test('LIGHTING CEILING PLAN - LEVEL 1') && !CEILING_TITLE.test('POWER PLAN'));
});

import { breakerCounts, circuitProblems, circuitStats, nextFree, sumBreakers, type Circuit } from '../shared/panels.ts';
import { countGroupOf } from '../shared/countGroup.ts';
// ---- panels: circuits and breakers (the first schedule on 2E-604, LSDH1201) ----
const ckt = (circuit: number, kind: Circuit['kind'], breaker_amps: number | null, poles = 1, description: string | null = null): Circuit => ({ circuit, kind, breaker_amps, poles, description, load_kva: null });
const lsdh1201: Circuit[] = [
  ckt(1, 'load', 60, 3, 'LSH2201'), ckt(7, 'load', 60, 3, 'LSH1203'),
  ckt(2, 'load', 60, 3, 'LSH2202'), ckt(8, 'load', 60, 3, 'LSH1204'),
  ...Array.from({ length: 15 }, (_, i) => ckt(13 + 2 * i, 'space', null)), ...Array.from({ length: 15 }, (_, i) => ckt(14 + 2 * i, 'space', null)),
];
test('panels: breakers are counted once each by size and poles; spaces are not breakers', () => {
  assert.deepEqual(breakerCounts(lsdh1201), [{ amps: 60, poles: 3, qty: 4, spares: 0 }]);
  assert.deepEqual(circuitStats({ positions: 42 }, lsdh1201), { positions: 42, used: 12, spare: 0, space: 30, breakers: 4 });
  // a panel with spares: 20 A spares are breakers, counted (and noted as spares)
  const p2 = [ckt(1, 'load', 20, 1, 'EMERGENCY LIGHTING'), ckt(3, 'spare', 20), ckt(5, 'spare', 20), ckt(2, 'load', 30, 3, 'LSH1101'), ckt(13, 'space', null)];
  assert.deepEqual(breakerCounts(p2), [{ amps: 20, poles: 1, qty: 3, spares: 2 }, { amps: 30, poles: 3, qty: 1, spares: 0 }]);
  assert.deepEqual(circuitStats({ positions: 24 }, p2), { positions: 24, used: 4, spare: 2, space: 18, breakers: 4 });
  assert.deepEqual(sumBreakers([breakerCounts(lsdh1201), breakerCounts(p2)]).map((b) => [b.amps, b.poles, b.qty]), [[20, 1, 3], [30, 3, 1], [60, 3, 4]]);
});
test('panels: overlapping breakers, circuits past the panel and sizeless breakers are flagged; the next free position is found', () => {
  assert.deepEqual(circuitProblems({ positions: 42 }, lsdh1201), []);
  const bad = [ckt(1, 'load', 60, 3), ckt(5, 'load', 20), ckt(41, 'load', 20, 2), ckt(2, 'spare', null)];
  const probs = circuitProblems({ positions: 42 }, bad);
  assert.ok(probs.some((p) => p.includes('Circuit 5 is used twice')));
  assert.ok(probs.some((p) => p.includes('Circuit 43 is past')));
  assert.ok(probs.some((p) => p.includes('spare at circuit 2 has no size')));
  assert.equal(nextFree(lsdh1201.filter((c) => c.kind !== 'space'), 1, 42), 13);
  assert.equal(nextFree([ckt(1, 'load', 20), ckt(5, 'load', 20)], 2, 42), 2);   // 2 and 4 are free on the other side
  assert.equal(nextFree([ckt(1, 'load', 20), ckt(5, 'load', 20), ckt(2, 'load', 20, 3)], 2, 42), 7);   // a 2-pole needs two free positions on one side: 7 and 9
});
test('counting tabs: lighting is a fixture, everything else a device, unless set', () => {
  const cats = [{ id: 'r', name: 'Recessed' }, { id: 'c', name: 'Cameras' }, { id: 'o', name: 'Other' }];
  const it = (category_id: string | null, name: string, count_group: 'fixture' | 'device' | null = null) => ({ category_id, name, spec: null, count_group });
  assert.equal(countGroupOf(it('r', 'LED 2X2 TROFFER'), cats), 'fixture');
  assert.equal(countGroupOf(it('c', '360° camera'), cats), 'device');
  assert.equal(countGroupOf(it('o', 'LED WRAPAROUND STRIP LIGHT'), cats), 'fixture');
  assert.equal(countGroupOf(it(null, 'Duplex receptacle'), cats), 'device');
  assert.equal(countGroupOf(it('r', 'Occupancy sensor', 'device'), cats), 'device');   // set by the estimator
  // fire alarm: by its category or by what it is
  const fa = [...cats, { id: 'f', name: 'Fire alarm devices' }];
  assert.equal(countGroupOf(it('f', 'Addressable relay'), fa), 'fire_alarm');
  assert.equal(countGroupOf(it(null, 'Horn/strobe, 75 cd'), fa), 'fire_alarm');
  assert.equal(countGroupOf(it('o', 'Smoke detector'), fa), 'fire_alarm');
  assert.equal(countGroupOf(it('c', 'Duplex receptacle'), fa), 'device');
  assert.equal(countGroupOf(it('r', 'Exit sign w/ strobe', 'fire_alarm'), fa), 'fire_alarm');   // set by the estimator
});

import { isRemembered, keepSignInCookies, rawCookie, REMEMBER_DAYS, setRemembered } from '../src/auth/remember.ts';
// ---- remember me: the sign-in cookies outlive the browser only when asked ----
test('remember me: the sign-in cookies are kept for 30 days only when remembered, and signing out forgets', () => {
  // a fake browser: cookie jar and local storage
  const jar = new Map<string, string>(); const writes: string[] = [];
  const doc = { get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }, set cookie(v: string) { writes.push(v); const [kv] = v.split(';'); const [k, ...rest] = kv.split('='); jar.set(k.trim(), rest.join('=')); } };
  const mem = new Map<string, string>(); const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  jar.set('nf_jwt', 'eyJhbGciOi.abc%3D'); jar.set('nf_refresh', 'r3fr35h'); jar.set('other', 'x');
  assert.equal(keepSignInCookies(doc, store), 0);                     // not remembered: left as session cookies
  assert.equal(writes.length, 0);
  setRemembered(true, store);
  assert.equal(isRemembered(store), true);
  assert.equal(keepSignInCookies(doc, store), 2);                     // both sign-in cookies, nothing else
  assert.deepEqual(writes, [`nf_jwt=eyJhbGciOi.abc%3D; path=/; secure; samesite=lax; max-age=${REMEMBER_DAYS * 86400}`, `nf_refresh=r3fr35h; path=/; secure; samesite=lax; max-age=${REMEMBER_DAYS * 86400}`]);
  assert.equal(rawCookie('nf_jwt', doc), 'eyJhbGciOi.abc%3D');          // the value is kept exactly as the library wrote it
  setRemembered(false, store);                                        // sign out
  assert.equal(isRemembered(store), false);
  assert.equal(keepSignInCookies(doc, store), 0);
});

import { areaRows, headerLabel, readAreaTable, rowToItem, sectionName, suggestColumns } from '../src/detect/areaSchedule.ts';
// ---- reading a schedule from boxed areas (modeled on E7.11 / E7.12 and E0.01's special purpose receptacle schedule) ----
{
  const W = 3000, H = 2000;
  const run = (str: string, x0: number, y: number, w = str.length * 5) => ({ str, cx: (x0 + w / 2) / W, cy: y / H, w: w / W, h: 8 / H, rotated: false });
  const items = (t: NonNullable<ReturnType<typeof readAreaTable>>, ch: ReturnType<typeof suggestColumns>) => areaRows(t, ch.type!).map((r) => rowToItem(r, ch, t.columns));
  // a light fixture schedule
  const runs = [
    run('LUMINAIRE SCHEDULE (1 OF 2)', 400, 70),                                  // a title above the table
    run('TYPE', 145, 100), run('LOCATION', 190, 100), run('DESCRIPTION', 300, 100), run('DRIVER', 600, 100), run('WATTAGE', 700, 100), run('VOLTAGE', 760, 100),
    run('BASIS OF DESIGN', 950, 100), run('REMARKS', 1600, 100),
    run('A1-4', 145, 120), run('CLASSROOM', 190, 120), run("4' LED SUSPENDED LINEAR", 300, 120), run('INTEGRAL 0-10V', 600, 120), run('33', 700, 120), run('277 V', 760, 120), run('LEDALITE', 950, 120), run('1. FIXTURE SHALL DIM.', 1450, 120),
    run('FIXTURE', 300, 131), run('DIMMING TO 1%', 600, 131), run('#77-0-5-L-B-C-VD-04', 950, 131), run('2. ARCHITECT SHALL VERIFY FINISH', 1450, 131),
    run('*MOUNTING TO MATCH CEILING', 950, 142),
    run('C', 145, 170), run('OFFICE', 190, 170), run("2' X 2' LAY-IN TROFFER", 300, 170), run('INTEGRAL 0-10V', 600, 170), run('DAY-BRITE CFI', 950, 170),
    run('#2CAZ-G-20L-835', 950, 181),
    run('P', 145, 220), run('WALL PACK', 300, 220), run('GARDCO', 950, 220),     // a one-letter type
    run('RELAY / CIRCUIT', 2500, 100), run('L-1', 2500, 120), run('CORRIDOR', 2600, 120),   // a relay schedule beside it, outside the box
  ];
  const edges = [140, 185, 295, 595, 695, 755, 940, 1445, 2700];
  const vlines = edges.flatMap((x) => [{ x, y0: 92, y1: 108 }, { x, y0: 112, y1: 160 }, { x, y0: 160, y1: 210 }, { x, y0: 210, y1: 240 }]);
  const box = { x0: 130 / W, y0: 60 / H, x1: 2400 / W, y1: 260 / H };
  const pick = (t: NonNullable<ReturnType<typeof readAreaTable>>, names: string[]) => ({ ...suggestColumns(t.columns), extra: t.columns.map((c, i) => (names.includes(c.header) ? i : -1)).filter((i) => i >= 0) });

  test('read schedule: only the boxed area; the header block gives the columns; other columns go into the details under their header', () => {
    const t = readAreaTable(runs, box, { pageW: W, pageH: H, vlines })!;
    assert.deepEqual(t.columns.map((c) => c.header), ['TYPE', 'LOCATION', 'DESCRIPTION', 'DRIVER', 'WATTAGE', 'VOLTAGE', 'BASIS OF DESIGN', 'REMARKS']);
    const ch = suggestColumns(t.columns);
    assert.equal(ch.type, 0); assert.equal(ch.description, 2);
    assert.deepEqual(ch.extra, [1, 3, 4, 5, 6, 7]);                                  // everything else is read, unless unticked
    const two = pick(t, ['DRIVER', 'BASIS OF DESIGN']);
    assert.deepEqual(items(t, two), [
      { code: 'A1-4', name: "4' LED SUSPENDED LINEAR FIXTURE", spec: 'Driver: INTEGRAL 0-10V DIMMING TO 1% · Basis of design: LEDALITE #77-0-5-L-B-C-VD-04 *MOUNTING TO MATCH CEILING', section: null },
      { code: 'C', name: "2' X 2' LAY-IN TROFFER", spec: 'Driver: INTEGRAL 0-10V · Basis of design: DAY-BRITE CFI #2CAZ-G-20L-835', section: null },
      { code: 'P', name: 'WALL PACK', spec: 'Basis of design: GARDCO', section: null },            // a one-letter type is a row, not a heading
    ]);
  });
  test('read schedule: one small box per column reads the whole table; an ignore area leaves rows or columns out', () => {
    const small = (x0: number, x1: number) => ({ x0: x0 / W, y0: 92 / H, x1: x1 / W, y1: 126 / H });
    const t = readAreaTable(runs, [small(150, 175), small(320, 420), small(945, 1200)], { pageW: W, pageH: H, vlines })!;
    assert.deepEqual(t.columns.map((c) => c.header), ['TYPE', 'DESCRIPTION', 'BASIS OF DESIGN']);
    assert.deepEqual(items(t, suggestColumns(t.columns)).map((i) => i!.code), ['A1-4', 'C', 'P']);
    // an ignore area over row P, and one over the REMARKS column
    const zones = [{ x0: 120, y0: 212, x1: 2400, y1: 240 }, { x0: 1445, y0: 60, x1: 2400, y1: 260 }];
    const skip = (x: number, y: number) => zones.some((z) => x * W >= z.x0 && x * W <= z.x1 && y * H >= z.y0 && y * H <= z.y1);
    const t2 = readAreaTable(runs, box, { pageW: W, pageH: H, vlines, skip })!;
    assert.ok(!t2.columns.some((c) => c.header === 'REMARKS'));
    assert.deepEqual(items(t2, suggestColumns(t2.columns)).map((i) => i!.code), ['A1-4', 'C']);
  });
  test('read schedule: without ruling lines the columns still split; a remembered choice wins; no header means nothing is read', () => {
    const t = readAreaTable(runs, box, { pageW: W, pageH: H })!;
    assert.equal(t.columns[suggestColumns(t.columns, { type: 'LOCATION' }).type!].header, 'LOCATION');
    assert.ok(suggestColumns(t.columns, { skip: ['REMARKS'] }).extra.every((i) => t.columns[i].header !== 'REMARKS'));
    assert.deepEqual(items(t, suggestColumns(t.columns)).map((i) => i!.code), ['A1-4', 'C', 'P']);
    assert.equal(readAreaTable(runs, { x0: 2450 / W, y0: 110 / H, x1: 2800 / W, y1: 130 / H }, { pageW: W, pageH: H }), null);
  });

  // a special purpose receptacle schedule: stacked headers, group labels, section headings, lines only on data rows
  const R = (str: string, x0: number, y: number) => run(str, x0, y, str.length * 4.6);
  const spr = [
    R('SPECIAL PURPOSE RECEPTACLE SCHEDULE', 215, 961),
    R('C.B.', 381, 1009), R('BRANCH WIRING (SEE NOTES)', 439, 1009),
    R('TYPE', 117, 1024), R('NEMA', 160, 1024), R('CODE', 116, 1034), R('CLASS', 158, 1034), R('DESCRIPTION', 239, 1029),
    R('TRIP', 357, 1030), R('(AMPS)', 352, 1040), R('POLES', 395, 1035),
    R('CONDUCTOR', 439, 1030), R('SIZE', 456, 1040), R('GROUND', 513, 1030), R('SIZE', 522, 1040), R('CONDUIT', 577, 1030), R('SIZE', 586, 1040),
    R('NON-TWIST LOCK TYPE W/ GROUND', 117, 1069),
    R('A', 125, 1094), R('5-20R', 161, 1094), R('125V, 2P, 3W W/ GROUND - 20A', 198, 1094), R('20', 365, 1094), R('1', 412, 1094), R('3#10', 455, 1094), R('1#10', 517, 1094), R('3/4"', 585, 1094),
    R('U', 125, 1118), R('18-50R', 161, 1118), R('120/250V, 4P, 5W W/ GROUND - 50A', 198, 1118), R('50', 365, 1118), R('3', 412, 1118), R('4#6', 455, 1118), R('1#8', 517, 1118), R('1 1/4"', 585, 1118),
    R('TWIST LOCK TYPE W/ GROUND', 117, 1143),
    R('AA', 122, 1168), R('L5-20R', 160, 1168), R('125V, 2P, 3W W/ GROUND - 20A', 198, 1168), R('20', 365, 1168), R('1', 412, 1168), R('3#10', 455, 1168), R('1#10', 517, 1168), R('3/4"', 585, 1168),
  ];
  const cx = [107, 147, 197, 344, 389, 434, 496, 563, 629];
  const sprLines = [
    ...cx.map((x) => ({ x, y0: 1015, y1: 1050 })),                                // the header row's cells
    { x: 107, y0: 1050, y1: 1180 }, { x: 629, y0: 1050, y1: 1180 },              // the frame runs on past the section heading rows
    ...cx.flatMap((x) => [{ x, y0: 1082, y1: 1131 }, { x, y0: 1156, y1: 1180 }]), // the column lines: data rows only
  ];
  const sprBox = { x0: 100 / W, y0: 950 / H, x1: 640 / W, y1: 1110 / H };       // the title, the header and the first row: the read follows the rest

  test('read schedule: stacked headers and group labels name each column; section headings become the rows\' sections', () => {
    const t = readAreaTable(spr, sprBox, { pageW: W, pageH: H, vlines: sprLines })!;
    assert.deepEqual(t.columns.map((c) => c.header), ['TYPE CODE', 'NEMA CLASS', 'DESCRIPTION', 'C.B. TRIP (AMPS)', 'C.B. POLES', 'BRANCH WIRING (SEE NOTES) CONDUCTOR SIZE', 'BRANCH WIRING (SEE NOTES) GROUND SIZE', 'CONDUIT SIZE']);
    const ch = suggestColumns(t.columns);
    const got = items(t, ch);
    assert.deepEqual(got.map((i) => [i!.code, i!.section]), [['A', 'NON-TWIST LOCK TYPE W/ GROUND'], ['U', 'NON-TWIST LOCK TYPE W/ GROUND'], ['AA', 'TWIST LOCK TYPE W/ GROUND']]);
    assert.equal(got[0]!.spec, 'NEMA class: 5-20R · C.B. trip (amps): 20 · C.B. poles: 1 · Branch wiring conductor size: 3#10 · Branch wiring ground size: 1#10 · Conduit size: 3/4"');
    assert.equal(got[1]!.name, '120/250V, 4P, 5W W/ GROUND - 50A');                      // the heading after U is not added to U
    assert.equal(sectionName('TWIST LOCK TYPE W/ GROUND'), 'Twist lock type w/ ground');
    assert.equal(headerLabel('BASIS OF DESIGN'), 'Basis of design');
  });
  test('read schedule: an ignore area over a column leaves it out of the read', () => {
    const skip = (x: number, y: number) => x * W > 563 && x * W < 629 && y * H > 1000;   // the conduit column
    const t = readAreaTable(spr, sprBox, { pageW: W, pageH: H, vlines: sprLines, skip })!;
    assert.ok(!t.columns.some((c) => c.header.includes('CONDUIT')));
    assert.ok(!items(t, suggestColumns(t.columns))[0]!.spec!.includes('Conduit'));
  });
}
