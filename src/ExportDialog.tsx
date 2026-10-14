import { useEffect, useMemo, useState } from 'react';
import { DownloadSimple, MicrosoftExcelLogo, MicrosoftWordLogo, X } from '@phosphor-icons/react';
import type { DrawingFileRow, ExportData, SheetRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { Check, Dialog, Seg } from '../app/ui.tsx';
import { aggregate, safeFileName } from '../export/aggregate.ts';
import type { ExportOptions } from '../export/types.ts';
import { loadFilePdf } from '../viewer/pdf.ts';
import { renderSnapshot } from '../viewer/snapshot.ts';
import { flushAll } from './sheetStore.ts';

type Format = 'xlsx' | 'docx';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function ExportDialog({ projectId, projectName, sheets, currentSheetId, onClose, onGoReview }: {
  projectId: string; projectName: string; sheets: SheetRow[]; currentSheetId: string; onClose: () => void; onGoReview: () => void;
}) {
  const { me } = useAuth();
  const [format, setFormat] = useState<Format>('xlsx');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [groupBy, setGroupBy] = useState<ExportOptions['groupBy']>('floor');
  const [perSheet, setPerSheet] = useState(true);
  const [subtotals, setSubtotals] = useState(true);
  const [log, setLog] = useState(true);
  const [snaps, setSnaps] = useState(true);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [preview, setPreview] = useState<ExportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const defaultName = `${safeFileName(projectName)}_E-Counts.${format}`;
  useEffect(() => { if (!nameTouched) setName(defaultName); }, [defaultName, nameTouched]);

  const counted = sheets.filter((s) => s.count_enabled);
  const sheetIds = scope === 'current' ? new Set([currentSheetId]) : null;

  // Read the saved numbers when the dialog opens (for the unreviewed warning)...
  useEffect(() => {
    let off = false;
    api<ExportData>(`/projects/${projectId}/export-data`).then((d) => { if (!off) setPreview(d); }).catch(() => undefined);
    return () => { off = true; };
  }, [projectId]);

  const unreviewed = useMemo(() => {
    if (!preview) return null;
    const agg = aggregate(preview, { sheetIds });
    const sh = agg.sheets.filter((s) => agg.unreviewedBySheet.get(s.id));
    return { n: agg.unreviewedTotal, sheets: sh };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, scope, currentSheetId]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      // ...and again at click time, after flushing any unsent edits, so the file reflects saved work.
      setStatus('Saving your latest changes…');
      await flushAll();
      setStatus('Reading counts…');
      const data = await api<ExportData>(`/projects/${projectId}/export-data`);
      const agg = aggregate(data, { sheetIds });
      if (agg.sheets.length === 0 || agg.grandTotal === 0) {
        throw new Error('There is nothing to export yet. Place some counts on a sheet first.');
      }
      const opts: ExportOptions = { sheetIds, groupBy, perSheetColumns: perSheet, subtotals, detectionLog: log, snapshots: snaps, preparedBy: me?.name ?? '' };
      const fileName = safeFileName(name.replace(/\.(xlsx|docx)$/i, ''), 'Takeoff') + `.${format}`;
      let blob: Blob;
      if (format === 'xlsx') {
        setStatus('Building the workbook…');
        blob = await (await import('../export/xlsx.ts')).buildXlsx(data, agg, opts);
      } else {
        setStatus('Building the report…');
        let getSnapshot;
        if (snaps) {
          const files = await api<{ files: DrawingFileRow[] }>(`/files?project=${projectId}`);
          const fileById = new Map(files.files.map((f) => [f.id, f]));
          const styles = new Map(data.items.map((i) => [i.id, { shape: i.marker_shape, glyph: i.marker_glyph }]));
          getSnapshot = async (s: SheetRow) => {
            const f = fileById.get(s.file_id);
            if (!f) return null;
            const pdf = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
            const page = await pdf.getPage(s.page);
            const mk = data.detections.filter((d) => d.sheet_id === s.id).map((d) => ({ x: d.x, y: d.y, itemId: d.item_type_id, unreviewed: d.status === 'unreviewed' }));
            const r = await renderSnapshot(page, mk, styles);
            page.cleanup();
            return r;
          };
        }
        blob = await (await import('../export/docx.ts')).buildDocx(data, agg, opts, getSnapshot, setStatus);
      }
      download(blob, fileName);
      setStatus('');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'The export failed. Please try again.');
      setStatus('');
      setBusy(false);
    }
  }

  return (
    <Dialog title="Export counts" onClose={busy ? () => undefined : onClose} wide>
      <div className="row-between">
        <div className="dialog-title">Export counts</div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
      </div>

      <div className="fmt-grid" role="radiogroup" aria-label="Format">
        <button className={`fmt-card${format === 'xlsx' ? ' on' : ''}`} role="radio" aria-checked={format === 'xlsx'} onClick={() => setFormat('xlsx')}>
          <span className="ic"><MicrosoftExcelLogo size={26} /></span>
          <span><div style={{ fontWeight: 500 }}>Excel workbook</div><div className="muted" style={{ fontSize: 12 }}>Summary, by floor/area and detection log tabs</div></span>
        </button>
        <button className={`fmt-card${format === 'docx' ? ' on' : ''}`} role="radio" aria-checked={format === 'docx'} onClick={() => setFormat('docx')}>
          <span className="ic"><MicrosoftWordLogo size={26} /></span>
          <span><div style={{ fontWeight: 500 }}>Word report</div><div className="muted" style={{ fontSize: 12 }}>Count tables by floor, with marked-up sheets</div></span>
        </button>
      </div>

      <div className="field">
        <label htmlFor="exs">Sheets</label>
        <select id="exs" className="input" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'current')}>
          <option value="all">All counted sheets ({counted.length})</option>
          <option value="current">This sheet only</option>
        </select>
      </div>

      <div className="field">
        <label>Group rows by</label>
        <Seg name="group" value={groupBy} onChange={setGroupBy} options={[{ value: 'item', label: 'Item' }, { value: 'sheet', label: 'Sheet' }, { value: 'floor', label: 'Floor / area' }]} />
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <Check checked={perSheet} onChange={setPerSheet}>Per-sheet quantity columns</Check>
        <Check checked={subtotals} onChange={setSubtotals}>Subtotals by floor and area</Check>
        <Check checked={log} onChange={setLog} disabled={format !== 'xlsx'}>Detection log with sheet coordinates (Excel)</Check>
        <Check checked={snaps} onChange={setSnaps} disabled={format !== 'docx'}>Marked-up sheet snapshots (Word only)</Check>
      </div>

      <div className="field">
        <label htmlFor="exn">File name</label>
        <input id="exn" className="input" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
      </div>

      {unreviewed && unreviewed.n > 0 && (
        <div className="banner" role="status">
          {unreviewed.n} detection{unreviewed.n === 1 ? '' : 's'} on {unreviewed.sheets.length === 1 ? (unreviewed.sheets[0].number ?? 'one sheet') : `${unreviewed.sheets.length} sheets`} {unreviewed.n === 1 ? 'is' : 'are'} unreviewed and will be marked in the export.{' '}
          <button className="btn btn-ghost" style={{ padding: 0, color: 'inherit', textDecoration: 'underline' }} onClick={onGoReview}>Review first</button>
        </div>
      )}
      {error && <div className="err-text" role="alert">{error}</div>}
      {status && <div className="muted" style={{ fontSize: 13 }} role="status"><span className="spinner" /> {status}</div>}

      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={run} disabled={busy}><DownloadSimple size={14} /> Export .{format}</button>
      </div>
    </Dialog>
  );
}
