import { useMemo, useState } from 'react';
import type { CategoryRow, ItemTypeRow } from '../../shared/types.ts';
import { countGroupOf, GROUP_LABEL, GROUPS, type CountGroup } from '../../shared/countGroup.ts';
import { Symbol } from '../app/ui.tsx';

/**
 * Picking an item from the library: filtered by what it counts as (Fixtures, Devices, Fire alarm) and searched by code or
 * description. Used to change counts to another item and to choose what Find similar counts as.
 */
export function ItemPicker({ items, categories, onPick, onNew, currentId, autoFocus = true, maxHeight = 220 }: {
  items: ItemTypeRow[]; categories: CategoryRow[]; onPick: (item: ItemTypeRow) => void; onNew?: () => void;
  currentId?: string | null; autoFocus?: boolean; maxHeight?: number;
}) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'all' | CountGroup>('all');
  const groupOf = useMemo(() => new Map(items.map((i) => [i.id, countGroupOf(i, categories)])), [items, categories]);
  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const present = GROUPS.filter((g) => items.some((i) => groupOf.get(i.id) === g));
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter((i) => (group === 'all' || groupOf.get(i.id) === group) && words.every((w) => `${i.code} ${i.name} ${i.category_id ? catName.get(i.category_id) ?? '' : ''}`.toLowerCase().includes(w)))
      // a code that starts with what was typed comes first ("D1" before "BD1")
      .sort((a, b) => Number(!a.code.toLowerCase().startsWith(words[0] ?? '')) - Number(!b.code.toLowerCase().startsWith(words[0] ?? '')) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [items, q, group, groupOf, catName]);
  return (
    <div className="item-picker">
      {present.length > 1 && (
        <div className="picker-chips" role="radiogroup" aria-label="Show">
          {(['all', ...present] as const).map((g) => (
            <button key={g} type="button" role="radio" aria-checked={group === g} className={`chip${group === g ? ' on' : ''}`} onClick={() => setGroup(g)}>
              {g === 'all' ? 'All' : GROUP_LABEL[g]}
            </button>
          ))}
        </div>
      )}
      <input
        className="input" type="search" value={q} autoFocus={autoFocus} placeholder="Search by code or description" aria-label="Search items"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); onPick(shown[0]); } e.stopPropagation(); }}
      />
      <div className="picker-list" style={{ maxHeight }} role="listbox" aria-label="Items">
        {shown.slice(0, 300).map((i) => (
          <button key={i.id} type="button" role="option" aria-selected={i.id === currentId} className={`picker-row${i.id === currentId ? ' on' : ''}`} onClick={() => onPick(i)}>
            <Symbol shape={i.marker_shape} glyph={i.marker_glyph} />
            <b>{i.code}</b>
            <span className="dim picker-name">{i.name}</span>
            {i.category_id && catName.get(i.category_id) && <span className="picker-cat">{catName.get(i.category_id)}</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="dim" style={{ padding: 8, fontSize: 13 }}>No items match{q ? ` “${q}”` : ''}.</div>}
      </div>
      {onNew && <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onNew}>+ New item…</button>}
    </div>
  );
}
