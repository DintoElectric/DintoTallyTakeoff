import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  ArrowCounterClockwise, ArrowClockwise, Cursor, Eraser, Export, MagicWand, MagnifyingGlassMinus, MagnifyingGlassPlus,
  PlusCircle, Plus, Selection, Stack, WarningCircle,
} from '@phosphor-icons/react';
import type { CategoryRow, CountRow, DrawingFileRow, ItemTypeRow, ProjectRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Seg, Symbol, TopBar, plural, useToast } from '../app/ui.tsx';
import { navigate, paths } from '../app/router.ts';
import { useFetch } from '../app/useFetch.ts';
import { DrawingView, type DrawingViewHandle, type ItemStyle, type MarkerData, type Tool } from '../viewer/DrawingView.tsx';
import { loadFilePdf } from '../viewer/pdf.ts';
import { useSheetStore } from './sheetStore.ts';
import { ItemDialog } from './ItemDialog.tsx';
import ExportDialog from './ExportDialog.tsx';

const STATUS_DOT = { not_counted: 'not_counted', needs_review: 'needs_review', reviewed: 'reviewed' } as const;
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function Workspace({ projectId, sheetId }: { projectId: string; sheetId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const readOnly = me?.role === 'viewer';

  const project = useFetch<{ project: ProjectRow }>(`/projects/${projectId}`);
  const sheetsQ = useFetch<{ sheets: SheetRow[] }>(`/sheets?project=${projectId}`);
  const filesQ = useFetch<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
  const itemsQ = useFetch<{ items: ItemTypeRow[] }>('/items');
  const catsQ = useFetch<{ categories: CategoryRow[] }>('/categories');
  const countsQ = useFetch<{ counts: CountRow[] }>(`/projects/${projectId}/counts`);

  const sheets = sheetsQ.data?.sheets ?? [];
  const sheet = sheets.find((s) => s.id === sheetId) ?? null;
  const items = itemsQ.data?.items ?? [];
  const categories = catsQ.data?.categories ?? [];
  const threshold = project.data?.project.review_threshold ?? 0.85;

  const { store, snap } = useSheetStore(sheetId);
  const [tool, setTool] = useState<Tool>('select');
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [scope, setScope] = useState<'sheet' | 'all'>('sheet');
  const [onlyActive, setOnlyActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoomPct, setZoomPct] = useState(100);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const viewRef = useRef<DrawingViewHandle>(null);

  // ----- load the sheet's detections, and refresh counts after each saved batch -----
  useEffect(() => { void store?.load(); }, [store]);
  const refreshTimer = useRef<number>();
  const { reload: reloadCounts } = countsQ;
  const { reload: reloadSheets } = sheetsQ;
  useEffect(() => {
    if (!store) return;
    store.onSaved = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => { void reloadCounts(); void reloadSheets(); }, 800);
    };
    return () => { store.onSaved = null; };
  }, [store, reloadCounts, reloadSheets]);
  useEffect(() => { setSelected(new Set()); }, [sheetId]);

  // Default the active item to the first library item.
  useEffect(() => {
    if (!activeItemId && items.length) setActiveItemId(items[0].id);
    if (activeItemId && items.length && !items.some((i) => i.id === activeItemId)) setActiveItemId(items[0]?.id ?? null);
  }, [items, activeItemId]);

  // ----- drawing: load the PDF for this sheet's file, then the page -----
  const file = filesQ.data?.files.find((f) => f.id === sheet?.file_id) ?? null;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfPct, setPdfPct] = useState(0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!file) return;
    let off = false;
    setPdfError(null);
    setPdfPct(0);
    loadFilePdf({ id: file.id, chunk_count: file.chunk_count }, (p) => { if (!off) setPdfPct(p); })
      .then((d) => { if (!off) setPdf(d); })
      .catch((e) => { if (!off) setPdfError(e instanceof Error ? e.message : 'The drawings could not be loaded.'); });
    return () => { off = true; };
  }, [file?.id, file?.chunk_count, attempt]);

  useEffect(() => {
    if (!pdf || !sheet) return;
    let off = false;
    setPage(null);
    pdf.getPage(sheet.page)
      .then((p) => {
        if (off) return;
        const vp = p.getViewport({ scale: 1 });
        setPageDims({ w: vp.width, h: vp.height });
        setPage(p);
      })
      .catch(() => { if (!off) setPdfError("This page couldn't be read."); });
    return () => { off = true; };
  }, [pdf, sheet?.page, sheet?.id]);

  // ----- derived data -----
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const styles = useMemo(() => new Map<string, ItemStyle>(items.map((i) => [i.id, { shape: i.marker_shape, glyph: i.marker_glyph }])), [items]);

  const markers: MarkerData[] = useMemo(
    () => snap.dets
      .filter((d) => !onlyActive || d.item_type_id === activeItemId)
      .map((d) => ({ id: d.id, x: d.x, y: d.y, itemId: d.item_type_id, flagged: d.status === 'unreviewed' && d.confidence !== null && d.confidence < threshold })),
    [snap.dets, onlyActive, activeItemId, threshold],
  );

  // Counts are always derived from detections (never stored constants).
  const localByItem = useMemo(() => {
    const m = new Map<string, { n: number; flagged: number }>();
    for (const d of snap.dets) {
      const e = m.get(d.item_type_id) ?? { n: 0, flagged: 0 };
      e.n++;
      if (d.status === 'unreviewed' && d.confidence !== null && d.confidence < threshold) e.flagged++;
      m.set(d.item_type_id, e);
    }
    return m;
  }, [snap.dets, threshold]);

  const otherSheetCounts = useMemo(() => (countsQ.data?.counts ?? []).filter((c) => c.sheet_id !== sheetId), [countsQ.data, sheetId]);
  const shown = useMemo(() => {
    const m = new Map<string, { n: number; flagged: number }>();
    if (scope === 'sheet') localByItem.forEach((v, k) => m.set(k, { ...v }));
    else {
      for (const c of otherSheetCounts) { const e = m.get(c.item_type_id) ?? { n: 0, flagged: 0 }; e.n += c.n; e.flagged += c.flagged; m.set(c.item_type_id, e); }
      localByItem.forEach((v, k) => { const e = m.get(k) ?? { n: 0, flagged: 0 }; e.n += v.n; e.flagged += v.flagged; m.set(k, e); });
    }
    return m;
  }, [scope, localByItem, otherSheetCounts]);
  const totalShown = [...shown.values()].reduce((s, v) => s + v.n, 0);
  const flaggedShown = [...shown.values()].reduce((s, v) => s + v.flagged, 0);

  const sheetTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of otherSheetCounts) m.set(c.sheet_id, (m.get(c.sheet_id) ?? 0) + c.n);
    m.set(sheetId, snap.dets.length);
    return m;
  }, [otherSheetCounts, sheetId, snap.dets.length]);

  const grouped = useMemo(() => {
    const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorized';
    const order = (id: string | null) => categories.find((c) => c.id === id)?.sort ?? 1e6;
    const groups = new Map<string, { name: string; order: number; items: ItemTypeRow[] }>();
    for (const it of items) {
      const k = it.category_id ?? '_';
      const g = groups.get(k) ?? { name: catName(it.category_id), order: order(it.category_id), items: [] };
      g.items.push(it);
      groups.set(k, g);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order);
  }, [items, categories]);

  // ----- actions -----
  const place = useCallback((x: number, y: number) => {
    if (!store) return;
    if (!activeItemId) return toast('Pick an item type on the right first.');
    store.place(activeItemId, x, y);
  }, [store, activeItemId, toast]);

  const deleteSelected = useCallback(() => {
    if (!store || readOnly || selected.size === 0) return;
    store.erase([...selected]);
    setSelected(new Set());
  }, [store, readOnly, selected]);

  async function setReviewed(reviewed: boolean) {
    if (!sheet) return;
    try {
      await api(`/sheets/${sheet.id}`, { method: 'PATCH', body: { count_status: reviewed ? 'reviewed' : 'needs_review' } });
      void sheetsQ.reload();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update the sheet.'); }
  }

  // ----- keyboard -----
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea, [role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (readOnly) return; if (e.shiftKey) store?.redo(); else store?.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); if (!readOnly) store?.redo(); return; }
      if (mod) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select');
      else if (k === 'a' && !readOnly) setTool('add');
      else if (k === 'b') setTool('box');
      else if (k === 'e' && !readOnly) setTool('erase');
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [store, readOnly, deleteSelected]);

  // ----- missing sheet -----
  if (sheetsQ.data && !sheet) {
    return (
      <>
        <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: project.data?.project.name ?? '…', to: paths.project(projectId) }, { label: 'Sheet not found' }]} />
        <div className="empty" style={{ margin: 40 }}>
          <div>That sheet no longer exists.</div>
          <button className="btn btn-primary" onClick={() => navigate(paths.project(projectId))}>Back to the drawing set</button>
        </div>
      </>
    );
  }

  const listSheets = sheets.filter((s) => s.count_enabled || s.id === sheetId);
  const saveText = snap.save.kind === 'saving' ? 'Saving…' : snap.save.kind === 'error' ? (snap.save.message ?? "Couldn't save. Retrying…") : snap.save.at ? `Saved ${fmtTime(snap.save.at)}` : '';
  const editorHint = snap.lastEditor && snap.lastEditor.id !== me?.id && Date.now() - new Date(snap.lastEditor.at).getTime() < 5 * 60 * 1000 ? `Also open: ${snap.lastEditor.name}` : null;
  const activeItem = activeItemId ? itemById.get(activeItemId) : null;
  const sheetLabel = sheet ? [sheet.number, sheet.title].filter(Boolean).join(' · ') || `Page ${sheet.page}` : '…';

  return (
    <>
      <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: project.data?.project.name ?? '…', to: paths.project(projectId) }, { label: sheetLabel }]}>
        {editorHint && <span className="save-state">{editorHint}</span>}
        {saveText && <span className={`save-state${snap.save.kind === 'error' ? ' err' : ''}`} role="status">{saveText}</span>}
        <button className="btn btn-secondary" disabled title="Auto-detect arrives in a later stage. Count manually for now."><MagicWand size={14} /> Auto-detect sheet</button>
        <button className="btn btn-primary" onClick={() => setShowExport(true)}><Export size={14} /> Export</button>
      </TopBar>

      <div className="ws">
        {/* left: sheet list */}
        <aside className="ws-left" aria-label="Sheets">
          <div className="row-between" style={{ padding: '14px 16px 4px' }}><h6 style={{ margin: 0 }}>Sheets</h6><span className="dim num" style={{ fontSize: 12 }}>{listSheets.length}</span></div>
          <div className="list">
            {listSheets.map((s) => (
              <button key={s.id} className={`sheet-row${s.id === sheetId ? ' cur' : ''}`} onClick={() => navigate(paths.sheet(projectId, s.id))}>
                <span className={`dot ${STATUS_DOT[s.count_status]}`} aria-label={s.count_status.replace('_', ' ')} />
                <span style={{ minWidth: 0 }}><div className="t1">{s.number ?? `Page ${s.page}`}</div><div className="t2">{s.title ?? ''}</div></span>
                <span className="num" style={{ fontSize: 12 }}>{sheetTotals.get(s.id) ?? 0}</span>
              </button>
            ))}
            {sheetsQ.loading && !sheetsQ.data && <div className="muted" style={{ padding: 12 }}><span className="spinner" /> Loading…</div>}
          </div>
          <div className="dot-legend">
            <div><span className="dot reviewed" /> Counted and reviewed</div>
            <div><span className="dot needs_review" /> Needs review</div>
            <div><span className="dot not_counted" /> Not counted</div>
          </div>
        </aside>

        {/* center: drawing */}
        <section className="ws-center">
          <div className="toolbar" role="toolbar" aria-label="Counting tools">
            <button className={`tool${tool === 'select' ? ' on' : ''}`} onClick={() => setTool('select')} aria-label="Select (V)" title="Select (V)"><Cursor size={18} /></button>
            <button className={`tool${tool === 'add' ? ' on' : ''}`} onClick={() => setTool('add')} disabled={readOnly} aria-label="Add count (A)" title="Add count (A)"><PlusCircle size={18} /></button>
            <button className={`tool${tool === 'box' ? ' on' : ''}`} onClick={() => setTool('box')} aria-label="Box select (B)" title="Box select (B)"><Selection size={18} /></button>
            <button className={`tool${tool === 'erase' ? ' on' : ''}`} onClick={() => setTool('erase')} disabled={readOnly} aria-label="Erase (E)" title="Erase (E)"><Eraser size={18} /></button>
            <span className="sep" />
            <button className="tool" onClick={() => store?.undo()} disabled={readOnly || !snap.canUndo} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)"><ArrowCounterClockwise size={18} /></button>
            <button className="tool" onClick={() => store?.redo()} disabled={readOnly || !snap.canRedo} aria-label="Redo (Shift+Ctrl+Z)" title="Redo (Shift+Ctrl+Z)"><ArrowClockwise size={18} /></button>
            <span className="sep" />
            <span className="muted" style={{ fontSize: 12 }}>Counting:</span>
            {activeItem ? <span className="tag tag-accent">{activeItem.code}</span> : <span className="tag tag-neutral">No item</span>}
            <div style={{ flex: 1 }} />
            <button className="tool" onClick={() => viewRef.current?.zoomBy(1 / 1.3)} aria-label="Zoom out"><MagnifyingGlassMinus size={18} /></button>
            <button className="btn btn-ghost" style={{ minWidth: 52 }} onClick={() => viewRef.current?.fit()} title="Fit to screen">{zoomPct}%</button>
            <button className="tool" onClick={() => viewRef.current?.zoomBy(1.3)} aria-label="Zoom in"><MagnifyingGlassPlus size={18} /></button>
            <button className={`btn btn-secondary`} onClick={() => setOnlyActive(!onlyActive)} aria-pressed={onlyActive} title="Show all markers, or only the active item's">
              <Stack size={14} /> {onlyActive && activeItem ? `Only ${activeItem.code}` : 'All items'}
            </button>
          </div>
          <div className="canvas-wrap">
            {page && pageDims ? (
              <DrawingView
                ref={viewRef} page={page} pageW={pageDims.w} pageH={pageDims.h} markers={markers} styles={styles}
                activeItemId={activeItemId} selected={selected} tool={tool} readOnly={readOnly}
                onPlace={place}
                onPick={(id, add) => setSelected((cur) => { if (!id) return add ? cur : new Set(); const n = new Set(add ? cur : []); if (add && cur.has(id)) n.delete(id); else n.add(id); return n; })}
                onErase={(id) => store?.erase([id])}
                onBox={(ids, add) => setSelected((cur) => new Set(add ? [...cur, ...ids] : ids))}
                onZoom={setZoomPct}
                onError={(m) => setPdfError(m)}
              />
            ) : (
              <div className="viewport-msg">
                {pdfError ? (
                  <div className="stack" style={{ alignItems: 'center' }}><div className="err-text">{pdfError}</div><button className="btn btn-secondary" onClick={() => setAttempt((a) => a + 1)}>Try again</button></div>
                ) : (
                  <div><span className="spinner" /> {file && pdfPct < 1 ? `Loading drawings… ${Math.round(pdfPct * 100)}%` : 'Opening sheet…'}</div>
                )}
              </div>
            )}
            {snap.loadError && <div className="viewport-msg" style={{ background: 'color-mix(in srgb, var(--color-bg) 85%, transparent)' }}><div className="stack" style={{ alignItems: 'center' }}><div className="err-text">{snap.loadError}</div><button className="btn btn-secondary" onClick={() => void store?.load(true)}>Try again</button></div></div>}
          </div>
        </section>

        {/* right: counts */}
        <aside className="ws-right" aria-label="Counts">
          <div className="head">
            <div className="row-between"><h5 style={{ margin: 0 }}>Counts</h5><span className="muted num" style={{ fontSize: 13 }}>{plural(totalShown, 'item')}</span></div>
            <Seg name="scope" value={scope} onChange={setScope} options={[{ value: 'sheet', label: 'This sheet' }, { value: 'all', label: 'All sheets' }]} />
            {selected.size > 0 && (
              <div className="hint" role="status">
                <span style={{ flex: 1 }}>{plural(selected.size, 'marker')} selected</span>
                {!readOnly && (
                  <>
                    <select className="input" style={{ width: 130, minHeight: 28 }} value="" aria-label="Change selected to…" onChange={(e) => { if (e.target.value) { store?.retype([...selected], e.target.value); } }}>
                      <option value="">Change to…</option>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
                    </select>
                    <button className="btn btn-secondary" style={{ minHeight: 28, padding: '2px 10px' }} onClick={deleteSelected}>Delete</button>
                  </>
                )}
              </div>
            )}
            {tool === 'add' && !activeItem && items.length > 0 && <div className="hint">Pick an item type below, then click the drawing.</div>}
          </div>
          <div className="items">
            {itemsQ.loading && !itemsQ.data && <div className="muted" style={{ padding: 12 }}><span className="spinner" /> Loading…</div>}
            {!itemsQ.loading && items.length === 0 && (
              <div className="empty">
                <div>No items yet.</div>
                <div className="dim">Add the fixtures and devices you count, or build the library from the Item library screen.</div>
                {!readOnly && <button className="btn btn-primary" onClick={() => setShowItemDialog(true)}><Plus size={14} /> Add item type</button>}
              </div>
            )}
            {grouped.map((g) => (
              <div key={g.name}>
                <div className="cat-h">{g.name}</div>
                {g.items.map((it) => {
                  const c = shown.get(it.id) ?? { n: 0, flagged: 0 };
                  return (
                    <button key={it.id} className={`item-row${it.id === activeItemId ? ' sel' : ''}`} onClick={() => setActiveItemId(it.id)} aria-pressed={it.id === activeItemId}>
                      <Symbol shape={it.marker_shape} glyph={it.marker_glyph} active={it.id === activeItemId} />
                      <span style={{ minWidth: 0 }}><div className="n1">{it.name}</div><div className="n2">{[it.code, it.spec].filter(Boolean).join(' · ')}</div></span>
                      {c.flagged > 0 ? <span className="tag tag-outline">{c.flagged} to review</span> : <span />}
                      <span className="cnt num">{c.n}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {items.length > 0 && !readOnly && <div style={{ padding: '8px 4px' }}><button className="btn btn-ghost" onClick={() => setShowItemDialog(true)}><Plus size={14} /> Add item type</button></div>}
          </div>
          <div className="foot">
            <div className="row" style={{ gap: 8 }}><WarningCircle size={16} /><span>{plural(flaggedShown, 'low-confidence detection')}</span></div>
            <button className="btn btn-secondary btn-block" disabled title="Review stepping arrives with auto-detect (a later stage). Manual counts are never flagged.">Review flagged items</button>
            {!readOnly && sheet && (
              sheet.count_status === 'reviewed'
                ? <button className="btn btn-secondary btn-block" onClick={() => setReviewed(false)}>Reopen sheet</button>
                : <button className="btn btn-secondary btn-block" onClick={() => setReviewed(true)}>Mark sheet reviewed</button>
            )}
          </div>
        </aside>
      </div>

      {showItemDialog && (
        <ItemDialog categories={categories} onClose={() => setShowItemDialog(false)} onCreated={(it) => { setShowItemDialog(false); setActiveItemId(it.id); void itemsQ.reload(); }} />
      )}
      {showExport && project.data && <ExportDialog projectId={projectId} projectName={project.data.project.name} sheets={sheets} currentSheetId={sheetId} onClose={() => setShowExport(false)} onGoReview={() => setShowExport(false)} />}
    </>
  );
}
