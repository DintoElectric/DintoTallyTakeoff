import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingFileRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { extractRuns } from '../detect/pageRuns.ts';
import { alignByGrids, candidates, gridLabels, isArchPlan, isTradePlan, levelOf, sameLevel, type Alignment, type GridLabels } from '../detect/sheetAlign.ts';
import { loadFilePdf } from '../viewer/pdf.ts';

type Status = 'ok' | 'check' | 'hand' | 'none' | 'manual';
interface Row { sheet: SheetRow; refId: string | null; align: Alignment | null; status: Status; busy?: boolean }

const STATUS: Record<Status, (r: Row) => string> = {
  ok: (r) => `Lined up: ${r.align!.across} + ${r.align!.down} grid lines agree`,
  check: (r) => `Only ${r.align!.across} + ${r.align!.down} grid lines agree: check it on the sheet`,
  hand: () => 'The grid lines do not agree: line it up by hand on the sheet',
  none: () => 'No architectural plan of this level',
  manual: () => 'Lined up by hand',
};
const statusOf = (a: Alignment | null): Status => (!a ? 'hand' : a.how === 'hand' ? 'manual' : a.across >= 8 && a.down >= 5 ? 'ok' : 'check');
const label = (s: SheetRow) => s.number ?? `Page ${s.page}`;

/**
 * Pairing each electrical plan with the architectural floor plan of the same level and area, and lining them up by the
 * column grid they share. Saved on each sheet; the line-up can be checked (and corrected by hand) on the sheet itself.
 */
export default function ArchAlignDialog({ sheets, files, onClose, onSaved }: {
  sheets: SheetRow[]; files: DrawingFileRow[]; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const arch = useMemo(() => sheets.filter(isArchPlan), [sheets]);
  const trade = useMemo(() => sheets.filter((s) => isTradePlan(s) && !isArchPlan(s)), [sheets]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [progress, setProgress] = useState('');
  const [rerun, setRerun] = useState(0);
  const [noCount, setNoCount] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cache = useRef(new Map<string, GridLabels>());

  const labelsOf = async (s: SheetRow): Promise<GridLabels | null> => {
    const hit = cache.current.get(s.id);
    if (hit) return hit;
    const f = fileById.get(s.file_id);
    if (!f) return null;
    const doc = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
    const page = await doc.getPage(s.page);
    const vp = page.getViewport({ scale: 1 });
    const g = gridLabels(await extractRuns(page), vp.width, vp.height);
    page.cleanup();
    cache.current.set(s.id, g);
    return g;
  };
  const lineUp = async (s: SheetRow, a: SheetRow): Promise<Alignment | null> => {
    const [e, r] = await Promise.all([labelsOf(s), labelsOf(a)]);
    return e && r ? alignByGrids(e, r) : null;
  };

  useEffect(() => {
    let off = false;
    (async () => {
      const out: Row[] = [];
      try {
        for (const [i, s] of trade.entries()) {
          if (off) return;
          setProgress(`Reading ${label(s)} (${i + 1} of ${trade.length})…`);
          // a pairing saved before is kept (unless lining everything up again)
          if (rerun === 0 && s.ref_sheet_id && arch.some((a) => a.id === s.ref_sheet_id)) {
            out.push({ sheet: s, refId: s.ref_sheet_id, align: s.ref_align ?? null, status: statusOf(s.ref_align ?? null) });
            continue;
          }
          const same = candidates(s, arch).filter((a) => sameLevel(a, s));
          if (!same.length) { out.push({ sheet: s, refId: null, align: null, status: 'none' }); continue; }
          let best: { a: SheetRow; al: Alignment } | null = null;
          for (const a of same) {
            const al = await lineUp(s, a);
            if (al && (!best || al.across + al.down > best.al.across + best.al.down)) best = { a, al };
          }
          out.push(best ? { sheet: s, refId: best.a.id, align: best.al, status: statusOf(best.al) } : { sheet: s, refId: same[0].id, align: null, status: 'hand' });
          setRows([...out]);
        }
        if (!off) { setRows(out); setProgress(''); }
      } catch (e) {
        if (!off) { setErr(e instanceof Error ? e.message : 'Reading the drawings failed.'); setRows(out); setProgress(''); }
      }
    })();
    return () => { off = true; };
  }, [rerun]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (s: SheetRow, refId: string) => {
    const a = arch.find((x) => x.id === refId) ?? null;
    setRows((rs) => rs!.map((r) => (r.sheet.id === s.id ? { ...r, refId: a?.id ?? null, align: null, status: a ? 'hand' : 'none', busy: !!a } : r)));
    if (!a) return;
    const al = await lineUp(s, a);
    setRows((rs) => rs!.map((r) => (r.sheet.id === s.id ? { ...r, align: al, status: statusOf(al), busy: false } : r)));
  };

  const archCounted = arch.filter((a) => a.count_enabled);
  const save = async () => {
    if (!rows) return;
    setSaving(true); setErr(null);
    let n = 0;
    try {
      for (const r of rows) {
        const same = r.refId === (r.sheet.ref_sheet_id ?? null) && JSON.stringify(r.align) === JSON.stringify(r.sheet.ref_align ?? null);
        if (same) continue;
        await api(`/sheets/${r.sheet.id}`, { method: 'PATCH', body: { ref_sheet_id: r.refId, ref_align: r.refId ? r.align : null } });
        n++;
      }
      if (noCount) for (const a of archCounted) await api(`/sheets/${a.id}`, { method: 'PATCH', body: { count_enabled: false } });
      const lined = rows.filter((r) => r.refId && r.align).length;
      onSaved(`Saved: ${plural(lined, 'plan')} lined up with the architectural drawings${n ? '' : ' (no changes)'}.${rows.some((r) => r.status === 'hand' || r.status === 'check') ? ' Open the ones marked to check or line up by hand.' : ''}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Saving stopped.');
      setSaving(false);
    }
  };

  return (
    <Dialog title="Architectural plans" onClose={saving ? () => undefined : onClose} wide>
      <div className="dialog-title">Line up with the architectural plans</div>
      <div className="dialog-body stack" style={{ gap: 12 }}>
        {arch.length === 0 ? (
          <div>Upload the architectural drawings to this project first (the floor plans, such as A1.02B), then line them up here. They are used to read the wall types; they are not counted.</div>
        ) : (
          <>
            <div className="dim" style={{ fontSize: 13 }}>
              Each plan is paired with the architectural floor plan of the same level and area ({arch.map(label).join(', ')}) and lined up by the column grid they share. Open a sheet and turn on <b>Architectural plan</b> to see the walls over it, and line it up by hand there if needed.
            </div>
            {progress && <div className="dim" style={{ fontSize: 12 }}><span className="spinner" /> {progress}</div>}
            {rows && rows.length > 0 && (
              <div className="read-rows" style={{ maxHeight: '50vh' }}>
                <table className="table compact">
                  <thead><tr><th>Sheet</th><th>Architectural plan</th><th>Lined up</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.sheet.id}>
                        <td><b>{label(r.sheet)}</b><div className="dim" style={{ fontSize: 12 }}>{r.sheet.title}</div></td>
                        <td style={{ width: 230 }}>
                          <select className="input" value={r.refId ?? ''} disabled={saving} onChange={(e) => void pick(r.sheet, e.target.value)}>
                            <option value="">None</option>
                            {candidates(r.sheet, arch).map((a) => <option key={a.id} value={a.id}>{label(a)} · {a.title}{levelOf(a.title).level !== levelOf(r.sheet.title).level ? ' (another level)' : ''}</option>)}
                          </select>
                        </td>
                        <td>
                          {r.busy ? <span className="dim"><span className="spinner" /> Lining up…</span> : (
                            <span className={r.status === 'ok' || r.status === 'manual' ? '' : 'dim'}>
                              {r.status === 'ok' || r.status === 'manual' ? '✓ ' : r.status === 'check' || r.status === 'hand' ? '! ' : ''}{STATUS[r.status](r)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows && rows.length === 0 && !progress && !err && <div>No plans to line up: the project's plans need a level in their title (such as "MAIN LEVEL").</div>}
            {archCounted.length > 0 && <Check checked={noCount} onChange={setNoCount}>Don't count the architectural sheets ({plural(archCounted.length, 'sheet')} are set to be counted)</Check>}
          </>
        )}
        {err && <div className="err-text" role="alert">{err}</div>}
      </div>
      <div className="dialog-actions">
        {arch.length > 0 && <button className="btn btn-ghost" disabled={saving || !!progress} onClick={() => { cache.current.clear(); setRows(null); setRerun((n) => n + 1); }}>Line up again</button>}
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        {arch.length > 0 && <button className="btn btn-primary" disabled={saving || !!progress || !rows} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>}
      </div>
    </Dialog>
  );
}
