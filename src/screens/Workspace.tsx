import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  ArrowCounterClockwise, ArrowClockwise, Cursor, Eraser, Eye, EyeSlash, Polygon, Shapes, Export, MagicWand, MagnifyingGlassMinus, MagnifyingGlassPlus, PlusCircle, Plus, Selection, Stack, WarningCircle, Crosshair, MagnifyingGlass, Hand,
} from '@phosphor-icons/react';
import type { CategoryRow, CountRow, DrawingFileRow, ItemTypeRow, ProjectRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Check, Dialog, Seg, Symbol, TopBar, plural, useToast } from '../app/ui.tsx';
import { navigate, paths } from '../app/router.ts';
import { useFetch } from '../app/useFetch.ts';
import { DrawingView, type DrawingViewHandle, type ItemStyle, type MarkerData, type Tool } from '../viewer/DrawingView.tsx';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';
import { extractPrims } from '../detect/primitives.ts';
import { ceilingIndex, CEILING_LABEL, type Ceiling, type CeilingIndex } from '../detect/ceiling.ts';
import { flushAll, getStore, useSheetStore } from './sheetStore.ts';
import { extractRuns } from '../detect/pageRuns.ts';
import { findMatchlines, zonesFromMatchlines } from '../detect/matchlines.ts';
import { inZones, type Zone, type ZonePoint } from '../../shared/zones.ts';
import { areaKey, areaNames, assignAreas, type AreaCountRow, type AreaRow } from '../../shared/areas.ts';
import AreaNameDialog from './AreaNameDialog.tsx';
import AutoCountDialog from './AutoCountDialog.tsx';
import { ItemDialog } from './ItemDialog.tsx';
import SimilarDialog from './SimilarDialog.tsx';
import { stepIndex } from '../app/step.ts';
import { singleItemOf } from '../app/selection.ts';
import { searchItems } from '../app/itemSearch.ts';
import ExportDialog from './ExportDialog.tsx';

const STATUS_DOT = { not_counted: 'not_counted', needs_review: 'needs_review', reviewed: 'reviewed' } as const;
const AREA_COLORS = ['#1f8a7e', '#d9480f', '#1c6aa8', '#8a3ffc', '#b7791f', '#2b8a3e', '#c2255c', '#5c677d'];
/** The same name always gets the same colour. */
const areaColor = (name: string) => { let h = 0; for (const c of areaKey(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AREA_COLORS[h % AREA_COLORS.length]; };
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function Workspace({ projectId, sheetId }: { projectId: string; sheetId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const readOnly = me?.role === 'viewer';

  const project = useFetch<{ project: ProjectRow }>(`/projects/${projectId}`);
  const sheetsQ = useFetch<{ sheets: SheetRow[] }>(`/sheets?project=${projectId}`);
  const filesQ = useFetch<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
  const itemsQ = useFetch<{ items: ItemTypeRow[] }>(`/items?project=${projectId}`);
  const catsQ = useFetch<{ categories: CategoryRow[] }>(`/categories?project=${projectId}`);
  const countsQ = useFetch<{ counts: CountRow[] }>(`/projects/${projectId}/counts`);
  const areasQ = useFetch<{ areas: AreaRow[] }>(`/sheets/${sheetId}/areas`);                              // this sheet's areas
  const areaTotalsQ = useFetch<{ names: string[]; rows: AreaCountRow[] }>(`/projects/${projectId}/area-counts`); // names and counts, project-wide

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
  const [cardOpen, setCardOpen] = useState(false);                       // the active item's details and actions, in the panel
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null); // bring an item's row into view after a marker is clicked
  const [confirmClear, setConfirmClear] = useState(false);
  const [query, setQuery] = useState('');                              // search the items listed in the panel
  const [onlyCounted, setOnlyCounted] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [keepHand, setKeepHand] = useState(false);
  const [hideMarkers, setHideMarkers] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoomPct, setZoomPct] = useState(100);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [similarBox, setSimilarBox] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null); // example symbol boxed for Count similar
  const [showExport, setShowExport] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const viewRef = useRef<DrawingViewHandle>(null);

  // ----- load the sheet's detections, and refresh counts after each saved batch -----
  useEffect(() => { void store?.load(); }, [store]);
  const refreshTimer = useRef<number>();
  const { reload: reloadCounts } = countsQ;
  const { reload: reloadSheets } = sheetsQ;
  const { reload: reloadAreaTotals } = areaTotalsQ;
  useEffect(() => {
    if (!store) return;
    store.onSaved = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => { void reloadCounts(); void reloadSheets(); void reloadAreaTotals(); }, 800);
    };
    return () => { store.onSaved = null; };
  }, [store, reloadCounts, reloadSheets, reloadAreaTotals]);
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
  // On a ceiling plan: which ceiling (drop, sheetrock, open) each spot is in, read from the room textures once per sheet
  const [ceil, setCeil] = useState<{ ci: CeilingIndex; w: number; h: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [autoZones, setAutoZones] = useState<Zone[]>([]);   // worked out from the matchlines
  const [draft, setDraft] = useState<ZonePoint[]>([]);         // outline being drawn with the zone tool
  const [zonesOpen, setZonesOpen] = useState(false);
  const [areasOpen, setAreasOpen] = useState(false);
  const [pendingArea, setPendingArea] = useState<ZonePoint[] | null>(null); // outline waiting for a name
  const [areaFilter, setAreaFilter] = useState('__all');                     // '__all', '__none', or an area name

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

  // Automatic zones: the part of the sheet past each matchline (it belongs to the neighbouring sheet).
  useEffect(() => {
    setAutoZones([]);
    if (!page || !sheet) return;
    let off = false;
    extractRuns(page).then((runs) => { if (!off) setAutoZones(zonesFromMatchlines(findMatchlines(runs, sheet.number))); }).catch(() => undefined);
    return () => { off = true; };
  }, [page, sheet?.id, sheet?.number]); // eslint-disable-line react-hooks/exhaustive-deps

  // The zones in force: the estimator's own if they have set any, otherwise the automatic ones.
  const zonesShown: Zone[] = sheet?.exclusion_zones ?? autoZones;
  const zonesByHand = sheet?.exclusion_zones != null;
  useEffect(() => { setDraft([]); }, [sheetId]);

  // ----- derived data -----
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const styles = useMemo(() => new Map<string, ItemStyle>(items.map((i) => [i.id, { shape: i.marker_shape, glyph: i.marker_glyph }])), [items]);

  const markers: MarkerData[] = useMemo(
    () => (hideMarkers ? [] : snap.dets)
      .filter((d) => !onlyActive || d.item_type_id === activeItemId)
      .map((d) => ({ id: d.id, x: d.x, y: d.y, itemId: d.item_type_id, flagged: d.status === 'unreviewed' && d.confidence !== null && d.confidence < threshold })),
    [snap.dets, onlyActive, activeItemId, threshold, hideMarkers],
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

  // Named count areas: this sheet's own, and counts per area (this sheet worked out here, so edits show at once).
  const sheetAreas = areasQ.data?.areas ?? [];
  const allAreaNames = useMemo(() => areaNames([...(areaTotalsQ.data?.names ?? []).map((name) => ({ name })), ...sheetAreas]), [areaTotalsQ.data, sheetAreas]);
  const localAreaRows = useMemo(
    () => assignAreas(snap.dets.map((d) => ({ sheet_id: sheetId, item_type_id: d.item_type_id, x: d.x, y: d.y, flagged: d.status === 'unreviewed' && d.confidence !== null && d.confidence < threshold })), sheetAreas),
    [snap.dets, sheetAreas, sheetId, threshold],
  );
  const otherAreaRows = useMemo(() => (areaTotalsQ.data?.rows ?? []).filter((r) => r.sheet_id !== sheetId), [areaTotalsQ.data, sheetId]);

  const shown = useMemo(() => {
    const m = new Map<string, { n: number; flagged: number }>();
    const bump = (item: string, n: number, flagged: number) => { const e = m.get(item) ?? { n: 0, flagged: 0 }; e.n += n; e.flagged += flagged; m.set(item, e); };
    if (areaFilter !== '__all') {
      // Only the counts that fall inside the chosen area (or in no area at all).
      const want = areaFilter === '__none' ? null : areaFilter;
      const rows = scope === 'sheet' ? localAreaRows : [...otherAreaRows, ...localAreaRows];
      for (const r of rows) if (want === null ? r.area === null : r.area !== null && areaKey(r.area) === areaKey(want)) bump(r.item_type_id, r.n, r.flagged);
      return m;
    }
    if (scope === 'sheet') localByItem.forEach((v, k) => m.set(k, { ...v }));
    else {
      for (const c of otherSheetCounts) bump(c.item_type_id, c.n, c.flagged);
      localByItem.forEach((v, k) => bump(k, v.n, v.flagged));
    }
    return m;
  }, [scope, areaFilter, localByItem, otherSheetCounts, localAreaRows, otherAreaRows]);
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

  // The items listed in the panel: by category, or (when searching) the best matches first.
  const listGroups = useMemo(() => {
    const counted = (it: ItemTypeRow) => (shown.get(it.id)?.n ?? 0) > 0;
    const keep = (list: ItemTypeRow[]) => (onlyCounted ? list.filter(counted) : list);
    if (query.trim()) {
      const hits = searchItems(query, keep(items), (it) => categories.find((c) => c.id === it.category_id)?.name ?? '');
      return [{ name: `${plural(hits.length, 'match', 'matches')} for “${query.trim()}”`, order: 0, items: hits }];
    }
    return grouped.map((g) => ({ ...g, items: keep(g.items) })).filter((g) => g.items.length > 0);
  }, [grouped, items, categories, query, onlyCounted, shown]);
  const openItem = (id: string) => { setActiveItemId(id); setCardOpen(true); setScrollTo({ id, n: Date.now() }); };

  useEffect(() => {
    setCeil(null);
    if (!page) return;
    let off = false;
    (async () => {
      const r = await extractPrims(page, pdfjs.OPS);
      if (off) return;
      const ci = ceilingIndex(r.prims);
      setCeil(ci.hasTextures ? { ci, w: r.width, h: r.height } : null);
    })().catch(() => undefined);   // no ceiling types on this sheet: nothing is lost
    return () => { off = true; };
  }, [page]);
  const ceilingAt = useCallback((x: number, y: number): Ceiling | undefined => ceil?.ci.at(x * ceil.w, y * ceil.h) ?? undefined, [ceil]);

  // ----- actions -----
  const place = useCallback((x: number, y: number) => {
    if (!store) return;
    if (!activeItemId) return toast('Pick an item type on the right first.');
    store.place(activeItemId, x, y, ceilingAt(x, y));
  }, [store, activeItemId, toast, ceilingAt]);
  // Fills in the ceiling of every count on this sheet that has none (made before this was read, or by another way).
  const readCeilings = () => {
    if (!store || !ceil || readOnly) return;
    const updates = snap.dets.filter((d) => d.status !== 'rejected').map((d) => ({ id: d.id, ceiling: ceilingAt(d.x, d.y) })).filter((u): u is { id: string; ceiling: Ceiling } => !!u.ceiling);
    const n = store.setCeilings(updates);
    toast(n ? `Read the ceiling of ${plural(n, 'count')} on this sheet.` : 'Every count on this sheet already has its ceiling.');
  };

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

  // ----- review queue: unreviewed counts, lowest confidence first -----
  const queue = useMemo(
    () => snap.dets.filter((d) => d.status === 'unreviewed')
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1) || a.y - b.y || a.x - b.x),
    [snap.dets],
  );
  const reviewIndex = reviewId ? queue.findIndex((d) => d.id === reviewId) : -1;
  const current = reviewIndex >= 0 ? queue[reviewIndex] : null;

  const focusDet = useCallback((id: string | null) => {
    setReviewId(id);
    const d = id ? snap.dets.find((x) => x.id === id) : null;
    if (d) { setSelected(new Set([d.id])); viewRef.current?.centerOn(d.x, d.y, 6); }
  }, [snap.dets]);

  const startReview = () => {
    if (queue.length === 0) return toast('Nothing to review on this sheet.');
    setReviewing(true);
    focusDet(queue[0].id);
  };
  const stepAfter = (nextId: string | undefined) => { if (nextId) focusDet(nextId); else { setReviewing(false); setReviewId(null); setSelected(new Set()); toast('Review finished for this sheet.'); } };
  const reviewAct = (kind: 'confirm' | 'reject') => {
    if (!current || !store) return;
    const next = queue[reviewIndex + 1]?.id ?? queue.find((d) => d.id !== current.id)?.id;
    if (kind === 'confirm') store.setStatus([current.id], 'confirmed'); else store.setStatus([current.id], 'rejected');
    stepAfter(next);
  };
  const confirmAllShown = () => {
    if (!store || queue.length === 0) return;
    store.setStatus(queue.map((d) => d.id), 'confirmed');
    setReviewing(false); setReviewId(null);
    toast(`Confirmed ${plural(queue.length, 'count')} on this sheet.`);
  };

  // ----- exclusion zones -----
  async function saveZones(next: Zone[] | null, message: string) {
    if (!sheet) return;
    try {
      const r = await api<{ sheet: SheetRow }>(`/sheets/${sheet.id}`, { method: 'PATCH', body: { exclusion_zones: next } });
      sheetsQ.setData((d) => (d ? { sheets: d.sheets.map((x) => (x.id === r.sheet.id ? r.sheet : x)) } : d));
      toast(message);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the zones.'); }
  }
  const finishZone = useCallback(() => {
    if (draft.length < 3) return toast('Place at least 3 corner points first.');
    if (tool === 'area') { setPendingArea(draft); setDraft([]); return; } // a count area needs a name first
    void saveZones([...zonesShown, { points: draft }], 'Zone saved. Auto-count will ignore everything inside it.');
    setDraft([]);
    setTool('select');
  }, [draft, zonesShown, tool]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveArea(name: string) {
    const pts = pendingArea;
    if (!pts) return;
    try {
      await api(`/sheets/${sheetId}/areas`, { body: { name, points: pts } });
      setPendingArea(null);
      setTool('select');
      await Promise.all([areasQ.reload(), areaTotalsQ.reload()]);
      toast(`Area “${name}” saved.`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the area.'); }
  }
  async function deleteArea(name: string) {
    try {
      for (const a of sheetAreas.filter((x) => areaKey(x.name) === areaKey(name))) await api(`/sheets/${sheetId}/areas/${a.id}`, { method: 'DELETE' });
      await Promise.all([areasQ.reload(), areaTotalsQ.reload()]);
      if (areaFilter !== '__all' && areaKey(areaFilter) === areaKey(name)) setAreaFilter('__all');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the area.'); }
  }
  async function renameArea(oldName: string, newName: string) {
    const first = sheetAreas.find((x) => areaKey(x.name) === areaKey(oldName));
    if (!first || !newName.trim() || newName.trim() === oldName) return;
    try {
      await api(`/sheets/${sheetId}/areas/${first.id}`, { method: 'PATCH', body: { name: newName } });
      await Promise.all([areasQ.reload(), areaTotalsQ.reload()]);
      toast('Renamed everywhere in this project.');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not rename the area.'); }
  }
  const autoInZones = useMemo(() => snap.dets.filter((d) => d.source === 'auto' && inZones(d.x, d.y, zonesShown)), [snap.dets, zonesShown]);
  const clearCountsInZones = () => {
    if (!store || autoInZones.length === 0) return;
    store.erase(autoInZones.map((d) => d.id)); // automatic counts only; manual counts are never touched
    toast(`Removed ${plural(autoInZones.length, 'automatic count')} inside the zones.`);
  };

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
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if ((tool === 'zone' || tool === 'area') && draft.length > 0) {
        if (e.key === 'Enter') { e.preventDefault(); finishZone(); return; }
        if (e.key === 'Escape') { setDraft([]); return; }
        if (e.key === 'Backspace') { e.preventDefault(); setDraft((d) => d.slice(0, -1)); return; }
      }
      if (reviewing && current && !readOnly) {
        if (k === 'y') { reviewAct('confirm'); return; }
        if (k === 'n') { reviewAct('reject'); return; }
      }
      // Each tool's letter is the first letter of what it does: Navigate, Select, Count, Find similar, Ignore area,
      // count Area, Erase (and H to hide markers).
      if (k === 'n') setTool('select');
      else if (k === 's') setTool('box');
      else if (k === 'c' && !readOnly) setTool('add');
      else if (k === 'f' && !readOnly) setTool('similar');
      else if (k === 'i' && !readOnly) { setTool('zone'); setDraft([]); }
      else if (k === 'a' && !readOnly) { setTool('area'); setDraft([]); }
      else if (k === 'e' && !readOnly) setTool('erase');
      else if (k === 'h') setHideMarkers((v) => !v);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [store, readOnly, deleteSelected, reviewing, current, tool, draft, finishZone]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The active item's counts: on this sheet (in reading order, for stepping through them) and in the whole project.
  const itemDets = useMemo(
    () => (activeItemId ? snap.dets.filter((d) => d.item_type_id === activeItemId && d.status !== 'rejected').sort((a, b) => a.y - b.y || a.x - b.x) : []),
    [snap.dets, activeItemId],
  );
  const itemOtherSheets = useMemo(() => otherSheetCounts.filter((c) => c.item_type_id === activeItemId && c.n > 0), [otherSheetCounts, activeItemId]);
  const itemInProject = itemDets.length + itemOtherSheets.reduce((n, c) => n + c.n, 0);
  const itemSheetCount = itemOtherSheets.length + (itemDets.length > 0 ? 1 : 0);
  useEffect(() => {
    if (!scrollTo) return;
    // Move only the list (never the page or the panel) so the item's row is in view; the card is at the top of the panel.
    const list = document.querySelector<HTMLElement>('.ws-right .items'), row = document.getElementById(`item-row-${scrollTo.id}`);
    if (list && row) {
      const top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
    document.querySelector<HTMLElement>('.ws-right')?.scrollTo?.({ top: 0 });
  }, [scrollTo]);

  // Selecting counts, however it is done (a click, a box, Next ▶, Select all here), shows their item in the panel with its
  // actions. If every selected count is of one item, that item becomes the active one.
  useEffect(() => {
    if (selected.size === 0 || reviewing) return;
    const itemId = singleItemOf(snap.dets, selected);
    if (!itemId) return;
    if (!itemById.has(itemId)) {
      toast("That count is for an item that is not in this project's item library, so it has no details to show. Use “Change to…” to give it one that is.");
      return;
    }
    setActiveItemId(itemId);
    setCardOpen(true);
    setScrollTo({ id: itemId, n: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const stepItem = (dir: 1 | -1) => {
    if (itemDets.length === 0) return toast('There are none of this item on this sheet.');
    const next = itemDets[stepIndex(itemDets.length, itemDets.findIndex((d) => selected.has(d.id)), dir)];
    setSelected(new Set([next.id]));
    viewRef.current?.centerOn(next.x, next.y, 6);
  };
  const deleteItemOnSheet = () => {
    if (!store || readOnly || !activeItem || itemDets.length === 0) return;
    store.erase(itemDets.map((d) => d.id)); // one step: Ctrl+Z brings them all back
    setSelected(new Set());
    toast(`${plural(itemDets.length, 'count')} of ${activeItem.code} deleted from this sheet. Ctrl+Z brings them back.`);
  };
  async function deleteItemEverywhere() {
    if (!activeItem) return;
    try {
      await flushAll(); // the sheet's waiting edits go first, so they are not lost or left behind
      const r = await api<{ deleted: number; sheets: number }>(`/items/${activeItem.id}/clear`, { body: { auto_only: keepHand } });
      setConfirmClear(false);
      setSelected(new Set());
      await store?.load(true);
      void countsQ.reload(); void sheetsQ.reload(); void areaTotalsQ.reload();
      toast(`${plural(r.deleted, 'count')} of ${activeItem.code} deleted from ${plural(r.sheets, 'sheet')}.`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete those counts.'); }
  }
  const sheetLabel = sheet ? [sheet.number, sheet.title].filter(Boolean).join(' · ') || `Page ${sheet.page}` : '…';

  return (
    <>
      <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: project.data?.project.name ?? '…', to: paths.project(projectId) }, { label: sheetLabel }]}>
        {editorHint && <span className="save-state">{editorHint}</span>}
        {saveText && <span className={`save-state${snap.save.kind === 'error' ? ' err' : ''}`} role="status">{saveText}</span>}
        {!readOnly && <button className="btn btn-secondary" onClick={() => { if (sheet && (sheet.kind === 'schedule' || sheet.kind === 'legend')) return toast(`This sheet is marked as a ${sheet.kind}. Auto-count skips schedules and legends, since the tags in their tables are not fixtures. Change its type in the sheet index to count it.`); setShowAuto(true); }} disabled={!sheet || !file}><MagicWand size={14} /> Auto-count sheet</button>}
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
            <button className={`tool${tool === 'select' ? ' on' : ''}`} onClick={() => setTool('select')} aria-label="Navigate (N)" title="Navigate (N): move around the sheet; click a count to see its item"><Hand size={18} /></button>
            <button className={`tool${tool === 'add' ? ' on' : ''}`} onClick={() => setTool('add')} disabled={readOnly} aria-label="Count (C)" title="Count (C): click to place a count of the item picked on the right"><PlusCircle size={18} /></button>
            <button className={`tool${tool === 'box' ? ' on' : ''}`} onClick={() => setTool('box')} aria-label="Select (S)" title="Select (S): click a count, or drag a box around several"><Cursor size={18} /></button>
            <button className={`tool${tool === 'similar' ? ' on' : ''}`} onClick={() => setTool('similar')} disabled={readOnly} aria-label="Find similar symbols (F)" title="Find similar symbols (F): choose an item on the right, then drag a box around one symbol"><Crosshair size={18} /></button>
            <button className={`tool${tool === 'zone' ? ' on' : ''}`} onClick={() => { setTool('zone'); setDraft([]); }} disabled={readOnly} aria-label="Ignore area (I)" title="Ignore area (I): outline an area whose counts are left out"><Polygon size={18} /></button>
            <button className={`tool${tool === 'area' ? ' on' : ''}`} onClick={() => { setTool('area'); setDraft([]); }} disabled={readOnly} aria-label="Count area (A)" title="Count area (A): outline a named area to count separately"><Shapes size={18} /></button>
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
            {(allAreaNames.length > 0 || areasOpen) && <button className={`btn btn-secondary${areasOpen ? ' on' : ''}`} onClick={() => { setAreasOpen((v) => !v); setZonesOpen(false); }} aria-expanded={areasOpen} title="Named areas that break the counts out (for example Lab A, Corridor)">Count areas · {allAreaNames.length}</button>}
            {(zonesShown.length > 0 || zonesOpen) && <button className={`btn btn-secondary${zonesOpen ? ' on' : ''}`} onClick={() => { setZonesOpen((v) => !v); setAreasOpen(false); }} aria-expanded={zonesOpen} title="Areas whose counts are ignored (past a matchline, or outlined by you)">Ignored areas · {zonesShown.length}</button>}
            <button className={`tool${hideMarkers ? ' on' : ''}`} onClick={() => setHideMarkers(!hideMarkers)} aria-pressed={hideMarkers} aria-label="Hide markers (H)" title="Hide or show markers (H)">{hideMarkers ? <EyeSlash size={18} /> : <Eye size={18} />}</button>
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
                zones={zonesShown}
                areas={sheetAreas.map((a) => ({ name: a.name, points: a.points, color: areaColor(a.name) }))}
                draft={draft}
                onZonePoint={(x, y) => setDraft((d) => [...d, { x, y }])}
                onZoneFinish={finishZone}
                onSimilarBox={(a, b) => {
                  if (!activeItemId) return toast('Pick the item type on the right first: the symbols found are counted as it.');
                  if (Math.abs(a.x - b.x) < 0.002 || Math.abs(a.y - b.y) < 0.002) return toast('Drag a box around one symbol.');
                  setSimilarBox({ a, b });
                }}
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
            {(tool === 'zone' || tool === 'area') && (
              <div className="hint" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 5, maxWidth: '80%' }} role="status">
                <span style={{ flex: 1 }}>{draft.length === 0 ? (tool === 'area' ? 'Click the corners of the area to name and count separately.' : 'Click the corners of the area to ignore.') : `${plural(draft.length, 'corner')} placed.`} Click the first point or press Enter to finish; Backspace undoes a point; Esc cancels.</span>
                {draft.length >= 3 && <button className="btn btn-primary" style={{ minHeight: 28, padding: '2px 12px' }} onClick={finishZone}>Finish</button>}
              </div>
            )}
            {areasOpen && (
              <div className="menu" style={{ position: 'absolute', top: 8, right: 8, width: 350, zIndex: 6, maxHeight: '80%', overflow: 'auto' }} role="dialog" aria-label="Count areas">
                <div className="row-between"><b>Count areas</b><button className="btn btn-ghost" onClick={() => setAreasOpen(false)}>Close</button></div>
                <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                  Outline an area and name it to see its counts on their own. Areas with the same name are one area, so their counts add up, across sheets too.
                </div>
                {areaNames(sheetAreas).map((n) => {
                  const inside = localAreaRows.filter((r) => r.area !== null && areaKey(r.area) === areaKey(n)).reduce((t, r) => t + r.n, 0);
                  const polys = sheetAreas.filter((a) => areaKey(a.name) === areaKey(n)).length;
                  return (
                    <div key={n} className="row-between" style={{ padding: '5px 0', gap: 8 }}>
                      <span className="row" style={{ gap: 8, minWidth: 0 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: areaColor(n), flex: 'none' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b>{n}</b> <span className="dim" style={{ fontSize: 12 }}>{plural(inside, 'count')} here{polys > 1 ? `, ${polys} outlines` : ''}</span></span>
                      </span>
                      {!readOnly && (
                        <span className="row" style={{ gap: 2 }}>
                          <button className="btn btn-ghost" onClick={() => { const v = window.prompt(`Rename “${n}” (this renames it everywhere in the project):`, n); if (v) void renameArea(n, v); }}>Rename</button>
                          <button className="btn btn-ghost" onClick={() => void deleteArea(n)}>Delete</button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {sheetAreas.length === 0 && <div className="dim" style={{ fontSize: 13 }}>No areas on this sheet yet.</div>}
                {allAreaNames.filter((n) => !sheetAreas.some((a) => areaKey(a.name) === areaKey(n))).length > 0 && (
                  <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>Also in this project: {allAreaNames.filter((n) => !sheetAreas.some((a) => areaKey(a.name) === areaKey(n))).join(', ')}</div>
                )}
                {!readOnly && <button className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={() => { setTool('area'); setDraft([]); setAreasOpen(false); }}>Outline a new area</button>}
              </div>
            )}
            {zonesOpen && (
              <div className="menu" style={{ position: 'absolute', top: 8, right: 8, width: 330, zIndex: 6 }} role="dialog" aria-label="Ignored areas">
                <div className="row-between"><b>Ignored areas</b><button className="btn btn-ghost" onClick={() => setZonesOpen(false)}>Close</button></div>
                <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
                  {zonesByHand ? 'Set by hand for this sheet.' : zonesShown.length ? 'Found automatically from the matchlines.' : 'No matchline was found on this sheet.'} Auto-count ignores everything inside these areas.
                </div>
                {zonesShown.map((z, i) => (
                  <div key={i} className="row-between" style={{ padding: '4px 0' }}>
                    <span>Area {i + 1} <span className="dim" style={{ fontSize: 12 }}>({z.points.length} corners{!zonesByHand ? ', automatic' : ''})</span></span>
                    {!readOnly && <button className="btn btn-ghost" onClick={() => void saveZones(zonesShown.filter((_, k) => k !== i), 'Area removed.')}>Delete</button>}
                  </div>
                ))}
                {!readOnly && (
                  <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                    <button className="btn btn-secondary" onClick={() => { setTool('zone'); setDraft([]); setZonesOpen(false); }}>Outline a new area</button>
                    <button className="btn btn-secondary" disabled={autoInZones.length === 0} onClick={clearCountsInZones} title="Removes automatic counts inside these areas. Manual counts are never touched.">
                      Remove {autoInZones.length} automatic count{autoInZones.length === 1 ? '' : 's'} inside
                    </button>
                    {zonesByHand && <button className="btn btn-ghost" onClick={() => void saveZones(null, 'Back to the automatic areas.')}>Go back to automatic</button>}
                  </div>
                )}
              </div>
            )}
            {snap.loadError && <div className="viewport-msg" style={{ background: 'color-mix(in srgb, var(--color-bg) 85%, transparent)' }}><div className="stack" style={{ alignItems: 'center' }}><div className="err-text">{snap.loadError}</div><button className="btn btn-secondary" onClick={() => void store?.load(true)}>Try again</button></div></div>}
          </div>
        </section>

        {/* right: counts */}
        <aside className="ws-right" aria-label="Counts">
        {cardOpen && activeItem && (
          <div className="item-card" role="region" aria-label={`${activeItem.code} details`}>
            <div className="row-between">
              <span className="row" style={{ gap: 8, minWidth: 0 }}><Symbol shape={activeItem.marker_shape} glyph={activeItem.marker_glyph} /><b>{activeItem.code}</b></span>
              <button className="btn btn-ghost" style={{ padding: '0 6px', minHeight: 24 }} onClick={() => setCardOpen(false)} aria-label="Close details">✕</button>
            </div>
            <div className="ic-name" title={[activeItem.name, activeItem.spec].filter(Boolean).join(' · ')}>{activeItem.name}</div>
            <div className="dim num" style={{ fontSize: 12 }}>{itemDets.length} on this sheet · {plural(itemInProject, 'count')} on {plural(itemSheetCount, 'sheet')}</div>
            {(() => {
              // the ceilings this item's counts sit in, on this sheet
              const by: Record<string, number> = {};
              for (const d of itemDets) { const k = d.ceiling ?? 'none'; by[k] = (by[k] ?? 0) + 1; }
              const known = (['drop', 'sheetrock', 'open'] as Ceiling[]).filter((c) => by[c]);
              if (!known.length && !ceil) return null;
              return (
                <div className="dim num" style={{ fontSize: 12 }}>
                  Ceiling: {known.length ? known.map((c) => `${by[c]} ${CEILING_LABEL[c].toLowerCase()}`).join(' · ') : 'not read yet'}{known.length && by.none ? ` · ${by.none} not read` : ''}
                  {ceil && !readOnly && by.none ? <button className="btn btn-ghost" style={{ padding: '0 6px', minHeight: 20, fontSize: 12 }} onClick={readCeilings} title="Read the ceiling of every count on this sheet that has none, from the ceiling plan's textures">Read ceiling types</button> : null}
                </div>
              );
            })()}
            {activeItem.length_ft != null && <div className="dim num" style={{ fontSize: 12 }}>{activeItem.length_ft} ft each · {Math.round(itemDets.length * activeItem.length_ft * 10) / 10} ft on this sheet · {Math.round(itemInProject * activeItem.length_ft * 10) / 10} ft in the project</div>}
            <div className="btns">
              <button className="btn btn-secondary" aria-pressed={onlyActive} onClick={() => setOnlyActive(!onlyActive)}>{onlyActive ? 'Show all items' : 'Show only this item'}</button>
              <button className="btn btn-secondary" disabled={itemDets.length === 0} onClick={() => stepItem(-1)} aria-label="Previous one on this sheet">◀</button>
              <button className="btn btn-secondary" disabled={itemDets.length === 0} onClick={() => stepItem(1)}>Next ▶</button>
            </div>
            <div className="btns">
              <button className="btn btn-secondary" disabled={itemDets.length === 0} onClick={() => setSelected(new Set(itemDets.map((d) => d.id)))}>Select all here</button>
              {!readOnly && <button className="btn btn-secondary" disabled={itemDets.length === 0} onClick={deleteItemOnSheet}>Delete on this sheet</button>}
              {!readOnly && <button className="btn btn-secondary" disabled={itemInProject === 0} onClick={() => setConfirmClear(true)}>Delete everywhere…</button>}
            </div>
          </div>
        )}
          <div className="head">
            <div className="row-between"><h5 style={{ margin: 0 }}>Counts</h5><span className="muted num" style={{ fontSize: 13 }}>{plural(totalShown, 'item')}</span></div>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <div className="search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
              <MagnifyingGlass size={14} />
              <input ref={searchRef} className="input" style={{ width: '100%' }} placeholder="Search items" title="Press / to search" aria-label="Search the items" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setQuery(''); searchRef.current?.blur(); }
                  // Enter opens the best match: the same details and actions as clicking one of its counts.
                  if (e.key === 'Enter') { const top = listGroups[0]?.items[0]; if (top) { openItem(top.id); toast(`${top.code}: ${plural(shown.get(top.id)?.n ?? 0, 'count')} ${scope === 'sheet' ? 'on this sheet' : 'in the project'}.`); } }
                }} />
              {query && <button className="btn btn-ghost" style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', padding: '0 6px', minHeight: 24 }} onClick={() => { setQuery(''); searchRef.current?.focus(); }} aria-label="Clear the search">✕</button>}
            </div>
            <button className="btn btn-secondary" style={{ flex: 'none', minHeight: 36, padding: '0 10px', fontSize: 12.5 }} aria-pressed={onlyCounted} onClick={() => setOnlyCounted(!onlyCounted)} title="Hide the items that have no counts">With counts</button>
            </div>
            <Seg name="scope" value={scope} onChange={setScope} options={[{ value: 'sheet', label: 'This sheet' }, { value: 'all', label: 'All sheets' }]} />
            {allAreaNames.length > 0 && (
              <select className="input" aria-label="Show counts for an area" value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
                <option value="__all">All areas (everything)</option>
                {allAreaNames.map((n) => <option key={n} value={n}>Area: {n}</option>)}
                <option value="__none">Not in any area</option>
              </select>
            )}
            {selected.size > 0 && (
              <div className="hint" role="status">
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{selected.size} selected</span>
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
            {items.length > 0 && listGroups.length === 0 && (
              <div className="empty" style={{ padding: 16 }}>
                <div>{onlyCounted && !query.trim() ? 'Nothing is counted yet in this view.' : `No item matches “${query.trim()}”.`}</div>
                {onlyCounted && <button className="btn btn-ghost" onClick={() => setOnlyCounted(false)}>Show items with no counts too</button>}
              </div>
            )}
            {listGroups.map((g) => (
              <div key={g.name}>
                <div className="cat-h">{g.name}</div>
                {g.items.map((it) => {
                  const c = shown.get(it.id) ?? { n: 0, flagged: 0 };
                  return (
                    <button key={it.id} id={`item-row-${it.id}`} className={`item-row${it.id === activeItemId ? ' sel' : ''}`} onClick={() => openItem(it.id)} aria-pressed={it.id === activeItemId}>
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
            <div className="row" style={{ gap: 8 }}><WarningCircle size={16} /><span>{plural(flaggedShown, 'low-confidence detection')} · {plural(queue.length, 'unreviewed count')} on this sheet</span></div>
            {reviewing && current ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="hint" role="status">Reviewing {reviewIndex + 1} of {queue.length}: <b>{itemById.get(current.item_type_id)?.code ?? '?'}</b>{current.confidence !== null ? ` (${Math.round(current.confidence * 100)}% sure)` : ''}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => reviewAct('confirm')}>Confirm (Y)</button>
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => reviewAct('reject')}>Not a device (N)</button>
                </div>
                <select className="input" aria-label="Change type (C)" value="" onChange={(e) => { if (e.target.value && current) { store?.retype([current.id], e.target.value); store?.setStatus([current.id], 'confirmed'); stepAfter(queue[reviewIndex + 1]?.id); } }}>
                  <option value="">Change type…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
                </select>
                <button className="btn btn-ghost" onClick={() => { setReviewing(false); setReviewId(null); }}>Stop reviewing</button>
              </div>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} disabled={queue.length === 0 || readOnly} onClick={startReview}>Review items</button>
                <button className="btn btn-secondary" style={{ flex: 1 }} disabled={queue.length === 0 || readOnly} onClick={confirmAllShown} title="Mark every unreviewed count on this sheet as confirmed">Confirm all</button>
              </div>
            )}
            {!readOnly && sheet && (
              sheet.count_status === 'reviewed'
                ? <button className="btn btn-secondary btn-block" onClick={() => setReviewed(false)}>Reopen sheet</button>
                : <button className="btn btn-secondary btn-block" onClick={() => setReviewed(true)}>Mark sheet reviewed</button>
            )}
          </div>
        </aside>
      </div>

      {pendingArea && <AreaNameDialog names={allAreaNames} onSave={(n) => void saveArea(n)} onCancel={() => { setPendingArea(null); setTool('select'); }} />}
      {confirmClear && activeItem && (
        <Dialog title="Delete counts" onClose={() => setConfirmClear(false)}>
          <div className="dialog-title">Delete every count of {activeItem.code}?</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {plural(itemInProject, 'count')} on {plural(itemSheetCount, 'sheet')} will be deleted. This can't be undone with Ctrl+Z. The item stays in the library.
          </div>
          <Check checked={keepHand} onChange={setKeepHand}>Keep the counts I placed by hand (delete only the automatic ones)</Check>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setConfirmClear(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void deleteItemEverywhere()}>Delete counts</button>
          </div>
        </Dialog>
      )}
      {similarBox && sheet && activeItem && (
        <SimilarDialog current={sheet} box={similarBox} sheets={sheets.filter((s) => s.count_enabled && s.kind !== 'schedule' && s.kind !== 'legend')} files={filesQ.data?.files ?? []}
          item={activeItem} store={store} onClose={() => { setSimilarBox(null); setTool('select'); }} onDone={(m) => { setSimilarBox(null); setTool('select'); toast(m); void countsQ.reload(); void sheetsQ.reload(); }} />
      )}
      {showItemDialog && (
        <ItemDialog projectId={projectId} categories={categories} onClose={() => setShowItemDialog(false)} onCreated={(it) => { setShowItemDialog(false); setActiveItemId(it.id); void itemsQ.reload(); }} />
      )}
      {showAuto && sheet && (
        <AutoCountDialog projectId={projectId} sheets={[sheet]} items={items} onClose={() => setShowAuto(false)}
          onDone={(msg) => { setShowAuto(false); toast(msg); void itemsQ.reload(); void countsQ.reload(); void sheetsQ.reload(); void getStore(sheetId).load(true); }} />
      )}
      {showExport && project.data && <ExportDialog projectId={projectId} projectName={project.data.project.name} sheets={sheets} currentSheetId={sheetId} onClose={() => setShowExport(false)} onGoReview={() => setShowExport(false)} />}
    </>
  );
}
