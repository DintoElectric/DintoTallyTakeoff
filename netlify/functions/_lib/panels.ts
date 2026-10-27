import { db } from './db.ts';
import type { Panel } from '../../../shared/panels.ts';

export const PANEL_COLS = `p.id, p.project_id, p.sheet_id, p.name, p.alt_name, p.voltage, p.phases, p.wires, p.main_type, p.main_amps,
  p.bus_amps, p.kaic::float8 as kaic, p.iso_ground, p.surge, p.fed_from, p.location, p.manufacturer, p.mounting, p.positions,
  p.notes, p.source, p.created_by_name, p.updated_at`;

/** A project's panels (or one panel), each with its circuits in circuit order. */
export async function loadPanels(projectId: string | null, panelId: string | null = null): Promise<Panel[]> {
  const q = (t: string, v: unknown[]) => db().pool.query(t, v);
  const panels = (await q(
    `select ${PANEL_COLS} from panels p
      where ($1::uuid is null or p.project_id = $1::uuid) and ($2::uuid is null or p.id = $2::uuid)
      order by lower(p.name), p.id`, [projectId, panelId])).rows as Panel[];
  if (!panels.length) return [];
  const circuits = (await q(
    `select panel_id, circuit, description, kind, breaker_amps, poles, load_kva::float8 as load_kva
       from panel_circuits where panel_id = any($1::uuid[]) order by circuit`, [panels.map((p) => p.id)])).rows;
  const by = new Map<string, Panel['circuits']>();
  for (const c of circuits) { const { panel_id, ...rest } = c; (by.get(panel_id) ?? by.set(panel_id, []).get(panel_id)!).push(rest); }
  return panels.map((p) => ({ ...p, circuits: by.get(p.id) ?? [] }));
}
