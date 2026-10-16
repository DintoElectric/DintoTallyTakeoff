import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { dateOnly, num, oneOf, onlyKeys, reqStr, str, uuid } from './_lib/validate.ts';
import { chunkKeys, deleteKeys, keys } from './_lib/blobs.ts';
import type { ExportData } from '../../shared/types.ts';
import { areaNames, assignAreas, type AreaRow } from '../../shared/areas.ts';

async function listProjects(id: string | null) {
  const sql = db().sql;
  return sql<any>`
    select p.id, p.name, p.location, p.client,
           to_char(p.bid_due, 'YYYY-MM-DD') as bid_due,
           p.status, p.review_threshold, p.created_by_name, p.created_at,
           coalesce(s.sheet_count, 0)::int as sheet_count,
           coalesce(d.n, 0)::int as items_counted,
           (case when coalesce(s.enabled, 0) = 0 then 0
                 else s.reviewed::float / s.enabled end)::float as progress
      from projects p
      left join lateral (
        select count(*) as sheet_count,
               count(*) filter (where count_enabled) as enabled,
               count(*) filter (where count_enabled and count_status = 'reviewed') as reviewed
          from sheets where project_id = p.id and superseded_at is null) s on true
      left join lateral (
        select count(*) as n
          from detections de join sheets sh on sh.id = de.sheet_id
         where sh.project_id = p.id and sh.superseded_at is null and de.status <> 'rejected') d on true
     where p.archived_at is null and (${id}::uuid is null or p.id = ${id}::uuid)
     order by p.created_at desc`;
}

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req); // ['projects', id?, sub?]
  const id = seg[1] ? uuid(seg[1], 'project id') : null;
  const sub = seg[2];
  const sql = db().sql;

  // ---- collection ----
  if (!id) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      return json({ projects: await listProjects(null) });
    }
    if (req.method === 'POST') {
      const actor = await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'location', 'client', 'bid_due']);
      const name = reqStr(b.name, 'Project name');
      const [row] = await sql<{ id: string }>`
        insert into projects (name, location, client, bid_due, created_by, created_by_name)
        values (${name}, ${str(b.location, 'Location')}, ${str(b.client, 'Client')},
                ${dateOnly(b.bid_due, 'Bid due')}, ${actor.id}, ${actor.name})
        returning id`;
      const [project] = await listProjects(row.id);
      return json({ project }, 201);
    }
    throw methodNotAllowed();
  }

  // ---- one project ----
  if (!sub) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      const [project] = await listProjects(id);
      if (!project) throw notFound('That project');
      return json({ project });
    }
    if (req.method === 'PATCH') {
      await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'location', 'client', 'bid_due', 'status', 'review_threshold']);
      const [cur] = await sql<any>`select name, location, client, to_char(bid_due,'YYYY-MM-DD') as bid_due, status, review_threshold from projects where id = ${id} and archived_at is null`;
      if (!cur) throw notFound('That project');
      const name = 'name' in b ? reqStr(b.name, 'Project name') : cur.name;
      const location = 'location' in b ? str(b.location, 'Location') : cur.location;
      const client = 'client' in b ? str(b.client, 'Client') : cur.client;
      const bidDue = 'bid_due' in b ? dateOnly(b.bid_due, 'Bid due') : cur.bid_due;
      const status = 'status' in b ? oneOf(b.status, ['splitting', 'counting', 'in_review', 'exported'] as const, 'Status') : cur.status;
      const thr = 'review_threshold' in b ? num(b.review_threshold, 'Review threshold', 0, 1) : cur.review_threshold;
      await sql`update projects set name = ${name}, location = ${location}, client = ${client},
                bid_due = ${bidDue}, status = ${status}, review_threshold = ${thr}, updated_at = now()
                where id = ${id}`;
      const [project] = await listProjects(id);
      return json({ project });
    }
    if (req.method === 'DELETE') {
      await requireRole('admin');
      // Collect exact blob keys first, then delete rows (cascade), then delete the blobs.
      const files = await sql<{ id: string; chunk_count: number }>`select id, chunk_count from drawing_files where project_id = ${id}`;
      const sheets = await sql<{ id: string }>`select id from sheets where project_id = ${id}`;
      await sql`delete from projects where id = ${id}`;
      const blobKeys = [
        ...files.flatMap((f) => chunkKeys(f.id, f.chunk_count)),
        ...sheets.map((s) => keys.thumb(s.id)),
      ];
      await deleteKeys(blobKeys); // already-gone keys are fine
      return json({ ok: true });
    }
    throw methodNotAllowed();
  }

  // ---- per-sheet, per-item counts (cheap; used by the workspace for "All sheets") ----
  if (sub === 'counts' && req.method === 'GET') {
    await requireRole('viewer');
    const rows = await sql<any>`
      select d.sheet_id, d.item_type_id, count(*)::int as n,
             (count(*) filter (where d.status = 'unreviewed' and d.confidence is not null and d.confidence < p.review_threshold))::int as flagged
        from detections d join sheets s on s.id = d.sheet_id join projects p on p.id = s.project_id
       where s.project_id = ${id} and s.superseded_at is null and d.status <> 'rejected'
       group by d.sheet_id, d.item_type_id`;
    return json({ counts: rows });
  }

  // ---- counts per named area (additive by name, across sheets) ----
  if (sub === 'area-counts' && req.method === 'GET') {
    await requireRole('viewer');
    const [proj] = await sql<{ review_threshold: number }>`select review_threshold from projects where id = ${id} and archived_at is null`;
    if (!proj) throw notFound('That project');
    const areas = await sql<any>`
      select a.id, a.sheet_id, a.name, a.polygon as points from areas a join sheets s on s.id = a.sheet_id
       where s.project_id = ${id} and s.superseded_at is null order by lower(a.name), a.id`;
    if (areas.length === 0) return json({ names: [], rows: [] });
    const dets = await sql<any>`
      select d.sheet_id, d.item_type_id, d.x, d.y,
             (d.status = 'unreviewed' and d.confidence is not null and d.confidence < ${proj.review_threshold}) as flagged
        from detections d join sheets s on s.id = d.sheet_id
       where s.project_id = ${id} and s.superseded_at is null and d.status <> 'rejected'`;
    return json({ names: areaNames(areas), rows: assignAreas(dets, areas as AreaRow[]) });
  }

  // ---- export data: everything an export needs, read at click time ----
  if (sub === 'export-data' && req.method === 'GET') {
    await requireRole('viewer');
    const [project] = await listProjects(id);
    if (!project) throw notFound('That project');
    const sheets = await sql<any>`
      select s.id, s.project_id, s.file_id, s.page, s.number, s.title, s.kind, s.floor, s.scale,
             s.page_width_pt, s.page_height_pt, s.rotation, s.count_enabled, s.count_status,
             s.read_source, s.title_unsure, s.version,
             (select count(*) from detections d where d.sheet_id = s.id and d.status <> 'rejected')::int as detection_count,
             0::int as flagged_count
        from sheets s where s.project_id = ${id} and s.superseded_at is null
       order by s.number nulls last, s.page`;
    const items = await sql<any>`
      select i.id, i.code, i.name, i.spec, i.category_id, i.unit, i.detection_mode, i.marker_shape, i.marker_glyph,
             0::int as sample_count, 0::int as detection_count
        from item_types i where i.project_id = ${id} order by i.code`;
    const categories = await sql<any>`select id, name, sort from item_categories where project_id = ${id} order by sort, name`;
    const counts = await sql<any>`
      select d.sheet_id, d.item_type_id, count(*)::int as n,
             (count(*) filter (where d.status = 'unreviewed' and d.confidence is not null and d.confidence < ${project.review_threshold}))::int as flagged
        from detections d join sheets s on s.id = d.sheet_id
       where s.project_id = ${id} and s.superseded_at is null and d.status <> 'rejected'
       group by d.sheet_id, d.item_type_id`;
    const detections = await sql<any>`
      select d.id, d.sheet_id, d.item_type_id, d.x, d.y, d.bbox, d.confidence, d.source, d.status,
             d.created_by_name, d.confirmed_by_name
        from detections d join sheets s on s.id = d.sheet_id
       where s.project_id = ${id} and s.superseded_at is null and d.status <> 'rejected'
       order by s.number nulls last, d.created_at`;
    const areas = await sql<any>`
      select a.id, a.sheet_id, a.name, a.polygon as points from areas a join sheets s on s.id = a.sheet_id
       where s.project_id = ${id} and s.superseded_at is null order by lower(a.name), a.id`;
    const out: ExportData = { project, sheets, items, categories, counts, detections, areas };
    return json(out);
  }

  throw new HttpError(404, 'That address was not found.');
});
