import { useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { CategoryRow, ItemTypeRow, MarkerShape } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Dialog, Seg, Symbol, TopBar, plural, useToast } from '../app/ui.tsx';
import { useFetch } from '../app/useFetch.ts';
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
  const dirty = JSON.stringify([f.code, f.name, f.spec, f.unit, f.category_id, f.detection_mode, f.marker_shape, f.marker_glyph]) !==
    JSON.stringify([item.code, item.name, item.spec, item.unit, item.category_id, item.detection_mode, item.marker_shape, item.marker_glyph]);

  async function save() {
    setBusy(true);
    try {
      await api(`/items/${item.id}`, { method: 'PATCH', body: { code: f.code, name: f.name, spec: f.spec ?? '', unit: f.unit, category_id: f.category_id, detection_mode: f.detection_mode, marker_shape: f.marker_shape, marker_glyph: f.marker_glyph ?? '' } });
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
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label>Marker</label><Seg name="eshape" value={f.marker_shape} onChange={(v) => canEdit && setF({ ...f, marker_shape: v })} options={SHAPES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} /></div>
        <div className="field" style={{ width: 70 }}><label htmlFor="eg">Letters</label><input id="eg" className="input" maxLength={2} value={f.marker_glyph ?? ''} disabled={!canEdit} onChange={(e) => setF({ ...f, marker_glyph: e.target.value.toUpperCase() })} /></div>
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
          {isAdmin && <button className="btn btn-secondary" onClick={() => setConfirm(true)}>Delete</button>}
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

export default function Library() {
  const { me } = useAuth();
  const canEdit = me?.role !== 'viewer';
  const isAdmin = me?.role === 'admin';
  const toast = useToast();
  const itemsQ = useFetch<{ items: ItemTypeRow[] }>('/items');
  const catsQ = useFetch<{ categories: CategoryRow[] }>('/categories');
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newCat, setNewCat] = useState<string | null>(null);

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
    try { await api('/categories', { body: { name } }); void catsQ.reload(); }
    catch (e) { toast(e instanceof ApiError ? (e.status === 409 ? 'That category already exists.' : e.message) : 'Could not add the category.'); }
  }

  return (
    <>
      <TopBar nav="library" />
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
              <div className="muted" style={{ fontSize: 13 }}>Shared across projects. Add the fixtures and devices you count; each one gets a marker shape and letters you will see on the drawing.</div>
            </div>
            <div className="row">
              {items.length > 0 && <div className="search"><MagnifyingGlass size={14} /><input className="input" placeholder="Search items" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
              <button className="btn btn-secondary" disabled title="Legend import arrives in a later stage.">Import legend</button>
              {canEdit && <button className="btn btn-primary" onClick={() => setShowNew(true)}><Plus size={14} /> New item</button>}
            </div>
          </div>

          {itemsQ.error && <div className="err-text" role="alert">{itemsQ.error}</div>}
          {itemsQ.loading && !itemsQ.data && <div className="muted"><span className="spinner" /> Loading…</div>}
          {!itemsQ.loading && !itemsQ.error && items.length === 0 && (
            <div className="empty" style={{ padding: 60 }}>
              <h4 style={{ margin: 0 }}>No items yet</h4>
              <div>{canEdit ? 'Create the first item to start counting.' : 'An estimator or admin will add the first items.'}</div>
              {canEdit && <div className="row"><button className="btn btn-secondary" disabled title="Legend import arrives in a later stage.">Import legend</button><button className="btn btn-primary" onClick={() => setShowNew(true)}><Plus size={14} /> New item</button></div>}
            </div>
          )}

          {items.length > 0 && (
            <table className="table">
              <thead><tr><th style={{ width: 44 }} /><th>Code</th><th>Description</th><th>Category</th><th>Detection</th><th className="right">Samples</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className={`tr-click${i.id === sel ? ' sel' : ''}`} onClick={() => setSel(i.id)}>
                    <td><Symbol shape={i.marker_shape} glyph={i.marker_glyph} /></td>
                    <td style={{ fontWeight: 500 }}>{i.code}</td>
                    <td><div>{i.name}</div>{i.spec && <div className="dim" style={{ fontSize: 12 }}>{i.spec}</div>}</td>
                    <td>{categories.find((c) => c.id === i.category_id)?.name ?? '—'}</td>
                    <td><span className={`tag ${i.detection_mode === 'auto' ? 'tag-accent' : 'tag-neutral'}`}>{i.detection_mode === 'auto' ? 'Auto-detect' : 'Manual only'}</span></td>
                    <td className="right num">{i.sample_count}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={6} className="muted">No items match.</td></tr>}
              </tbody>
            </table>
          )}
        </main>

        {selected && <Editor item={selected} categories={categories} canEdit={canEdit} isAdmin={isAdmin} onSaved={() => void itemsQ.reload()} onDeleted={() => { setSel(null); void itemsQ.reload(); }} />}
      </div>

      {showNew && <ItemDialog categories={categories} defaultCategoryId={cat !== 'all' && cat !== '_' ? cat : null} onClose={() => setShowNew(false)} onCreated={(it) => { setShowNew(false); setSel(it.id); void itemsQ.reload(); }} />}
    </>
  );
}
