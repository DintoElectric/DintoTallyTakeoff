import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CaretDown, CaretRight, FileArrowUp, Folder, FolderOpen, FolderSimplePlus, MagnifyingGlass, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import type { JobRow, ProjectRow } from '../../shared/types.ts';
import { SYSTEMS, SYSTEM_LABEL, type SystemKey } from '../../shared/systems.ts';
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

function NewProjectDialog({ file, jobs, jobId: presetJob, onClose }: { file: File | null; jobs: JobRow[]; jobId?: string | null; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(file ? file.name.replace(/\.pdf$/i, '') : '');
  const [location, setLocation] = useState('');
  const [client, setClient] = useState('');
  const [bidDue, setBidDue] = useState('');
  const [job, setJob] = useState<string>(presetJob ?? '');          // '' none, '__new' a new job, else a job's id
  const [newJob, setNewJob] = useState('');
  const [system, setSystem] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return setErr('Give the project a name.');
    if (job === '__new' && !newJob.trim()) return setErr('Give the new job a name.');
    setBusy(true);
    setErr(null);
    try {
      const jobId = job === '__new' ? (await api<{ job: JobRow }>('/jobs', { body: { name: newJob.trim() } })).job.id : job || null;
      const { project } = await api<{ project: ProjectRow }>('/projects', {
        body: { name, location: location || null, client: client || null, bid_due: bidDue || null, job_id: jobId, system: system || null },
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
      <div className="field">
        <label htmlFor="pj">Job (optional)</label>
        <select id="pj" className="input" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="">Not in a job</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          <option value="__new">New job…</option>
        </select>
        {job === '__new' && <input className="input" style={{ marginTop: 6 }} placeholder="Job name, for example Hillcrest Middle School" value={newJob} onChange={(e) => setNewJob(e.target.value)} aria-label="New job name" />}
      </div>
      <div className="field">
        <label htmlFor="ps">System it counts (optional)</label>
        <select id="ps" className="input" value={system} onChange={(e) => setSystem(e.target.value)}>
          <option value="">All systems</option>
          {SYSTEMS.map((k) => <option key={k} value={k}>{SYSTEM_LABEL[k]}{k === 'lighting' ? ' (fixtures and controls)' : ''}</option>)}
        </select>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Upload only that system’s drawings here; Auto-count and the counts panel start on it.</div>
      </div>
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : file ? 'Create and upload' : 'Create project'}</button>
      </div>
    </Dialog>
  );
}

/** A new job (a folder for a job's projects), or renaming one. */
function JobDialog({ job, onClose, onDone }: { job: JobRow | null; onClose: () => void; onDone: (j: JobRow) => void }) {
  const [name, setName] = useState(job?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) return setErr('Give the job a name.');
    setBusy(true); setErr(null);
    try { const r = job ? await api<{ job: JobRow }>(`/jobs/${job.id}`, { method: 'PATCH', body: { name: name.trim() } }) : await api<{ job: JobRow }>('/jobs', { body: { name: name.trim() } }); onDone(r.job); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save the job.'); setBusy(false); }
  };
  return (
    <Dialog title={job ? 'Rename job' : 'New job'} onClose={onClose}>
      <div className="dialog-title">{job ? 'Rename job' : 'New job'}</div>
      <div className="dialog-body">A job is a folder for its projects: for example one per system, each with its own drawings and counts.</div>
      <div className="field"><label htmlFor="jn">Job name</label><input id="jn" className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} autoFocus placeholder="Hillcrest Middle School" /></div>
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : job ? 'Rename' : 'Create job'}</button>
      </div>
    </Dialog>
  );
}

/** Deleting a job removes the folder only: its projects stay, out of any folder. */
function JobDeleteDialog({ job, onClose, onDone }: { job: JobRow; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Dialog title="Delete job" onClose={onClose}>
      <div className="dialog-title">Delete the job “{job.name}”?</div>
      <div className="dialog-body">{job.project_count ? `Its ${plural(job.project_count, 'project')} stay, with their drawings and counts, out of any folder.` : 'It has no projects.'} Only the folder goes.</div>
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/jobs/${job.id}`, { method: 'DELETE' }); onDone(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the job.'); setBusy(false); } }}>Delete job</button>
      </div>
    </Dialog>
  );
}

/** A project's job (the folder it is in) and the system it counts. */
function ProjectJobDialog({ project, jobs, onClose, onDone }: { project: ProjectRow; jobs: JobRow[]; onClose: () => void; onDone: () => void }) {
  const [job, setJob] = useState(project.job_id ?? '');
  const [system, setSystem] = useState<string>(project.system ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api(`/projects/${project.id}`, { method: 'PATCH', body: { job_id: job || null, system: system || null } }); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save.'); setBusy(false); }
  };
  return (
    <Dialog title="Job and system" onClose={onClose}>
      <div className="dialog-title">{project.name}</div>
      <div className="field">
        <label htmlFor="mj">Job</label>
        <select id="mj" className="input" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="">Not in a job</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ms">System it counts</label>
        <select id="ms" className="input" value={system} onChange={(e) => setSystem(e.target.value)}>
          <option value="">All systems</option>
          {SYSTEMS.map((k) => <option key={k} value={k}>{SYSTEM_LABEL[k]}</option>)}
        </select>
      </div>
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Dialog>
  );
}

/** Deleting a project takes two confirmations: the warning, then typing the project's name. */
function DeleteDialog({ project, onClose, onDone }: { project: ProjectRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === project.name.trim().toLowerCase();
  const del = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await api(`/projects/${project.id}?confirm=${encodeURIComponent(typed.trim())}`, { method: 'DELETE' });
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not delete the project.');
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete project" onClose={onClose}>
      <div className="dialog-title">Delete “{project.name}”?</div>
      {step === 1 ? (
        <>
          <div className="dialog-body">This permanently removes its drawing sets, sheets, counts and panels for everyone. It can't be undone.</div>
          <div className="dialog-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={() => setStep(2)}>Continue</button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void del(); }}>
          <div className="dialog-body">
            <p style={{ marginTop: 0 }}>To confirm, type the project's name: <b>{project.name}</b></p>
            <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the project name to confirm" autoComplete="off" spellCheck={false} />
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!matches || busy}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export default function Projects() {
  const { me } = useAuth();
  const canEdit = me?.role !== 'viewer';
  const { data, error, loading, reload } = useFetch<{ projects: ProjectRow[] }>('/projects');
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [dialog, setDialog] = useState<{ file: File | null } | null>(null);
  const [toDelete, setToDelete] = useState<ProjectRow | null>(null);
  const jobsQ = useFetch<{ jobs: JobRow[] }>('/jobs');
  const jobs = jobsQ.data?.jobs ?? [];
  const [jobDialog, setJobDialog] = useState<{ job: JobRow | null } | null>(null);
  const [jobToDelete, setJobToDelete] = useState<JobRow | null>(null);
  const [moving, setMoving] = useState<ProjectRow | null>(null);
  const [newIn, setNewIn] = useState<string | null>(null);      // New project inside this job
  // folders closed by the estimator (remembered)
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('tally.closedJobs') ?? '[]')); } catch { return new Set(); } });
  const toggle = (id: string) => setClosed((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); try { localStorage.setItem('tally.closedJobs', JSON.stringify([...n])); } catch { /* not remembered */ } return n; });
  const reloadAll = () => { void reload(); void jobsQ.reload(); };
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
    const jobName = new Map(jobs.map((j) => [j.id, j.name.toLowerCase()]));
    return s ? projects.filter((p) => [p.name, p.location, p.client, p.job_id ? jobName.get(p.job_id) : null].some((v) => v?.toLowerCase().includes(s))) : projects;
  }, [projects, jobs, q]);
  // the folders: each job with its projects (jobs with no match hidden while searching), then the projects in no job
  const groups = useMemo(() => {
    const known = new Set(jobs.map((j) => j.id));
    const out: { job: JobRow | null; rows: ProjectRow[] }[] = jobs.map((j) => ({ job: j, rows: shown.filter((p) => p.job_id === j.id) }))
      .filter((g) => g.rows.length > 0 || !q.trim());
    out.push({ job: null, rows: shown.filter((p) => !p.job_id || !known.has(p.job_id)) });
    return out;
  }, [jobs, shown, q]);

  function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      toast(/\.tiff?$/i.test(f.name) ? 'TIFF drawings are not supported yet. Please upload a PDF.' : "That isn't a PDF.");
      return;
    }
    setNewIn(null);
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
              {canEdit && <button className="btn btn-secondary" onClick={() => setJobDialog({ job: null })} title="A folder for a job's projects (one per system)"><FolderSimplePlus size={14} /> New job</button>}
              {canEdit && <button className="btn btn-primary" onClick={() => { setNewIn(null); setDialog({ file: null }); }}><Plus size={14} /> New project</button>}
            </div>
          </div>

          {canEdit && (
            <div className={`dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
              <div className="icon-tile"><FileArrowUp size={22} /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>Drop a drawing set to start a takeoff</div>
                <div className="muted" style={{ fontSize: 13 }}>PDF. Sheets are split and named from the title block, ready to count.</div>
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
                  <th>Progress</th><th>Status</th><th>Bid due</th><th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const open = !g.job || !closed.has(g.job.id) || !!q.trim();
                  const rows = open ? g.rows : [];
                  return [
                    g.job ? (
                      <tr key={`job-${g.job.id}`} className="job-row" onClick={() => toggle(g.job!.id)}>
                        <td colSpan={8}>
                          <div className="row" style={{ gap: 8 }}>
                            {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
                            {open ? <FolderOpen size={18} /> : <Folder size={18} />}
                            <span className="job-name">{g.job.name}</span>
                            <span className="dim" style={{ fontSize: 12 }}>{plural(g.rows.length, 'project')}</span>
                            <span style={{ flex: 1 }} />
                            {canEdit && (
                              <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                                <button className="btn btn-ghost" style={{ minHeight: 28, padding: '2px 8px', fontSize: 12 }} onClick={() => { setNewIn(g.job!.id); setDialog({ file: null }); }}><Plus size={12} /> New project in this job</button>
                                <button className="btn btn-ghost btn-icon" aria-label={`Rename ${g.job.name}`} title="Rename job" onClick={() => setJobDialog({ job: g.job })}><PencilSimple size={15} /></button>
                                <button className="btn btn-ghost btn-icon" aria-label={`Delete the job ${g.job.name}`} title="Delete job (its projects stay)" onClick={() => setJobToDelete(g.job)}><Trash size={15} /></button>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : jobs.length > 0 && g.rows.length > 0 ? (
                      <tr key="job-none" className="job-row none"><td colSpan={8}><span className="dim">Not in a job</span></td></tr>
                    ) : null,
                    ...rows.map((p) => (
                  <tr key={p.id} className={`tr-click${g.job ? ' in-job' : ''}`} onClick={() => navigate(paths.project(p.id))}>
                    <td><div style={{ fontWeight: 500 }}>{p.name}{p.system && <span className="tag tag-outline" style={{ marginLeft: 8 }}>{SYSTEM_LABEL[p.system as SystemKey]}</span>}</div>{p.location && <div className="dim" style={{ fontSize: 12 }}>{p.location}</div>}</td>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        {canEdit && <button className="btn btn-ghost btn-icon" aria-label={`Job and system of ${p.name}`} title="Job and system" onClick={() => setMoving(p)}><Folder size={16} /></button>}
                        <button className="btn btn-ghost btn-icon" aria-label={`Delete ${p.name}`} title="Delete project" onClick={() => setToDelete(p)}><Trash size={16} /></button>
                      </div>
                    </td>
                  </tr>
                    )),
                  ];
                })}
                {shown.length === 0 && <tr><td colSpan={8} className="muted">No projects match “{q}”.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </main>
      {dialog && <NewProjectDialog file={dialog.file} jobs={jobs} jobId={newIn} onClose={() => setDialog(null)} />}
      {jobDialog && <JobDialog job={jobDialog.job} onClose={() => setJobDialog(null)} onDone={(j) => { setJobDialog(null); toast(jobDialog.job ? 'Job renamed.' : `Job “${j.name}” created. Add its projects with New project in this job.`); reloadAll(); }} />}
      {jobToDelete && <JobDeleteDialog job={jobToDelete} onClose={() => setJobToDelete(null)} onDone={() => { setJobToDelete(null); toast('Job deleted. Its projects are kept.'); reloadAll(); }} />}
      {moving && <ProjectJobDialog project={moving} jobs={jobs} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reloadAll(); }} />}
      {toDelete && <DeleteDialog project={toDelete} onClose={() => setToDelete(null)} onDone={() => { setToDelete(null); reloadAll(); }} />}
    </>
  );
}
