import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { discover, scanSheets, writeSheet, type CodeRow, type SheetScan } from '../detect/autoCount.ts';

/** Scans sheets for tags, shows what was found, then counts the ones you choose. */
export default function AutoCountDialog({ projectId, sheets, items, onClose, onDone }: {
  projectId: string; sheets: SheetRow[]; items: ItemTypeRow[]; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [phase, setPhase] = useState<'scan' | 'pick' | 'write'>('scan');
  const [progress, setProgress] = useState({ done: 0, total: sheets.length, label: '' });
  const [scans, setScans] = useState<SheetScan[]>([]);
  const [inc, setInc] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const abort = useRef(new AbortController());

  const byCode = useMemo(() => new Map(items.map((i) => [i.code.toUpperCase(), i])), [items]);
  const rows: CodeRow[] = useMemo(() => discover(scans), [scans]);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const files = await api<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
        const res = await scanSheets(sheets, files.files, (done, total, label) => { if (!off) setProgress({ done, total, label }); }, abort.current.signal);
        if (off) return;
        setScans(res);
        const found = discover(res);
        // Tags are pre-selected; short letter-only codes only if already in the library.
        setInc(new Set(found.filter((r) => r.kind === 'tag' || byCode.has(r.code.toUpperCase())).map((r) => r.code)));
        setPhase('pick');
      } catch (e) {
        if (!off && !(e instanceof DOMException)) setError(e instanceof Error ? e.message : 'The scan failed.');
      }
    })();
    return () => { off = true; abort.current.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    setPhase('write');
    setError(null);
    try {
      // 1. Create library items for new tags.
      const map = new Map<string, ItemTypeRow>(items.map((i) => [i.code, i]));
      const wanted = rows.filter((r) => inc.has(r.code));
      for (const r of wanted) {
        if (map.has(r.code)) continue;
        const ci = [...byCode.keys()].find((k) => k === r.code.toUpperCase());
        if (ci) { map.set(r.code, byCode.get(ci)!); continue; }
        setStatus(`Adding ${r.code} to the library…`);
        const { item } = await api<{ item: ItemTypeRow }>('/items', {
          body: { code: r.code, name: (names[r.code] ?? '').trim() || r.code, marker_shape: r.kind === 'short' ? 'square' : 'circle', marker_glyph: r.code.slice(0, 2) },
        });
        map.set(r.code, item);
      }
      // 2. Write each sheet's detections.
      let total = 0;
      let i = 0;
      for (const sc of scans) {
        i++;
        setStatus(`Saving counts: sheet ${i} of ${scans.length}…`);
        total += await writeSheet(sc, map, inc);
      }
      onDone(`Counted ${plural(total, 'item')} across ${plural(scans.length, 'sheet')}. They are marked unreviewed until you confirm them.`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Saving the counts failed.');
      setPhase('pick');
    }
  }

  const totalSelected = rows.filter((r) => inc.has(r.code)).reduce((n, r) => n + r.total, 0);
  const failed = scans.filter((s) => s.error);

  return (
    <Dialog title="Auto-count" onClose={phase === 'write' ? () => undefined : onClose} wide>
      <div className="dialog-title">Auto-count {plural(sheets.length, 'sheet')}</div>

      {phase === 'scan' && (
        <div className="stack">
          <div className="muted" style={{ fontSize: 13 }}>Reading each sheet's tags (B13, XL4, OS and so on)…</div>
          <div className="progress" style={{ width: '100%' }}><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div className="dim" style={{ fontSize: 12 }}>{progress.label ? `Sheet ${progress.done + 1} of ${progress.total}: ${progress.label}` : 'Loading the drawings…'}</div>
        </div>
      )}

      {phase !== 'scan' && (
        <>
          <div className="muted" style={{ fontSize: 13 }}>
            Found {plural(rows.length, 'tag type')}. Choose what to count. New tags are added to your item library; you can rename them there.
            Counts are marked unreviewed until you confirm them.
          </div>
          {failed.length > 0 && <div className="err-text">{plural(failed.length, 'sheet')} couldn't be read: {failed.map((f) => f.sheet.number ?? `page ${f.sheet.page}`).join(', ')}.</div>}
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            <table className="table">
              <thead><tr><th /><th>Tag</th><th>Library item</th><th className="right">Found</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const lib = byCode.get(r.code.toUpperCase());
                  return (
                    <tr key={r.code}>
                      <td><Check checked={inc.has(r.code)} disabled={phase === 'write'} onChange={(v) => setInc((cur) => { const n = new Set(cur); if (v) n.add(r.code); else n.delete(r.code); return n; })}><span className="sr-only">Count {r.code}</span></Check></td>
                      <td style={{ fontWeight: 500 }}>{r.code}{r.kind === 'short' && <span className="tag tag-outline" style={{ marginLeft: 8 }} title="Short letter-only codes can match ordinary text. They are flagged for review.">Short code</span>}</td>
                      <td>{lib ? <span className="muted">{lib.name}</span> : <input className="input" style={{ minHeight: 30, padding: '3px 8px' }} placeholder="Description (optional)" aria-label={`Description for ${r.code}`} value={names[r.code] ?? ''} disabled={phase === 'write'} onChange={(e) => setNames({ ...names, [r.code]: e.target.value })} />}</td>
                      <td className="right num">{r.total}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={4} className="muted">No tags were found. Sheets drawn as pictures (scans) have no text to read.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {error && <div className="err-text" role="alert">{error}</div>}
      {status && phase === 'write' && <div className="muted" style={{ fontSize: 13 }} role="status"><span className="spinner" /> {status}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'write'}>Cancel</button>
        {phase !== 'scan' && <button className="btn btn-primary" onClick={run} disabled={phase === 'write' || totalSelected === 0}>Count {totalSelected} item{totalSelected === 1 ? '' : 's'}</button>}
      </div>
    </Dialog>
  );
}
