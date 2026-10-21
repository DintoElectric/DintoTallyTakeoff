import type { Actor } from './auth.ts';
import { db, transaction } from './db.ts';
import { HttpError, json, notFound, readJson } from './http.ts';
import { num, oneOf, onlyKeys, uuid } from './validate.ts';
import { BATCH_MAX_OPS } from '../../../shared/limits.ts';
import type { Detection } from '../../../shared/types.ts';

const CEILINGS = ['drop', 'sheetrock', 'open'] as const;
const DET_COLS = `d.id, d.sheet_id, d.item_type_id, d.x, d.y, d.bbox, d.confidence, d.source, d.status, d.ceiling,
                  d.created_by_name, d.confirmed_by_name`;

export async function sheetTotals(sheetId: string) {
  const r = await db().pool.query(
    `select d.item_type_id, count(*)::int as n,
            (count(*) filter (where d.status = 'unreviewed' and d.confidence is not null and d.confidence < p.review_threshold))::int as flagged
       from detections d
       join sheets s on s.id = d.sheet_id
       join projects p on p.id = s.project_id
      where d.sheet_id = $1 and d.status <> 'rejected'
      group by d.item_type_id`,
    [sheetId],
  );
  return r.rows as { item_type_id: string; n: number; flagged: number }[];
}

export async function listDetections(sheetId: string, sinceRaw: string | null) {
  const sql = db().sql;
  const [sheet] = await sql<{ version: number }>`select version from sheets where id = ${sheetId}`;
  if (!sheet) throw notFound('That sheet');
  const since = sinceRaw === null ? null : Number(sinceRaw);
  if (since !== null && Number.isFinite(since) && since === sheet.version) {
    return json({ version: sheet.version, unchanged: true });
  }
  const r = await db().pool.query(
    `select ${DET_COLS} from detections d where d.sheet_id = $1 and d.status <> 'rejected' order by d.created_at, d.id`,
    [sheetId],
  );
  // Who edited last, so the workspace can show "Also open: {name}" (spec 2.10).
  const le = await db().pool.query(
    `select coalesce(confirmed_by, created_by) as id, coalesce(confirmed_by_name, created_by_name) as name, updated_at
       from detections where sheet_id = $1 order by updated_at desc limit 1`,
    [sheetId],
  );
  const last = le.rows[0] ?? null;
  return json({
    version: sheet.version,
    detections: r.rows as Detection[],
    totals: await sheetTotals(sheetId),
    last_editor: last ? { id: last.id, name: last.name, at: last.updated_at } : null,
  });
}

function validBbox(v: unknown) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'A box must have x, y, w and h.');
  const o = v as Record<string, unknown>;
  onlyKeys(o, ['x', 'y', 'w', 'h']);
  return { x: num(o.x, 'Box x', 0, 1), y: num(o.y, 'Box y', 0, 1), w: num(o.w, 'Box width', 0, 1), h: num(o.h, 'Box height', 0, 1) };
}

/**
 * Autosave batch: up to 500 operations applied in one transaction.
 * Safe to resend: add uses the client-supplied id with ON CONFLICT DO NOTHING,
 * update and delete are naturally repeatable (spec 2.10).
 */
export async function applyBatch(req: Request, sheetId: string, actor: Actor) {
  const b = await readJson(req);
  onlyKeys(b, ['ops']);
  if (!Array.isArray(b.ops) || b.ops.length === 0) throw new HttpError(400, 'There was nothing to save.');
  if (b.ops.length > BATCH_MAX_OPS) throw new HttpError(400, `Send at most ${BATCH_MAX_OPS} changes at a time.`);

  const version = await transaction(async (q) => {
    // Lock the sheet row so concurrent batches serialize and versions stay ordered.
    const locked = await q(`select id, project_id from sheets where id = $1 for update`, [sheetId]);
    if (!locked.rows[0]) throw notFound('That sheet');
    const projectId = locked.rows[0].project_id as string;
    // Each project counts with its own library: an item from another project cannot be placed here.
    const ownItem = async (itemId: string) => {
      const r = await q(`select 1 from item_types where id = $1 and project_id = $2`, [itemId, projectId]);
      if (!r.rows[0]) throw new HttpError(400, "That item belongs to another project's library.");
      return itemId;
    };

    let autoAdded = false;
    let manualAdded = false;
    for (const raw of b.ops as Record<string, unknown>[]) {
      const op = oneOf(raw.op, ['add', 'update', 'delete'] as const, 'Operation');
      if (op === 'add') {
        onlyKeys(raw, ['op', 'detection']);
        const d = (raw.detection ?? {}) as Record<string, unknown>;
        onlyKeys(d, ['id', 'item_type_id', 'x', 'y', 'bbox', 'confidence', 'source', 'status', 'ceiling']);
        const source = oneOf(d.source, ['auto', 'manual'] as const, 'Source');
        // Manual placements are confirmed with no confidence; auto detections start unreviewed.
        const status = source === 'manual' ? 'confirmed' : 'unreviewed';
        const confidence = source === 'manual' ? null : d.confidence == null ? null : num(d.confidence, 'Confidence', 0, 1);
        const ins = await q(
          `insert into detections (id, sheet_id, item_type_id, x, y, bbox, confidence, source, status,
                                   created_by, created_by_name, confirmed_by, confirmed_by_name, ceiling)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (id) do nothing returning id`,
          [
            uuid(d.id, 'detection id'),
            sheetId,
            await ownItem(uuid(d.item_type_id, 'item id')),
            num(d.x, 'x', 0, 1),
            num(d.y, 'y', 0, 1),
            validBbox(d.bbox) ? JSON.stringify(validBbox(d.bbox)) : null,
            confidence,
            source,
            status,
            actor.id,
            actor.name,
            source === 'manual' ? actor.id : null,
            source === 'manual' ? actor.name : null,
            d.ceiling == null ? null : oneOf(d.ceiling, CEILINGS, 'Ceiling'),
          ],
        );
        if (ins.rows[0]) (source === 'auto' ? (autoAdded = true) : (manualAdded = true));
      } else if (op === 'update') {
        onlyKeys(raw, ['op', 'id', 'fields']);
        const id = uuid(raw.id, 'detection id');
        const f = (raw.fields ?? {}) as Record<string, unknown>;
        onlyKeys(f, ['item_type_id', 'status', 'x', 'y', 'ceiling']);
        const sets: string[] = [];
        const params: unknown[] = [id, sheetId];
        const add = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ('item_type_id' in f) add('item_type_id', await ownItem(uuid(f.item_type_id, 'item id')));
        if ('x' in f) add('x', num(f.x, 'x', 0, 1));
        if ('y' in f) add('y', num(f.y, 'y', 0, 1));
        if ('ceiling' in f) add('ceiling', f.ceiling == null ? null : oneOf(f.ceiling, CEILINGS, 'Ceiling'));
        if ('status' in f) {
          const st = oneOf(f.status, ['unreviewed', 'confirmed', 'rejected'] as const, 'Status');
          add('status', st);
          if (st === 'confirmed' || st === 'rejected') {
            add('confirmed_by', actor.id);
            add('confirmed_by_name', actor.name);
          }
        }
        if (sets.length) {
          await q(`update detections set ${sets.join(', ')}, updated_at = now() where id = $1 and sheet_id = $2`, params);
        }
      } else {
        onlyKeys(raw, ['op', 'id']);
        await q(`delete from detections where id = $1 and sheet_id = $2`, [uuid(raw.id, 'detection id'), sheetId]);
      }
    }
    const upd = await q(
      `update sheets set version = version + 1,
              count_status = case
                when $2::boolean then 'needs_review'                       -- a new auto-detection run
                when count_status = 'not_counted' and $3::boolean then 'needs_review'
                else count_status end
        where id = $1 returning version`,
      [sheetId, autoAdded, manualAdded],
    );
    return upd.rows[0].version as number;
  });

  const totals = await sheetTotals(sheetId);
  const [st] = await db().sql<{ count_status: string }>`select count_status from sheets where id = ${sheetId}`;
  return json({ version, totals, count_status: st?.count_status });
}

