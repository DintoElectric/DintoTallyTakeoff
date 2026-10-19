// One store per sheet, kept outside React so pending saves survive switching sheets.
// Edits apply locally at once, then autosave as idempotent batches (spec 2.10).
import { useSyncExternalStore } from 'react';
import type { Detection, DetectionOp } from '../../shared/types.ts';
import { ApiError, api } from '../auth/api.ts';
import {
  AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS, AUTOSAVE_RETRY_MS, BATCH_MAX_OPS, TEAMMATE_POLL_MS,
} from '../../shared/limits.ts';

type Change =
  | { t: 'add'; det: Detection }
  | { t: 'remove'; id: string; det: Detection }
  | { t: 'patch'; id: string; fields: Partial<Pick<Detection, 'item_type_id' | 'status' | 'x' | 'y'>> }
  | { t: 'reject'; id: string }
  | { t: 'restore'; det: Detection };

interface Edit { forward: Change[]; backward: Change[] }

export interface SaveState {
  kind: 'idle' | 'saving' | 'saved' | 'error';
  at: Date | null;
  message: string | null;
}

export interface Snapshot {
  dets: Detection[];
  loaded: boolean;
  loadError: string | null;
  save: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  lastEditor: { id: string; name: string; at: string } | null;
}

interface ListResponse {
  version: number;
  unchanged?: boolean;
  detections?: Detection[];
  last_editor?: { id: string; name: string; at: string } | null;
}

function toOp(c: Change): DetectionOp {
  switch (c.t) {
    case 'add': {
      const { id, item_type_id, x, y, bbox, confidence, source, status } = c.det;
      return { op: 'add', detection: { id, item_type_id, x, y, bbox, confidence, source, status } };
    }
    case 'remove': return { op: 'delete', id: c.id };
    case 'patch': return { op: 'update', id: c.id, fields: c.fields };
    case 'reject': return { op: 'update', id: c.id, fields: { status: 'rejected' } };
    case 'restore': return { op: 'update', id: c.det.id, fields: { status: c.det.status, item_type_id: c.det.item_type_id } };
  }
}

const inverseEmpty: Snapshot = {
  dets: [], loaded: false, loadError: null, save: { kind: 'idle', at: null, message: null },
  canUndo: false, canRedo: false, lastEditor: null,
};

export class SheetStore {
  readonly id: string;
  private map = new Map<string, Detection>();
  private version = 0;
  private queue: DetectionOp[] = [];
  private inflight = false;
  private firstPendingAt = 0;
  private saveTimer: number | undefined;
  private retryTimer: number | undefined;
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private listeners = new Set<() => void>();
  private snap: Snapshot = inverseEmpty;
  private lastEditor: Snapshot['lastEditor'] = null;
  private save: SaveState = { kind: 'idle', at: null, message: null };
  private loaded = false;
  private loadError: string | null = null;
  private loading = false;
  onSaved: (() => void) | null = null;

  constructor(id: string) { this.id = id; }

  /* ----- subscription ----- */
  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getSnapshot = () => this.snap;
  private emit() {
    this.snap = {
      dets: [...this.map.values()], loaded: this.loaded, loadError: this.loadError, save: this.save,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, lastEditor: this.lastEditor,
    };
    this.listeners.forEach((l) => l());
  }

  pending() { return this.queue.length + (this.inflight ? 1 : 0); }

  /* ----- loading and teammate merge ----- */
  async load(force = false) {
    if (this.loading || (this.loaded && !force) || this.queue.length || this.inflight) return;
    this.loading = true;
    try {
      const r = await api<ListResponse>(`/sheets/${this.id}/detections`);
      this.replaceFromServer(r);
      this.loaded = true;
      this.loadError = null;
    } catch (e) {
      this.loadError = e instanceof ApiError ? e.message : 'Could not load the counts for this sheet.';
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  private replaceFromServer(r: ListResponse) {
    this.map = new Map((r.detections ?? []).map((d) => [d.id, d]));
    this.version = r.version;
    this.lastEditor = r.last_editor ?? null;
  }

  /** Every ~15 s while visible: pick up teammates' changes when we have nothing unsaved. */
  async poll() {
    if (!this.loaded || this.queue.length || this.inflight || document.hidden) return;
    try {
      const r = await api<ListResponse>(`/sheets/${this.id}/detections?since=${this.version}`);
      if (this.queue.length || this.inflight) return; // we started editing meanwhile; our edits win
      if (r.unchanged) return;
      this.replaceFromServer(r);
      this.undoStack = []; // history refers to states that no longer exist
      this.redoStack = [];
      this.emit();
    } catch { /* polling failures are silent */ }
  }

  /* ----- local application ----- */
  private applyLocal(c: Change) {
    switch (c.t) {
      case 'add': case 'restore': this.map.set(c.det.id, { ...c.det }); break;
      case 'remove': case 'reject': this.map.delete(c.t === 'remove' ? c.id : c.id); break;
      case 'patch': {
        const d = this.map.get(c.id);
        if (d) this.map.set(c.id, { ...d, ...c.fields });
        break;
      }
    }
  }

  private commit(edit: Edit, record: boolean) {
    for (const c of edit.forward) this.applyLocal(c);
    this.enqueue(edit.forward.map(toOp));
    if (record) { this.undoStack.push(edit); this.redoStack = []; if (this.undoStack.length > 500) this.undoStack.shift(); }
    this.emit();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    const back: Edit = { forward: e.backward, backward: e.forward };
    this.commit(back, false);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.commit(e, false);
  }

  /* ----- editing actions ----- */
  place(itemId: string, x: number, y: number) {
    const det: Detection = {
      id: crypto.randomUUID(), sheet_id: this.id, item_type_id: itemId, x, y, bbox: null,
      confidence: null, source: 'manual', status: 'confirmed',
    };
    this.commit({ forward: [{ t: 'add', det }], backward: [{ t: 'remove', id: det.id, det }] }, true);
  }

  /** Places several counts as one step, so a single undo takes them all back. */
  placeMany(itemId: string, points: { x: number; y: number }[]) {
    if (points.length === 0) return;
    const dets: Detection[] = points.map((p) => ({
      id: crypto.randomUUID(), sheet_id: this.id, item_type_id: itemId, x: p.x, y: p.y, bbox: null,
      confidence: null, source: 'manual', status: 'confirmed',
    }));
    this.commit({ forward: dets.map((det) => ({ t: 'add' as const, det })), backward: dets.map((det) => ({ t: 'remove' as const, id: det.id, det })) }, true);
  }

  erase(ids: string[]) {
    const forward: Change[] = [], backward: Change[] = [];
    for (const id of ids) {
      const d = this.map.get(id);
      if (!d) continue;
      if (d.source === 'manual') {
        forward.push({ t: 'remove', id, det: d });
        backward.push({ t: 'add', det: d });
      } else {
        // Auto detections are rejected, not deleted, so the decision is kept (and can train detection later).
        forward.push({ t: 'reject', id });
        backward.push({ t: 'restore', det: d });
      }
    }
    if (forward.length) this.commit({ forward, backward }, true);
  }

  retype(ids: string[], itemId: string) {
    const forward: Change[] = [], backward: Change[] = [];
    for (const id of ids) {
      const d = this.map.get(id);
      if (!d || d.item_type_id === itemId) continue;
      forward.push({ t: 'patch', id, fields: { item_type_id: itemId } });
      backward.push({ t: 'patch', id, fields: { item_type_id: d.item_type_id } });
    }
    if (forward.length) this.commit({ forward, backward }, true);
  }

  setStatus(ids: string[], status: 'confirmed' | 'rejected') {
    const forward: Change[] = [], backward: Change[] = [];
    for (const id of ids) {
      const d = this.map.get(id);
      if (!d) continue;
      if (status === 'rejected') { forward.push({ t: 'reject', id }); backward.push({ t: 'restore', det: d }); }
      else if (d.status !== 'confirmed') {
        forward.push({ t: 'patch', id, fields: { status: 'confirmed' } });
        backward.push({ t: 'patch', id, fields: { status: d.status } });
      }
    }
    if (forward.length) this.commit({ forward, backward }, true);
  }

  /* ----- autosave ----- */
  private enqueue(ops: DetectionOp[]) {
    if (!ops.length) return;
    if (!this.queue.length && !this.inflight) this.firstPendingAt = Date.now();
    this.queue.push(...ops);
    this.save = { kind: 'saving', at: this.save.at, message: null };
    window.clearTimeout(this.saveTimer);
    const waited = Date.now() - this.firstPendingAt;
    // Every 1.5 s after the last change, and at least every 5 s during continuous work.
    this.saveTimer = window.setTimeout(() => void this.flush(), waited >= AUTOSAVE_MAX_WAIT_MS ? 0 : AUTOSAVE_DELAY_MS);
  }

  async flush(keepalive = false): Promise<void> {
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.retryTimer);
    if (this.inflight || !this.queue.length) return;
    const ops = this.queue.slice(0, BATCH_MAX_OPS);
    this.inflight = true;
    this.save = { kind: 'saving', at: this.save.at, message: null };
    this.emit();
    try {
      const r = await api<{ version: number }>(`/sheets/${this.id}/detections/batch`, { body: { ops }, keepalive });
      this.queue.splice(0, ops.length); // sent in order; new edits were only appended
      this.version = r.version;
      this.inflight = false;
      this.save = { kind: 'saved', at: new Date(), message: null };
      this.emit();
      this.onSaved?.();
      if (this.queue.length) void this.flush();
    } catch (e) {
      this.inflight = false;
      const status = e instanceof ApiError ? e.status : 0;
      if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
        // The server will never accept this batch: drop it and show the server's truth.
        this.queue.splice(0, ops.length);
        this.save = { kind: 'error', at: this.save.at, message: `Some changes couldn't be saved: ${(e as Error).message}` };
        this.emit();
        this.loaded = false;
        void this.load(true);
        return;
      }
      // Network trouble or an ended session: keep the queue in memory and retry.
      this.save = { kind: 'error', at: this.save.at, message: "Couldn't save. Retrying…" };
      this.emit();
      this.retryTimer = window.setTimeout(() => void this.flush(), AUTOSAVE_RETRY_MS);
    }
  }
}

const stores = new Map<string, SheetStore>();
export function getStore(id: string): SheetStore {
  let s = stores.get(id);
  if (!s) stores.set(id, (s = new SheetStore(id)));
  return s;
}

export const pendingEdits = () => [...stores.values()].reduce((n, s) => n + s.pending(), 0);
export const flushAll = (keepalive = false) => Promise.all([...stores.values()].map((s) => s.flush(keepalive)));
export function pollAll() { stores.forEach((s) => void s.poll()); }

// Flush when the tab is hidden or closing; warn if edits are still unsent (spec 2.10).
document.addEventListener('visibilitychange', () => { if (document.hidden) void flushAll(true); });
window.addEventListener('pagehide', () => { void flushAll(true); });
window.addEventListener('beforeunload', (e) => {
  if (pendingEdits() > 0) { e.preventDefault(); e.returnValue = ''; }
});
window.setInterval(pollAll, TEAMMATE_POLL_MS);

const NONE: Snapshot = inverseEmpty;
const noopSub = () => () => undefined;
export function useSheetStore(id: string | null): { store: SheetStore | null; snap: Snapshot } {
  const store = id ? getStore(id) : null;
  const snap = useSyncExternalStore(store ? store.subscribe : noopSub, store ? store.getSnapshot : () => NONE);
  return { store, snap };
}
