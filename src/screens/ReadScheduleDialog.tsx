import { useEffect, useMemo, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { CategoryRow, ItemTypeRow } from '../../shared/types.ts';
import { inZones, type Zone } from '../../shared/zones.ts';
import { api, ApiError } from '../auth/api.ts';
import { pdfjs } from '../viewer/pdf.ts';
import { extractRuns } from '../detect/pageRuns.ts';
import { extractPrims } from '../detect/primitives.ts';
import { lengthFeetFromText } from '../detect/lengthText.ts';
import { areaRows, headerLabel, readAreaTable, rowToItem, sectionName, suggestColumns, type AreaTable, type Box, type ColumnChoice } from '../detect/areaSchedule.ts';
import { Check, Dialog, plural, useToast } from '../app/ui.tsx';

// What was picked last time (by header name), so the next sheet of the same schedule is set up already.
type Memory = { type?: string; description?: string; skip?: string[] };
const memKey = (projectId: string) => `tally.readcols.${projectId}`;
const recall = (projectId: string): Memory => { try { return JSON.parse(localStorage.getItem(memKey(projectId)) ?? '{}'); } catch { return {}; } };
const remember = (projectId: string, v: Memory) => { try { localStorage.setItem(memKey(projectId), JSON.stringify(v)); } catch { /* picked again next time */ } };

/**
 * Reads the schedule in the boxed areas. The estimator picks the Type and Description columns; every other column read
 * goes into each item's details under its header (untick the ones not wanted, or draw an ignore area over them).
 */
export default function ReadScheduleDialog({ page, projectId, boxes, zones, items, categories, onAddBox, onIgnoreColumn, onStartOver, onClose, onDone }: {
  page: PDFPageProxy; projectId: string; boxes: Box[]; zones: Zone[]; items: ItemTypeRow[]; categories: CategoryRow[];
  onAddBox: () => void; onIgnoreColumn: () => void; onStartOver: () => void; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [table, setTable] = useState<AreaTable | null | undefined>(undefined); // undefined: reading
  const [choice, setChoice] = useState<ColumnChoice>({ type: null, description: null, extra: [] });
  const [off, setOff] = useState<Set<string>>(new Set());         // rows unticked, by code
  const [update, setUpdate] = useState(true);
  const [group, setGroup] = useState<'fixture' | 'device'>('fixture');
  const [useSections, setUseSections] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      const [runs, { prims }] = await Promise.all([extractRuns(page), extractPrims(page, pdfjs.OPS)]);
      const vp = page.getViewport({ scale: 1 });
      const vlines = prims.filter((p) => p.n === 2 && p.x1 - p.x0 < 0.6 && p.y1 - p.y0 > 4).map((p) => ({ x: (p.x0 + p.x1) / 2, y0: p.y0, y1: p.y1 }));
      const t = readAreaTable(runs, boxes, { pageW: vp.width, pageH: vp.height, skip: (x, y) => inZones(x, y, zones), vlines });
      if (gone) return;
      setTable(t);
      if (t) {
        const c = suggestColumns(t.columns, recall(projectId));
        setChoice(c);
        // a schedule of devices (receptacles, outlets) reads as devices; a light fixture schedule as fixtures
        const words = t.columns.map((k) => k.header).join(' ');
        setGroup(/DRIVER|LUMEN|LAMP|CCT|BALLAST|WATTAGE/i.test(words) ? 'fixture' : /NEMA|RECEPT|OUTLET|DEVICE|C\.?B\.?|BREAKER|CONDUIT/i.test(words) ? 'device' : 'fixture');
      }
    })().catch((e) => { console.warn('Reading the schedule failed', e); if (!gone) setTable(null); });
    return () => { gone = true; };
  }, [page, boxes, zones, projectId]);

  const byCode = useMemo(() => new Map(items.map((i) => [i.code.toUpperCase(), i])), [items]);
  const rows = useMemo(() => {
    if (!table || choice.type === null) return [];
    const seen = new Set<string>();
    return areaRows(table, choice.type).map((r) => rowToItem(r, choice, table.columns)).filter((r): r is NonNullable<typeof r> => !!r && !seen.has(r.code) && !!seen.add(r.code));
  }, [table, choice]);
  const sections = [...new Set(rows.map((r) => r.section).filter(Boolean))] as string[];
  const chosen = rows.filter((r) => !off.has(r.code) && (update || !byCode.has(r.code)));
  const fresh = chosen.filter((r) => !byCode.has(r.code)).length;

  const write = async () => {
    if (!table) return;
    setBusy('Saving…');
    const head = (i: number | null) => (i === null ? undefined : table.columns[i].header);
    remember(projectId, { type: head(choice.type), description: head(choice.description), skip: table.columns.map((c, i) => (i !== choice.type && i !== choice.description && !choice.extra.includes(i) ? c.header : '')).filter(Boolean) });
    let added = 0, updated = 0;
    try {
      // the section headings as categories (made when missing)
      const catId = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      if (useSections) for (const s of sections) {
        const name = sectionName(s);
        if (catId.has(name.toLowerCase())) continue;
        setBusy(`Adding category ${name}…`);
        try { const { category } = await api<{ category: CategoryRow }>('/categories', { body: { project_id: projectId, name } }); catId.set(name.toLowerCase(), category.id); } catch { /* a teammate may have just added it */ }
      }
      for (const [i, r] of chosen.entries()) {
        setBusy(`Saving ${i + 1} of ${chosen.length}…`);
        const category_id = useSections && r.section ? catId.get(sectionName(r.section).toLowerCase()) ?? null : undefined;
        const cur = byCode.get(r.code);
        if (cur) { await api(`/items/${cur.id}`, { method: 'PATCH', body: { name: r.name, spec: r.spec, count_group: group, ...(category_id !== undefined ? { category_id } : {}) } }); updated++; }
        else { await api('/items', { body: { project_id: projectId, code: r.code, name: r.name, spec: r.spec, unit: 'EA', count_group: group, length_ft: group === 'fixture' ? lengthFeetFromText(r.name, r.spec ?? '') : null, ...(category_id ? { category_id } : {}) } }); added++; }
      }
      toast([added && `Added ${plural(added, 'type')}`, updated && `updated ${plural(updated, 'type')}`].filter(Boolean).join(', ') + '.');
      onDone();
    } catch (e) {
      toast(`${e instanceof ApiError ? e.message : 'Saving stopped.'} ${added + updated ? `${added + updated} were saved before that.` : ''}`);
      setBusy(null);
    }
  };

  const pick = (k: 'type' | 'description', v: string) => setChoice((c) => {
    const i = v === '' ? null : Number(v);
    const next = { ...c, [k]: i };
    // a column picked as Type or Description is not also read into the details
    return { ...next, extra: table ? table.columns.map((_, j) => j).filter((j) => j !== next.type && j !== next.description && (c.extra.includes(j) || j === c.type || j === c.description)) : c.extra };
  });
  const toggleExtra = (i: number) => setChoice((c) => ({ ...c, extra: c.extra.includes(i) ? c.extra.filter((j) => j !== i) : [...c.extra, i].sort((a, b) => a - b) }));
  return (
    <Dialog title="Read schedule" onClose={onClose} wide className="read-schedule">
      <div className="row-between" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="dialog-title" style={{ margin: 0 }}>Read the schedule</div>
        <div className="row" style={{ gap: 6, flex: 'none' }}>
          <button className="btn btn-secondary" onClick={onAddBox} disabled={!!busy}>Box another column</button>
          <button className="btn btn-secondary" onClick={onIgnoreColumn} disabled={!!busy} title="Draw an ignore area over a column (or rows) to leave out, then continue reading">Ignore a column</button>
          <button className="btn btn-ghost" onClick={onStartOver} disabled={!!busy}>Start over</button>
        </div>
      </div>
      {table === undefined && <div className="dialog-body"><span className="spinner" /> Reading…</div>}
      {table === null && (
        <div className="dialog-body">No column header was found in {boxes.length > 1 ? 'these boxes' : 'the box'}. Drag the box over the schedule's header (TYPE, DESCRIPTION…) and a row or two below it; the read follows the columns down the table. Text in ignore areas is left out.</div>
      )}
      {table && (
        <div className="dialog-body stack" style={{ gap: 14 }}>
          <div className="read-cols">
            {(['type', 'description'] as const).map((k) => (
              <label key={k} className="field">
                <span>{k === 'type' ? 'Type (the code)' : 'Description'}</span>
                <select className="input" value={choice[k] ?? ''} onChange={(e) => pick(k, e.target.value)}>
                  <option value="">{k === 'type' ? 'Pick the column' : 'Not read'}</option>
                  {table.columns.map((c, i) => <option key={i} value={i}>{c.header}{c.sample ? ` · ${c.sample.slice(0, 28)}` : ''}</option>)}
                </select>
              </label>
            ))}
            <div className="field read-also">
              <span>Also read, into each item's details</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>
                {table.columns.map((c, i) => (i === choice.type || i === choice.description ? null : (
                  <Check key={i} checked={choice.extra.includes(i)} onChange={() => toggleExtra(i)}>{headerLabel(c.header)}</Check>
                )))}
                {table.columns.length <= 2 && <span className="dim">No other columns read.</span>}
              </div>
            </div>
          </div>
          {choice.type === null ? <div className="hint">Pick the column that holds the type codes (A1, B2…).</div> : (
            <div className="read-rows">
              <table className="table compact">
                <thead><tr><th style={{ width: 28 }} /><th>Type</th><th>Description</th><th>Details</th>{sections.length > 0 && <th>Section</th>}<th /></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const inLib = byCode.has(r.code);
                    return (
                      <tr key={r.code} className={off.has(r.code) || (inLib && !update) ? 'dim' : ''}>
                        <td><input type="checkbox" checked={!off.has(r.code)} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(r.code)) n.delete(r.code); else n.add(r.code); return n; })} aria-label={`Read ${r.code}`} /></td>
                        <td><b>{r.code}</b></td>
                        <td><div className="clamp3">{r.name}</div></td>
                        <td title={r.spec ?? ''}><div className="clamp3">{r.spec}</div></td>
                        {sections.length > 0 && <td className="dim">{r.section ? sectionName(r.section) : ''}</td>}
                        <td>{inLib ? <span className="tag tag-outline">In library</span> : <span className="tag tag-accent">New</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length === 0 && <div className="dim" style={{ padding: 8 }}>No type codes found in that column.</div>}
            </div>
          )}
          <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
            <label className="row" style={{ gap: 8, fontSize: 13 }}>New types are
              <select className="input" style={{ width: 120, minHeight: 30 }} value={group} onChange={(e) => setGroup(e.target.value as 'fixture' | 'device')}><option value="fixture">Fixtures</option><option value="device">Devices</option></select>
            </label>
            {sections.length > 0 && <Check checked={useSections} onChange={setUseSections}>Use the section headings as categories ({sections.map(sectionName).join(', ')})</Check>}
            <Check checked={update} onChange={setUpdate}>Update the types already in the library ({rows.filter((r) => byCode.has(r.code)).length})</Check>
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="btn btn-primary" disabled={!table || choice.type === null || chosen.length === 0 || !!busy} onClick={() => void write()}>
          {busy ?? (chosen.length ? `Save ${plural(chosen.length, 'type')}${fresh && fresh < chosen.length ? ` (${fresh} new)` : ''}` : 'Nothing to save')}
        </button>
      </div>
    </Dialog>
  );
}
