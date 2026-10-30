import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { MarkerShape } from '../../shared/types.ts';
import { BASE_MAX_PX, DETAIL_MAX_PX } from '../../shared/limits.ts';
import { overlayLooksRight, tintOverlay } from './overlayTint.ts';
import { GridIndex } from '../detect/grid.ts';
import type { Zone, ZonePoint } from '../../shared/zones.ts';
import { appPalette, drawMarker, type Palette } from './markerDraw.ts';

export type Tool = 'select' | 'add' | 'box' | 'erase' | 'zone' | 'area' | 'similar' | 'read' | 'align';
export interface MarkerData { id: string; x: number; y: number; itemId: string; flagged: boolean }
export interface ItemStyle { shape: MarkerShape; glyph: string | null }
export interface DrawingViewHandle { zoomBy(factor: number): void; fit(): void; centerOn(x: number, y: number, zoomFactor?: number): void }

interface Props {
  page: PDFPageProxy | null;
  pageW: number; // displayed page size in PDF points; also the layout size of the page layer
  pageH: number;
  markers: MarkerData[];
  styles: Map<string, ItemStyle>;
  activeItemId: string | null;
  selected: Set<string>;
  tool: Tool;
  readOnly: boolean;
  onPlace(x: number, y: number): void;
  onPick(id: string | null, additive: boolean): void;
  onErase(id: string): void;
  onBox(ids: string[], additive: boolean): void;
  /** The rectangle drawn with the similar-symbol tool, in normalized page coordinates. */
  onSimilarBox?(a: { x: number; y: number }, b: { x: number; y: number }): void;
  onReadBox?(a: { x: number; y: number }, b: { x: number; y: number }): void; // Read schedule: the area to read
  onZoom(pct: number): void;
  onError(message: string): void;
  /** Exclusion zones drawn dimmed: the part of a sheet that lies past a matchline, or that the estimator outlined. */
  zones?: Zone[];
  /** Named count areas, drawn as coloured outlines with their name. */
  areas?: { name: string; points: ZonePoint[]; color: string }[];
  /** The outline being drawn with the zone or area tool (normalized points). */
  draft?: ZonePoint[];
  onZonePoint?(x: number, y: number): void;
  onZoneFinish?(): void;
  /**
   * The architectural floor plan drawn over the sheet, in orange, where the alignment puts it: a point E of this sheet is at
   * s * E + (dx, dy) on the architectural page (PDF points).
   */
  overlay?: { page: PDFPageProxy; s: number; dx: number; dy: number } | null;
  /** A click with the line-up tool, in normalized page coordinates. */
  onAlignClick?(x: number, y: number): void;
}

const DEFAULT_STYLE: ItemStyle = { shape: 'circle', glyph: null };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const DrawingView = forwardRef<DrawingViewHandle, Props>(function DrawingView(props, ref) {
  const { page, pageW, pageH } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const markerCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const detailRef = useRef<HTMLCanvasElement | null>(null);

  const view = useRef({ z: 1, tx: 0, ty: 0 });
  const fitZ = useRef(1);
  const size = useRef({ w: 1, h: 1 });
  const baseScale = useRef(1);
  const palette = useRef<Palette | null>(null);
  const raf = useRef(0);
  const detailTimer = useRef<number>();
  const detailTask = useRef<RenderTask | null>(null);
  const detailTok = useRef(0);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // Always read the latest props from handlers without re-binding listeners.
  const P = useRef(props);
  P.current = props;

  const grid = useMemo(() => new GridIndex(props.markers), [props.markers]);
  const gridRef = useRef(grid);
  gridRef.current = grid;

  /* ---------- markers (single canvas overlay; fast for thousands of markers) ---------- */
  const drawMarkers = useCallback(() => {
    raf.current = 0;
    const c = markerCanvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    palette.current ??= appPalette();
    const pal = palette.current;
    const { z, tx, ty } = view.current;
    const { markers, styles, activeItemId, selected, zones } = P.current;
    const sx = (x: number) => tx + x * pageW * z;
    const sy = (y: number) => ty + y * pageH * z;
    if (zones?.length) {
      ctx.save();
      ctx.fillStyle = 'rgba(22,24,38,0.30)';
      ctx.strokeStyle = 'rgba(22,24,38,0.65)';
      ctx.setLineDash([6, 4]);
      for (const zone of zones) {
        ctx.beginPath();
        zone.points.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    const areas = P.current.areas;
    if (areas?.length) {
      ctx.save();
      for (const a of areas) {
        ctx.beginPath();
        a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
        ctx.closePath();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = a.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = a.color;
        ctx.stroke();
      }
      // names last, so no outline is drawn over a label
      ctx.font = '600 13px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      for (const a of areas) {
        const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
        const lx = sx(Math.min(...xs)) + 6, ly = sy(Math.min(...ys)) + 6;
        const w = ctx.measureText(a.name).width + 10;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(lx - 4, ly - 2, w, 20);
        ctx.fillStyle = a.color;
        ctx.fillText(a.name, lx, ly);
      }
      ctx.restore();
    }
    const draft = P.current.draft;
    if (draft?.length) {
      ctx.save();
      ctx.strokeStyle = pal.active;
      ctx.fillStyle = pal.active;
      ctx.lineWidth = 2;
      ctx.beginPath();
      draft.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
      ctx.stroke();
      if (draft.length >= 3) { ctx.setLineDash([4, 4]); ctx.lineTo(sx(draft[0].x), sy(draft[0].y)); ctx.stroke(); ctx.setLineDash([]); }
      draft.forEach((p, i) => { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), i === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fill(); });
      ctx.restore();
    }
    const size16 = window.matchMedia('(pointer: coarse)').matches ? 20 : 16;
    for (let pass = 0; pass < 3; pass++) {
      for (const m of markers) {
        const isSel = selected.has(m.id);
        const isActive = m.itemId === activeItemId;
        if (pass === 0 ? isSel || isActive : pass === 1 ? isSel || !isActive : !isSel) continue;
        const sx = tx + m.x * pageW * z;
        const sy = ty + m.y * pageH * z;
        if (sx < -24 || sy < -24 || sx > w + 24 || sy > h + 24) continue;
        const st = styles.get(m.itemId) ?? DEFAULT_STYLE;
        drawMarker(ctx, pal, st.shape, st.glyph, sx, sy, { size: size16, active: isActive, selected: isSel, flagged: m.flagged });
      }
    }
  }, [pageW, pageH]);

  const scheduleMarkers = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(drawMarkers);
  }, [drawMarkers]);

  useEffect(() => { scheduleMarkers(); }, [props.markers, props.styles, props.activeItemId, props.selected, props.zones, props.areas, props.draft, scheduleMarkers]);

  /* ---------- detail layer: sharp re-render of the visible region after zooming stops ---------- */
  const renderDetail = useCallback(async () => {
    const pg = P.current.page;
    const layer = layerRef.current;
    if (!pg || !layer) return;
    const tok = ++detailTok.current;
    detailTask.current?.cancel();
    const { z, tx, ty } = view.current;
    const { w: vw, h: vh } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const need = z * dpr;
    const hide = () => { if (detailRef.current) detailRef.current.style.display = 'none'; };
    if (need <= baseScale.current * 1.15) return hide();

    // Visible region in page coordinates, plus a small margin so panning a little stays sharp.
    const mx = (vw / z) * 0.08, my = (vh / z) * 0.08;
    const x0 = clamp(-tx / z - mx, 0, pageW), y0 = clamp(-ty / z - my, 0, pageH);
    const x1 = clamp((vw - tx) / z + mx, 0, pageW), y1 = clamp((vh - ty) / z + my, 0, pageH);
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 1 || rh < 1) return hide();
    const scale = Math.min(need, Math.sqrt(DETAIL_MAX_PX / (rw * rh)));
    if (scale <= baseScale.current * 1.05) return hide();

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rw * scale);
    canvas.height = Math.ceil(rh * scale);
    try {
      const vp = pg.getViewport({ scale });
      const task = pg.render({ canvas, viewport: vp, annotationMode: 0, transform: [1, 0, 0, 1, -x0 * scale, -y0 * scale] });
      detailTask.current = task;
      await task.promise;
    } catch (e) {
      if ((e as { name?: string })?.name !== 'RenderingCancelledException') console.warn('Detail render failed', e);
      return;
    }
    if (tok !== detailTok.current) return;
    canvas.style.left = `${x0}px`;
    canvas.style.top = `${y0}px`;
    canvas.style.width = `${canvas.width / scale}px`;
    canvas.style.height = `${canvas.height / scale}px`;
    // Swap in only when finished, so there is never a blank flash.
    const old = detailRef.current;
    layer.appendChild(canvas);
    detailRef.current = canvas;
    if (old) { old.width = old.height = 0; old.remove(); }
  }, [pageW, pageH]);

  const scheduleDetail = useCallback(() => {
    window.clearTimeout(detailTimer.current);
    detailTimer.current = window.setTimeout(() => { void renderDetail(); }, 180);
  }, [renderDetail]);

  /* ---------- view transform ---------- */
  const apply = useCallback((notify = true) => {
    const { z, tx, ty } = view.current;
    if (layerRef.current) layerRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    scheduleMarkers();
    scheduleDetail();
    if (notify) P.current.onZoom(Math.round((z / fitZ.current) * 100));
  }, [scheduleMarkers, scheduleDetail]);

  const fit = useCallback(() => {
    const { w, h } = size.current;
    const z = Math.min(w / pageW, h / pageH) * 0.94;
    fitZ.current = z;
    view.current = { z, tx: (w - pageW * z) / 2, ty: (h - pageH * z) / 2 };
    apply();
  }, [pageW, pageH, apply]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    const v = view.current;
    const z = clamp(v.z * factor, fitZ.current * 0.3, Math.max(8, fitZ.current * 30));
    const f = z / v.z;
    view.current = { z, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f };
    apply();
  }, [apply]);

  // Centers a normalized page point; zoomFactor is relative to "fit" (e.g. 6 = six times the fit zoom).
  const centerOn = useCallback((nx: number, ny: number, zoomFactor?: number) => {
    const z = zoomFactor ? clamp(fitZ.current * zoomFactor, fitZ.current * 0.3, Math.max(8, fitZ.current * 30)) : view.current.z;
    const { w, h } = size.current;
    view.current = { z, tx: w / 2 - nx * pageW * z, ty: h / 2 - ny * pageH * z };
    apply();
  }, [pageW, pageH, apply]);

  useImperativeHandle(ref, () => ({
    zoomBy: (f: number) => zoomAt(size.current.w / 2, size.current.h / 2, f),
    fit,
    centerOn,
  }), [zoomAt, fit, centerOn]);

  /* ---------- size + page lifecycle ---------- */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const first = size.current.w <= 1;
      size.current = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
      if (first) fit(); else apply(false);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [fit, apply]);

  /* ---------- the architectural plan over the sheet (orange lines on a clear background) ---------- */
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const overlayPage = props.overlay?.page ?? null;
  useEffect(() => {
    const layer = layerRef.current;
    if (!overlayPage || !layer) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const free = (c: HTMLCanvasElement) => { c.width = 0; c.height = 0; };
    (async () => {
      const vp1 = overlayPage.getViewport({ scale: 1 });
      // Drawn at a modest size (outlines need little detail), and smaller again if the browser hands back a blank canvas (it
      // does that, silently, when canvas memory runs short beside the drawing's own canvases).
      for (const maxPx of [4e6, 1.5e6]) {
        const scale = clamp(Math.sqrt(maxPx / (vp1.width * vp1.height)), 0.2, 2);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp1.width * scale);
        canvas.height = Math.ceil(vp1.height * scale);
        try {
          task = overlayPage.render({ canvas, viewport: overlayPage.getViewport({ scale }), annotationMode: 0 });
          await task.promise;
        } catch (e) {
          free(canvas);
          if ((e as { name?: string })?.name === 'RenderingCancelledException' || cancelled) return;
          continue;
        }
        if (cancelled) { free(canvas); return; }
        // The page was drawn into an opaque canvas (pdf.js gives it no transparency): the recoloured pixels go into a fresh
        // canvas that has it, so the paper is clear. (Written back into the drawn one, the paper stays solid.)
        const ctx = canvas.getContext('2d');
        let shown: HTMLCanvasElement | null = null;
        if (ctx && canvas.width > 0) {
          try {
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            if (overlayLooksRight(tintOverlay(img.data))) {   // dark lines orange, the paper clear
              const out = document.createElement('canvas');
              out.width = canvas.width; out.height = canvas.height;
              const octx = out.getContext('2d', { alpha: true });
              if (octx) { octx.putImageData(img, 0, 0); shown = out; } else free(out);
            }
          } catch { shown = null; }
        }
        free(canvas);
        if (!shown) continue;
        shown.className = 'overlay-canvas';
        shown.style.width = `${vp1.width}px`;
        shown.style.height = `${vp1.height}px`;
        if (overlayRef.current) { free(overlayRef.current); overlayRef.current.remove(); }
        layer.appendChild(shown);
        overlayRef.current = shown;
        placeOverlay();
        return;
      }
      if (!cancelled) P.current.onError("The architectural plan couldn't be drawn in this browser. Try closing other tabs, then turn it on again.");
    })();
    return () => { cancelled = true; task?.cancel(); if (overlayRef.current) { free(overlayRef.current); overlayRef.current.remove(); } overlayRef.current = null; };
  }, [overlayPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const placeOverlay = () => {
    const o = P.current.overlay, c = overlayRef.current;
    if (!o || !c) return;
    c.style.transform = `translate(${-o.dx / o.s}px, ${-o.dy / o.s}px) scale(${1 / o.s})`;
  };
  useEffect(placeOverlay, [props.overlay?.s, props.overlay?.dx, props.overlay?.dy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // New page: fit it, and render the base bitmap of the whole page (capped for tablets).
    const layer = layerRef.current;
    if (!page || !layer) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    layer.style.width = `${pageW}px`;
    layer.style.height = `${pageH}px`;
    fit();
    (async () => {
      const scale = clamp(Math.sqrt(BASE_MAX_PX / (pageW * pageH)), 0.4, 4);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(pageW * scale);
      canvas.height = Math.ceil(pageH * scale);
      try {
        task = page.render({ canvas, viewport: page.getViewport({ scale }), annotationMode: 0 }); // 0 = hide markups
        await task.promise;
      } catch (e) {
        if ((e as { name?: string })?.name !== 'RenderingCancelledException') {
          console.error('Base render failed', e);
          P.current.onError("This sheet couldn't be drawn. Try another sheet, or re-export the PDF.");
        }
        return;
      }
      if (cancelled) { canvas.width = canvas.height = 0; return; }
      canvas.style.width = `${pageW}px`;
      canvas.style.height = `${pageH}px`;
      const old = baseRef.current;
      layer.insertBefore(canvas, layer.firstChild);
      baseRef.current = canvas;
      baseScale.current = canvas.width / pageW;
      if (old) { old.width = old.height = 0; old.remove(); }
      if (detailRef.current) detailRef.current.style.display = 'none';
      scheduleDetail();
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      detailTask.current?.cancel();
      window.clearTimeout(detailTimer.current);
    };
    // fit/scheduleDetail depend only on pageW/pageH, which are in the list.
  }, [page, pageW, pageH, fit, scheduleDetail]);

  /* ---------- wheel: scroll zooms around the cursor ---------- */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [zoomAt]);

  /* ---------- pointer gestures: tap, drag-pan, box, pinch ---------- */
  const g = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    mode: 'none' as 'none' | 'pending' | 'pan' | 'box' | 'pinch',
    sx: 0, sy: 0, stx: 0, sty: 0, type: 'mouse',
    pd: 1, pz: 1, pcx: 0, pcy: 0, ptx: 0, pty: 0,
    lastTap: 0, lastTapX: 0, lastTapY: 0, shift: false, button: 0,
  });

  const local = (e: { clientX: number; clientY: number }) => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const sxOf = (x: number) => view.current.tx + x * pageW * view.current.z;
  const syOf = (y: number) => view.current.ty + y * pageH * view.current.z;
  const toNorm = (sx: number, sy: number) => ({
    x: (sx - view.current.tx) / (pageW * view.current.z),
    y: (sy - view.current.ty) / (pageH * view.current.z),
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    const s = g.current;
    const p = local(e);
    viewportRef.current!.setPointerCapture(e.pointerId);
    s.pointers.set(e.pointerId, p);
    s.type = e.pointerType;
    s.shift = e.shiftKey || e.ctrlKey || e.metaKey;
    s.button = e.button;
    if (s.pointers.size === 2) {
      const [a, b] = [...s.pointers.values()];
      s.mode = 'pinch';
      s.pd = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      s.pz = view.current.z;
      s.pcx = (a.x + b.x) / 2; s.pcy = (a.y + b.y) / 2;
      s.ptx = view.current.tx; s.pty = view.current.ty;
      setBox(null);
    } else {
      s.mode = 'pending';
      s.sx = p.x; s.sy = p.y; s.stx = view.current.tx; s.sty = view.current.ty;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s.pointers.has(e.pointerId)) return;
    const p = local(e);
    s.pointers.set(e.pointerId, p);
    if (s.mode === 'pinch' && s.pointers.size >= 2) {
      const [a, b] = [...s.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const z = clamp(s.pz * (d / s.pd), fitZ.current * 0.3, Math.max(8, fitZ.current * 30));
      const wx = (s.pcx - s.ptx) / s.pz, wy = (s.pcy - s.pty) / s.pz;
      view.current = { z, tx: cx - wx * z, ty: cy - wy * z };
      apply();
      return;
    }
    const dx = p.x - s.sx, dy = p.y - s.sy;
    if (s.mode === 'pending') {
      const thr = s.type === 'touch' ? 8 : 4;
      if (Math.hypot(dx, dy) < thr) return;
      s.mode = (P.current.tool === 'box' || P.current.tool === 'similar' || P.current.tool === 'read') && s.button === 0 ? 'box' : 'pan';
    }
    if (s.mode === 'pan') {
      view.current = { ...view.current, tx: s.stx + dx, ty: s.sty + dy };
      apply(false);
    } else if (s.mode === 'box') {
      setBox({ x0: s.sx, y0: s.sy, x1: p.x, y1: p.y });
    }
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const s = g.current;
    if (!s.pointers.has(e.pointerId)) return;
    const p = local(e);
    s.pointers.delete(e.pointerId);
    if (s.mode === 'pinch') {
      if (s.pointers.size === 1) {
        // One finger remains: continue as a pan from where it is now.
        const rest = [...s.pointers.values()][0];
        s.mode = 'pan'; s.sx = rest.x; s.sy = rest.y; s.stx = view.current.tx; s.sty = view.current.ty;
      } else if (s.pointers.size === 0) s.mode = 'none';
      return;
    }
    const mode = s.mode;
    s.mode = 'none';
    if (cancelled) { setBox(null); return; }
    const pr = P.current;
    if (mode === 'box') {
      setBox(null);
      const a = toNorm(s.sx, s.sy), b = toNorm(p.x, p.y);
      if (pr.tool === 'similar') pr.onSimilarBox?.(a, b);
      else if (pr.tool === 'read') pr.onReadBox?.(a, b);
      else pr.onBox(gridRef.current.inRect(a.x, a.y, b.x, b.y).map((m) => m.id), s.shift);
    } else if (mode === 'pending') {
      const n = toNorm(p.x, p.y);
      if (s.button === 1) return;
      // Double-tap (touch/pen) toggles fit and a closer zoom, in the non-placing tools.
      const now = e.timeStamp;
      if (s.type !== 'mouse' && (pr.tool === 'select' || pr.tool === 'box') && now - s.lastTap < 320 && Math.hypot(p.x - s.lastTapX, p.y - s.lastTapY) < 30) {
        s.lastTap = 0;
        if (view.current.z > fitZ.current * 1.5) fit(); else zoomAt(p.x, p.y, 3);
        return;
      }
      s.lastTap = now; s.lastTapX = p.x; s.lastTapY = p.y;
      if ((n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1) && pr.tool !== 'zone' && pr.tool !== 'area') { if (pr.tool === 'select' || pr.tool === 'box') pr.onPick(null, false); return; }
      const coarse = s.type === 'touch' ? 22 : 12;
      const rx = coarse / (pageW * view.current.z), ry = coarse / (pageH * view.current.z);
      const hit = gridRef.current.nearest(n.x, n.y, rx, ry);
      if (pr.tool === 'select' || pr.tool === 'box') pr.onPick(hit?.id ?? null, s.shift); // Navigate and Select both pick a count you click
      else if (pr.tool === 'add') { if (!pr.readOnly) pr.onPlace(n.x, n.y); }
      else if (pr.tool === 'align') pr.onAlignClick?.(n.x, n.y);
      else if (pr.tool === 'erase') { if (!pr.readOnly && hit) pr.onErase(hit.id); }
      else if ((pr.tool === 'zone' || pr.tool === 'area') && !pr.readOnly) {
        // Clicking the first corner (with 3 or more placed) closes the outline.
        const d = pr.draft;
        const nearFirst = d && d.length >= 3 && Math.hypot(sxOf(d[0].x) - p.x, syOf(d[0].y) - p.y) < 14;
        if (nearFirst) pr.onZoneFinish?.();
        else pr.onZonePoint?.(Math.min(1, Math.max(0, n.x)), Math.min(1, Math.max(0, n.y)));
      }
    }
  };

  const toolClass = `tool-${props.tool}`;
  return (
    <div
      ref={viewportRef}
      className={`viewport ${toolClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Drawing sheet. Scroll to zoom, drag to pan."
    >
      <div ref={layerRef} className="page-layer" />
      <canvas ref={markerCanvasRef} className="marker-canvas" style={{ width: '100%', height: '100%' }} />
      {box && (
        <div style={{
          position: 'absolute', left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1),
          width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0),
          border: '1px solid var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)', pointerEvents: 'none',
        }} />
      )}
    </div>
  );
});
