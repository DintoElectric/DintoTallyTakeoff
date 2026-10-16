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

// ---- item libraries become per project: migrate legacy data, then the move/copy queries ----
{
  const { PGlite: P } = await import('@electric-sql/pglite');
  const files = readdirSync(dir).sort();
  const last = files.find((f) => /project_libraries/.test(f));
  assert.ok(last, 'the project_libraries migration exists');
  const seed = async (twoProjects) => {
    const d = new P();
    for (const f of files.filter((x) => x < last)) await d.exec(readFileSync(`${dir}/${f}`, 'utf8'));   // the database as it is today
    const proj = async (n) => (await d.query(`insert into projects (name, created_by) values ($1,'u') returning id`, [n])).rows[0].id;
    const pA = await proj('A'); const pB = twoProjects ? await proj('B') : null;
    const sheet = async (p, page) => {
      const fl = (await d.query(`insert into drawing_files (project_id,file_name,size_bytes,chunk_count,uploaded_by) values ($1,'f.pdf',1,1,'u') returning id`, [p])).rows[0].id;
      return (await d.query(`insert into sheets (project_id,file_id,page,page_width_pt,page_height_pt) values ($1,$2,$3,100,100) returning id`, [p, fl, page])).rows[0].id;
    };
    const sA = await sheet(pA, 1); const sB = pB ? await sheet(pB, 1) : null;
    const cat = (await d.query(`insert into item_categories (name, sort) values ('Recessed', 1) returning id`)).rows[0].id;
    await d.query(`insert into item_categories (name, sort) values ('Unused cat', 2)`);
    const item = async (code, name, c) => (await d.query(`insert into item_types (code,name,category_id,created_by) values ($1,$2,$3,'u') returning id`, [code, name, c])).rows[0].id;
    const onlyA = await item('A1', 'only counted in A', cat), both = await item('B2', 'counted in both', cat), unused = await item('C3', 'never counted', cat), plain = await item('D4', 'no category', null);
    const det = (s, i) => d.query(`insert into detections (id,sheet_id,item_type_id,x,y,source,status,created_by) values (gen_random_uuid(),$1,$2,0.5,0.5,'manual','confirmed','u')`, [s, i]);
    await det(sA, onlyA); await det(sA, both); if (sB) await det(sB, both);
    return { d, pA, pB, sA, sB, ids: { onlyA, both, unused, plain } };
  };

  // two projects
  const t = await seed(true);
  await t.d.exec(readFileSync(`${dir}/${last}`, 'utf8'));
  const items = (await t.d.query(`select id, code, project_id, category_id from item_types order by code, project_id`)).rows;
  const byCode = (c) => items.filter((i) => i.code === c);
  assert.equal(byCode('A1').length, 1); assert.equal(byCode('A1')[0].project_id, t.pA);                 // used in A only: goes to A
  assert.equal(byCode('B2').length, 2);                                                                  // used in both: one copy each
  assert.deepEqual(byCode('B2').map((i) => i.project_id).sort(), [t.pA, t.pB].sort());
  assert.equal(byCode('C3')[0].project_id, null); assert.equal(byCode('D4')[0].project_id, null);       // unused: unassigned, not lost
  // every count still points at an item of its own project
  const bad = await t.d.query(`select d.id from detections d join sheets s on s.id = d.sheet_id join item_types i on i.id = d.item_type_id where i.project_id is distinct from s.project_id`);
  assert.equal(bad.rows.length, 0, 'counts follow their project');
  assert.equal((await t.d.query(`select count(*)::int n from detections`)).rows[0].n, 3, 'no count lost');
  // categories: each project has its own "Recessed", used by its items
  const cats = (await t.d.query(`select id, name, project_id from item_categories where name = 'Recessed' order by project_id nulls last`)).rows;
  assert.equal(cats.filter((c) => c.project_id).length, 2);
  const a1 = byCode('A1')[0]; assert.equal(cats.find((c) => c.id === a1.category_id).project_id, t.pA);
  assert.equal(byCode('B2').filter((i) => cats.find((c) => c.id === i.category_id)?.project_id === i.project_id).length, 2);
  // the same code and description can now exist in two projects, but not twice in one
  await t.d.query(`insert into item_types (code,name,created_by,project_id) values ('A1','only counted in A','u',$1)`, [t.pB]);
  await assert.rejects(t.d.query(`insert into item_types (code,name,created_by,project_id) values ('a1','ONLY COUNTED IN A','u',$1)`, [t.pA]));
  await t.d.query(`insert into item_categories (name, sort, project_id) values ('Recessed', 9, $1)`.replace('$1', `'${t.pB}'`)).then(() => assert.fail('duplicate category name in one project')).catch(() => {});

  // claiming the unassigned items, and copying a library
  const { claimItems, copyLibrary } = await import('../netlify/functions/_lib/library.ts');
  const q = (text, params) => t.d.query(text, params);
  const claimed = await claimItems(q, t.pB, null);
  assert.deepEqual(claimed, { moved: 2, skipped: 0 });
  assert.equal((await t.d.query(`select count(*)::int n from item_types where project_id is null`)).rows[0].n, 0);
  const c3 = (await t.d.query(`select i.project_id, c.name as cat, c.project_id as cat_project from item_types i join item_categories c on c.id = i.category_id where i.code = 'C3'`)).rows[0];
  assert.equal(c3.project_id, t.pB); assert.equal(c3.cat, 'Recessed'); assert.equal(c3.cat_project, t.pB);   // its category came along, in B's own list
  const copied = await copyLibrary(q, t.pB, t.pA, 'u');
  assert.ok(copied.copied >= 2 && copied.skipped >= 1, JSON.stringify(copied));                            // A already had A1 and B2: skipped
  assert.deepEqual(await copyLibrary(q, t.pB, t.pA, 'u'), { copied: 0, skipped: copied.copied + copied.skipped });  // copying twice adds nothing
  const dst = (await t.d.query(`select i.code, c.project_id as cat_project from item_types i left join item_categories c on c.id = i.category_id where i.project_id = $1 and i.code = 'C3'`, [t.pA])).rows[0];
  assert.equal(dst.cat_project, t.pA);

  // one project: the whole library is its library
  const one = await seed(false);
  await one.d.exec(readFileSync(`${dir}/${last}`, 'utf8'));
  assert.equal((await one.d.query(`select count(*)::int n from item_types where project_id is null`)).rows[0].n, 0);
  assert.equal((await one.d.query(`select count(*)::int n from item_categories where project_id is null`)).rows[0].n, 0);
  assert.equal((await one.d.query(`select count(*)::int n from item_types where project_id = $1`, [one.pA])).rows[0].n, 4);
  // the list queries the items endpoint runs (with their casts), and the check that keeps counts inside their project
  const LIST = `select i.id, i.code, i.project_id from item_types i
     where ($1::uuid is null or i.id = $1::uuid) and ($2::uuid is null or i.project_id = $2::uuid) and ($3::boolean = false or i.project_id is null)
     order by i.code, i.created_at, i.id`;
  assert.equal((await one.d.query(LIST, [null, one.pA, false])).rows.length, 4);        // a project's library
  assert.equal((await one.d.query(LIST, [one.ids.plain, null, false])).rows.length, 1);  // one item by id
  assert.equal((await t.d.query(LIST, [null, null, true])).rows.length, 0);              // unassigned: none left after claiming
  const own = (item, project) => one.d.query(`select 1 from item_types where id = $1 and project_id = $2`, [item, project]);
  assert.equal((await own(one.ids.plain, one.pA)).rows.length, 1);
  assert.equal((await own(t.ids.onlyA, t.pB)).rows.length, 0, "A's item cannot be used on B's sheets");
  console.log('project libraries OK');
}
