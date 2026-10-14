import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { oneOf, onlyKeys, str, uuid } from './_lib/validate.ts';
import { getBytes, keys, putBytes } from './_lib/blobs.ts';
import { applyBatch, listDetections } from './_lib/detections.ts';

const SHEET_SELECT = `
  select s.id, s.project_id, s.file_id, s.page, s.number, s.title, s.kind, s.floor, s.scale,
         s.page_width_pt, s.page_height_pt, s.rotation, s.count_enabled, s.count_status,
         s.read_source, s.title_unsure, s.version,
         (select count(*) from detections d where d.sheet_id = s.id and d.status <> 'rejected')::int as detection_count,
         (select count(*) from detections d where d.sheet_id = s.id and d.status = 'unreviewed'
             and d.confidence is not null and d.confidence < p.review_threshold)::int as flagged_count
    from sheets s join projects p on p.id = s.project_id`;

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req); // ['sheets', id?, sub?, sub2?]
  const pool = db().pool;

  // GET /api/sheets?project=ID
  if (!seg[1]) {
    if (req.method !== 'GET') throw methodNotAllowed();
    await requireRole('viewer');
    const project = uuid(new URL(req.url).searchParams.get('project'), 'project id');
    const r = await pool.query(
      `${SHEET_SELECT} where s.project_id = $1 and s.superseded_at is null
        order by s.number nulls last, s.page`,
      [project],
    );
    return json({ sheets: r.rows });
  }

  const id = uuid(seg[1], 'sheet id');
  const sub = seg[2];

  if (!sub) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      const r = await pool.query(`${SHEET_SELECT} where s.id = $1`, [id]);
      if (!r.rows[0]) throw notFound('That sheet');
      return json({ sheet: r.rows[0] });
    }
    if (req.method === 'PATCH') {
      await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['number', 'title', 'kind', 'floor', 'scale', 'count_enabled', 'count_status']);
      const cur = await pool.query(`select number, title, kind, floor, scale, count_enabled, count_status, read_source from sheets where id = $1`, [id]);
      const c = cur.rows[0];
      if (!c) throw notFound('That sheet');
      const edited = ['number', 'title'].some((k) => k in b);
      const next = {
        number: 'number' in b ? str(b.number, 'Sheet number', { max: 60 }) : c.number,
        title: 'title' in b ? str(b.title, 'Sheet title', { max: 200 }) : c.title,
        kind: 'kind' in b ? oneOf(b.kind, ['floor_plan', 'legend', 'site_plan', 'schedule', 'other'] as const, 'Kind') : c.kind,
        floor: 'floor' in b ? str(b.floor, 'Floor', { max: 60 }) : c.floor,
        scale: 'scale' in b ? str(b.scale, 'Scale', { max: 60 }) : c.scale,
        count_enabled: 'count_enabled' in b ? b.count_enabled === true : c.count_enabled,
        count_status: 'count_status' in b ? oneOf(b.count_status, ['not_counted', 'needs_review', 'reviewed'] as const, 'Status') : c.count_status,
      };
      // A hand-edited number or title is no longer "unsure"; it is a manual read.
      await pool.query(
        `update sheets set number = $2, title = $3, kind = $4, floor = $5, scale = $6, count_enabled = $7, count_status = $8,
                read_source = case when $9::boolean then 'manual' else read_source end,
                title_unsure = case when $9::boolean then false else title_unsure end
          where id = $1`,
        [id, next.number, next.title, next.kind, next.floor, next.scale, next.count_enabled, next.count_status, edited],
      );
      const r = await pool.query(`${SHEET_SELECT} where s.id = $1`, [id]);
      return json({ sheet: r.rows[0] });
    }
    throw methodNotAllowed();
  }

  if (sub === 'thumb') {
    if (req.method === 'PUT') {
      await requireRole('estimator');
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 400_000) throw new HttpError(413, 'That thumbnail is empty or too large.');
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new HttpError(400, 'Thumbnails must be JPEG images.');
      const ex = await pool.query(`select 1 from sheets where id = $1`, [id]);
      if (!ex.rows[0]) throw notFound('That sheet');
      await putBytes(keys.thumb(id), bytes, 'image/jpeg');
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      await requireRole('viewer');
      const bytes = await getBytes(keys.thumb(id));
      if (!bytes) throw notFound('That thumbnail');
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
    }
    throw methodNotAllowed();
  }

  if (sub === 'detections') {
    if (!seg[3] && req.method === 'GET') {
      await requireRole('viewer');
      return listDetections(id, new URL(req.url).searchParams.get('since'));
    }
    if (seg[3] === 'batch' && req.method === 'POST') {
      const actor = await requireRole('estimator');
      return applyBatch(req, id, actor);
    }
    throw methodNotAllowed();
  }

  throw new HttpError(404, 'That address was not found.');
});
