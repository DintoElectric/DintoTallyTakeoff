import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { FileArrowUp, MagnifyingGlass, Plus, Trash } from '@phosphor-icons/react';
import type { ProjectRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Dialog, TopBar, plural, useToast } from '../app/ui.tsx';
import { navigate, paths } from '../app/router.ts';
import { useFetch } from '../app/useFetch.ts';
import { startUpload } from '../upload/uploads.ts';

const STATUS: Record<ProjectRow['status'], { label: string; cls: string }> = {
  counting: { label: 'Counting', cls: 'tag-accent' },
  in_review: { label: 'In review', cls: 'tag-outline' },
  exported: { label: 'Exported', cls: 'tag-neutral' },
  splitting: { label: 'Splitting sheets', cls: 'tag-neutral' },
};

const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function NewProjectDialog({ file, onClose }: { file: File | null; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(file ? file.name.replace(/\.pdf$/i, '') : '');
  const [location, setLocation] = useState('');
  const [client, setClient] = useState('');
  const [bidDue, setBidDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return setErr('Give the project a name.');
    setBusy(true);
    setErr(null);
    try {
      const { project } = await api<{ project: ProjectRow }>('/projects', {
        body: { name, location: location || null, client: client || null, bid_due: bidDue || null },
      });
      if (file) startUpload(project.id, file, me?.limits.maxFileBytes ?? 200 * 1048576);
      navigate(paths.project(project.id));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not create the project.');
      toast('Could not create the project.');
      setBusy(false);
    }
  }

  return (
    <Dialog title="New project" onClose={onClose}>
      <div className="dialog-title">New project</div>
      {file && <div className="muted" style={{ fontSize: 13 }}>Drawing set: {file.name}</div>}
      <div className="field"><label htmlFor="pn">Project name</label><input id="pn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
      <div className="field"><label htmlFor="pl">Location (optional)</label><input id="pl" className="input" value={location} onChange={(e) => setLocation(e.target.value)} /></div>
      <div className="field"><label htmlFor="pc">GC / client (optional)</label><input id="pc" className="input" value={client} onChange={(e) => setClient(e.target.value)} /></div>
      <div className="field"><label htmlFor="pb">Bid due (optional)</label><input id="pb" className="input" type="date" value={bidDue} onChange={(e) => setBidDue(e.target.value)} /></div>
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : file ? 'Create and upload' : 'Create project'}</button>
      </div>
    </Dialog>
  );
}

function DeleteDialog({ project, onClose, onDone }: { project: ProjectRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Delete project" onClose={onClose}>
      <div className="dialog-title">Delete “{project.name}”?</div>
      <div className="dialog-body">This permanently removes its drawing sets, sheets and counts for everyone. It can't be undone.</div>
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await api(`/projects/${project.id}`, { method: 'DELETE' });
            onDone();
          } catch (e) {
            toast(e instanceof ApiError ? e.message : 'Could not delete the project.');
            setBusy(false);
          }
        }}>{busy ? 'Deleting…' : 'Delete project'}</button>
      </div>
    </Dialog>
  );
}

export default function Projects() {
  const { me } = useAuth();
  const canEdit = me?.role !== 'viewer';
  const isAdmin = me?.role === 'admin';
  const { data, error, loading, reload } = useFetch<{ projects: ProjectRow[] }>('/projects');
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [dialog, setDialog] = useState<{ file: File | null } | null>(null);
  const [toDelete, setToDelete] = useState<ProjectRow | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Refresh progress when returning to this screen / while uploads finish.
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, 20000);
    return () => window.clearInterval(t);
  }, [reload]);

  const projects = data?.projects ?? [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? projects.filter((p) => [p.name, p.location, p.client].some((v) => v?.toLowerCase().includes(s))) : projects;
  }, [projects, q]);

  function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      toast(/\.tiff?$/i.test(f.name) ? 'TIFF drawings are not supported yet. Please upload a PDF.' : "That isn't a PDF.");
      return;
    }
    setDialog({ file: f });
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (canEdit) pick(e.dataTransfer.files); };

  return (
    <>
      <TopBar nav="projects" />
      <main className="page">
        <div className="page-inner">
          <div className="row-between">
            <div>
              <h2 style={{ marginBottom: 2 }}>Projects</h2>
              <div className="muted" style={{ fontSize: 14 }}>{projects.length === 0 ? 'No projects yet' : `${plural(projects.length, 'active bid')}`}</div>
            </div>
            <div className="row">
              {projects.length > 0 && (
                <div className="search">
                  <MagnifyingGlass size={14} />
                  <input className="input" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
                </div>
              )}
              {canEdit && <button className="btn btn-primary" onClick={() => setDialog({ file: null })}><Plus size={14} /> New project</button>}
            </div>
          </div>

          {canEdit && (
            <div className={`dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
              <div className="icon-tile"><FileArrowUp size={22} /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>Drop a drawing set to start a takeoff</div>
                <div className="muted" style={{ fontSize: 13 }}>PDF. Sheets are split and named from the title block. Counting is manual for now.</div>
              </div>
              <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>Browse files</button>
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
            </div>
          )}

          {error && <div className="err-text" role="alert">{error} <button className="btn btn-ghost" onClick={() => void reload()}>Retry</button></div>}
          {loading && !data && <div className="muted"><span className="spinner" /> Loading projects…</div>}
          {!loading && !error && projects.length === 0 && !canEdit && (
            <div className="muted">Nothing here yet. An estimator or admin will add the first project.</div>
          )}

          {projects.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th><th>GC / client</th><th className="right">Sheets</th><th className="right">Items counted</th>
                  <th>Progress</th><th>Status</th><th>Bid due</th>{isAdmin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="tr-click" onClick={() => navigate(paths.project(p.id))}>
                    <td><div style={{ fontWeight: 500 }}>{p.name}</div>{p.location && <div className="dim" style={{ fontSize: 12 }}>{p.location}</div>}</td>
                    <td>{p.client ?? '—'}</td>
                    <td className="right num">{p.sheet_count}</td>
                    <td className="right num">{p.items_counted}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="progress" aria-hidden="true"><i style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>
                        <span className="dim num" style={{ fontSize: 12 }}>{Math.round(p.progress * 100)}%</span>
                      </div>
                    </td>
                    <td><span className={`tag ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span></td>
                    <td>{fmtDate(p.bid_due)}</td>
                    {isAdmin && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-icon" aria-label={`Delete ${p.name}`} onClick={() => setToDelete(p)}><Trash size={16} /></button>
                      </td>
                    )}
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={8} className="muted">No projects match “{q}”.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </main>
      {dialog && <NewProjectDialog file={dialog.file} onClose={() => setDialog(null)} />}
      {toDelete && <DeleteDialog project={toDelete} onClose={() => setToDelete(null)} onDone={() => { setToDelete(null); void reload(); }} />}
    </>
  );
}
