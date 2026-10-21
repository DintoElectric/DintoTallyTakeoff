import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingFileRow, Detection, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { BATCH_MAX_OPS } from '../../shared/limits.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { extractPrims, type Prim } from '../detect/primitives.ts';
import { extractRuns } from '../detect/pageRuns.ts';
import { findGridBubbles, inBubble, type GridBubble } from '../detect/gridBubbles.ts';
import { ceilingIndex, type CeilingIndex } from '../detect/ceiling.ts';
import { buildTemplate, darkSmall, dropCounted, findSimilar, type SymbolMatch, type Template, type TextMark } from '../detect/symbolSearch.ts';
import { flushAll, getStore, type SheetStore } from './sheetStore.ts';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';

interface PageShapes { prims: Prim[]; texts: TextMark[]; bubbles: GridBubble[]; ceilings: CeilingIndex; width: number; height: number }
// Shapes of recently searched sheets, so changing the strictness does not read the drawing again.
const cache = new Map<string, PageShapes>();
async function shapesOf(sheet: SheetRow, file: DrawingFileRow): Promise<PageShapes> {
  const hit = cache.get(sheet.id);
  if (hit) return hit;
  const pdf = await loadFilePdf({ id: file.id, chunk_count: file.chunk_count });
  const page = await pdf.getPage(sheet.page);
  try {
    const r = await extractPrims(page, pdfjs.OPS, { keepPoints: true }); // the points let a turned symbol be told from another
    // The letters on the page too: a device is often a plain circle or square with its letters inside ("CR", "MM").
    const runs = await extractRuns(page);
    const texts = runs.filter((m) => m.str.trim()).map((m) => ({ s: m.str, x: m.cx * r.width, y: m.cy * r.height }));
    const out = { prims: darkSmall(r.prims), texts, bubbles: findGridBubbles(r.prims, runs, r.width, r.height), ceilings: ceilingIndex(r.prims), width: r.width, height: r.height };
    cache.set(sheet.id, out);
    if (cache.size > 6) cache.delete(cache.keys().next().value as string);
    return out;
  } finally { page.cleanup(); }
}

const STRICT = [{ v: 0.95, label: 'Exact copies only' }, { v: 0.85, label: 'Close (recommended)' }, { v: 0.7, label: 'Loose: partly hidden or crowded symbols' }];
const label = (s: SheetRow) => s.number ?? `page ${s.page}`;
/** What the search is looking for, in words, so a wrong box is easy to spot. */
function describe(t: Template): string {
  const letters = t.texts.length ? ` with “${t.texts.join(' ')}” in it` : '';
  if (t.sig.length === 0) return `the text “${t.texts[0]}”`;
  return `a symbol of ${t.sig.length === 1 ? 'one shape' : `${t.sig.length} shapes`}${letters}, in any orientation`;
}

interface Row { sheet: SheetRow; matches: SymbolMatch[]; width: number; height: number; skipped: number }

/**
 * "Count similar": the estimator boxed one symbol; every look-alike on the sheet (and optionally the other counting
 * sheets) is found and counted as the chosen item, once they have looked at the numbers.
 */
export default function SimilarDialog({ current, box, sheets, files, item, store, onClose, onDone }: {
  current: SheetRow; box: { a: { x: number; y: number }; b: { x: number; y: number } }; sheets: SheetRow[]; files: DrawingFileRow[];
  item: ItemTypeRow; store: SheetStore | null; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<'prep' | 'review' | 'search' | 'write'>('prep');
  const [score, setScore] = useState(0.85);
  const [rows, setRows] = useState<Row[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState('');
  const [others, setOthers] = useState(false);
  const tpl = useRef<Template | null>(null);
  const [looking, setLooking] = useState('');
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const targets = useMemo(() => [current, ...(others ? sheets.filter((s) => s.id !== current.id) : [])], [current, others, sheets]);

  // Build the example from the current sheet, then search every target sheet.
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        setPhase(tpl.current ? 'search' : 'prep');
        const cf = fileById.get(current.file_id);
        if (!cf) throw new Error('The drawing file is not available.');
        if (!tpl.current) {
          const here = await shapesOf(current, cf);
          const b = { x0: Math.min(box.a.x, box.b.x) * here.width, y0: Math.min(box.a.y, box.b.y) * here.height, x1: Math.max(box.a.x, box.b.x) * here.width, y1: Math.max(box.a.y, box.b.y) * here.height };
          const t = buildTemplate(here.prims, here.texts, b);
          if (!t) throw new Error('I could not see a symbol in that box. Drag a box around one symbol, including any letters inside it.');
          if (t.sig.length === 0 && t.texts.length !== 1) throw new Error('That box holds several pieces of text and no symbol. Box one symbol, or one tag.');
          if (t.sig.length < 2 && t.texts.length === 0) throw new Error('That symbol is a single plain shape with no letters in it, which would match far too much. Include its letters or more of its detail in the box.');
          tpl.current = t;
          setLooking(describe(t));
        }
        const t = tpl.current;
        await flushAll();
        const out: Row[] = [];
        for (let i = 0; i < targets.length; i++) {
          if (off) return;
          const s = targets[i];
          setProgress(`Sheet ${i + 1} of ${targets.length}: ${label(s)}`);
          const f = fileById.get(s.file_id);
          if (!f) continue;
          const shapes = await shapesOf(s, f);
          // The letters and numbers in grid-line bubbles are not devices, however much they look like the example.
          const found = findSimilar(shapes.prims, t, { minScore: score, texts: shapes.texts }).filter((m) => !inBubble(m.x / shapes.width, m.y / shapes.height, shapes.bubbles));
          // Already counted as this item (a second run, or hand-placed): left out.
          const { detections } = await api<{ detections: Detection[] }>(`/sheets/${s.id}/detections`);
          const counted = detections.filter((d) => d.item_type_id === item.id && d.status !== 'rejected').map((d) => ({ x: d.x * shapes.width, y: d.y * shapes.height }));
          const fresh = dropCounted(found, counted, Math.max(8, Math.max(t.w, t.h) * 0.6));
          if (found.length > 0 || s.id === current.id) out.push({ sheet: s, matches: fresh, width: shapes.width, height: shapes.height, skipped: found.length - fresh.length });
          await new Promise((r) => setTimeout(r, 0));
        }
        if (off) return;
        setRows(out);
        setPick(new Set(out.filter((r) => r.matches.length > 0 && r.matches.length <= 400).map((r) => r.sheet.id)));
        setPhase('review');
      } catch (e) { if (!off) { setError(e instanceof Error ? e.message : 'The search failed.'); setPhase('review'); } }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score, others]);

  const total = rows.filter((r) => pick.has(r.sheet.id)).reduce((n, r) => n + r.matches.length, 0);

  async function add() {
    setPhase('write');
    setError(null);
    try {
      let n = 0;
      for (const r of rows) {
        if (!pick.has(r.sheet.id) || r.matches.length === 0) continue;
        // the ceiling each one sits in, on a ceiling plan
        const ceil = cache.get(r.sheet.id)?.ceilings;
        const pts = r.matches.map((m) => ({ x: Math.min(1, Math.max(0, m.x / r.width)), y: Math.min(1, Math.max(0, m.y / r.height)), ceiling: ceil?.at(m.x, m.y) ?? undefined }));
        if (r.sheet.id === current.id && store) store.placeMany(item.id, pts);   // one undo step, saved with the other edits
        else {
          const ops = pts.map((p) => ({ op: 'add', detection: { id: crypto.randomUUID(), item_type_id: item.id, x: p.x, y: p.y, bbox: null, confidence: null, source: 'manual', status: 'confirmed', ...(p.ceiling ? { ceiling: p.ceiling } : {}) } }));
          for (let i = 0; i < ops.length; i += BATCH_MAX_OPS) await api(`/sheets/${r.sheet.id}/detections/batch`, { body: { ops: ops.slice(i, i + BATCH_MAX_OPS) } });
          void getStore(r.sheet.id).load(true);
        }
        n += pts.length;
      }
      onDone(`${plural(n, 'count')} added as ${item.code}. Undo (Ctrl+Z) takes back the ones on this sheet.`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not add the counts.');
      setPhase('review');
    }
  }

  const busy = phase === 'prep' || phase === 'search' || phase === 'write';
  return (
    <Dialog title="Count similar symbols" onClose={phase === 'write' ? () => undefined : onClose} wide>
      <div className="dialog-title">Count similar symbols as {item.code}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        Finds every symbol that looks like the one you boxed, and counts it as <b>{item.code}</b> ({item.name}). Look at the numbers, then add them.
      </div>
      {looking && <div className="dim" style={{ fontSize: 12 }}>Looking for {looking}.</div>}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 260 }}>
          <label htmlFor="sm">How alike</label>
          <select id="sm" className="input" value={score} disabled={busy} onChange={(e) => setScore(Number(e.target.value))}>
            {STRICT.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </div>
        {sheets.length > 1 && (
          <Check checked={others} disabled={busy} onChange={setOthers}>Also search the other {plural(sheets.length - 1, 'counting sheet')}</Check>
        )}
      </div>
      {busy && <div className="stack"><div className="muted" style={{ fontSize: 13 }}><span className="spinner" /> {phase === 'write' ? 'Adding the counts…' : progress || 'Reading the symbol…'}</div></div>}
      {phase === 'review' && !error && (
        <div style={{ maxHeight: 260, overflow: 'auto' }} className="stack">
          {rows.every((r) => r.matches.length === 0) && <div className="banner">No symbols like that {rows.some((r) => r.skipped > 0) ? 'that are not already counted' : 'were found'}. Try “Loose”, or box the symbol again a little more tightly.</div>}
          {rows.filter((r) => r.matches.length > 0 || r.skipped > 0).map((r) => (
            <Check key={r.sheet.id} checked={pick.has(r.sheet.id)} onChange={(v) => setPick((cur) => { const n = new Set(cur); if (v) n.add(r.sheet.id); else n.delete(r.sheet.id); return n; })}>
              <b>{label(r.sheet)}</b> <span className="dim">{r.sheet.title ?? ''}</span>
              <span className="tag tag-neutral" style={{ marginLeft: 6 }}>{plural(r.matches.length, 'symbol')}</span>
              {r.skipped > 0 && <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>{r.skipped} already counted</span>}
              {r.matches.length > 400 && <span className="err-text" style={{ fontSize: 12, marginLeft: 6 }}>That many suggests the box caught something common</span>}
            </Check>
          ))}
        </div>
      )}
      {error && <div className="err-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'write'}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void add()} disabled={busy || total === 0}>Add {plural(total, 'count')}</button>
      </div>
    </Dialog>
  );
}
