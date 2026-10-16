import { useEffect, useMemo, useState } from 'react';
import type { DrawingFileRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { extractRuns } from '../detect/pageRuns.ts';
import { pageFingerprint } from '../detect/fingerprint.ts';
import { candidateGroups, defaultRemovals, findDuplicateGroups, type DupGroup } from '../detect/duplicates.ts';
import { loadFilePdf } from '../viewer/pdf.ts';

/**
 * Finds sheets that were uploaded more than once and removes the extra copies (admin). A sheet is only called a copy
 * when its number matches AND what is printed on it is the same; a revised drawing with the same number is shown
 * separately and left alone unless you tick it.
 */
export default function DuplicatesDialog({ sheets, files, onClose, onDone }: {
  sheets: SheetRow[]; files: DrawingFileRow[]; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'remove'>('scan');
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const fileName = useMemo(() => new Map(files.map((f) => [f.id, f.file_name])), [files]);
  const byId = useMemo(() => new Map(sheets.map((s) => [s.id, s])), [sheets]);
  const unnumbered = sheets.filter((s) => !s.number?.trim()).length;

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const cands = candidateGroups(sheets).flat();
        const prints = new Map<string, Set<string>>();
        const fileById = new Map(files.map((f) => [f.id, f]));
        for (let i = 0; i < cands.length; i++) {
          if (off) return;
          const s = cands[i];
          setProgress({ done: i, total: cands.length, label: `${s.number} (${fileName.get(s.file_id) ?? 'file'}, page ${s.page})` });
          const f = fileById.get(s.file_id);
          if (!f) continue;
          const pdf = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
          const page = await pdf.getPage(s.page);
          try { prints.set(s.id, pageFingerprint(await extractRuns(page))); } finally { page.cleanup(); }
          await new Promise((r) => setTimeout(r, 0));
        }
        if (off) return;
        const order = new Map(files.map((f, i) => [f.id, i]));
        const g = findDuplicateGroups(sheets, prints, order);
        setGroups(g);
        setRemove(defaultRemovals(g));
        setPhase('review');
      } catch (e) { if (!off) { setError(e instanceof Error ? e.message : 'The sheets could not be compared.'); setPhase('review'); } }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupIds = (g: DupGroup) => g.clusters.flatMap((c) => c.members.map((m) => m.id));
  const atRisk = [...remove].reduce((n, id) => n + (byId.get(id)?.detection_count ?? 0), 0);
  const nCopies = groups.reduce((n, g) => n + g.clusters.reduce((m, c) => m + Math.max(0, c.members.length - 1), 0), 0);

  async function run() {
    setPhase('remove');
    setError(null);
    let removed = 0, filesGone = 0;
    try {
      for (const id of remove) {
        setProgress({ done: removed, total: remove.size, label: '' });
        const r = await api<{ ok: boolean; file_removed: boolean }>(`/sheets/${id}`, { method: 'DELETE' });
        removed++;
        if (r.file_removed) filesGone++;
      }
      onDone(`Removed ${plural(removed, 'duplicate sheet')}${filesGone ? `, and ${plural(filesGone, 'file')} left with no sheets` : ''}.`);
    } catch (e) {
      setError(`${e instanceof ApiError || e instanceof Error ? e.message : 'Could not remove that sheet.'} ${removed ? `${plural(removed, 'sheet')} had already been removed.` : ''}`);
      setPhase('review');
    }
  }

  return (
    <Dialog title="Remove duplicate sheets" onClose={phase === 'remove' ? () => undefined : onClose} wide>
      <div className="dialog-title">Remove duplicate sheets</div>
      {phase === 'scan' && (
        <div className="stack">
          <div className="muted" style={{ fontSize: 13 }}>Comparing sheets that share a sheet number…</div>
          <div className="progress" style={{ width: '100%' }}><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="dim" style={{ fontSize: 12 }}>{progress.label ? `Sheet ${progress.done + 1} of ${progress.total}: ${progress.label}` : 'Loading the drawings…'}</div>
        </div>
      )}
      {phase !== 'scan' && (
        groups.length === 0 ? (
          <div className="banner">No duplicate sheets found. {unnumbered ? `${plural(unnumbered, 'sheet')} had no readable sheet number and could not be compared.` : ''}</div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13 }}>
              Found {plural(nCopies, 'extra copy', 'extra copies')} of {plural(groups.length, 'sheet')}. Ticked sheets are removed; one copy of every drawing always stays,
              preferring the copy that has counts, then the earlier upload. A sheet with the same number but different content is a different version: it is shown, not ticked.
              {unnumbered ? ` ${plural(unnumbered, 'sheet')} with no readable number were not compared.` : ''}
            </div>
            <div style={{ maxHeight: 340, overflow: 'auto' }} className="stack">
              {groups.map((g) => {
                const left = groupIds(g).filter((id) => !remove.has(id)).length;
                return (
                  <div key={g.number} className="stack" style={{ gap: 4, paddingBottom: 6, borderBottom: '1px solid var(--color-border, #333)' }}>
                    <b>{g.number}</b>
                    {g.clusters.map((c, ci) => (
                      <div key={ci} className="stack" style={{ gap: 2, marginLeft: 6 }}>
                        {ci > 0 && <div className="dim" style={{ fontSize: 12 }}>A different version of this sheet ({Math.round(c.sim * 100)}% alike)</div>}
                        {c.members.map((m, mi) => {
                          const s = byId.get(m.id);
                          const ticked = remove.has(m.id);
                          return (
                            <Check key={m.id} checked={ticked} disabled={phase === 'remove' || (!ticked && left <= 1)}
                              onChange={(v) => setRemove((cur) => { const n = new Set(cur); if (v) n.add(m.id); else n.delete(m.id); return n; })}>
                              {fileName.get(m.file_id) ?? 'file'} · page {m.page}
                              {s?.title ? <span className="dim"> · {s.title}</span> : null}
                              {m.detection_count > 0 && <span className="tag tag-outline" style={{ marginLeft: 6 }}>{plural(m.detection_count, 'count')}</span>}
                              {mi === 0 && c.members.length > 1 && !ticked && <span className="tag tag-neutral" style={{ marginLeft: 6 }}>Kept</span>}
                            </Check>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            {atRisk > 0 && <div className="err-text" role="status">Removing the ticked sheets deletes {plural(atRisk, 'count')} placed on them. This can't be undone.</div>}
          </>
        )
      )}
      {error && <div className="err-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'remove'}>{groups.length === 0 && phase !== 'scan' ? 'Close' : 'Cancel'}</button>
        {phase !== 'scan' && groups.length > 0 && <button className="btn btn-primary" onClick={() => void run()} disabled={phase === 'remove' || remove.size === 0}>Remove {plural(remove.size, 'sheet')}</button>}
      </div>
    </Dialog>
  );
}
