import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash, Warning } from '@phosphor-icons/react';
import type { ProjectRow, SheetRow } from '../../shared/types.ts';
import { breakerCounts, breakerLabel, circuitProblems, circuitStats, mainLabel, nextFree, sumBreakers, takes, type Circuit, type CircuitKind, type Panel } from '../../shared/panels.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useFetch } from '../app/useFetch.ts';
import { navigate, paths } from '../app/router.ts';
import { TopBar, plural, useToast } from '../app/ui.tsx';

type Draft = Omit<Panel, 'id' | 'project_id' | 'source' | 'created_by_name' | 'updated_at'> & { id: string | null };
const blank = (sheetId: string | null): Draft => ({
  id: null, sheet_id: sheetId, name: '', alt_name: null, voltage: null, phases: null, wires: null, main_type: null, main_amps: null,
  bus_amps: null, kaic: null, iso_ground: null, surge: null, fed_from: null, location: null, manufacturer: null, mounting: null,
  positions: null, notes: null, circuits: [],
});
const toDraft = (p: Panel): Draft => { const { project_id: _p, source: _s, created_by_name: _c, updated_at: _u, ...rest } = p; return { ...rest, circuits: [...p.circuits].sort((a, b) => a.circuit - b.circuit) }; };
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
const KIND_LABEL: Record<CircuitKind, string> = { load: 'Load', spare: 'Spare', space: 'Space' };

export default function Panels({ projectId, panelId }: { projectId: string; panelId: string | null }) {
  const { me } = useAuth();
  const toast = useToast();
  const project = useFetch<{ project: ProjectRow }>(`/projects/${projectId}`);
  const sheets = useFetch<{ sheets: SheetRow[] }>(`/sheets?project=${projectId}`);
  const panelsQ = useFetch<{ panels: Panel[] }>(`/panels?project=${projectId}`);
  const canEdit = me?.role !== 'viewer';
  const panels = panelsQ.data?.panels ?? [];
  const startSheet = new URLSearchParams(location.search).get('sheet');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // open the panel in the address (or a new one when ?new=1)
  useEffect(() => {
    if (!panelsQ.data) return;
    if (new URLSearchParams(location.search).get('new') === '1') { setDraft(blank(startSheet)); setDirty(false); return; }
    const p = panelId ? panels.find((x) => x.id === panelId) : null;
    setDraft(p ? toDraft(p) : null); setDirty(false);
  }, [panelId, panelsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveOk = () => !dirty || confirm('Discard the changes to this panel?');
  const open = (id: string | null) => { if (leaveOk()) navigate(paths.panels(projectId, id)); };
  const update = (patch: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setDirty(true); };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { id, ...body } = draft;
      const { panel } = id
        ? await api<{ panel: Panel }>(`/panels/${id}`, { method: 'PATCH', body })
        : await api<{ panel: Panel }>('/panels', { body: { ...body, project_id: projectId } });
      setDirty(false);
      await panelsQ.reload();
      toast(`Saved ${panel.name}.`);
      if (!id) navigate(paths.panels(projectId, panel.id), true);
      else setDraft(toDraft(panel));
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The panel was not saved. Try again.'); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft?.id || !confirm(`Delete panel ${draft.name}? Its circuits are deleted with it.`)) return;
    try { await api(`/panels/${draft.id}`, { method: 'DELETE' }); setDirty(false); await panelsQ.reload(); toast(`Deleted ${draft.name}.`); navigate(paths.panels(projectId), true); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Delete failed. Try again.'); }
  };

  const totals = useMemo(() => sumBreakers(panels.map((p) => breakerCounts(p.circuits))), [panels]);
  const sheetName = (id: string | null) => { const s = sheets.data?.sheets.find((x) => x.id === id); return s ? s.number ?? `Page ${s.page}` : null; };

  return (
    <>
      <TopBar crumbs={[{ label: 'Projects', to: paths.projects() }, { label: project.data?.project.name ?? '…', to: paths.project(projectId) }, { label: 'Panels' }]} />
      <div className="two-col">
        <aside className="panels-side">
          <div className="row-between">
            <b>Panels <span className="dim num">· {panels.length}</span></b>
            {canEdit && <button className="btn btn-secondary" style={{ minHeight: 30 }} onClick={() => { if (leaveOk()) navigate(`${paths.panels(projectId)}?new=1`); }}><Plus size={14} /> Add panel</button>}
          </div>
          {panelsQ.error && <p className="err-text">{panelsQ.error}</p>}
          {panelsQ.data && panels.length === 0 && <p className="dim" style={{ fontSize: 13 }}>No panels yet. Add one and type in its schedule; reading panel schedules from the drawings comes next.</p>}
          <div className="panels-list">
            {panels.map((p) => {
              const st = circuitStats(p, p.circuits);
              return (
                <button key={p.id} className={`panel-row${draft?.id === p.id ? ' on' : ''}`} onClick={() => open(p.id)}>
                  <span className="panel-name">{p.name}</span>
                  <span className="dim">{[mainLabel(p), p.voltage].filter(Boolean).join(' · ') || 'No details yet'}</span>
                  <span className="dim num">{st.positions ? `${st.used + st.spare} of ${st.positions} circuits used` : plural(st.breakers, 'breaker')}{sheetName(p.sheet_id) ? ` · ${sheetName(p.sheet_id)}` : ''}</span>
                </button>
              );
            })}
          </div>
          {totals.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <b style={{ fontSize: 13 }}>Breakers, all panels</b>
              <table className="table compact">
                <tbody>{totals.map((b) => <tr key={`${b.amps}/${b.poles}`}><td>{breakerLabel(b.amps, b.poles)}</td><td className="right num">{b.qty}</td><td className="dim num">{b.spares ? `${b.spares} spare` : ''}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </aside>
        <main className="sheet-main">
          {!draft && <div className="empty"><p>Pick a panel on the left{canEdit ? ', or add one' : ''}.</p></div>}
          {draft && <PanelEditor draft={draft} update={update} canEdit={canEdit} sheets={sheets.data?.sheets ?? []} dirty={dirty} saving={saving} onSave={save} onDiscard={() => { setDirty(false); open(draft.id); }} onDelete={remove} />}
        </main>
      </div>
    </>
  );
}

function PanelEditor({ draft, update, canEdit, sheets, dirty, saving, onSave, onDiscard, onDelete }: {
  draft: Draft; update: (p: Partial<Draft>) => void; canEdit: boolean; sheets: SheetRow[]; dirty: boolean; saving: boolean;
  onSave: () => void; onDiscard: () => void; onDelete: () => void;
}) {
  const stats = circuitStats(draft, draft.circuits);
  const breakers = breakerCounts(draft.circuits);
  const problems = circuitProblems(draft, draft.circuits);
  const blocking = problems.some((p) => p.includes('used twice'));
  const setCircuits = (circuits: Circuit[]) => update({ circuits: [...circuits].sort((a, b) => a.circuit - b.circuit) });
  const setCkt = (i: number, patch: Partial<Circuit>) => setCircuits(draft.circuits.map((c, j) => (j === i ? { ...c, ...patch, ...(patch.kind === 'space' ? { breaker_amps: null, poles: 1 } : {}) } : c)));
  const [bulk, setBulk] = useState({ qty: '1', amps: '20', poles: '1', kind: 'load' as CircuitKind });

  const addBreakers = () => {
    let list = draft.circuits;
    const n = Math.max(1, Math.min(84, Number(bulk.qty) || 1)), poles = Number(bulk.poles) || 1;
    for (let i = 0; i < n; i++) {
      const at = nextFree(list, poles, draft.positions);
      if (at === null) { alert(`There's no room for ${n - i === 1 ? 'that breaker' : `${n - i} more breakers`} in ${draft.positions} positions.`); break; }
      list = [...list, { circuit: at, description: null, kind: bulk.kind, breaker_amps: bulk.kind === 'space' ? null : Number(bulk.amps) || null, poles: bulk.kind === 'space' ? 1 : poles, load_kva: null }];
    }
    setCircuits(list);
  };
  const field = (label: string, el: React.ReactNode, wide = false) => <label className={`field${wide ? ' wide' : ''}`}><span>{label}</span>{el}</label>;
  const text = (k: keyof Draft, placeholder = '') => <input className="input" disabled={!canEdit} value={(draft[k] as string | null) ?? ''} placeholder={placeholder} onChange={(e) => update({ [k]: e.target.value || null } as Partial<Draft>)} />;
  const numIn = (k: keyof Draft, placeholder = '') => <input className="input num" inputMode="numeric" disabled={!canEdit} value={(draft[k] as number | null) ?? ''} placeholder={placeholder} onChange={(e) => update({ [k]: numOrNull(e.target.value) } as Partial<Draft>)} />;
  const yesNo = (k: 'iso_ground' | 'surge') => (
    <select className="input" disabled={!canEdit} value={draft[k] === null ? '' : draft[k] ? 'yes' : 'no'} onChange={(e) => update({ [k]: e.target.value === '' ? null : e.target.value === 'yes' } as Partial<Draft>)}>
      <option value="">Not shown</option><option value="yes">Yes</option><option value="no">No</option>
    </select>
  );

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 980 }}>
      <div className="row-between">
        <h1 style={{ margin: 0, fontSize: 20 }}>{draft.name || 'New panel'}</h1>
        {canEdit && (
          <div className="row" style={{ gap: 8 }}>
            {draft.id && <button className="btn btn-ghost" onClick={onDelete}><Trash size={16} /> Delete</button>}
            {dirty && draft.id && <button className="btn btn-secondary" onClick={onDiscard}>Discard changes</button>}
            <button className="btn btn-primary" disabled={!dirty || saving || !draft.name.trim() || blocking} onClick={onSave}>{saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add panel'}</button>
          </div>
        )}
      </div>

      <section className="form-grid">
        {field('Panel ID', text('name', 'LSDH1201'))}
        {field('Also called', text('alt_name', 'B818-LS-SDH-1201'))}
        {field('Voltage', text('voltage', '480/277V Wye'))}
        {field('Phase', <select className="input" disabled={!canEdit} value={draft.phases ?? ''} onChange={(e) => update({ phases: numOrNull(e.target.value) })}><option value="">Not shown</option><option value="1">1</option><option value="3">3</option></select>)}
        {field('Wires', numIn('wires', '4'))}
        {field('Main (MCB or MLO)', <select className="input" disabled={!canEdit} value={draft.main_type ?? ''} onChange={(e) => update({ main_type: (e.target.value || null) as Draft['main_type'] })}><option value="">Not shown</option><option value="MCB" title="Main circuit breaker">MCB</option><option value="MLO" title="Main lugs only">MLO</option></select>)}
        {field('Main rating (A)', numIn('main_amps', '225'))}
        {field('Bus rating (A)', numIn('bus_amps'))}
        {field('KAIC', numIn('kaic', '22'))}
        {field('Circuits (positions)', numIn('positions', '42'))}
        {field('Iso ground', yesNo('iso_ground'))}
        {field('Surge protection', yesNo('surge'))}
        {field('Fed from', text('fed_from', 'LV-1'))}
        {field('Location', text('location'))}
        {field('Manufacturer', text('manufacturer', 'Eaton'))}
        {field('Mounting', text('mounting', 'Surface'))}
        {field('Schedule is on sheet', <select className="input" disabled={!canEdit} value={draft.sheet_id ?? ''} onChange={(e) => update({ sheet_id: e.target.value || null })}><option value="">Not set</option>{sheets.map((s) => <option key={s.id} value={s.id}>{s.number ?? `Page ${s.page}`}{s.title ? ` · ${s.title}` : ''}</option>)}</select>, true)}
      </section>

      <section className="stack" style={{ gap: 10 }}>
        <div className="row-between">
          <b>Circuits</b>
          <span className="dim num" style={{ fontSize: 13 }}>{stats.positions ? `${stats.positions} positions · ${stats.used} used · ${stats.spare} spare · ${stats.space} space` : 'Set the number of circuits to see spaces'} · {plural(stats.breakers, 'breaker')}</span>
        </div>
        {breakers.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{breakers.map((b) => <span key={`${b.amps}/${b.poles}`} className="tag tag-neutral num">{breakerLabel(b.amps, b.poles)} × {b.qty}{b.spares ? ` (${b.spares} spare)` : ''}</span>)}</div>}
        {problems.length > 0 && <div className="hint warn"><Warning size={16} /><div>{problems.map((p) => <div key={p}>{p}</div>)}{blocking && <div>Fix this to save.</div>}</div></div>}
        <table className="table ckt-table">
          <thead><tr><th style={{ width: 120 }}>Circuit</th><th>Description</th><th style={{ width: 110 }}>Kind</th><th style={{ width: 100 }}>Breaker (A)</th><th style={{ width: 80 }}>Poles</th><th style={{ width: 44 }} /></tr></thead>
          <tbody>
            {draft.circuits.map((c, i) => (
              <tr key={`${c.circuit}-${i}`}>
                <td className="num"><span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input className="input num" style={{ width: 56 }} disabled={!canEdit} value={c.circuit} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 200) setCkt(i, { circuit: n }); }} aria-label="Circuit number" />{c.poles > 1 && <span className="dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }} title="A multi-pole breaker takes these circuits">{takes(c).slice(1).map((n) => `, ${n}`).join('')}</span>}</span></td>
                <td><input className="input" disabled={!canEdit} value={c.description ?? ''} placeholder={c.kind === 'space' ? 'SPACE' : c.kind === 'spare' ? 'SPARE' : ''} onChange={(e) => setCkt(i, { description: e.target.value || null })} aria-label="Description" /></td>
                <td><select className="input" disabled={!canEdit} value={c.kind} onChange={(e) => setCkt(i, { kind: e.target.value as CircuitKind })} aria-label="Kind">{(['load', 'spare', 'space'] as CircuitKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></td>
                <td><input className="input num" inputMode="numeric" disabled={!canEdit || c.kind === 'space'} value={c.breaker_amps ?? ''} onChange={(e) => setCkt(i, { breaker_amps: numOrNull(e.target.value) })} aria-label="Breaker size" /></td>
                <td><select className="input" disabled={!canEdit || c.kind === 'space'} value={c.poles} onChange={(e) => setCkt(i, { poles: Number(e.target.value) })} aria-label="Poles"><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></td>
                <td>{canEdit && <button className="btn btn-ghost icon-btn" onClick={() => setCircuits(draft.circuits.filter((_, j) => j !== i))} aria-label={`Remove circuit ${c.circuit}`} title="Remove"><Trash size={15} /></button>}</td>
              </tr>
            ))}
            {draft.circuits.length === 0 && <tr><td colSpan={6} className="dim" style={{ fontSize: 13 }}>No circuits yet. Spaces don't need entering: set the number of circuits and every position without a breaker counts as a space.</td></tr>}
          </tbody>
        </table>
        {canEdit && (
          <div className="row add-breakers">
            <span className="dim" style={{ fontSize: 13 }}>Add</span>
            <input className="input num" style={{ width: 56 }} value={bulk.qty} onChange={(e) => setBulk({ ...bulk, qty: e.target.value })} aria-label="How many" />
            <select className="input" style={{ width: 96 }} value={bulk.kind} onChange={(e) => setBulk({ ...bulk, kind: e.target.value as CircuitKind })} aria-label="Kind"><option value="load">Load</option><option value="spare">Spare</option><option value="space">Space</option></select>
            {bulk.kind !== 'space' && <><input className="input num" style={{ width: 70 }} value={bulk.amps} onChange={(e) => setBulk({ ...bulk, amps: e.target.value })} aria-label="Breaker amps" /><span className="dim" style={{ fontSize: 13 }}>A</span>
              <select className="input" style={{ width: 90 }} value={bulk.poles} onChange={(e) => setBulk({ ...bulk, poles: e.target.value })} aria-label="Poles"><option value="1">1-pole</option><option value="2">2-pole</option><option value="3">3-pole</option></select></>}
            <button className="btn btn-secondary" onClick={addBreakers}>Add at the next free circuits</button>
          </div>
        )}
      </section>
      {field('Notes', <textarea className="input" rows={2} disabled={!canEdit} value={draft.notes ?? ''} onChange={(e) => update({ notes: e.target.value || null })} />, true)}
    </div>
  );
}
