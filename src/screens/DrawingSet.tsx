import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePdf, Check as CheckIcon, SquaresFour, List, UploadSimple, Trash } from '@phosphor-icons/react';
import type { CategoryRow, DrawingFileRow, ItemTypeRow, ProjectRow, SheetKind, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Check, Dialog, Seg, TopBar, fmtBytes, plural, useToast } from '../app/ui.tsx';
import { navigate, paths } from '../app/router.ts';
import { useFetch } from '../app/useFetch.ts';
import { cancelUpload, dismissUpload, startUpload, useUploads } from '../upload/uploads.ts';
import { FLOOR_OPTIONS } from '../upload/titleBlock.ts';
import AutoCountDialog from './AutoCountDialog.tsx';
import ScheduleDialog from './ScheduleDialog.tsx';
import ScheduleSheetsDialog from './ScheduleSheetsDialog.tsx';
import ScheduleFinderDialog from './ScheduleFinderDialog.tsx';
import DuplicatesDialog from './DuplicatesDialog.tsx';

const KIND_LABEL: Record<SheetKind, string> = { floor_plan: 'Floor plan', legend: 'Legend', site_plan: 'Site plan', schedule: 'Schedule', other: 'Other' };
const STATUS_LABEL = { not_counted: 'Not counted', needs_review: 'Needs review', reviewed: 'Reviewed' } as const;

function FloorSelect({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled: boolean }) {
  const opts = value && !FLOOR_OPTIONS.includes(value) ? [value, ...FLOOR_OPTIONS] : FLOOR_OPTIONS;
  return (
    <select className="input" aria-label="Floor" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Floor…</option>
      {opts.map((o) => <option key={o} value={o}>{/^\d+$/.test(o) ? `Level ${o}` : o}</option>)}
    </select>
  );
}

function TextCell({ value, onSave, className, label, disabled }: { value: string | null; onSave: (v: string | null) => void; className: string; label: string; disabled: boolean }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <input className={`ghost-input ${className}`} aria-label={label} value={v} disabled={disabled} placeholder={label}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t !== (value ?? '')) onSave(t || null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export default function DrawingSet({ projectId }: { projectId: string }) {
  const { me } = useAuth();
  const canEdit = me?.role !== 'viewer';
  const isAdmin = me?.role === 'admin';
  const toast = useToast();
  const project = useFetch<{ project: ProjectRow }>(`/projects/${projectId}`);
  const files = useFetch<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
  const sheetsQ = useFetch<{ sheets: SheetRow[] }>(`/sheets?project=${projectId}`);
  const items = useFetch<{ items: ItemTypeRow[] }>(`/items?project=${projectId}`);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sheets, setSheets] = useState<SheetRow[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DrawingFileRow | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false); // Read schedules: the sheets with schedules, to box
  const [picked, setPicked] = useState<Set<string>>(new Set());   // drawings ticked for deleting
  const [delSheets, setDelSheets] = useState(false);
  const [schedSheetsOpen, setSchedSheetsOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const cats = useFetch<{ categories: CategoryRow[] }>(`/categories?project=${projectId}`);
  const picker = useRef<HTMLInputElement>(null);
  const jobs = useUploads(projectId);

  useEffect(() => { if (sheetsQ.data) setSheets(sheetsQ.data.sheets); }, [sheetsQ.data]);

  // Refresh while anything is still being processed (here or by a teammate).
  const busyRemote = (files.data?.files ?? []).some((f) => f.upload_status === 'uploading' || f.upload_status === 'processing');
  const activeJobs = jobs.some((j) => j.phase === 'uploading' || j.phase === 'splitting');
  useEffect(() => {
    if (!busyRemote && !activeJobs) return;
    const t = window.setInterval(() => { void files.reload(); void sheetsQ.reload(); }, 3000);
    return () => window.clearInterval(t);
  }, [busyRemote, activeJobs, files.reload, sheetsQ.reload]);

  const proj = project.data?.project;
  // Schedules and legends are never auto-counted: the tags printed in their tables are not fixtures on a plan.
  const isNonCounting = (s: SheetRow) => s.kind === 'schedule' || s.kind === 'legend';
  const enabled = sheets.filter((s) => s.count_enabled && !isNonCounting(s));
  const skippedSheets = sheets.filter((s) => s.count_enabled && isNonCounting(s)).length;
  const libCount = items.data?.items.length ?? 0;
  const platesOk = sheets.length > 0 && sheets.filter((s) => s.kind === 'floor_plan').every((s) => s.number && s.floor);

  async function patch(s: SheetRow, fields: Partial<Pick<SheetRow, 'number' | 'title' | 'kind' | 'floor' | 'scale' | 'count_enabled'>>) {
    const before = sheets;
    setSheets((cur) => cur.map((x) => (x.id === s.id ? { ...x, ...fields } : x)));
    try {
      const r = await api<{ sheet: SheetRow }>(`/sheets/${s.id}`, { method: 'PATCH', body: fields });
      setSheets((cur) => cur.map((x) => (x.id === s.id ? r.sheet : x)));
    } catch (e) {
      setSheets(before);
      toast(e instanceof ApiError ? e.message : 'Could not save that change.');
    }
  }

  function openWorkspace() {
    const first = enabled[0] ?? sheets[0];
    if (first) navigate(paths.sheet(projectId, first.id));
  }

  function addFile(f: File | undefined) {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return toast(/\.tiff?$/i.test(f.name) ? 'TIFF drawings are not supported yet. Please upload a PDF.' : "That isn't a PDF.");
    startUpload(projectId, f, me?.limits.maxFileBytes ?? 200 * 1048576, () => { void files.reload(); void sheetsQ.reload(); void project.reload(); });
  }

  const readyFiles = (files.data?.files ?? []).filter((f) => f.upload_status === 'ready');
  const remoteBusy = (files.data?.files ?? []).filter((f) => f.upload_status === 'uploading' || f.upload_status === 'processing');
  const err = project.error || sheetsQ.error || files.error;

  return (
    <>
      <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: proj?.name ?? '…', to: paths.project(projectId) }, { label: 'Drawing set' }]}>
        {canEdit && <button className="btn btn-secondary" onClick={() => picker.current?.click()}><UploadSimple size={14} /> Add drawings</button>}
        <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="btn btn-secondary" onClick={() => navigate(paths.library(projectId))}>Item library</button>
        <button className="btn btn-secondary" onClick={() => navigate(paths.panels(projectId))}>Panels</button>
        <button className="btn btn-secondary" onClick={openWorkspace} disabled={sheets.length === 0}>Open workspace</button>
        {canEdit && <button className="btn btn-secondary" onClick={() => setFinderOpen(true)} disabled={sheets.length === 0} title="Find the sheets with schedules, then box the schedules to read into the item library">Read schedules</button>}
        {canEdit && <button className="btn btn-secondary" onClick={() => setSchedSheetsOpen(true)} disabled={sheets.length === 0} title="Stop counting the sheets that are, or hold, schedules">Exclude schedules</button>}
        {isAdmin && <button className="btn btn-secondary" onClick={() => setDupOpen(true)} disabled={sheets.length < 2} title="Find and remove sheets that were uploaded more than once">Remove duplicates</button>}
        {canEdit && <button className="btn btn-primary" onClick={() => setAutoOpen(true)} disabled={enabled.length === 0} title={enabled.length === 0 ? 'Tick Count on at least one sheet first.' : skippedSheets ? `${plural(skippedSheets, 'schedule or legend sheet')} ticked to count will be skipped.` : undefined}>Auto-count {enabled.length} sheet{enabled.length === 1 ? '' : 's'}</button>}
      </TopBar>
      <div className="two-col">
        <main className="sheet-main">
          <div className="row-between">
            <div>
              <h3 style={{ marginBottom: 2 }}>Sheet index</h3>
              <div className="muted" style={{ fontSize: 13 }}>Sheet numbers and titles are read from each title block. Check the floor, then pick which sheets to count.</div>
            </div>
            <Seg name="view" value={view} onChange={setView} options={[{ value: 'grid', label: <><SquaresFour size={14} /> Grid</> }, { value: 'list', label: <><List size={14} /> List</> }]} />
          </div>

          {err && <div className="err-text" role="alert">{err}</div>}

          <div className="stack" style={{ gap: 8 }}>
            {jobs.map((j) => (
              <div key={j.id} className="upload-row">
                <FilePdf size={20} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.fileName}</div>
                  <div className="dim" style={{ fontSize: 11 }}>{fmtBytes(j.sizeBytes)}</div>
                </div>
                {j.phase === 'error' ? <span className="err-text" style={{ maxWidth: 360 }}>{j.text}</span> : (
                  <>
                    <div className="progress" style={{ width: 160 }}><i style={{ width: `${Math.round(j.pct * 100)}%` }} /></div>
                    <span className="muted" style={{ fontSize: 12, minWidth: 110 }}>{j.text}</span>
                  </>
                )}
                {(j.phase === 'uploading' || j.phase === 'splitting') && <button className="btn btn-secondary" onClick={() => cancelUpload(j.id)}>Cancel</button>}
                {j.phase === 'error' && <button className="btn btn-secondary" onClick={() => dismissUpload(j.id)}>Dismiss</button>}
              </div>
            ))}
            {remoteBusy.filter((f) => !jobs.some((j) => j.fileName === f.file_name && (j.phase === 'uploading' || j.phase === 'splitting'))).map((f) => (
              <div key={f.id} className="upload-row"><FilePdf size={20} /><div style={{ flex: 1 }}>{f.file_name}</div><span className="muted" style={{ fontSize: 12 }}>A teammate is uploading this…</span></div>
            ))}
            {readyFiles.map((f) => (
              <div key={f.id} className="upload-row">
                <FilePdf size={20} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</div>
                  <div className="dim" style={{ fontSize: 11 }}>{plural(f.page_count ?? 0, 'page')} · {fmtBytes(f.size_bytes)}</div>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{plural(f.page_count ?? 0, 'sheet')} indexed</span>
                {canEdit && <button className="btn btn-ghost btn-icon" aria-label={`Delete ${f.file_name}`} title="Delete this drawing set (all its sheets)" onClick={() => setConfirmDelete(f)}><Trash size={16} /></button>}
              </div>
            ))}
          </div>

          {sheetsQ.loading && !sheetsQ.data && <div className="muted"><span className="spinner" /> Loading sheets…</div>}
          {!sheetsQ.loading && sheets.length === 0 && jobs.length === 0 && remoteBusy.length === 0 && (
            <div className="empty">
              <div>No drawings yet.</div>
              {canEdit ? <button className="btn btn-primary" onClick={() => picker.current?.click()}>Upload a PDF drawing set</button> : <div>An estimator or admin needs to upload the drawing set.</div>}
            </div>
          )}

          {canEdit && sheets.length > 0 && (
            <div className="row sheet-pick-bar">
              {picked.size > 0
                ? <><span className="num"><b>{picked.size}</b> selected</span>
                    <button className="btn btn-secondary" onClick={() => setDelSheets(true)}><Trash size={14} /> Delete selected</button>
                    <button className="btn btn-ghost" onClick={() => setPicked(new Set())}>Clear</button></>
                : <span className="dim">Tick drawings to delete them from the project.</span>}
              <span style={{ flex: 1 }} />
              {picked.size < sheets.length && <button className="btn btn-ghost" onClick={() => setPicked(new Set(sheets.map((x) => x.id)))}>Select all</button>}
            </div>
          )}
          {view === 'grid' ? (
            <div className="sheet-grid">
              {sheets.map((s) => (
                <div key={s.id} className={`sheet-card${s.count_enabled ? ' on' : ''}${picked.has(s.id) ? ' picked' : ''}`}>
                  {canEdit && (
                    <label className="sheet-pick" title="Select this drawing">
                      <input type="checkbox" aria-label={`Select ${s.number ?? `page ${s.page}`}`} checked={picked.has(s.id)} onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    </label>
                  )}
                  {/* the thumbnail opens that drawing; the number and title below still edit in place */}
                  <button type="button" className="thumb thumb-open" onClick={() => navigate(paths.sheet(projectId, s.id))} aria-label={`Open sheet ${s.number ?? `page ${s.page}`}`} title="Open this drawing">
                    <img src={`/api/sheets/${s.id}/thumb`} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                    <span className="tag tag-neutral">{KIND_LABEL[s.kind]}</span>
                    <span className="st">{STATUS_LABEL[s.count_status]}{s.detection_count > 0 ? ` · ${s.detection_count}` : ''}</span>
                    <span className="open-hint">Open</span>
                  </button>
                  <div className="sheet-body">
                    <div>
                      <div className="row" style={{ gap: 6 }}>
                        <TextCell className="t1" label="Sheet number" value={s.number} disabled={!canEdit} onSave={(v) => patch(s, { number: v })} />
                        {(s.title_unsure || !s.number) && <span className="tag tag-outline" title="Read from the title block. Please check.">Check</span>}
                      </div>
                      <TextCell className="t2" label="Sheet title" value={s.title} disabled={!canEdit} onSave={(v) => patch(s, { title: v })} />
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <div style={{ flex: 1 }}><FloorSelect value={s.floor} disabled={!canEdit} onChange={(v) => patch(s, { floor: v })} /></div>
                      <Check checked={s.count_enabled} disabled={!canEdit} onChange={(v) => patch(s, { count_enabled: v })}>Count</Check>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            sheets.length > 0 && (
              <table className="table">
                <thead><tr>
                  {canEdit && <th style={{ width: 32 }}><input type="checkbox" aria-label="Select all drawings" checked={picked.size === sheets.length} ref={(el) => { if (el) el.indeterminate = picked.size > 0 && picked.size < sheets.length; }} onChange={(e) => setPicked(e.target.checked ? new Set(sheets.map((x) => x.id)) : new Set())} /></th>}
                  <th>Page</th><th>Number</th><th>Title</th><th>Kind</th><th>Floor</th><th>Count</th><th className="right">Counted</th><th /></tr></thead>
                <tbody>
                  {sheets.map((s) => (
                    <tr key={s.id}>
                      {canEdit && <td><input type="checkbox" aria-label={`Select ${s.number ?? `page ${s.page}`}`} checked={picked.has(s.id)} onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} /></td>}
                      <td className="num">{s.page}</td>
                      <td style={{ width: 120 }}><TextCell className="t1" label="Sheet number" value={s.number} disabled={!canEdit} onSave={(v) => patch(s, { number: v })} /></td>
                      <td><TextCell className="t2" label="Sheet title" value={s.title} disabled={!canEdit} onSave={(v) => patch(s, { title: v })} /></td>
                      <td style={{ width: 140 }}>
                        <select className="input" aria-label="Kind" value={s.kind} disabled={!canEdit} onChange={(e) => patch(s, { kind: e.target.value as SheetKind })}>
                          {(Object.keys(KIND_LABEL) as SheetKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                        </select>
                      </td>
                      <td style={{ width: 130 }}><FloorSelect value={s.floor} disabled={!canEdit} onChange={(v) => patch(s, { floor: v })} /></td>
                      <td><Check checked={s.count_enabled} disabled={!canEdit} onChange={(v) => patch(s, { count_enabled: v })}>Count</Check></td>
                      <td className="right num">{s.detection_count}</td>
                      <td className="right"><button className="btn btn-secondary" style={{ minHeight: 28, padding: '2px 10px' }} onClick={() => navigate(paths.sheet(projectId, s.id))} aria-label={`Open sheet ${s.number ?? `page ${s.page}`}`}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </main>

        <aside className="side-right">
          <h6>Before you count</h6>
          <div className="steps">
            <div className={`step${platesOk ? ' done' : ''}`}>
              <div className="step-badge">{platesOk ? <CheckIcon size={12} weight="bold" /> : 1}</div>
              <div><div>Check sheet names and floors.</div><div className="dim" style={{ fontSize: 12 }}>Marked “Check” means the title block wasn't clear.</div></div>
            </div>
            <div className={`step${libCount > 0 ? ' done' : ''}`}>
              <div className="step-badge">{libCount > 0 ? <CheckIcon size={12} weight="bold" /> : 2}</div>
              <div>
                <div>Set up your item library.</div>
                <div className="dim" style={{ fontSize: 12 }}>{libCount > 0 ? `${plural(libCount, 'item')} in the library.` : 'No items yet. Add the fixtures and devices you count.'}</div>
                <button className="btn btn-ghost" style={{ padding: 0 }} onClick={() => navigate(paths.library(projectId))}>Open item library</button>
              </div>
            </div>
            <div className={`step${enabled.length > 0 ? ' done' : ''}`}>
              <div className="step-badge">{enabled.length > 0 ? <CheckIcon size={12} weight="bold" /> : 3}</div>
              <div><div>Choose sheets to count.</div><div className="dim" style={{ fontSize: 12 }}>{plural(enabled.length, 'sheet')} selected.</div></div>
            </div>
          </div>
        </aside>
      </div>

      {schedSheetsOpen && (
        <ScheduleSheetsDialog sheets={sheets} files={files.data?.files ?? []} onClose={() => setSchedSheetsOpen(false)}
          onDone={(msg) => { setSchedSheetsOpen(false); toast(msg); void sheetsQ.reload(); void project.reload(); }} />
      )}
      {dupOpen && (
        <DuplicatesDialog sheets={sheets} files={files.data?.files ?? []} onClose={() => setDupOpen(false)}
          onDone={(msg) => { setDupOpen(false); toast(msg); void files.reload(); void sheetsQ.reload(); void project.reload(); }} />
      )}
      {finderOpen && (
        <ScheduleFinderDialog projectId={projectId} sheets={sheets} files={files.data?.files.filter((f) => f.upload_status === 'ready') ?? []} onClose={() => setFinderOpen(false)} onOldReader={() => { setFinderOpen(false); setScheduleOpen(true); }} />
      )}
      {scheduleOpen && (
        <ScheduleDialog projectId={projectId} sheets={sheets} files={files.data?.files.filter((f) => f.upload_status === 'ready') ?? []} items={items.data?.items ?? []} categories={cats.data?.categories ?? []}
          onClose={() => setScheduleOpen(false)} onDone={(msg) => { setScheduleOpen(false); toast(msg); void items.reload(); void cats.reload(); }} />
      )}
      {autoOpen && (
        <AutoCountDialog projectId={projectId} sheets={enabled} items={items.data?.items ?? []} onClose={() => setAutoOpen(false)}
          onDone={(msg) => { setAutoOpen(false); toast(msg); void sheetsQ.reload(); void items.reload(); void project.reload(); const first = enabled[0]; if (first) navigate(paths.sheet(projectId, first.id)); }} />
      )}
      {delSheets && (
        <DeleteSheetsDialog sheets={sheets.filter((x) => picked.has(x.id))} onClose={() => setDelSheets(false)}
          onDone={(msg) => { setDelSheets(false); setPicked(new Set()); toast(msg); void files.reload(); void sheetsQ.reload(); void project.reload(); }} />
      )}
      {confirmDelete && (
        <Dialog title="Delete drawing set" onClose={() => setConfirmDelete(null)}>
          <div className="dialog-title">Delete “{confirmDelete.file_name}”?</div>
          <div className="dialog-body">This removes the file, its {plural(sheets.filter((x) => x.file_id === confirmDelete.id).length, 'sheet')} and every count on them ({plural(sheets.filter((x) => x.file_id === confirmDelete.id).reduce((n, x) => n + x.detection_count, 0), 'count')}). It can't be undone.</div>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={async () => {
              try { await api(`/files/${confirmDelete.id}`, { method: 'DELETE' }); setConfirmDelete(null); void files.reload(); void sheetsQ.reload(); void project.reload(); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.'); }
            }}>Delete</button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Deleting drawings from the project: their counts go with them; a PDF goes once its last sheet is deleted. */
function DeleteSheetsDialog({ sheets, onClose, onDone }: { sheets: SheetRow[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const counts = sheets.reduce((n, s) => n + s.detection_count, 0);
  const ok = counts === 0 || typed.trim().toLowerCase() === 'delete';
  const name = (s: SheetRow) => s.number ?? `Page ${s.page}`;
  const go = async () => {
    setErr(null);
    let done = 0, files = 0;
    try {
      for (const s of sheets) {
        setBusy(`Deleting ${done + 1} of ${sheets.length}…`);
        const r = await api<{ ok: boolean; file_removed?: boolean }>(`/sheets/${s.id}`, { method: 'DELETE' });
        done++; if (r.file_removed) files++;
      }
      onDone(`Deleted ${plural(done, 'drawing')}${counts ? ` and ${plural(counts, 'count')}` : ''}${files ? `; ${plural(files, 'PDF')} with no sheets left ${files === 1 ? 'was' : 'were'} removed` : ''}.`);
    } catch (e) {
      setErr(`${e instanceof ApiError ? e.message : 'Deleting stopped.'}${done ? ` ${plural(done, 'drawing')} ${done === 1 ? 'was' : 'were'} deleted before that.` : ''}`);
      setBusy(null);
    }
  };
  return (
    <Dialog title="Delete drawings" onClose={busy ? () => undefined : onClose}>
      <div className="dialog-title">Delete {plural(sheets.length, 'drawing')} from the project?</div>
      <div className="dialog-body stack" style={{ gap: 10 }}>
        <div>{sheets.slice(0, 10).map(name).join(', ')}{sheets.length > 10 ? `, and ${sheets.length - 10} more` : ''}.</div>
        <div>{counts ? <>Every count on {sheets.length === 1 ? 'it' : 'them'} goes too: <b>{plural(counts, 'count')}</b>. </> : 'There are no counts on them. '}A drawing set's PDF is removed once its last sheet is deleted. This can't be undone.</div>
        {counts > 0 && (
          <label className="field"><span>To confirm, type <b>delete</b></span>
            <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type delete to confirm" autoComplete="off" />
          </label>
        )}
        {err && <div className="err-text" role="alert">{err}</div>}
      </div>
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={!!busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void go()} disabled={!ok || !!busy}>{busy ?? `Delete ${plural(sheets.length, 'drawing')}`}</button>
      </div>
    </Dialog>
  );
}
