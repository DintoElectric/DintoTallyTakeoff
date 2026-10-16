import { useEffect, useMemo, useState } from 'react';
import type { DrawingFileRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { extractRuns } from '../detect/pageRuns.ts';
import { readSchedulePage } from '../detect/readSchedulePage.ts';
import { classifySheet, scheduleHeadings, titleSaysSchedule, type ScheduleFinding } from '../detect/scheduleSheets.ts';
import { loadFilePdf, pdfjs } from '../viewer/pdf.ts';

const label = (s: SheetRow) => `${s.number ?? `page ${s.page}`}${s.title ? ` · ${s.title}` : ''}`;
const WHY: Record<ScheduleFinding['why'], string> = { title: 'Titled as a schedule', table: 'Has a readable schedule table', heading: 'Has a schedule heading on it' };

/**
 * Finds the sheets that are, or contain, schedules and turns their Count off, so Auto-count only covers the rest.
 * Sheets titled as schedules need no reading; counting sheets are checked for a schedule table or heading.
 */
export default function ScheduleSheetsDialog({ sheets, files, onClose, onDone }: {
  sheets: SheetRow[]; files: DrawingFileRow[]; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'apply'>('scan');
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [findings, setFindings] = useState<ScheduleFinding[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(sheets.map((s) => [s.id, s])), [sheets]);
  const counting = sheets.filter((s) => s.count_enabled).length;

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const found: ScheduleFinding[] = [];
        // Sheets that say they are schedules need no reading. The others are read only if they are counting.
        const toRead = sheets.filter((s) => s.kind !== 'schedule' && s.kind !== 'legend' && !titleSaysSchedule(s.title) && s.count_enabled);
        for (const s of sheets) { const f = classifySheet(s); if (f) found.push(f); }
        const fileById = new Map(files.map((f) => [f.id, f]));
        for (let i = 0; i < toRead.length; i++) {
          if (off) return;
          const s = toRead[i];
          setProgress({ done: i, total: toRead.length, label: label(s) });
          const f = fileById.get(s.file_id);
          if (!f) continue;
          const pdf = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
          const page = await pdf.getPage(s.page);
          try {
            const runs = await extractRuns(page);
            const tableTypes = (await readSchedulePage(page, pdfjs.OPS, true, runs)).length;
            const fnd = classifySheet(s, { tableTypes, headings: scheduleHeadings(runs.map((r) => r.str)) });
            if (fnd) found.push(fnd);
          } finally { page.cleanup(); }
          await new Promise((r) => setTimeout(r, 0));
        }
        if (off) return;
        setFindings(found);
        setPick(new Set(found.filter((x) => x.preselect).map((x) => x.id)));
        setPhase('review');
      } catch (e) { if (!off) { setError(e instanceof Error ? e.message : 'The sheets could not be checked.'); setPhase('review'); } }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply() {
    setPhase('apply');
    setError(null);
    let done = 0;
    try {
      for (const f of findings.filter((x) => pick.has(x.id))) {
        await api(`/sheets/${f.id}`, { method: 'PATCH', body: { count_enabled: false, ...(f.setKind ? { kind: 'schedule' } : {}) } });
        done++;
      }
      onDone(`${plural(done, 'sheet')} marked as not counting. Auto-count will skip ${done === 1 ? 'it' : 'them'}.`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not save that change.');
      setPhase('review');
    }
  }

  return (
    <Dialog title="Mark schedule sheets as not counting" onClose={phase === 'apply' ? () => undefined : onClose} wide>
      <div className="dialog-title">Mark schedule sheets as not counting</div>
      {phase === 'scan' && (
        <div className="stack">
          <div className="muted" style={{ fontSize: 13 }}>Looking for schedules on the sheets that are set to count…</div>
          <div className="progress" style={{ width: '100%' }}><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="dim" style={{ fontSize: 12 }}>{progress.label ? `Sheet ${progress.done + 1} of ${progress.total}: ${progress.label}` : 'Loading the drawings…'}</div>
        </div>
      )}
      {phase !== 'scan' && (
        <>
          {findings.length === 0 ? (
            <div className="banner">No sheet that is set to count is, or holds, a schedule. Auto-count will cover {plural(counting, 'sheet')}.</div>
          ) : (
            <>
              <div className="muted" style={{ fontSize: 13 }}>
                Tick the sheets to stop counting. A schedule lists tags such as BC-14 that Auto-count would otherwise count as fixtures.
                Counts already placed on these sheets are kept. A plan that only has a schedule on it is left unticked, because you still want its fixtures counted.
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto' }} className="stack">
                {findings.map((f) => {
                  const s = byId.get(f.id)!;
                  return (
                    <Check key={f.id} checked={pick.has(f.id)} disabled={phase === 'apply'}
                      onChange={(v) => setPick((cur) => { const n = new Set(cur); if (v) n.add(f.id); else n.delete(f.id); return n; })}>
                      <b>{s.number ?? `page ${s.page}`}</b> <span className="dim">{s.title ?? ''}</span>
                      <span className="tag tag-neutral" style={{ marginLeft: 6 }}>{WHY[f.why]}</span>
                      {f.why !== 'title' && <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>{f.detail}</span>}
                      {s.count_enabled && s.detection_count > 0 && <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>{plural(s.detection_count, 'count')} kept</span>}
                    </Check>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
      {error && <div className="err-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'apply'}>{findings.length === 0 && phase !== 'scan' ? 'Close' : 'Cancel'}</button>
        {phase !== 'scan' && findings.length > 0 && <button className="btn btn-primary" onClick={() => void apply()} disabled={phase === 'apply' || pick.size === 0}>Stop counting {plural(pick.size, 'sheet')}</button>}
      </div>
    </Dialog>
  );
}
