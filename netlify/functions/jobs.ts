// Jobs: folders grouping a job's workspaces (projects) on the home page.
//   GET    /api/jobs            -> { jobs }            (viewer)
//   POST   /api/jobs { name }   -> { job }             (estimator)
//   PATCH  /api/jobs/:id { name } -> { job }          (estimator)
//   DELETE /api/jobs/:id        -> { ok }              (estimator; its projects stay, out of any folder)
import type { Context } from '@netlify/functions';
import { db } from './_lib/db.ts';
import { handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { requireRole } from './_lib/auth.ts';
import { onlyKeys, reqStr, uuid } from './_lib/validate.ts';

const SELECT = (sql: ReturnType<typeof db>['sql'], id: string | null) => sql<any>`
  select j.id, j.name, j.created_by_name, j.created_at,
         (select count(*) from projects p where p.job_id = j.id and p.archived_at is null)::int as project_count
    from jobs j
   where (${id}::uuid is null or j.id = ${id}::uuid)
   order by lower(j.name), j.created_at`;

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req);   // ['jobs', id?]
  const id = seg[1] ? uuid(seg[1], 'job id') : null;
  const sql = db().sql;
  if (!id) {
    if (req.method === 'GET') { await requireRole('viewer'); return json({ jobs: await SELECT(sql, null) }); }
    if (req.method === 'POST') {
      const actor = await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name']);
      const name = reqStr(b.name, 'Job name', 200);
      const [row] = await sql<{ id: string }>`insert into jobs (name, created_by, created_by_name) values (${name}, ${actor.id}, ${actor.name}) returning id`;
      const [job] = await SELECT(sql, row.id);
      return json({ job }, 201);
    }
    throw methodNotAllowed();
  }
  if (req.method === 'PATCH') {
    await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['name']);
    const name = reqStr(b.name, 'Job name', 200);
    const r = await sql`update jobs set name = ${name} where id = ${id} returning id`;
    if (!r.length) throw notFound('That job');
    const [job] = await SELECT(sql, id);
    return json({ job });
  }
  if (req.method === 'DELETE') {
    await requireRole('estimator');
    await sql`delete from jobs where id = ${id}`;   // its projects stay (job_id is set to null)
    return json({ ok: true });
  }
  throw methodNotAllowed();
});
