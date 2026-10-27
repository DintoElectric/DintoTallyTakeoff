-- Panels and their circuits (read from panel schedules or typed in), and whether an item counts as a fixture or a device.
-- New tables and one new optional column only: nothing that already exists is changed.

-- Fixture (lighting) or device; empty means "decide from the item's category and name".
alter table item_types add column if not exists count_group text
  check (count_group is null or count_group in ('fixture', 'device'));

create table if not exists panels (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  sheet_id         uuid references sheets(id) on delete set null,   -- the sheet its schedule is on
  name             text not null,                                    -- panel ID, e.g. LSDH1201
  alt_name         text,                                             -- e.g. B818-LS-SDH-1201
  voltage          text,                                             -- e.g. 480/277V Wye
  phases           int check (phases is null or phases in (1, 3)),
  wires            int check (wires is null or wires between 2 and 5),
  main_type        text check (main_type is null or main_type in ('MCB', 'MLO')),
  main_amps        int check (main_amps is null or main_amps between 1 and 10000),
  bus_amps         int check (bus_amps is null or bus_amps between 1 and 10000),
  kaic             numeric check (kaic is null or kaic between 0 and 500),
  iso_ground       boolean,
  surge            boolean,
  fed_from         text,
  location         text,
  manufacturer     text,
  mounting         text,
  positions        int check (positions is null or positions between 1 and 200),   -- circuit positions (42 in a 42-circuit panel)
  notes            text,
  source           text not null default 'manual' check (source in ('manual', 'read')),
  created_by       text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists panels_project_idx on panels (project_id);

-- One row per breaker or entry, at its first circuit number. A 3-pole breaker at circuit 1 also takes 3 and 5.
create table if not exists panel_circuits (
  id            uuid primary key default gen_random_uuid(),
  panel_id      uuid not null references panels(id) on delete cascade,
  circuit       int not null check (circuit between 1 and 200),
  description   text,
  kind          text not null check (kind in ('load', 'spare', 'space')),
  breaker_amps  int check (breaker_amps is null or breaker_amps between 1 and 6000),
  poles         int not null default 1 check (poles between 1 and 3),
  load_kva      numeric,
  unique (panel_id, circuit)
);
