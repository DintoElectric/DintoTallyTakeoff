import { useState } from 'react';
import type { CategoryRow, ItemTypeRow, MarkerShape } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Dialog, Seg, Symbol } from '../app/ui.tsx';
import { lengthFeetFromText } from '../detect/lengthText.ts';

const SHAPES: MarkerShape[] = ['circle', 'square', 'rect', 'diamond'];

/** Create an item type (library entry). Shared by the library and the workspace. */
export function ItemDialog({ projectId, categories, defaultCategoryId, onClose, onCreated }: {
  projectId: string; categories: CategoryRow[]; defaultCategoryId?: string | null; onClose: () => void; onCreated: (item: ItemTypeRow) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [unit, setUnit] = useState('EA');
  const [length, setLength] = useState('');                    // feet per fixture, for linear fixtures
  const [group, setGroup] = useState('');                      // fixture, device, or automatic
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? '');
  const [shape, setShape] = useState<MarkerShape>('circle');
  const [glyph, setGlyph] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const suggested = lengthFeetFromText(name, spec);

  async function save() {
    if (!code.trim() || !name.trim()) return setErr('Code and description are both required.');
    setBusy(true);
    setErr(null);
    try {
      const { item } = await api<{ item: ItemTypeRow }>('/items', {
        body: { project_id: projectId, code, name, spec: spec || null, unit: unit || 'EA', category_id: categoryId || null, count_group: group || null, marker_shape: shape, marker_glyph: glyph || null, length_ft: length.trim() ? Number(length) : null },
      });
      onCreated(item);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.status === 409 ? 'An item with that code and description already exists. To add a variant, use a different description.' : e.message) : 'Could not save the item.');
      setBusy(false);
    }
  }

  return (
    <Dialog title="New item" onClose={onClose}>
      <div className="row-between">
        <div className="dialog-title">New item</div>
        <Symbol shape={shape} glyph={glyph.toUpperCase() || null} big />
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ width: 110 }}><label htmlFor="ic">Code</label><input id="ic" className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="A1" autoFocus /></div>
        <div className="field" style={{ flex: 1 }}><label htmlFor="in">Description</label><input id="in" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="2x4 LED troffer" /></div>
      </div>
      <div className="field"><label htmlFor="is">Spec (optional)</label><input id="is" className="input" value={spec} onChange={(e) => setSpec(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="il">Length each, in feet (linear fixtures only)</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="il" className="input" style={{ width: 110 }} type="number" min="0" step="0.5" value={length} onChange={(e) => setLength(e.target.value)} placeholder="4" />
          {!length.trim() && suggested != null && <button type="button" className="btn btn-ghost" onClick={() => setLength(String(suggested))}>Use {suggested} ft from the description</button>}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>The Excel export totals feet as count × length.</div>
      </div>
      <div className="field">
        <label htmlFor="icg">Counts as</label>
        <select id="icg" className="input" style={{ width: 220 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Automatic (from its category and name)</option>
          <option value="fixture">Fixture (lighting)</option>
          <option value="device">Device</option>
          <option value="fire_alarm">Fire alarm</option>
        </select>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Which counting tab it is in: Fixtures or Devices.</div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="icat">Category</label>
          <select id="icat" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 90 }}><label htmlFor="iu">Unit</label><input id="iu" className="input" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label>Marker shape</label><Seg name="shape" value={shape} onChange={setShape} options={SHAPES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} /></div>
        <div className="field" style={{ width: 130 }}><label htmlFor="ig">Letters (up to 8)</label><input id="ig" className="input" maxLength={8} value={glyph} onChange={(e) => setGlyph(e.target.value)} /></div>
      </div>
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Add item'}</button>
      </div>
    </Dialog>
  );
}
