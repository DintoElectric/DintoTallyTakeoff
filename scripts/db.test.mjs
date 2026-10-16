// Runs the real migration and the trickiest queries against an in-memory Postgres (PGlite).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();
const dir = 'netlify/database/migrations';
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(`${dir}/${f}`, 'utf8'));

const u = '11111111-1111-4111-8111-111111111111';
const p = (await db.query(`insert into projects (name, created_by, created_by_name) values ('P','u1','John') returning id`)).rows[0];
const f = (await db.query(`insert into drawing_files (project_id,file_name,size_bytes,chunk_count,uploaded_by,upload_status) values ($1,'a.pdf',100,1,'u1','ready') returning id`, [p.id])).rows[0];
const s = (await db.query(`insert into sheets (project_id,file_id,page,number,page_width_pt,page_height_pt,count_enabled) values ($1,$2,1,'E-101',792,612,true) returning id`, [p.id, f.id])).rows[0];
const it = (await db.query(`insert into item_types (code,name,created_by) values ('A','Troffer','u1') returning id`)).rows[0];

// Same statements as detections.ts
await db.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,status,created_by) values ($1,$2,$3,0.5,0.5,'manual','confirmed','u1') on conflict (id) do nothing`, [u, s.id, it.id]);
const dup = await db.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,status,created_by) values ($1,$2,$3,0.5,0.5,'manual','confirmed','u1') on conflict (id) do nothing returning id`, [u, s.id, it.id]);
assert.equal(dup.rows.length, 0, 'resending an add must be a no-op');
await db.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,status,confidence,created_by) values ('22222222-2222-4222-8222-222222222222',$1,$2,0.2,0.2,'auto','unreviewed',0.6,'u1')`, [s.id, it.id]);

const totals = await db.query(
  `select d.item_type_id, count(*)::int as n,
          (count(*) filter (where d.status = 'unreviewed' and d.confidence is not null and d.confidence < p.review_threshold))::int as flagged
     from detections d join sheets s on s.id = d.sheet_id join projects p on p.id = s.project_id
    where d.sheet_id = $1 and d.status <> 'rejected' group by d.item_type_id`, [s.id]);
assert.deepEqual(totals.rows[0].n, 2); assert.equal(totals.rows[0].flagged, 1);

const list = await db.query(`
  select p.id, to_char(p.bid_due, 'YYYY-MM-DD') as bid_due,
         coalesce(s.sheet_count, 0)::int as sheet_count, coalesce(d.n, 0)::int as items_counted,
         (case when coalesce(s.enabled, 0) = 0 then 0 else s.reviewed::float / s.enabled end)::float as progress
    from projects p
    left join lateral (select count(*) as sheet_count, count(*) filter (where count_enabled) as enabled,
         count(*) filter (where count_enabled and count_status = 'reviewed') as reviewed
         from sheets where project_id = p.id and superseded_at is null) s on true
    left join lateral (select count(*) as n from detections de join sheets sh on sh.id = de.sheet_id
         where sh.project_id = p.id and sh.superseded_at is null and de.status <> 'rejected') d on true
   where p.archived_at is null and ($1::uuid is null or p.id = $1::uuid)`, [null]);
assert.equal(list.rows[0].items_counted, 2); assert.equal(list.rows[0].sheet_count, 1);

// cascade: deleting the project removes files/sheets/detections
await db.query(`delete from projects where id = $1`, [p.id]);
assert.equal((await db.query(`select count(*)::int n from detections`)).rows[0].n, 0);
// coordinate check constraint
await assert.rejects(db.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,created_by) values (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),2,0,'manual','u')`));
// items may share a code when the description differs; code + description stays unique
await db.query(`insert into item_types (code,name,created_by) values ('D9','4'' SURFACE/WET','u1')`);
await db.query(`insert into item_types (code,name,created_by) values ('D9','4'' SURFACE/WET/EM/OPEN','u1')`);
await assert.rejects(db.query(`insert into item_types (code,name,created_by) values ('d9','4'' surface/wet','u1')`), /unique|duplicate/i);
// exclusion zones: a nullable jsonb column on sheets; null means automatic
const sh = (await db.query(`insert into projects (name, created_by) values ('Z','u') returning id`)).rows[0];
const fl = (await db.query(`insert into drawing_files (project_id,file_name,size_bytes,chunk_count,uploaded_by) values ($1,'z.pdf',1,1,'u') returning id`, [sh.id])).rows[0];
const zs = (await db.query(`insert into sheets (project_id,file_id,page,page_width_pt,page_height_pt) values ($1,$2,1,100,100) returning id, exclusion_zones`, [sh.id, fl.id])).rows[0];
assert.equal(zs.exclusion_zones, null);
await db.query(`update sheets set exclusion_zones = $2::jsonb where id = $1`, [zs.id, JSON.stringify([{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.1 }] }])]);
assert.equal((await db.query(`select exclusion_zones from sheets where id = $1`, [zs.id])).rows[0].exclusion_zones[0].points.length, 3);
await db.query(`update sheets set exclusion_zones = $2::jsonb where id = $1`, [zs.id, null]);
assert.equal((await db.query(`select exclusion_zones from sheets where id = $1`, [zs.id])).rows[0].exclusion_zones, null);
console.log('db.test OK');

// named areas use the areas table from the first migration
{
  const { PGlite: P } = await import('@electric-sql/pglite');
  const d2 = new P();
  for (const f of readdirSync(dir).sort()) await d2.exec(readFileSync(`${dir}/${f}`, 'utf8'));
  const pr = (await d2.query(`insert into projects (name, created_by) values ('P','u') returning id`)).rows[0];
  const fl = (await d2.query(`insert into drawing_files (project_id,file_name,size_bytes,chunk_count,uploaded_by) values ($1,'a.pdf',1,1,'u') returning id`, [pr.id])).rows[0];
  const s1 = (await d2.query(`insert into sheets (project_id,file_id,page,page_width_pt,page_height_pt) values ($1,$2,1,100,100) returning id`, [pr.id, fl.id])).rows[0];
  const s2 = (await d2.query(`insert into sheets (project_id,file_id,page,page_width_pt,page_height_pt) values ($1,$2,2,100,100) returning id`, [pr.id, fl.id])).rows[0];
  const pts = JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
  await d2.query(`insert into areas (sheet_id, name, polygon, created_by) values ($1,'Lab A',$3::jsonb,'u'), ($2,'lab a',$3::jsonb,'u')`, [s1.id, s2.id, pts]);
  // canonical spelling lookup, as the endpoint does it
  const can = await d2.query(`select a.name from areas a join sheets s on s.id = a.sheet_id where s.project_id = $1 and lower(a.name) = lower($2) order by a.name limit 1`, [pr.id, 'LAB A']);
  assert.equal(can.rows[0].name, 'Lab A');
  // renaming by name changes every polygon of that name in the project
  await d2.query(`update areas set name = $3 where lower(name) = lower($2) and sheet_id in (select id from sheets where project_id = $1)`, [pr.id, 'Lab A', 'Laboratory A']);
  assert.equal((await d2.query(`select count(*)::int n from areas where name = 'Laboratory A'`)).rows[0].n, 2);
  const list = await d2.query(`select id, sheet_id, name, polygon as points from areas where sheet_id = $1 order by lower(name), id`, [s1.id]);
  assert.equal(list.rows[0].points.length, 3);
  console.log('areas OK');
}

// removing one sheet: its counts and areas go, a "replaces" link is cleared, the other sheets of the file stay
{
  const { PGlite: P } = await import('@electric-sql/pglite');
  const d3 = new P();
  for (const f of readdirSync(dir).sort()) await d3.exec(readFileSync(`${dir}/${f}`, 'utf8'));
  const pr = (await d3.query(`insert into projects (name, created_by) values ('P','u') returning id`)).rows[0];
  const fl = (await d3.query(`insert into drawing_files (project_id,file_name,size_bytes,chunk_count,uploaded_by) values ($1,'a.pdf',1,1,'u') returning id`, [pr.id])).rows[0];
  const mk = async (page) => (await d3.query(`insert into sheets (project_id,file_id,page,page_width_pt,page_height_pt) values ($1,$2,$3,100,100) returning id`, [pr.id, fl.id, page])).rows[0].id;
  const s1 = await mk(1), s2 = await mk(2);
  await d3.query(`update sheets set replaces_sheet_id = $1 where id = $2`, [s1, s2]);
  const it = (await d3.query(`insert into item_types (code,name,unit,created_by) values ('X','x','EA','u') returning id`)).rows[0];
  await d3.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,status,created_by) values (gen_random_uuid(),$1,$2,0.5,0.5,'manual','confirmed','u')`, [s1, it.id]);
  await d3.query(`insert into areas (sheet_id,name,polygon,created_by) values ($1,'A','[]'::jsonb,'u')`, [s1]);
  // the same statements the endpoint runs
  await d3.query(`update sheets set replaces_sheet_id = null where replaces_sheet_id = $1`, [s1]);
  await d3.query(`delete from sheets where id = $1`, [s1]);
  assert.equal((await d3.query(`select count(*)::int n from detections`)).rows[0].n, 0);
  assert.equal((await d3.query(`select count(*)::int n from areas`)).rows[0].n, 0);
  assert.equal((await d3.query(`select count(*)::int n from sheets where file_id = $1`, [fl.id])).rows[0].n, 1);
  await d3.query(`delete from sheets where id = $1`, [s2]);
  assert.equal((await d3.query(`select count(*)::int n from sheets where file_id = $1`, [fl.id])).rows[0].n, 0); // last sheet: the endpoint now removes the file
  await d3.query(`delete from drawing_files where id = $1`, [fl.id]);
  console.log('sheet delete OK');
}
