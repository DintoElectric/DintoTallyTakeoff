import { useEffect, useMemo, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { ItemTypeRow } from '../../shared/types.ts';
import { inZones, type Zone } from '../../shared/zones.ts';
import { api, ApiError } from '../auth/api.ts';
import { pdfjs } from '../viewer/pdf.ts';
import { extractRuns } from '../detect/pageRuns.ts';
import { extractPrims } from '../detect/primitives.ts';
import { lengthFeetFromText } from '../detect/lengthText.ts';
import { areaRows, FIELDS, readAreaTable, rowToItem, suggestColumns, type AreaTable, type Box, type Field } from '../detect/areaSchedule.ts';
import { Check, Dialog, plural, useToast } from '../app/ui.tsx';

// The columns picked last time, by header name, so the next sheet of the same schedule is set up already.
const memKey = (projectId: string) => `tally.readcols.${projectId}`;
const recall = (projectId: string): Partial<Record<Field, string>> => { try { return JSON.parse(localStorage.getItem(memKey(projectId)) ?? '{}'); } catch { return {}; } };
const remember = (projectId: string, v: Partial<Record<Field, string>>) => { try { localStorage.setItem(memKey(projectId), JSON.stringify(v)); } catch { /* not kept: picked again next time */ } };

/** Reads the schedule in the boxed area: the estimator picks the Type, Description, Driver and Basis of design columns. */
export default function ReadScheduleDialog({ page, projectId, boxes, zones, items, onAddBox, onStartOver, onClose, onDone }: {
  page: PDFPageProxy; projectId: string; boxes: Box[]; zones: Zone[]; items: ItemTypeRow[];
  onAddBox: () => void; onStartOver: () => void; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [table, setTable] = useState<AreaTable | null | undefined>(undefined); // undefined: reading
  const [cols, setCols] = useState<Record<Field, number | null>>({ type: null, description: null, driver: null, basis: null });
  const [off, setOff] = useState<Set<string>>(new Set());         // rows unticked, by code
  const [update, setUpdate] = useState(true);
  const [group, setGroup] = useState<'fixture' | 'device'>('fixture');
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
      if (t) setCols(suggestColumns(t.columns, recall(projectId)));
    })().catch((e) => { console.warn('Reading the schedule failed', e); if (!gone) setTable(null); });
    return () => { gone = true; };
  }, [page, boxes, zones, projectId]);

  const byCode = useMemo(() => new Map(items.map((i) => [i.code.toUpperCase(), i])), [items]);
  const rows = useMemo(() => {
    if (!table || cols.type === null) return [];
    const seen = new Set<string>();
    return areaRows(table, cols.type).map((r) => rowToItem(r, cols)).filter((r): r is NonNullable<typeof r> => !!r && !seen.has(r.code) && !!seen.add(r.code));
  }, [table, cols]);
  const chosen = rows.filter((r) => !off.has(r.code) && (update || !byCode.has(r.code)));
  const fresh = chosen.filter((r) => !byCode.has(r.code)).length;

  const write = async () => {
    if (!table) return;
    setBusy('Saving…');
    remember(projectId, Object.fromEntries(FIELDS.map((f) => [f.key, cols[f.key] === null ? '' : table.columns[cols[f.key] as number].header])));
    let added = 0, updated = 0;
    try {
      for (const [i, r] of chosen.entries()) {
        setBusy(`Saving ${i + 1} of ${chosen.length}…`);
        const cur = byCode.get(r.code);
        if (cur) { await api(`/items/${cur.id}`, { method: 'PATCH', body: { name: r.name, spec: r.spec, count_group: group } }); updated++; }
        else { await api('/items', { body: { project_id: projectId, code: r.code, name: r.name, spec: r.spec, unit: 'EA', count_group: group, length_ft: lengthFeetFromText(r.name, r.spec ?? '') } }); added++; }
      }
      toast([added && `Added ${plural(added, 'type')}`, updated && `updated ${plural(updated, 'type')}`].filter(Boolean).join(', ') + '.');
      onDone();
    } catch (e) {
      toast(`${e instanceof ApiError ? e.message : 'Saving stopped.'} ${added + updated ? `${added + updated} were saved before that.` : ''}`);
      setBusy(null);
    }
  };

  const pick = (f: Field, v: string) => setCols((c) => ({ ...c, [f]: v === '' ? null : Number(v) }));
  return (
    <Dialog title="Read schedule" onClose={onClose} wide className="read-schedule">
      <div className="dialog-title">Read the schedule</div>
      {table === undefined && <div className="dialog-body"><span className="spinner" /> Reading…</div>}
      {table === null && (
        <div className="dialog-body">No column header was found in {boxes.length > 1 ? 'these boxes' : 'the box'}. Drag the box over a header (TYPE, DESCRIPTION, DRIVER…) and a row or two below it; the read follows the column down the table. Text in ignore areas is left out.</div>
      )}
      {table && (
        <div className="dialog-body stack" style={{ gap: 14 }}>
          <div className="row-between" style={{ gap: 12 }}>
            <div className="dim" style={{ fontSize: 13 }}>{plural(table.columns.length, 'column')} found in {plural(boxes.length, 'box', 'boxes')}: {table.columns.map((c) => c.header).join(' · ')}. Pick the ones to read; the others are skipped.</div>
            <div className="row" style={{ gap: 6, flex: 'none' }}>
              <button className="btn btn-secondary" onClick={onAddBox} disabled={!!busy}>Box another column</button>
              <button className="btn btn-ghost" onClick={onStartOver} disabled={!!busy}>Start over</button>
            </div>
          </div>
          <div className="read-cols">
            {FIELDS.map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                <select className="input" value={cols[f.key] ?? ''} onChange={(e) => pick(f.key, e.target.value)}>
                  <option value="">{f.key === 'type' ? 'Pick the column' : 'Not read'}</option>
                  {table.columns.map((c, i) => <option key={i} value={i}>{c.header}{c.sample ? ` · ${c.sample.slice(0, 28)}` : ''}</option>)}
                </select>
              </label>
            ))}
          </div>
          {cols.type === null ? <div className="hint">Pick the column that holds the type codes (A1, B2…).</div> : (
            <div className="read-rows">
              <table className="table compact">
                <thead><tr><th style={{ width: 28 }} /><th>Type</th><th>Description</th><th>Driver</th><th>Basis of design</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const spec = r.spec ?? '';
                    const driver = /Driver: (.*?)( · Basis of design: |$)/.exec(spec)?.[1] ?? '';
                    const basis = /Basis of design: (.*)$/.exec(spec)?.[1] ?? '';
                    const inLib = byCode.has(r.code);
                    return (
                      <tr key={r.code} className={off.has(r.code) || (inLib && !update) ? 'dim' : ''}>
                        <td><input type="checkbox" checked={!off.has(r.code)} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(r.code)) n.delete(r.code); else n.add(r.code); return n; })} aria-label={`Read ${r.code}`} /></td>
                        <td><b>{r.code}</b></td>
                        <td><div className="clamp3">{r.name}</div></td>
                        <td>{driver}</td>
                        <td title={basis}><div className="clamp3">{basis}</div></td>
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
            <Check checked={update} onChange={setUpdate}>Update the types already in the library ({rows.filter((r) => byCode.has(r.code)).length})</Check>
          </div>
        </div>
      )}
      <div className="dialog-actions">
        {table === null && <><button className="btn btn-ghost" onClick={onStartOver}>Start over</button><button className="btn btn-secondary" onClick={onAddBox}>Box another column</button></>}
        <button className="btn btn-secondary" onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="btn btn-primary" disabled={!table || cols.type === null || chosen.length === 0 || !!busy} onClick={() => void write()}>
          {busy ?? (chosen.length ? `Save ${plural(chosen.length, 'type')}${fresh && fresh < chosen.length ? ` (${fresh} new)` : ''}` : 'Nothing to save')}
        </button>
      </div>
    </Dialog>
  );
}
