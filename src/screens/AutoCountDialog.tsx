import { useEffect, useMemo, useRef, useState } from 'react';
import type { CategoryRow, Detection, DrawingFileRow, ItemTypeRow, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { Check, Dialog, plural } from '../app/ui.tsx';
import { discover, scanSheets, writeSheet, type CodeRow, type SheetScan } from '../detect/autoCount.ts';
import { CONF_EMERGENCY, CONF_NORMAL_SPLIT } from '../detect/writePlan.ts';
import { EMERGENCY_KEY, discoverMarkers, emergencyCode, isEmergency, parseCustomMarkers } from '../detect/emergency.ts';
import { flushAll, getStore } from './sheetStore.ts';

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
  const [ignorePast, setIgnorePast] = useState(true);
  const [leaveOutGrid, setLeaveOutGrid] = useState(true); // grid-line bubbles (D, F, 4, E.2 ...) are not fixtures
  // What is already counted on these sheets, so a re-run can start fresh.
  const [existing, setExisting] = useState<Map<string, { auto: number; confirmed: number; manual: number }>>(new Map());
  const [resetAuto, setResetAuto] = useState(true);
  const [resetManual, setResetManual] = useState(false);
  const [markers, setMarkers] = useState<Set<string>>(new Set()); // confirmed emergency label patterns
  const [customText, setCustomText] = useState('');
  const [splitOff, setSplitOff] = useState<Set<string>>(new Set()); // codes the estimator chose NOT to split
  const abort = useRef(new AbortController());

  // Several library items can share a code (variants), so each code maps to a list.
  const byCode = useMemo(() => {
    const m = new Map<string, ItemTypeRow[]>();
    for (const i of items) m.set(i.code.toUpperCase(), [...(m.get(i.code.toUpperCase()) ?? []), i]);
    return m;
  }, [items]);
  // Anything past a matchline belongs to the neighbouring sheet and is left out (unless you turn that off).
  const effective: SheetScan[] = useMemo(() => scans.map((sc) => ({ ...sc, hits: sc.hits.filter((h) => !(ignorePast && h.past) && !(leaveOutGrid && h.grid)) })), [scans, ignorePast, leaveOutGrid]);
  // The grid marks that would otherwise have been counted: a tag, or a short code that is in the library.
  const wouldCount = (h: { grid?: boolean; past?: boolean; kind: string; code: string }) => !!h.grid && !(ignorePast && h.past) && (h.kind !== 'short' || byCode.has(h.code.toUpperCase()));
  const gridMarks = useMemo(() => scans.flatMap((sc) => sc.hits.filter(wouldCount)), [scans, ignorePast, byCode]); // eslint-disable-line react-hooks/exhaustive-deps
  const gridBubbleTotal = useMemo(() => scans.reduce((n, sc) => n + (sc.bubbles?.length ?? 0), 0), [scans]);
  const pastCount = useMemo(() => scans.reduce((n, sc) => n + sc.hits.filter((h) => h.past).length, 0), [scans]);
  const pastSheets = useMemo(() => scans.filter((sc) => sc.hits.some((h) => h.past)).length, [scans]);
  // Library matches first, then drawing notes, then other tags, then short codes, then room numbers.
  const [showShort, setShowShort] = useState(false);
  const [emOpen, setEmOpen] = useState(false); // the emergency options start folded up so the tag table has the room
  const rows: CodeRow[] = useMemo(() => {
    const rank = (r: CodeRow) => (r.kind === 'room' ? 4 : byCode.has(r.code.toUpperCase()) ? 0 : r.kind === 'note' ? 1 : r.kind === 'tag' ? 2 : 3);
    // Short letter-only marks (S, OS, CR, MM ...) are easily mixed up with other text, so they are counted only when this
    // project's library has them (a security device CR, a fire alarm module MM), or when you ask to see them.
    return [...discover(effective)].filter((r) => r.kind !== 'short' || byCode.has(r.code.toUpperCase()) || showShort)
      .sort((a, b) => rank(a) - rank(b) || b.total - a.total || a.code.localeCompare(b.code));
  }, [effective, byCode, showShort]);
  const shortRows = useMemo(() => discover(effective).filter((r) => r.kind === 'short' && !byCode.has(r.code.toUpperCase())), [effective, byCode]);
  const shortMarks = shortRows.reduce((n, r) => n + r.total, 0);

  // Emergency markers: found from the labels beside fixtures, confirmed by the estimator.
  const candidates = useMemo(() => discoverMarkers(effective.flatMap((sc) => sc.hits)), [effective]);
  const activeMarkers = useMemo(() => new Set([...markers, ...parseCustomMarkers(customText)]), [markers, customText]);
  const emByCode = useMemo(() => {
    const m = new Map<string, number>();
    for (const sc of effective) for (const h of sc.hits) if (h.kind === 'tag' && isEmergency(h, activeMarkers)) m.set(h.code, (m.get(h.code) ?? 0) + 1);
    return m;
  }, [effective, activeMarkers]);
  const exTotals = useMemo(() => [...existing.values()].reduce((a, v) => ({ auto: a.auto + v.auto, confirmed: a.confirmed + v.confirmed, manual: a.manual + v.manual }), { auto: 0, confirmed: 0, manual: 0 }), [existing]);
  const emTotal = [...emByCode.values()].reduce((a, b) => a + b, 0);
  // A fixture type is split into normal and emergency when it has emergency fixtures, unless it is an exit sign
  // (always emergency), has several library variants already, or the estimator turned the split off.
  const splits = (code: string) => (emByCode.get(code) ?? 0) > 0 && !splitOff.has(code) && (byCode.get(code.toUpperCase())?.length ?? 0) <= 1 && !/^XL/i.test(code);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const files = await api<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
        const res = await scanSheets(sheets, files.files, (done, total, label) => { if (!off) setProgress({ done, total, label }); }, abort.current.signal, new Set(items.map((i) => i.code.toUpperCase())));
        if (off) return;
        setScans(res);
        const found = discover(res.map((sc) => ({ ...sc, hits: sc.hits.filter((h) => !h.past) })));
        // Tags are pre-selected; short letter-only codes only if already in the library.
        // With a library (for example from a fixture schedule) only tags that match it are pre-ticked, so grid
        // labels and other look-alikes stay out. With no matches yet, every tag is pre-ticked to get you started.
        // Room numbers are never pre-ticked.
        const lib = found.filter((r) => r.kind !== 'room' && r.kind !== 'note' && byCode.has(r.code.toUpperCase()));
        setLibraryDriven(lib.length > 0);
        const notes = found.filter((r) => r.kind === 'note'); // drawing notes are always counted
        setInc(new Set([...(lib.length > 0 ? lib : found.filter((r) => r.kind === 'tag')), ...notes].map((r) => r.code)));
        // Only markers with a normal twin are pre-ticked; "possible" ones (no twin) are left for the estimator.
        setMarkers(new Set(discoverMarkers(res.flatMap((sc) => sc.hits.filter((h) => !h.past))).filter((c) => c.partner !== null).map((c) => c.pattern)));
        // How many counts are already there (so the estimator sees exactly what a fresh start erases).
        try {
          const ex = new Map<string, { auto: number; confirmed: number; manual: number }>();
          await Promise.all(res.filter((sc) => !sc.error).map(async (sc) => {
            const r = await api<{ detections: Detection[] }>(`/sheets/${sc.sheet.id}/detections`);
            ex.set(sc.sheet.id, {
              auto: r.detections.filter((d) => d.source === 'auto').length,
              confirmed: r.detections.filter((d) => d.source === 'auto' && d.status === 'confirmed').length,
              manual: r.detections.filter((d) => d.source === 'manual').length,
            });
          }));
          if (!off) setExisting(ex);
        } catch { /* the counts shown are only information; the reset itself does not depend on them */ }
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
      await flushAll(); // save any edits still waiting to be sent, so they are not lost or left out of a fresh start
      // 1. Resolve each chosen tag to a library item, creating items for new tags.
      let noteCat: string | undefined;
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
        const isNote = r.kind === 'note';
        if (isNote && noteCat === undefined) {
          const { categories } = await api<{ categories: CategoryRow[] }>(`/categories?project=${projectId}`);
          noteCat = categories.find((c) => c.name.toLowerCase() === 'drawing notes')?.id ?? (await api<{ category: CategoryRow }>('/categories', { body: { project_id: projectId, name: 'Drawing notes' } })).category.id;
        }
        const { item } = await api<{ item: ItemTypeRow }>('/items', {
          body: {
            project_id: projectId, code: r.code, name: (names[r.code] ?? '').trim() || (isNote ? `Drawing note ${r.code}` : r.code),
            category_id: isNote ? noteCat : null, marker_shape: isNote ? 'diamond' : r.kind === 'short' ? 'square' : 'circle', marker_glyph: isNote ? null : r.code.slice(0, 2),
          },
        });
        resolved.set(r.code, item);
      }
      // Emergency versions: B13 -> B13E (the schedule's own convention). Use the library item if it exists, else create it.
      const emKeys = new Set<string>();
      let emCreated = 0;
      for (const r of rows.filter((x) => inc.has(x.code) && x.kind === 'tag' && splits(x.code))) {
        const base = resolved.get(r.code);
        if (!base) continue;
        const emCode = emergencyCode(r.code, activeMarkers);
        let emItem = byCode.get(emCode.toUpperCase())?.[0];
        if (!emItem) {
          setStatus(`Adding ${emCode} (emergency ${r.code}) to the library…`);
          try {
            emItem = (await api<{ item: ItemTypeRow }>('/items', {
              body: { project_id: projectId, code: emCode, name: `${base.name}, emergency`.slice(0, 200), spec: base.spec, category_id: base.category_id, unit: base.unit, marker_shape: base.marker_shape, marker_glyph: base.marker_glyph },
            })).item;
            emCreated++;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409)) throw e;
            emItem = (await api<{ items: ItemTypeRow[] }>(`/items?project=${projectId}`)).items.find((i) => i.code.toUpperCase() === emCode.toUpperCase());
            if (!emItem) throw e;
          }
        }
        resolved.set(r.code + EMERGENCY_KEY, emItem);
        emKeys.add(r.code + EMERGENCY_KEY);
      }
      // Every library item whose code was found anywhere in the scan (ticked or not, past a matchline or not):
      // their earlier unreviewed automatic counts are replaced by this run.
      const clearIds = new Set<string>();
      for (const sc of scans) for (const h of sc.hits) for (const it of byCode.get(h.code.toUpperCase()) ?? []) clearIds.add(it.id);
      for (const it of resolved.values()) clearIds.add(it.id);
      const writeInc = new Set([...inc, ...emKeys]);
      // 2. Write each sheet's detections.
      let total = 0, removedPast = 0, removedGrid = 0, removedShort = 0, erased = 0, skipped = 0;
      const reset: false | 'auto' | 'all' = resetAuto ? (resetManual ? 'all' : 'auto') : false;
      let i = 0;
      for (const sc of scans) {
        i++;
        if (sc.error) { skipped++; continue; } // a sheet that could not be read is left exactly as it was
        setStatus(`Saving counts: sheet ${i} of ${scans.length}…`);
        // Fixtures of a split type go to their normal or emergency item.
        const hits = sc.hits.map((h) => {
          if (h.kind !== 'tag' || !inc.has(h.code) || !splits(h.code)) return h;
          return isEmergency(h, activeMarkers) ? { ...h, code: h.code + EMERGENCY_KEY, conf: CONF_EMERGENCY } : { ...h, conf: CONF_NORMAL_SPLIT };
        });
        const r = await writeSheet({ ...sc, hits }, resolved, writeInc, { ambiguous, clearItemIds: clearIds, reset, ignorePast, leaveOutGrid });
        total += r.added;
        removedPast += r.removedPast;
        removedGrid += r.removedGrid;
        removedShort += r.removedDropped;
        erased += r.erased;
      }
      // Sheets already open in this session must show the new counts, not a cached copy.
      await Promise.all(scans.map((sc) => getStore(sc.sheet.id).load(true)));
      onDone(`Counted ${plural(total, 'item')} across ${plural(scans.length, 'sheet')}.${erased ? ` Erased ${plural(erased, 'earlier count')} first.` : ''}${skipped ? ` ${plural(skipped, 'sheet')} could not be read and was left as it was.` : ''}${removedGrid ? ` Removed ${plural(removedGrid, 'earlier count')} that sat on grid-line bubbles.` : ''}${removedPast ? ` Removed ${plural(removedPast, 'earlier count')} that lay past matchlines.` : ''}${removedShort ? ` Removed ${plural(removedShort, 'earlier short-code count')}.` : ''}${ambiguous.size ? ` ${[...ambiguous].join(', ')} ${ambiguous.size === 1 ? 'has' : 'have'} several variants: review those and move each to the right item.` : ''} ${emKeys.size ? ` Emergency fixtures were counted under their own items (${[...emKeys].map((k) => emergencyCode(k.replace(EMERGENCY_KEY, ''), activeMarkers)).slice(0, 6).join(', ')}${emKeys.size > 6 ? '…' : ''}).` : ''} Counts are unreviewed until you confirm them.`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Saving the counts failed.');
      setPhase('pick');
    }
  }

  const totalSelected = rows.filter((r) => inc.has(r.code)).reduce((n, r) => n + r.total, 0);
  // The folded emergency section says what it holds, and flags a marker that still needs a decision.
  const emToReview = candidates.filter((c) => !markers.has(c.pattern)).length;
  const emSummary = candidates.length === 0 && markers.size === 0
    ? 'none found'
    : `${emTotal > 0 ? `${emTotal} fixture${emTotal === 1 ? '' : 's'} counted separately` : 'nothing counted separately'} · ${markers.size} marker${markers.size === 1 ? '' : 's'} ticked`;
  const failed = scans.filter((s) => s.error);

  return (
    <Dialog title="Auto-count" onClose={phase === 'write' ? () => undefined : onClose} wide className="ac">
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
            Found {plural(rows.length, 'tag type')}.{libraryDriven ? ' The tags in your item library are ticked.' : ' New tags are added to your item library; you can rename them there.'} Counts stay unreviewed until you confirm them.
          </div>

          {/* the tags to count come first and take the room */}
          <div className="ac-table">
            <table className="table">
              <thead><tr><th /><th>Tag</th><th>Library item</th><th>Emergency</th><th className="right">Found</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const lib = byCode.get(r.code.toUpperCase());
                  return (
                    <tr key={r.code}>
                      <td><Check checked={inc.has(r.code)} disabled={phase === 'write'} onChange={(v) => setInc((cur) => { const n = new Set(cur); if (v) n.add(r.code); else n.delete(r.code); return n; })}><span className="sr-only">Count {r.code}</span></Check></td>
                      <td style={{ fontWeight: 500 }}>{r.code}{r.kind === 'short' && <span className="tag tag-outline" style={{ marginLeft: 8 }} title="Short letter-only codes can match ordinary text. They are flagged for review.">Short code</span>}{r.kind === 'note' && <span className="tag tag-accent" style={{ marginLeft: 8 }} title="A number or letters inside a hexagon on the plan.">Drawing note</span>}{r.kind === 'room' && <span className="tag tag-neutral" style={{ marginLeft: 8 }} title="A room name sits just above it and it appears once. Tick it only if it is really a device.">Looks like a room number</span>}</td>
                      <td>{lib ? <span className="muted">{lib[0].name.length > 50 ? `${lib[0].name.slice(0, 50)}…` : lib[0].name}{lib.length > 1 ? ` (+${lib.length - 1} variant${lib.length === 2 ? '' : 's'}: flagged for review)` : ''}</span> : <input className="input" style={{ minHeight: 30, padding: '3px 8px' }} placeholder={r.kind === 'note' ? `Drawing note ${r.code}` : 'Description (optional)'} aria-label={`Description for ${r.code}`} value={names[r.code] ?? ''} disabled={phase === 'write'} onChange={(e) => setNames({ ...names, [r.code]: e.target.value })} />}</td>
                      <td>{r.kind === 'tag' && (emByCode.get(r.code) ?? 0) > 0 && !/^XL/i.test(r.code) && (byCode.get(r.code.toUpperCase())?.length ?? 0) <= 1 ? (
                        <Check checked={!splitOff.has(r.code)} disabled={phase === 'write'} onChange={(v) => setSplitOff((cur) => { const n = new Set(cur); if (v) n.delete(r.code); else n.add(r.code); return n; })}>{emByCode.get(r.code)} as {emergencyCode(r.code, activeMarkers)}</Check>
                      ) : <span className="dim">{r.kind === 'tag' && /^XL/i.test(r.code) ? 'exit sign' : ''}</span>}</td>
                      <td className="right num">{r.total}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={5} className="muted">No tags were found. Sheets drawn as pictures (scans) have no text to read.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="ac-options">
            {exTotals.auto + exTotals.manual > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <Check checked={resetAuto} disabled={phase === 'write'} onChange={(v) => { setResetAuto(v); if (!v) setResetManual(false); }}>
                  Start fresh: erase the {plural(exTotals.auto, 'earlier automatic count')}{exTotals.confirmed ? ` (${exTotals.confirmed} confirmed)` : ''} first, then count again.
                </Check>
                {exTotals.manual > 0 && (
                  <Check checked={resetManual} disabled={phase === 'write' || !resetAuto} onChange={setResetManual}>
                    <span style={resetManual ? { color: 'var(--color-accent-300)' } : undefined}>Also erase the {plural(exTotals.manual, 'count')} placed by hand. This cannot be undone.</span>
                  </Check>
                )}
              </div>
            )}
            {/* always shown, like the other two options, so it is clear that it exists and what it found */}
            <Check checked={leaveOutGrid} disabled={phase === 'write'} onChange={setLeaveOutGrid}>
              Leave out grid-line bubbles ({gridMarks.length > 0
                ? `${plural(gridMarks.length, 'mark')} would be counted: ${[...new Set(gridMarks.map((h) => h.code))].slice(0, 6).join(', ')}${new Set(gridMarks.map((h) => h.code)).size > 6 ? '…' : ''}`
                : gridBubbleTotal > 0 ? `${plural(gridBubbleTotal, 'bubble')} found, none would be counted` : 'none found on these sheets'}). Removes earlier counts on them.
            </Check>
            {pastCount > 0 && (
            <Check checked={ignorePast} disabled={phase === 'write'} onChange={setIgnorePast}>
              Leave out {plural(pastCount, 'mark')} past matchlines (on {plural(pastSheets, 'sheet')}). They belong to the neighbouring sheet.
            </Check>
          )}

            <div className="ac-section">
              <button type="button" className="ac-head" aria-expanded={emOpen} onClick={() => setEmOpen((v) => !v)}>
                <span className="ac-caret">{emOpen ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 500 }}>Emergency fixtures</span>
                <span className="dim" style={{ fontSize: 12 }}>{emSummary}</span>
                {emToReview > 0 && <span className="tag tag-outline">{emToReview} to review</span>}
              </button>
              {emOpen && (
                <div className="stack" style={{ gap: 8, padding: '6px 0 2px 18px' }}>
            <div className="muted" style={{ fontSize: 13 }}>
              {candidates.length > 0
                ? 'These labels beside fixtures look like emergency markings, each next to a normal version of the same label. Tick the ones that mean emergency; those fixtures are counted separately.'
                : 'No emergency labels were found automatically. If your drawings mark emergency fixtures with a label, type it below.'}
            </div>
            {candidates.map((c) => (
              <Check key={c.pattern} checked={markers.has(c.pattern)} disabled={phase === 'write'} onChange={(v) => setMarkers((cur) => { const n = new Set(cur); if (v) n.add(c.pattern); else n.delete(c.pattern); return n; })}>
                <span><b>{c.pattern.startsWith('+') ? `“${c.pattern.slice(1)}” after the tag` : c.pattern}</b> <span className="dim">({c.count} fixtures, e.g. {c.examples.slice(0, 3).join(', ')}; {c.partner ? `normal: ${c.partner}` : c.pattern.startsWith('+') ? 'possible: a word written after the tag; tick it only if it means emergency (not, for example, night light)' : 'possible: starts with E, no normal version found'})</span></span>
              </Check>
            ))}
            <input className="input" style={{ minHeight: 30, padding: '3px 8px' }} aria-label="Other emergency labels" placeholder="Other emergency labels, e.g. EM#, NL  (# stands for a number)" value={customText} disabled={phase === 'write'} onChange={(e) => setCustomText(e.target.value)} />

                </div>
              )}
            </div>
          {shortMarks > 0 && (
            <div className="dim" style={{ fontSize: 12 }}>
              {plural(shortMarks, 'short letter-only mark')} ({shortRows.slice(0, 6).map((r) => `${r.code} ${r.total}`).join(', ')}{shortRows.length > 6 ? '…' : ''}) {showShort ? 'are listed below, not ticked' : 'are not counted'}:
              they are easily confused with other text. Devices such as CR, DC or MM are counted once they are in this project's library.
              <button className="btn btn-ghost" style={{ padding: '0 6px' }} onClick={() => setShowShort((v) => !v)}>{showShort ? 'Hide them' : 'Show them to add some'}</button>
            </div>
          )}
          {failed.length > 0 && <div className="err-text">{plural(failed.length, 'sheet')} couldn't be read: {failed.map((f) => f.sheet.number ?? `page ${f.sheet.page}`).join(', ')}.</div>}
          </div>
        </>
      )}

      {error && <div className="err-text" role="alert">{error}</div>}
      {status && phase === 'write' && <div className="muted" style={{ fontSize: 13 }} role="status"><span className="spinner" /> {status}</div>}
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={phase === 'write'}>Cancel</button>
        {phase !== 'scan' && <button className="btn btn-primary" onClick={run} disabled={phase === 'write' || totalSelected === 0}>{resetAuto && exTotals.auto + (resetManual ? exTotals.manual : 0) > 0 ? 'Erase and count' : 'Count'} {totalSelected} item{totalSelected === 1 ? '' : 's'}</button>}
      </div>
    </Dialog>
  );
}
