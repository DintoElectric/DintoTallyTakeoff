import { useEffect, useState } from 'react';
import type { DrawingFileRow, SheetRow } from '../../shared/types.ts';
import { Dialog, plural } from '../app/ui.tsx';
import { navigate, paths } from '../app/router.ts';
import { extractRuns } from '../detect/pageRuns.ts';
import { scheduleHeadings, titleSaysSchedule } from '../detect/scheduleSheets.ts';
import { loadFilePdf } from '../viewer/pdf.ts';

interface Found { sheet: SheetRow; headings: string[] }
// what each sheet holds, kept for the session: reading every sheet's text takes a moment
const seen = new Map<string, string[]>();

/**
 * Read schedules, step 1: the sheets that have schedules on them, with the schedules' names. Open one to box the
 * schedule to read (the drawing opens with the Read schedule tool on).
 */
export default function ScheduleFinderDialog({ projectId, sheets, files, onClose, onOldReader }: {
  projectId: string; sheets: SheetRow[]; files: DrawingFileRow[]; onClose: () => void; onOldReader: () => void;
}) {
  const [found, setFound] = useState<Found[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: sheets.length });

  useEffect(() => {
    let off = false;
    (async () => {
      const fileById = new Map(files.map((f) => [f.id, f]));
      const out: Found[] = [];
      for (let i = 0; i < sheets.length; i++) {
        if (off) return;
        const s = sheets[i];
        let headings = seen.get(s.id);
        if (!headings) {
          headings = [];
          const f = fileById.get(s.file_id);
          if (f) {
            try {
              const doc = await loadFilePdf({ id: f.id, chunk_count: f.chunk_count });
              const page = await doc.getPage(s.page);
              headings = scheduleHeadings((await extractRuns(page)).map((r) => r.str));
            } catch { /* a page that can't be read is just not listed */ }
          }
          seen.set(s.id, headings);
        }
        if (headings.length || s.kind === 'schedule' || titleSaysSchedule(s.title)) { out.push({ sheet: s, headings }); setFound([...out]); }
        setProgress({ done: i + 1, total: sheets.length });
      }
    })();
    return () => { off = true; };
  }, [sheets, files]);

  const scanning = progress.done < progress.total;
  return (
    <Dialog title="Read schedules" onClose={onClose} wide>
      <div className="dialog-title">Read schedules</div>
      <div className="dialog-body stack" style={{ gap: 12 }}>
        <div className="dim" style={{ fontSize: 13 }}>
          Open a sheet and box the schedule you want read (its header and a row or two is enough). Draw ignore areas over columns you don't need. Only what you box is read.
        </div>
        <div className="dim num" style={{ fontSize: 12 }}>{scanning ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Looking through the sheets… {progress.done} of {progress.total}</> : `${plural(found.length, 'sheet')} with schedules, of ${plural(sheets.length, 'sheet')}.`}</div>
        <div className="finder-list">
          {found.map(({ sheet: s, headings }) => (
            <div key={s.id} className="finder-row">
              <div style={{ minWidth: 0 }}>
                <div><b>{s.number ?? `Page ${s.page}`}</b>{s.title ? <span className="dim"> · {s.title}</span> : null}</div>
                <div className="dim" style={{ fontSize: 12 }}>{headings.length ? headings.slice(0, 6).join(' · ') + (headings.length > 6 ? ` · and ${headings.length - 6} more` : '') : 'Titled as a schedule'}</div>
              </div>
              <button className="btn btn-primary" style={{ flex: 'none' }} onClick={() => navigate(`${paths.sheet(projectId, s.id)}?read=1`)}>Open and box</button>
            </div>
          ))}
          {!scanning && found.length === 0 && <div className="dim">No schedules found. You can still open any sheet and use the Read schedule tool (R) on it.</div>}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onOldReader} title="The earlier reader: tries to read whole pages by itself">Read whole pages automatically instead</button>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
