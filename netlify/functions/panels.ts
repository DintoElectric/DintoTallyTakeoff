// /api/panels?project=<id>   GET   the project's panels, each with its circuits
// /api/panels                POST  a new panel (estimator): its details and, optionally, its circuits
// /api/panels/:id            GET · PATCH (details; circuits, when sent, replace them all) · DELETE
import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db, transaction } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { int, num, oneOf, onlyKeys, reqStr, str, uuid } from './_lib/validate.ts';
import { loadPanels } from './_lib/panels.ts';
import { MAX_NOTE } from './_lib/limits.ts';
import { circuitProblems, type Circuit } from '../../shared/panels.ts';

const FIELDS = ['sheet_id', 'name', 'alt_name', 'voltage', 'phases', 'wires', 'main_type', 'main_amps', 'bus_amps', 'kaic', 'iso_ground',
  'surge', 'fed_from', 'location', 'manufacturer', 'mounting', 'positions', 'notes', 'source'] as const;
const MAX_CIRCUITS = 200;

const optInt = (v: unknown, label: string, min: number, max: number) => (v === null || v === undefined || v === '' ? null : int(v, label, min, max));
const optBool = (v: unknown, label: string) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'boolean') throw new HttpError(400, `${label} must be yes or no.`);
  return v;
};

/** The panel details in a request, checked; only the keys present. */
async function details(b: Record<string, unknown>, projectId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) {
    if (!(k in b)) continue;
    const v = b[k];
    switch (k) {
      case 'name': out[k] = reqStr(v, 'Panel ID', 60); break;
      case 'sheet_id': {
        if (v === null || v === '' || v === undefined) { out[k] = null; break; }
        const id = uuid(v, 'sheet id');
        const [s] = await db().sql<{ id: string }>`select id from sheets where id = ${id} and project_id = ${projectId}`;
        if (!s) throw new HttpError(400, 'That sheet is not in this project.');
        out[k] = id; break;
      }
      case 'phases': {
        if (v === null || v === '' || v === undefined) { out[k] = null; break; }
        const n = Number(v);
        if (n !== 1 && n !== 3) throw new HttpError(400, 'Phase must be 1 or 3.');
        out[k] = n; break;
      }
      case 'wires': out[k] = optInt(v, 'Wires', 2, 5); break;
      case 'main_type': out[k] = v === null || v === '' || v === undefined ? null : oneOf(v, ['MCB', 'MLO'] as const, 'Main'); break;
      case 'main_amps': out[k] = optInt(v, 'Main rating', 1, 10000); break;
      case 'bus_amps': out[k] = optInt(v, 'Bus rating', 1, 10000); break;
      case 'kaic': out[k] = v === null || v === '' || v === undefined ? null : num(v, 'KAIC', 0, 500); break;
      case 'positions': out[k] = optInt(v, 'Circuits', 1, 200); break;
      case 'iso_ground': out[k] = optBool(v, 'Iso ground'); break;
      case 'surge': out[k] = optBool(v, 'Surge protection'); break;
      case 'source': out[k] = oneOf(v, ['manual', 'read'] as const, 'Source'); break;
      case 'notes': out[k] = str(v, 'Notes', { max: MAX_NOTE }); break;
      default: out[k] = str(v, k.replace('_', ' '), { max: 120 });
    }
  }
  return out;
}

/** The circuits in a request, checked. Problems a person must fix (two breakers on one circuit) are refused. */
function circuits(v: unknown, positions: number | null): Circuit[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'Circuits must be a list.');
  if (v.length > MAX_CIRCUITS) throw new HttpError(400, `A panel can have up to ${MAX_CIRCUITS} circuits.`);
  const list: Circuit[] = v.map((c, i) => {
    if (!c || typeof c !== 'object') throw new HttpError(400, `Circuit ${i + 1} is not valid.`);
    const o = c as Record<string, unknown>;
    onlyKeys(o, ['circuit', 'description', 'kind', 'breaker_amps', 'poles', 'load_kva']);
    const kind = oneOf(o.kind, ['load', 'spare', 'space'] as const, 'Circuit kind');
    return {
      circuit: int(o.circuit, 'Circuit number', 1, 200),
      description: str(o.description, 'Description', { max: 120 }),
      kind,
      breaker_amps: kind === 'space' ? null : optInt(o.breaker_amps, 'Breaker size', 1, 6000),
      poles: optInt(o.poles, 'Poles', 1, 3) ?? 1,
      load_kva: o.load_kva === null || o.load_kva === undefined || o.load_kva === '' ? null : num(o.load_kva, 'Load', 0, 100000),
    };
  });
  const twice = circuitProblems({ positions }, list).find((p) => p.includes('used twice'));
  if (twice) throw new HttpError(400, twice);
  return list;
}

async function writeCircuits(q: (t: string, p?: unknown[]) => Promise<{ rows: any[] }>, panelId: string, list: Circuit[]) {
  await q(`delete from panel_circuits where panel_id = $1`, [panelId]);
  for (const c of list) {
    await q(`insert into panel_circuits (panel_id, circuit, description, kind, breaker_amps, poles, load_kva) values ($1,$2,$3,$4,$5,$6,$7)`,
      [panelId, c.circuit, c.description, c.kind, c.breaker_amps, c.poles, c.load_kva]);
  }
}

export default handle(async (req: Request, _ctx: Context) => {
  const [, idRaw] = segments(req);
  const sql = db().sql;

  if (!idRaw) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      const projectId = uuid(new URL(req.url).searchParams.get('project'), 'project id');
      return json({ panels: await loadPanels(projectId) });
    }
    if (req.method === 'POST') {
      const a = await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['project_id', ...FIELDS, 'circuits']);
      const projectId = uuid(b.project_id, 'project id');
      const [proj] = await sql<{ id: string }>`select id from projects where id = ${projectId} and archived_at is null`;
      if (!proj) throw notFound('That project');
      const d = await details(b, projectId);
      if (!d.name) throw new HttpError(400, 'Panel ID is required.');
      const list = 'circuits' in b ? circuits(b.circuits, (d.positions as number | null) ?? null) : [];
      const id = await transaction(async (q) => {
        const cols = Object.keys(d);
        const { rows } = await q(
          `insert into panels (project_id, ${cols.join(', ')}, created_by, created_by_name)
           values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, $${cols.length + 3}) returning id`,
          [projectId, ...cols.map((k) => d[k]), a.id, a.name]);
        await writeCircuits(q, rows[0].id, list);
        return rows[0].id as string;
      });
      return json({ panel: (await loadPanels(null, id))[0] }, 201);
    }
    throw methodNotAllowed();
  }

  const id = uuid(idRaw, 'panel id');
  const [cur] = await loadPanels(null, id);
  if (!cur) throw notFound('That panel');

  if (req.method === 'GET') {
    await requireRole('viewer');
    return json({ panel: cur });
  }
  if (req.method === 'PATCH') {
    await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, [...FIELDS, 'circuits']);
    const d = await details(b, cur.project_id);
    const positions = 'positions' in d ? (d.positions as number | null) : cur.positions;
    const list = 'circuits' in b ? circuits(b.circuits, positions) : null;
    await transaction(async (q) => {
      const cols = Object.keys(d);
      if (cols.length) await q(`update panels set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...cols.map((k) => d[k])]);
      else await q(`update panels set updated_at = now() where id = $1`, [id]);
      if (list) await writeCircuits(q, id, list);
    });
    return json({ panel: (await loadPanels(null, id))[0] });
  }
  if (req.method === 'DELETE') {
    await requireRole('estimator');
    await sql`delete from panels where id = ${id}`;
    return json({ ok: true });
  }
  throw methodNotAllowed();
});
