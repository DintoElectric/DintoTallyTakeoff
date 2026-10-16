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
  const [libraryDriven, setLibraryDriven] = useState(false);
  const abort = useRef(new AbortController());

  // Several library items can share a code (variants), so each code maps to a list.
  const byCode = useMemo(() => {
    const m = new Map<string, ItemTypeRow[]>();
    for (const i of items) m.set(i.code.toUpperCase(), [...(m.get(i.code.toUpperCase()) ?? []), i]);
    return m;
  }, [items]);
  // Library matches first, then other tags, then short codes, then room numbers.
  const rows: CodeRow[] = useMemo(() => {
    const rank = (r: CodeRow) => (r.kind === 'room' ? 3 : byCode.has(r.code.toUpperCase()) ? 0 : r.kind === 'tag' ? 1 : 2);
    return [...discover(scans)].sort((a, b) => rank(a) - rank(b) || b.total - a.total || a.code.localeCompare(b.code));
  }, [scans, byCode]);

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
        // With a library (for example from a fixture schedule) only tags that match it are pre-ticked, so grid
        // labels and other look-alikes stay out. With no matches yet, every tag is pre-ticked to get you started.
        // Room numbers are never pre-ticked.
        const lib = found.filter((r) => r.kind !== 'room' && byCode.has(r.code.toUpperCase()));
        setLibraryDriven(lib.length > 0);
        setInc(new Set((lib.length > 0 ? lib : found.filter((r) => r.kind === 'tag')).map((r) => r.code)));
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
      // 1. Resolve each chosen tag to a library item, creating items for new tags.
      const resolved = new Map<string, ItemTypeRow>();
      const ambiguous = new Set<string>();
      for (const r of rows.filter((x) => inc.has(x.code))) {
        const lib = byCode.get(r.code.toUpperCase());
        if (lib?.length) {
          resolved.set(r.code, lib[0]); // the first item with this code is the default
          if (lib.length > 1) ambiguous.add(r.code);
          continue;
        }
        setStatus(`Adding ${r.code} to the library…`);
        const { item } = await api<{ item: ItemTypeRow }>('/items', {
          body: { code: r.code, name: (names[r.code] ?? '').trim() || r.code, marker_shape: r.kind === 'short' ? 'square' : 'circle', marker_glyph: r.code.slice(0, 2) },
        });
        resolved.set(r.code, item);
      }
      // Items for codes that were found but not ticked: their earlier unreviewed auto counts get removed.
      const excludedIds = new Set<string>();
      for (const r of rows) if (!inc.has(r.code)) for (const it of byCode.get(r.code.toUpperCase()) ?? []) excludedIds.add(it.id);
      // 2. Write each sheet's detections.
      let total = 0;
      let i = 0;
      for (const sc of scans) {
        i++;
        setStatus(`Saving counts: sheet ${i} of ${scans.length}…`);
        total += await writeSheet(sc, resolved, inc, ambiguous, excludedIds);
      }
      onDone(`Counted ${plural(total, 'item')} across ${plural(scans.length, 'sheet')}.${ambiguous.size ? ` ${[...ambiguous].join(', ')} ${ambiguous.size === 1 ? 'has' : 'have'} several variants: review those and move each to the right item.` : ''} Counts are unreviewed until you confirm them.`);
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
            Found {plural(rows.length, 'tag type')}.{libraryDriven ? ' The tags that match your item library are ticked; the rest are unticked.' : ' New tags are added to your item library; you can rename them there.'}
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
                      <td style={{ fontWeight: 500 }}>{r.code}{r.kind === 'short' && <span className="tag tag-outline" style={{ marginLeft: 8 }} title="Short letter-only codes can match ordinary text. They are flagged for review.">Short code</span>}{r.kind === 'room' && <span className="tag tag-neutral" style={{ marginLeft: 8 }} title="A room name sits just above it and it appears once. Tick it only if it is really a device.">Looks like a room number</span>}</td>
                      <td>{lib ? <span className="muted">{lib[0].name.length > 50 ? `${lib[0].name.slice(0, 50)}…` : lib[0].name}{lib.length > 1 ? ` (+${lib.length - 1} variant${lib.length === 2 ? '' : 's'}: flagged for review)` : ''}</span> : <input className="input" style={{ minHeight: 30, padding: '3px 8px' }} placeholder="Description (optional)" aria-label={`Description for ${r.code}`} value={names[r.code] ?? ''} disabled={phase === 'write'} onChange={(e) => setNames({ ...names, [r.code]: e.target.value })} />}</td>
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
