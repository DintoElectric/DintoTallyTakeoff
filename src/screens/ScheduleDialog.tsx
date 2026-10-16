import { useEffect, useMemo, useState } from 'react';
import type { CategoryRow, DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { categoryFor, resolveSimilar, specLine, type ScheduleRow } from '../detect/scheduleParse.ts';
import { readSchedulePage } from '../detect/readSchedulePage.ts';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';

type Phase = 'pick' | 'read' | 'review' | 'write';
const label = (s: SheetRow) => s.number ?? `page ${s.page}`;

/** Reads a fixture schedule from sheets in the drawing set and turns its rows into library items. */
export default function ScheduleDialog({ projectId, sheets, files, items, categories, onClose, onDone }: {
  projectId: string; sheets: SheetRow[]; files: DrawingFileRow[]; items: ItemTypeRow[]; categories: CategoryRow[];
  onClose: () => void; onDone: (summary: string) => void;
}) {
  const scheduleSheets = useMemo(() => sheets.filter((s) => s.kind === 'schedule'), [sheets]);
  const [phase, setPhase] = useState<Phase>(scheduleSheets.length ? 'read' : 'pick');
  const [chosen, setChosen] = useState<Set<string>>(new Set(scheduleSheets.map((s) => s.id)));
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [inc, setInc] = useState<Set<string>>(new Set());
  const [updateExisting, setUpdateExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [searchedAll, setSearchedAll] = useState(false);

  const byCode = useMemo(() => {
    const m = new Map<string, ItemTypeRow[]>();
    for (const i of items) m.set(i.code.toUpperCase(), [...(m.get(i.code.toUpperCase()) ?? []), i]);
    return m;
  }, [items]);

  // A row's identity: its code, unless the schedule repeats codes for different items (IPC: ceiling and wall mounted).
  const rkey = (r: ScheduleRow) => r.key ?? r.code;
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toUpperCase();
  const existingFor = (r: ScheduleRow): ItemTypeRow | undefined => {
    const list = byCode.get(r.code.toUpperCase()) ?? [];
    return r.key ? list.find((i) => norm(i.name) === norm(r.name)) : list[0];
  };

  /** Reads one sheet. With `onlyIfLooksLikeOne`, a sheet whose text has no schedule-table headings is skipped cheaply. */
  async function readSheet(sh: SheetRow, onlyIfLooksLikeOne: boolean): Promise<ScheduleRow[]> {
    const f = files.find((x) => x.id === sh.file_id);
    if (!f) return [];
    const pdf = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
    const page = await pdf.getPage(sh.page);
    try { return await readSchedulePage(page, pdfjs.OPS, onlyIfLooksLikeOne); } finally { page.cleanup(); }
  }

  async function read(ids: Set<string>, onlyIfLooksLikeOne = false) {
    setPhase('read');
    setError(null);
    const list = sheets.filter((s) => ids.has(s.id));
    const all: ScheduleRow[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        setProgress({ done: i, total: list.length, label: label(list[i]) });
        all.push(...(await readSheet(list[i], onlyIfLooksLikeOne)));
        await new Promise((r) => setTimeout(r, 0));
      }
      // A type listed twice keeps its first row.
      const seen = new Set<string>();
      const unique = all.filter((r) => (seen.has(rkey(r)) ? false : (seen.add(rkey(r)), true)));
      resolveSimilar(unique);
      setRows(unique);
      setInc(new Set(unique.filter((r) => !r.removed && !existingFor(r)).map(rkey)));
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The schedule could not be read.');
      setPhase('pick');
    }
  }

  useEffect(() => { if (scheduleSheets.length) void read(chosen); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function write() {
    setPhase('write');
    setError(null);
    try {
      const chosenRows = rows.filter((r) => inc.has(rkey(r)));
      // Categories come from the schedule (outlet kinds, camera, receptacle) or the mounting (Recessed, Pendant, ...). Create the ones that are missing.
      const catOf = (r: ScheduleRow) => r.category ?? categoryFor(r.mounting);
      const catId = new Map<string, string>(categories.map((c) => [c.name.toLowerCase(), c.id]));
      for (const name of new Set(chosenRows.map(catOf))) {
        if (catId.has(name.toLowerCase())) continue;
        setStatus(`Adding category ${name}…`);
        try {
          const { category } = await api<{ category: CategoryRow }>('/categories', { body: { name } });
          catId.set(name.toLowerCase(), category.id);
        } catch { /* a teammate may have just added it; the item is saved without a category */ }
      }
      let added = 0, updated = 0, skipped = 0;
      for (let i = 0; i < chosenRows.length; i++) {
        const r = chosenRows[i];
        setStatus(`Saving ${r.code} (${i + 1} of ${chosenRows.length})…`);
        const existing = existingFor(r);
        try {
          if (existing) {
            if (updateExisting) {
              await api(`/items/${existing.id}`, { method: 'PATCH', body: { name: r.name, spec: specLine(r) } });
              updated++;
            } else skipped++;
          } else {
            await api('/items', {
              body: {
                code: r.code, name: r.name.slice(0, 200), spec: specLine(r) || null, unit: 'EA',
                category_id: catId.get(catOf(r).toLowerCase()) ?? null, marker_shape: 'circle', marker_glyph: r.code.slice(0, 2),
              },
            });
            added++;
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) skipped++;
          else throw e;
        }
      }
      onDone(`Schedule read: ${plural(added, 'type')} added${updated ? `, ${updated} updated` : ''}${skipped ? `, ${skipped} already in the library` : ''}.`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Saving the types failed.');
      setPhase('review');
    }
  }

  const nIncluded = rows.filter((r) => inc.has(rkey(r))).length;
  const inLib = rows.filter((r) => existingFor(r)).length;
  const removed = rows.filter((r) => r.removed).length;

  return (
    <Dialog title="Read schedule" onClose={phase === 'write' ? () => undefined : onClose} wide>
      <div className="dialog-title">Read schedule</div>

      {phase === 'pick' && (
        <>
          <div className="muted" style={{ fontSize: 13 }}>
            {scheduleSheets.length === 0 ? "No sheet is marked as a schedule. Choose the sheet(s) that hold the schedule table." : 'Choose the sheet(s) to read.'}
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto' }} className="stack">
            {sheets.map((s) => (
              <Check key={s.id} checked={chosen.has(s.id)} onChange={(v) => setChosen((cur) => { const n = new Set(cur); if (v) n.add(s.id); else n.delete(s.id); return n; })}>
                {label(s)}{s.title ? ` · ${s.title}` : ''}
              </Check>
            ))}
          </div>
        </>
      )}

      {phase === 'read' && (
        <div className="stack">
          <div className="muted" style={{ fontSize: 13 }}>Reading the schedule table…</div>
          <div className="progress" style={{ width: '100%' }}><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="dim" style={{ fontSize: 12 }}>{progress.label ? `Sheet ${progress.done + 1} of ${progress.total}: ${progress.label}` : 'Loading the drawings…'}</div>
        </div>
      )}

      {(phase === 'review' || phase === 'write') && (
        <>
          {rows.length === 0 ? (
            <div className="stack">
              <div className="banner">I couldn't find a schedule table I can read on {searchedAll ? 'any sheet' : 'those sheets'}. Tables drawn as pictures (scans) have no text to read.</div>
              {!searchedAll && sheets.length > chosen.size && (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-secondary" onClick={() => { setSearchedAll(true); void read(new Set(sheets.map((x) => x.id)), true); }}>Search every sheet for a schedule</button>
                  <button className="btn btn-ghost" onClick={() => setPhase('pick')}>Choose sheets myself</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="muted" style={{ fontSize: 13 }}>
                Found {plural(rows.length, 'type')}{inLib ? `, ${inLib} already in your library` : ''}{removed ? `, ${removed} marked removed` : ''}.
                Ticked types are added to the item library, with their description and specs. Check them over before adding.
              </div>
              <div style={{ maxHeight: 340, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr><th /><th>Type</th><th>Group</th><th>Description</th><th>Details</th><th>Listed</th></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const lib = !!existingFor(r);
                      return (
                        <tr key={rkey(r)} style={r.removed ? { opacity: 0.55 } : undefined}>
                          <td><Check checked={inc.has(rkey(r))} disabled={phase === 'write' || (lib && !updateExisting)} onChange={(v) => setInc((cur) => { const n = new Set(cur); if (v) n.add(rkey(r)); else n.delete(rkey(r)); return n; })}><span className="sr-only">Include {r.code}</span></Check></td>
                          <td style={{ fontWeight: 500 }}>{r.code}{lib && <span className="tag tag-neutral" style={{ marginLeft: 6 }}>In library</span>}{r.removed && <span className="tag tag-outline" style={{ marginLeft: 6 }}>Removed</span>}</td>
                          <td style={{ fontSize: 12 }}>{r.category ?? categoryFor(r.mounting)}</td>
                          <td style={{ maxWidth: 280 }}>{r.name}</td>
                          <td style={{ fontSize: 12 }}>{r.spec ?? [r.lumens, r.watts, r.manufacturer !== '-' ? r.manufacturer : ''].filter((x) => x && x !== '-' && x !== 'N/A').join(' · ')}</td>
                          <td className="num" style={{ fontSize: 12 }}>{r.count ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {inLib > 0 && <Check checked={updateExisting} onChange={(v) => { setUpdateExisting(v); if (v) setInc((cur) => new Set([...cur, ...rows.filter((r) => existingFor(r) && !r.removed).map(rkey)])); else setInc((cur) => new Set([...cur].filter((k) => !rows.some((r) => rkey(r) === k && existingFor(r))))); }}>Also update the description of types already in the library</Check>}
            </>
          )}
        </>
      )}

      {error && <div className="err-text" role="alert">{error}</div>}
      {status && phase === 'write' && <div className="muted" style={{ fontSize: 13 }} role="status"><span className="spinner" /> {status}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'write'}>Cancel</button>
        {phase === 'pick' && <button className="btn btn-secondary" onClick={() => { setSearchedAll(true); void read(new Set(sheets.map((x) => x.id)), true); }}>Search every sheet</button>}
        {phase === 'pick' && <button className="btn btn-primary" onClick={() => void read(chosen)} disabled={chosen.size === 0}>Read {plural(chosen.size, 'sheet')}</button>}
        {(phase === 'review' || phase === 'write') && rows.length > 0 && <button className="btn btn-primary" onClick={() => void write()} disabled={phase === 'write' || nIncluded === 0}>Add {plural(nIncluded, 'type')} to library</button>}
      </div>
    </Dialog>
  );
}
