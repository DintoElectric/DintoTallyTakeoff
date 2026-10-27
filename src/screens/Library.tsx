import { useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { CategoryRow, ItemTypeRow, MarkerShape, ProjectRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Check, Dialog, Seg, Symbol, TopBar, plural, useToast } from '../app/ui.tsx';
import { useFetch } from '../app/useFetch.ts';
import { paths } from '../app/router.ts';
import { lengthFeetFromText } from '../detect/lengthText.ts';
import { ItemDialog } from './ItemDialog.tsx';

const SHAPES: MarkerShape[] = ['circle', 'square', 'rect', 'diamond'];

function Editor({ item, categories, canEdit, isAdmin, onSaved, onDeleted }: {
  item: ItemTypeRow; categories: CategoryRow[]; canEdit: boolean; isAdmin: boolean; onSaved: () => void; onDeleted: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState(item);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setF(item), [item]);
  const cat = categories.find((c) => c.id === f.category_id)?.name ?? 'Uncategorized';
  const dirty = JSON.stringify([f.code, f.name, f.spec, f.unit, f.category_id, f.detection_mode, f.marker_shape, f.marker_glyph, f.length_ft ?? null, f.count_group ?? null]) !==
    JSON.stringify([item.code, item.name, item.spec, item.unit, item.category_id, item.detection_mode, item.marker_shape, item.marker_glyph, item.length_ft ?? null, item.count_group ?? null]);
  const suggested = lengthFeetFromText(f.name, f.spec ?? '');

  async function save() {
    setBusy(true);
    try {
      await api(`/items/${item.id}`, { method: 'PATCH', body: { code: f.code, name: f.name, spec: f.spec ?? '', unit: f.unit, category_id: f.category_id, detection_mode: f.detection_mode, marker_shape: f.marker_shape, marker_glyph: f.marker_glyph ?? '', length_ft: f.length_ft ?? null, count_group: f.count_group ?? null } });
      toast('Item saved.');
      onSaved();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the item.'); }
    setBusy(false);
  }

  return (
    <aside className="lib-right" aria-label="Item details">
      <div className="row" style={{ gap: 14 }}>
        <Symbol shape={f.marker_shape} glyph={f.marker_glyph} big />
        <div style={{ minWidth: 0 }}><div className="muted" style={{ fontSize: 12 }}>{f.code} · {cat}</div><h4 style={{ marginBottom: 0 }}>{f.name}</h4></div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ width: 110 }}><label htmlFor="ec">Code</label><input id="ec" className="input" value={f.code} disabled={!canEdit} onChange={(e) => setF({ ...f, code: e.target.value })} /></div>
        <div className="field" style={{ width: 80 }}><label htmlFor="eu">Unit</label><input id="eu" className="input" value={f.unit} disabled={!canEdit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="ecat">Category</label>
          <select id="ecat" className="input" value={f.category_id ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, category_id: e.target.value || null })}>
            <option value="">Uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label htmlFor="en">Description</label><input id="en" className="input" value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label htmlFor="es">Spec</label><input id="es" className="input" value={f.spec ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, spec: e.target.value })} /></div>
      <div className="field">
        <label htmlFor="el">Length each, in feet (linear fixtures only)</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="el" className="input" style={{ width: 110 }} type="number" min="0" step="0.5" value={f.length_ft ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, length_ft: e.target.value === '' ? null : Number(e.target.value) })} placeholder="none" />
          {canEdit && f.length_ft == null && suggested != null && <button type="button" className="btn btn-ghost" onClick={() => setF({ ...f, length_ft: suggested })}>Use {suggested} ft from the description</button>}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>The Excel export totals feet as count × length. Leave empty for fixtures counted by the piece, or for runs whose length comes from the plans.</div>
      </div>
      <div className="field">
        <label htmlFor="ecg">Counts as</label>
        <select id="ecg" className="input" style={{ width: 220 }} value={f.count_group ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, count_group: (e.target.value || null) as ItemTypeRow['count_group'] })}>
          <option value="">Automatic (from its category and name)</option>
          <option value="fixture">Fixture (lighting)</option>
          <option value="device">Device</option>
          <option value="fire_alarm">Fire alarm</option>
        </select>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Which counting tab it is in: Fixtures or Devices.</div>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label>Marker</label><Seg name="eshape" value={f.marker_shape} onChange={(v) => canEdit && setF({ ...f, marker_shape: v })} options={SHAPES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} /></div>
        <div className="field" style={{ width: 120 }}><label htmlFor="eg">Letters (up to 8)</label><input id="eg" className="input" maxLength={8} value={f.marker_glyph ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, marker_glyph: e.target.value.toUpperCase() })} /></div>
      </div>
      <div className="field">
        <label>Detection</label>
        <Seg name="edet" value={f.detection_mode} onChange={(v) => canEdit && setF({ ...f, detection_mode: v })} options={[{ value: 'auto', label: 'Auto-detect' }, { value: 'manual', label: 'Manual only' }]} />
        {item.sample_count === 0 && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>Auto-detect needs at least one confirmed sample. Manual counting always works.</div>}
      </div>
      <div className="field">
        <label>Confirmed samples</label>
        <div className="dim" style={{ fontSize: 13 }}>{item.sample_count === 0 ? 'No samples yet. Samples are saved when you confirm detections (a later stage).' : plural(item.sample_count, 'sample')}</div>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{plural(item.detection_count, 'count')} use this item.</div>
      <div style={{ flex: 1 }} />
      {canEdit && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {canEdit && <button className="btn btn-secondary" onClick={() => setConfirm(true)}>Delete</button>}
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save item'}</button>
        </div>
      )}
      {confirm && (
        <Dialog title="Delete item" onClose={() => setConfirm(false)}>
          <div className="dialog-title">Delete “{item.name}”?</div>
          <div className="dialog-body">{item.detection_count > 0 ? `${plural(item.detection_count, 'count')} use this item. Change them to another item first, then delete it.` : "It's removed from the library for everyone."}</div>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={item.detection_count > 0} onClick={async () => {
              try { await api(`/items/${item.id}`, { method: 'DELETE' }); setConfirm(false); onDeleted(); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.'); }
            }}>Delete</button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

/** Copy another project's library (items and categories) into this one. Items it already has are left alone. */
function CopyLibraryDialog({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const projects = useFetch<{ projects: ProjectRow[] }>('/projects');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const others = (projects.data?.projects ?? []).filter((p) => p.id !== projectId);
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ copied: number; skipped: number }>('/items/copy', { body: { from_project_id: from, to_project_id: projectId } });
      onDone(`${plural(r.copied, 'item')} copied${r.skipped ? `, ${r.skipped} already in this library` : ''}.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not copy the library.'); setBusy(false); }
  }
  return (
    <Dialog title="Copy a library" onClose={onClose}>
      <div className="dialog-title">Copy another project's library</div>
      <div className="muted" style={{ fontSize: 13 }}>Adds that project's items and categories to this one, so you don't start from nothing. Items this project already has are left as they are. Counts are not copied.</div>
      <div className="field">
        <label htmlFor="cl">Copy from</label>
        <select id="cl" className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Choose a project…</option>
          {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {projects.data && others.length === 0 && <div className="dim" style={{ fontSize: 13 }}>There is no other project yet.</div>}
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !from}>{busy ? 'Copying…' : 'Copy library'}</button>
      </div>
    </Dialog>
  );
}

export default function Library({ projectId }: { projectId: string }) {
  const { me } = useAuth();
  const canEdit = me?.role !== 'viewer';
  const isAdmin = me?.role === 'admin';
  const toast = useToast();
  const project = useFetch<{ project: ProjectRow }>(`/projects/${projectId}`);
  const itemsQ = useFetch<{ items: ItemTypeRow[] }>(`/items?project=${projectId}`);
  const catsQ = useFetch<{ categories: CategoryRow[] }>(`/categories?project=${projectId}`);
  // Items from before libraries were per project, not yet in any project.
  const legacyQ = useFetch<{ items: ItemTypeRow[] }>('/items?unassigned=1');
  const [showCopy, setShowCopy] = useState(false);
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newCat, setNewCat] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());          // ticked for deleting
  const [bulk, setBulk] = useState<{ ids: string[]; all: boolean } | null>(null);

  const items = itemsQ.data?.items ?? [];
  const categories = catsQ.data?.categories ?? [];
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.category_id ?? '_', (m.get(i.category_id ?? '_') ?? 0) + 1);
    return m;
  }, [items]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => (cat === 'all' || (cat === '_' ? !i.category_id : i.category_id === cat)) && (!s || [i.code, i.name, i.spec].some((v) => v?.toLowerCase().includes(s))));
  }, [items, cat, q]);
  const selected = items.find((i) => i.id === sel) ?? null;

  async function addCategory() {
    if (newCat === null) return;
    const name = newCat.trim();
    setNewCat(null);
    if (!name) return;
    try { await api('/categories', { body: { project_id: projectId, name } }); void catsQ.reload(); }
    catch (e) { toast(e instanceof ApiError ? (e.status === 409 ? 'That category already exists.' : e.message) : 'Could not add the category.'); }
  }

  return (
    <>
      <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: project.data?.project.name ?? '…', to: paths.project(projectId) }, { label: 'Item library' }]} />
      <div className="lib">
        <aside className="lib-left" aria-label="Categories">
          <h6 style={{ padding: '0 10px' }}>Categories</h6>
          <button className={`cat-btn${cat === 'all' ? ' on' : ''}`} onClick={() => setCat('all')}><span>All items</span><span className="num">{items.length}</span></button>
          {categories.map((c) => <button key={c.id} className={`cat-btn${cat === c.id ? ' on' : ''}`} onClick={() => setCat(c.id)}><span>{c.name}</span><span className="num">{counts.get(c.id) ?? 0}</span></button>)}
          {(counts.get('_') ?? 0) > 0 && <button className={`cat-btn${cat === '_' ? ' on' : ''}`} onClick={() => setCat('_')}><span>Uncategorized</span><span className="num">{counts.get('_')}</span></button>}
          {canEdit && (newCat === null
            ? <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setNewCat('')}><Plus size={14} /> New category</button>
            : <input className="input" autoFocus placeholder="Category name" aria-label="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} onBlur={addCategory} onKeyDown={(e) => { if (e.key === 'Enter') void addCategory(); if (e.key === 'Escape') setNewCat(null); }} />)}
        </aside>

        <main className="lib-main">
          <div className="row-between">
            <div>
              <h3 style={{ marginBottom: 2 }}>Item library</h3>
              <div className="muted" style={{ fontSize: 13 }}>This project's items. Add the fixtures and devices you count here; each one gets a marker shape and letters you will see on the drawing.</div>
            </div>
            <div className="row">
              {items.length > 0 && <div className="search"><MagnifyingGlass size={14} /><input className="input" placeholder="Search items" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
              <button className="btn btn-secondary" disabled title="Legend import arrives in a later stage.">Import legend</button>
              {canEdit && <button className="btn btn-secondary" onClick={() => setShowCopy(true)}>Copy from another project</button>}
              {canEdit && <button className="btn btn-primary" onClick={() => setShowNew(true)}><Plus size={14} /> New item</button>}
            </div>
          </div>

          {canEdit && (legacyQ.data?.items.length ?? 0) > 0 && (
            <div className="banner" role="status">
              <div>{plural(legacyQ.data!.items.length, 'item')} from before libraries were per project {legacyQ.data!.items.length === 1 ? "isn't" : "aren't"} in any project yet.</div>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn btn-secondary" onClick={async () => {
                  try {
                    const r = await api<{ moved: number; skipped: number }>('/items/claim', { body: { project_id: projectId } });
                    toast(`${plural(r.moved, 'item')} added to this project${r.skipped ? `, ${r.skipped} skipped because this project already has them` : ''}.`);
                    void itemsQ.reload(); void catsQ.reload(); void legacyQ.reload();
                  } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add them.'); }
                }}>Add them to this project</button>
                <span className="dim" style={{ fontSize: 12 }}>They disappear from here once any project takes them, so add them where they belong.</span>
              </div>
            </div>
          )}
          {itemsQ.error && <div className="err-text" role="alert">{itemsQ.error}</div>}
          {itemsQ.loading && !itemsQ.data && <div className="muted"><span className="spinner" /> Loading…</div>}
          {!itemsQ.loading && !itemsQ.error && items.length === 0 && (
            <div className="empty" style={{ padding: 60 }}>
              <h4 style={{ margin: 0 }}>No items yet</h4>
              <div>{canEdit ? 'Create the first item to start counting.' : 'An estimator or admin will add the first items.'}</div>
              {canEdit && <div className="row"><button className="btn btn-secondary" disabled title="Legend import arrives in a later stage.">Import legend</button><button className="btn btn-primary" onClick={() => setShowNew(true)}><Plus size={14} /> New item</button></div>}
            </div>
          )}

          {items.length > 0 && canEdit && (
            <div className="row lib-bulk">
              {picked.size > 0
                ? <><span className="num"><b>{picked.size}</b> selected</span>
                    <button className="btn btn-secondary" onClick={() => setBulk({ ids: [...picked], all: false })}>Delete selected</button>
                    <button className="btn btn-ghost" onClick={() => setPicked(new Set())}>Clear</button></>
                : <span className="dim">Tick items to delete several at once.</span>}
              <span style={{ flex: 1 }} />
              <button className="btn btn-ghost" onClick={() => setBulk({ ids: items.map((i) => i.id), all: true })}>Delete all…</button>
            </div>
          )}
          {items.length > 0 && (
            <table className="table">
              <thead><tr>
                {canEdit && <th style={{ width: 32 }}><input type="checkbox" aria-label="Select all the items shown" checked={shown.length > 0 && shown.every((i) => picked.has(i.id))}
                  ref={(el) => { if (el) el.indeterminate = shown.some((i) => picked.has(i.id)) && !shown.every((i) => picked.has(i.id)); }}
                  onChange={(e) => setPicked((p) => { const n = new Set(p); for (const i of shown) { if (e.target.checked) n.add(i.id); else n.delete(i.id); } return n; })} /></th>}
                <th style={{ width: 44 }} /><th>Code</th><th>Description</th><th>Category</th><th>Detection</th><th className="right">Samples</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className={`tr-click${i.id === sel ? ' sel' : ''}`} onClick={() => setSel(i.id)}>
                    {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${i.code}`} checked={picked.has(i.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} /></td>}
                    <td><Symbol shape={i.marker_shape} glyph={i.marker_glyph} /></td>
                    <td style={{ fontWeight: 500 }}>{i.code}</td>
                    <td><div>{i.name}</div>{i.spec && <div className="dim" style={{ fontSize: 12 }}>{i.spec}</div>}</td>
                    <td>{categories.find((c) => c.id === i.category_id)?.name ?? '—'}</td>
                    <td><span className={`tag ${i.detection_mode === 'auto' ? 'tag-accent' : 'tag-neutral'}`}>{i.detection_mode === 'auto' ? 'Auto-detect' : 'Manual only'}</span></td>
                    <td className="right num">{i.sample_count}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={canEdit ? 7 : 6} className="muted">No items match.</td></tr>}
              </tbody>
            </table>
          )}
        </main>

        {selected && <Editor item={selected} categories={categories} canEdit={canEdit} isAdmin={isAdmin} onSaved={() => void itemsQ.reload()} onDeleted={() => { setSel(null); void itemsQ.reload(); }} />}
      </div>

      {bulk && <BulkDeleteDialog items={items.filter((i) => bulk.ids.includes(i.id))} all={bulk.all} onClose={() => setBulk(null)}
        onDone={(msg) => { setBulk(null); setPicked(new Set()); if (sel && bulk.ids.includes(sel)) setSel(null); toast(msg); void itemsQ.reload(); }} />}
      {showCopy && <CopyLibraryDialog projectId={projectId} onClose={() => setShowCopy(false)} onDone={(m) => { setShowCopy(false); toast(m); void itemsQ.reload(); void catsQ.reload(); }} />}
      {showNew && <ItemDialog projectId={projectId} categories={categories} defaultCategoryId={cat !== 'all' && cat !== '_' ? cat : null} onClose={() => setShowNew(false)} onCreated={(it) => { setShowNew(false); setSel(it.id); void itemsQ.reload(); }} />}
    </>
  );
}

/** Deleting several items: items with counts on drawings are kept unless their counts go too. "Delete all" asks twice. */
function BulkDeleteDialog({ items, all, onClose, onDone }: { items: ItemTypeRow[]; all: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [withCounts, setWithCounts] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const counted = items.filter((i) => i.detection_count > 0);
  const countTotal = counted.reduce((n, i) => n + i.detection_count, 0);
  const going = withCounts ? items.length : items.length - counted.length;
  const ok = going > 0 && (!all || typed.trim().toLowerCase() === 'delete');
  const go = async () => {
    setBusy(true); setErr(null);
    let deleted = 0, countsDeleted = 0, kept = 0;
    try {
      for (let i = 0; i < items.length; i += 200) {
        const r = await api<{ deleted: number; counts_deleted: number; kept: unknown[] }>('/items/bulk-delete', { body: { ids: items.slice(i, i + 200).map((x) => x.id), with_counts: withCounts } });
        deleted += r.deleted; countsDeleted += r.counts_deleted; kept += r.kept.length;
      }
      onDone(`Deleted ${plural(deleted, 'item')}${countsDeleted ? ` and ${plural(countsDeleted, 'count')}` : ''}${kept ? `; kept ${plural(kept, 'item')} that ${kept === 1 ? 'has' : 'have'} counts` : ''}.`);
    } catch (e) {
      setErr(`${e instanceof ApiError ? e.message : 'Deleting stopped.'}${deleted ? ` ${plural(deleted, 'item')} were deleted before that.` : ''}`);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete items" onClose={onClose}>
      <div className="dialog-title">{all ? `Delete all ${plural(items.length, 'item')} in this library?` : `Delete ${plural(items.length, 'item')}?`}</div>
      <div className="dialog-body stack" style={{ gap: 10 }}>
        <div>This can't be undone.{items.length <= 8 ? ` ${items.map((i) => i.code).join(', ')}.` : ''}</div>
        {counted.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div>{plural(counted.length, 'of them has', 'of them have')} counts on drawings ({plural(countTotal, 'count')}).</div>
            <Check checked={withCounts} onChange={setWithCounts}>Also delete their counts</Check>
            {!withCounts && <div className="dim" style={{ fontSize: 12 }}>Those {plural(counted.length, 'item')} will be kept.</div>}
          </div>
        )}
        {all && (
          <label className="field"><span>To confirm, type <b>delete</b></span>
            <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type delete to confirm" autoComplete="off" />
          </label>
        )}
        {err && <div className="err-text" role="alert">{err}</div>}
      </div>
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void go()} disabled={!ok || busy}>{busy ? 'Deleting…' : going === 0 ? 'Nothing to delete' : `Delete ${plural(going, 'item')}`}</button>
      </div>
    </Dialog>
  );
}
