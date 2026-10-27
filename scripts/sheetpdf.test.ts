// The drawing export, checked by reading its output back with the same PDF reader the app uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, rgb, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildSheetPdf, sheetPdfName, winAnsi } from '../src/export/sheetPdf.ts';
import { extractPrims } from '../src/detect/primitives.ts';

const open = async (bytes: Uint8Array) => pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;

/** A two-page "drawing set"; the second page is landscape and turned 90° (as some CAD exports are), with a black box on it. */
async function drawingSet(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([300, 200]).drawText('Cover', { x: 20, y: 100 });
  const p = d.addPage([600, 400]);
  p.setRotation(degrees(90));
  p.drawRectangle({ x: 100, y: 50, width: 40, height: 20, color: rgb(0, 0, 0) });
  // a markup on the page, as Bluebeam leaves them (a stamp)
  const annot = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [200, 200, 260, 230], Contents: PDFString.of('Counted') }));
  p.node.set(PDFName.of('Annots'), d.context.obj([annot]));
  return d.save();
}

async function exportPage2(marks: { x: number; y: number; shape: any }[] | null, list = false) {
  const source = await drawingSet();
  const doc = await open(source);
  const page = await doc.getPage(2);
  const vp = page.getViewport({ scale: 1 });
  const bytes = await buildSheetPdf({
    source, pageIndex: 1, viewport: { width: vp.width, height: vp.height }, toPdfPoint: (x, y) => vp.convertToPdfPoint(x, y), marks,
    list: list ? { title: 'Test project · E1.01 LIGHTING PLAN', subtitle: 'Counts on this sheet', groups: [{ name: 'Fixtures', rows: [{ code: 'BC-14', name: "4' strip", n: 2 }] }, { name: 'Devices', rows: [{ code: 'EX-1', name: 'Exit sign', n: 1 }] }] } : null,
  });
  return { source, page, vp, out: await open(bytes) };
}

test('drawing export without counts: the original page, unchanged, alone', async () => {
  const { page, out } = await exportPage2(null);
  assert.equal(out.numPages, 1);
  const a = await page.getOperatorList(), b = await (await out.getPage(1)).getOperatorList();
  assert.deepEqual(b.fnArray, a.fnArray);                                     // the same drawing, nothing added
  assert.equal((await page.getAnnotations()).length, 1);                    // the original has a markup
  assert.equal((await (await out.getPage(1)).getAnnotations()).length, 0);  // the export leaves it out, as the app does
  const vp2 = (await out.getPage(1)).getViewport({ scale: 1 });
  assert.equal(vp2.width, 400); assert.equal(vp2.height, 600);               // still turned: shown 400 wide, 600 tall
});

test('drawing export with counts: each marker lands where its count is on the page as shown (a turned page too)', async () => {
  const marks = [{ x: 0.25, y: 0.5, shape: 'circle' }, { x: 0.7, y: 0.2, shape: 'square' }, { x: 0.5, y: 0.85, shape: 'diamond' }];
  const { vp, out } = await exportPage2(marks as any);
  assert.equal(out.numPages, 1);
  const p = await out.getPage(1);
  const { prims } = await extractPrims(p, pdfjs.OPS);
  for (const m of marks) {
    const x = m.x * vp.width, y = m.y * vp.height;
    const near = prims.filter((q: any) => Math.abs((q.x0 + q.x1) / 2 - x) < 1.5 && Math.abs((q.y0 + q.y1) / 2 - y) < 1.5 && q.x1 - q.x0 > 5);
    assert.ok(near.length > 0, `a ${m.shape} marker at (${x.toFixed(0)}, ${y.toFixed(0)})`);
  }
  // the drawing itself is still there: the black box
  assert.ok(prims.some((q: any) => q.fill && q.lum < 0.1 && Math.round(q.x1 - q.x0) === 20 && Math.round(q.y1 - q.y0) === 40));
});

test('drawing export: a page listing the counts, by fixtures and devices, with the total', async () => {
  const { out } = await exportPage2([{ x: 0.5, y: 0.5, shape: 'circle' }], true);
  assert.equal(out.numPages, 2);
  const text = (await (await out.getPage(2)).getTextContent()).items.map((i: any) => i.str).join(' ');
  for (const s of ['E1.01 LIGHTING PLAN', 'Fixtures', 'BC-14', "4' strip", 'Devices', 'EX-1', 'All counts', '3']) assert.ok(text.includes(s), s);
});

test('drawing export: file names and text the standard PDF fonts can write', () => {
  assert.equal(sheetPdfName('E1.01', 'LIGHTING PLAN', 4, true), 'E1.01 LIGHTING PLAN - counts.pdf');
  assert.equal(sheetPdfName(null, null, 7, false), 'Page 7.pdf');
  assert.equal(sheetPdfName('E1.01', 'POWER/SIGNAL: LEVEL 1', 1, false), 'E1.01 POWER-SIGNAL- LEVEL 1.pdf');
  assert.equal(winAnsi('360° camera – 4×'), '360° camera – 4×');
  assert.equal(winAnsi('Ω ≥ 2'), '? ? 2');
});
