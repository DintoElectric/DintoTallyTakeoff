-- Item libraries belong to a project. Until now there was one library shared by every project.
--
-- Existing data is split by use:
--   * an item that counts use goes to the project that counted it (an item counted in several projects is copied,
--     and each project's counts are pointed at its own copy);
--   * when the database has a single project, everything else goes to it;
--   * anything else stays "unassigned" (project_id null) and can be added to a project from its library screen.
alter table item_categories add column if not exists project_id uuid references projects(id) on delete cascade;
alter table item_types      add column if not exists project_id uuid references projects(id) on delete cascade;

-- Names and codes only have to be unique within a project.
alter table item_categories drop constraint if exists item_categories_name_key;
drop index if exists item_types_code_name_uniq;
create unique index if not exists item_categories_project_name_uniq
  on item_categories (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create unique index if not exists item_types_project_code_name_uniq
  on item_types (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(code), lower(name));
create index if not exists item_types_project_idx on item_types (project_id);
create index if not exists item_categories_project_idx on item_categories (project_id);

do $$
declare
  it record; pr record; cc record;
  first_p uuid; clone uuid; catid uuid; only_p uuid; n_projects int;
begin
  -- 1. Items that counts use.
  for it in select * from item_types where project_id is null order by created_at, id loop
    first_p := null;
    for pr in
      select distinct s.project_id as pid from detections d join sheets s on s.id = d.sheet_id
       where d.item_type_id = it.id order by pid
    loop
      if first_p is null then
        first_p := pr.pid;
        update item_types set project_id = first_p where id = it.id;
      else
        -- A copy for the next project. Its counts move to it; teach-by-example samples stay with the first copy.
        insert into item_types (code, name, spec, category_id, unit, detection_mode, marker_shape, marker_glyph, created_by, created_at, project_id)
        values (it.code, it.name, it.spec, it.category_id, it.unit, 'manual', it.marker_shape, it.marker_glyph, it.created_by, it.created_at, pr.pid)
        returning id into clone;
        update detections set item_type_id = clone
         where item_type_id = it.id and sheet_id in (select id from sheets where project_id = pr.pid);
      end if;
    end loop;
  end loop;

  -- 2. One project: the rest of the library is its library.
  select count(*) into n_projects from projects;
  if n_projects = 1 then
    select id into only_p from projects;
    update item_types set project_id = only_p where project_id is null;
    update item_categories set project_id = only_p where project_id is null;
  end if;

  -- 3. Categories: each project gets its own copy of the categories its items use.
  for cc in
    select distinct i.project_id as pid, i.category_id as cid
      from item_types i join item_categories c on c.id = i.category_id
     where i.project_id is not null and c.project_id is null
  loop
    catid := null;
    select id into catid from item_categories
     where project_id = cc.pid and lower(name) = (select lower(name) from item_categories where id = cc.cid);
    if catid is null then
      insert into item_categories (name, sort, project_id)
      select name, sort, cc.pid from item_categories where id = cc.cid returning id into catid;
    end if;
    update item_types set category_id = catid where project_id = cc.pid and category_id = cc.cid;
  end loop;
end $$;
