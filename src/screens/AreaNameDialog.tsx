import { useState } from 'react';
import { Dialog } from '../app/ui.tsx';
import { MAX_AREA_NAME, areaKey } from '../../shared/areas.ts';

/** Name a newly outlined area: pick one that already exists in the project, or type a new name. */
export default function AreaNameDialog({ names, onSave, onCancel }: { names: string[]; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const clean = name.replace(/\s+/g, ' ').trim();
  const existing = names.find((n) => areaKey(n) === areaKey(clean));
  return (
    <Dialog title="Name this area" onClose={onCancel}>
      <div className="dialog-title">Name this area</div>
      <div className="muted" style={{ fontSize: 13 }}>
        Areas with the same name are one area: their counts add up, on this sheet and across sheets.
      </div>
      {names.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div style={{ fontSize: 12 }} className="dim">Use an existing name</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {names.map((n) => (
              <button key={n} className={`btn btn-secondary${existing === n ? ' on' : ''}`} style={existing === n ? { boxShadow: 'inset 0 0 0 1px var(--color-accent)' } : undefined} onClick={() => setName(n)} aria-pressed={existing === n}>{n}</button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="an">{names.length > 0 ? 'Or a new name' : 'Name'}</label>
        <input id="an" className="input" value={name} maxLength={MAX_AREA_NAME} autoFocus placeholder="for example: Lab A, Corridor, Level 2 east"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && clean) onSave(existing ?? clean); }} />
        {existing && existing !== clean && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>This is the same area as “{existing}”.</div>}
      </div>
      <div className="dialog-actions">
        <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={!clean} onClick={() => onSave(existing ?? clean)}>Save area</button>
      </div>
    </Dialog>
  );
}
