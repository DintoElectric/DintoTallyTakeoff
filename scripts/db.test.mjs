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
console.log('db.test OK');
