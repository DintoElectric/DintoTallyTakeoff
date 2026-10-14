import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { oneOf, onlyKeys, reqStr, str, uuid } from './_lib/validate.ts';
import { deleteKeys, keys } from './_lib/blobs.ts';

const SHAPES = ['rect', 'circle', 'square', 'diamond'] as const;

async function listItems(id: string | null) {
  return db().sql<any>`
    select i.id, i.code, i.name, i.spec, i.category_id, i.unit, i.detection_mode, i.marker_shape, i.marker_glyph,
           (select count(*) from item_samples s where s.item_type_id = i.id)::int as sample_count,
           (select count(*) from detections d where d.item_type_id = i.id and d.status <> 'rejected')::int as detection_count
      from item_types i
     where (${id}::uuid is null or i.id = ${id}::uuid)
     order by i.code`;
}

function glyph(v: unknown): string | null {
  const g = str(v, 'Symbol letters', { max: 2 });
  return g ? g.toUpperCase() : null;
}

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req);
  const sql = db().sql;

  if (!seg[1]) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      return json({ items: await listItems(null) });
    }
    if (req.method === 'POST') {
      const actor = await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['code', 'name', 'spec', 'category_id', 'unit', 'marker_shape', 'marker_glyph']);
      const code = reqStr(b.code, 'Code', 40);
      const name = reqStr(b.name, 'Description');
      const categoryId = b.category_id ? uuid(b.category_id, 'category id') : null;
      const [row] = await sql<{ id: string }>`
        insert into item_types (code, name, spec, category_id, unit, marker_shape, marker_glyph, created_by)
        values (${code}, ${name}, ${str(b.spec, 'Spec')}, ${categoryId}, ${str(b.unit, 'Unit', { max: 10 }) ?? 'EA'},
                ${b.marker_shape ? oneOf(b.marker_shape, SHAPES, 'Shape') : 'circle'}, ${glyph(b.marker_glyph)}, ${actor.id})
        returning id`;
      const [item] = await listItems(row.id);
      return json({ item }, 201);
    }
    throw methodNotAllowed();
  }

  const id = uuid(seg[1], 'item id');

  if (req.method === 'PATCH') {
    await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['code', 'name', 'spec', 'category_id', 'unit', 'detection_mode', 'marker_shape', 'marker_glyph']);
    const [cur] = await listItems(id);
    if (!cur) throw notFound('That item');
    const code = 'code' in b ? reqStr(b.code, 'Code', 40) : cur.code;
    const name = 'name' in b ? reqStr(b.name, 'Description') : cur.name;
    const spec = 'spec' in b ? str(b.spec, 'Spec') : cur.spec;
    const categoryId = 'category_id' in b ? (b.category_id ? uuid(b.category_id, 'category id') : null) : cur.category_id;
    const unit = 'unit' in b ? str(b.unit, 'Unit', { max: 10 }) ?? 'EA' : cur.unit;
    const shape = 'marker_shape' in b ? oneOf(b.marker_shape, SHAPES, 'Shape') : cur.marker_shape;
    const g = 'marker_glyph' in b ? glyph(b.marker_glyph) : cur.marker_glyph;
    const mode = 'detection_mode' in b ? oneOf(b.detection_mode, ['auto', 'manual'] as const, 'Detection') : cur.detection_mode;
    if (mode === 'auto' && cur.sample_count === 0) {
      throw new HttpError(400, 'Auto-detect needs at least one confirmed sample for this item first.');
    }
    await sql`update item_types set code = ${code}, name = ${name}, spec = ${spec}, category_id = ${categoryId},
              unit = ${unit}, marker_shape = ${shape}, marker_glyph = ${g}, detection_mode = ${mode} where id = ${id}`;
    const [item] = await listItems(id);
    return json({ item });
  }

  if (req.method === 'DELETE') {
    await requireRole('admin');
    const [cur] = await listItems(id);
    if (!cur) return json({ ok: true }); // already gone is success
    if (cur.detection_count > 0) {
      throw new HttpError(409, `${cur.detection_count} count${cur.detection_count === 1 ? ' uses' : 's use'} this item. Change them to another item first, then delete it.`);
    }
    const samples = await sql<{ id: string }>`select id from item_samples where item_type_id = ${id}`;
    await sql`delete from detections where item_type_id = ${id} and status = 'rejected'`;
    await sql`delete from item_types where id = ${id}`;
    await deleteKeys([keys.symbol(id), ...samples.map((s) => keys.sample(id, s.id))]);
    return json({ ok: true });
  }

  throw methodNotAllowed();
});
