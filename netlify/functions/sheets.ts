import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { oneOf, onlyKeys, str, uuid } from './_lib/validate.ts';
import { getBytes, keys, putBytes } from './_lib/blobs.ts';
import { applyBatch, listDetections } from './_lib/detections.ts';
import { validateZones } from '../../shared/zones.ts';
import { cleanAreaName } from '../../shared/areas.ts';

const SHEET_SELECT = `
  select s.id, s.project_id, s.file_id, s.page, s.number, s.title, s.kind, s.floor, s.scale,
         s.page_width_pt, s.page_height_pt, s.rotation, s.count_enabled, s.count_status,
         s.read_source, s.title_unsure, s.version, s.exclusion_zones,
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
      onlyKeys(b, ['number', 'title', 'kind', 'floor', 'scale', 'count_enabled', 'count_status', 'exclusion_zones']);
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
      if ('exclusion_zones' in b) {
        // null puts the sheet back to automatic zones; a list (possibly empty) is the estimator's own.
        let zones: unknown = null;
        if (b.exclusion_zones !== null) {
          try { zones = validateZones(b.exclusion_zones); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Those zones are not valid.'); }
        }
        await pool.query(`update sheets set exclusion_zones = $2::jsonb where id = $1`, [id, zones === null ? null : JSON.stringify(zones)]);
      }
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

  // ----- named count areas: /api/sheets/:id/areas[/:areaId] -----
  if (sub === 'areas') {
    const areaId = seg[3] ? uuid(seg[3], 'area id') : null;
    const sheetRow = await pool.query(`select project_id from sheets where id = $1`, [id]);
    if (!sheetRow.rows[0]) throw notFound('That sheet');
    const projectId = sheetRow.rows[0].project_id as string;
    const name = (v: unknown) => { try { return cleanAreaName(v); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'That name is not valid.'); } };
    // "Lab A" and "lab a" are one area: use the spelling already in the project.
    const canonical = async (n: string) => {
      const r = await pool.query(`select a.name from areas a join sheets s on s.id = a.sheet_id where s.project_id = $1 and lower(a.name) = lower($2) order by a.name limit 1`, [projectId, n]);
      return (r.rows[0]?.name as string | undefined) ?? n;
    };
    const polygon = (v: unknown) => { try { return validateZones([{ points: v }])[0].points; } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'That outline is not valid.'); } };

    if (!areaId && req.method === 'GET') {
      await requireRole('viewer');
      const r = await pool.query(`select id, sheet_id, name, polygon as points from areas where sheet_id = $1 order by lower(name), id`, [id]);
      return json({ areas: r.rows });
    }
    if (!areaId && req.method === 'POST') {
      const actor = await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'points']);
      const n = await canonical(name(b.name));
      const pts = polygon(b.points);
      const r = await pool.query(`insert into areas (sheet_id, name, polygon, created_by) values ($1, $2, $3::jsonb, $4) returning id, sheet_id, name, polygon as points`, [id, n, JSON.stringify(pts), actor.id]);
      return json({ area: r.rows[0] }, 201);
    }
    if (areaId && req.method === 'PATCH') {
      await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'points']);
      const cur = await pool.query(`select name from areas where id = $1 and sheet_id = $2`, [areaId, id]);
      if (!cur.rows[0]) throw notFound('That area');
      if ('points' in b) await pool.query(`update areas set polygon = $3::jsonb where id = $1 and sheet_id = $2`, [areaId, id, JSON.stringify(polygon(b.points))]);
      if ('name' in b) {
        // The name is the identity of the area, so renaming changes every polygon of that name in the project.
        const n = await canonical(name(b.name));
        await pool.query(`update areas set name = $3 where lower(name) = lower($2) and sheet_id in (select id from sheets where project_id = $1)`, [projectId, cur.rows[0].name, n]);
      }
      const r = await pool.query(`select id, sheet_id, name, polygon as points from areas where id = $1`, [areaId]);
      return json({ area: r.rows[0] });
    }
    if (areaId && req.method === 'DELETE') {
      await requireRole('estimator');
      await pool.query(`delete from areas where id = $1 and sheet_id = $2`, [areaId, id]); // already gone is success
      return json({ ok: true });
    }
    throw methodNotAllowed();
  }

  throw new HttpError(404, 'That address was not found.');
});
