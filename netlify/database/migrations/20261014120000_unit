-- Tally: initial schema (spec section 2.6).
-- Never edit this file after it has been applied: Netlify checksums migrations.
-- Add a new timestamped migration instead.

create table projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  location         text,
  client           text,
  bid_due          date,
  status           text not null default 'counting'
                   check (status in ('splitting','counting','in_review','exported')),
  review_threshold real not null default 0.85,
  created_by       text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);

create table drawing_files (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  file_name     text not null,
  size_bytes    bigint not null,
  page_count    int,
  chunk_count   int not null,
  rev_no        int not null default 1,
  upload_status text not null default 'uploading'
                check (upload_status in ('uploading','processing','ready','failed')),
  progress      real not null default 0,
  error         text,
  uploaded_by   text not null,
  created_at    timestamptz not null default now()
);
create index drawing_files_project_idx on drawing_files (project_id);

create table sheets (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  file_id           uuid not null references drawing_files(id) on delete cascade,
  page              int  not null,
  number            text,
  title             text,
  kind              text not null default 'other'
                    check (kind in ('floor_plan','legend','site_plan','schedule','other')),
  floor             text,
  scale             text,
  -- Page size of the page as displayed (PDF points at the page's own rotation).
  -- All detection coordinates are normalized 0..1 against this displayed page.
  page_width_pt     real not null,
  page_height_pt    real not null,
  rotation          int  not null default 0,
  count_enabled     boolean not null default false,
  count_status      text not null default 'not_counted'
                    check (count_status in ('not_counted','needs_review','reviewed')),
  read_source       text not null default 'text'
                    check (read_source in ('text','ocr','manual')),
  title_unsure      boolean not null default false,
  version           int  not null default 1,
  replaces_sheet_id uuid references sheets(id),
  superseded_at     timestamptz,
  created_at        timestamptz not null default now(),
  unique (file_id, page)
);
create index sheets_project_idx on sheets (project_id);

create table areas (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    uuid not null references sheets(id) on delete cascade,
  name        text not null,
  polygon     jsonb not null,
  created_by  text not null
);

create table item_categories (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique,
  sort  int  not null default 0
);

create table item_types (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  spec           text,
  category_id    uuid references item_categories(id) on delete set null,
  unit           text not null default 'EA',
  detection_mode text not null default 'manual' check (detection_mode in ('auto','manual')),
  marker_shape   text not null default 'circle'
                 check (marker_shape in ('rect','circle','square','diamond')),
  marker_glyph   text,
  symbol_key     text,
  created_by     text not null,
  created_at     timestamptz not null default now()
);

create table item_samples (
  id           uuid primary key default gen_random_uuid(),
  item_type_id uuid not null references item_types(id) on delete cascade,
  sheet_id     uuid references sheets(id) on delete set null,
  crop_key     text not null,
  bbox         jsonb,
  created_by   text not null,
  created_at   timestamptz not null default now()
);

create table detections (
  id                 uuid primary key,
  sheet_id           uuid not null references sheets(id) on delete cascade,
  item_type_id       uuid not null references item_types(id),
  x                  real not null,
  y                  real not null,
  bbox               jsonb,
  confidence         real,
  source             text not null check (source in ('auto','manual')),
  status             text not null default 'unreviewed'
                     check (status in ('unreviewed','confirmed','rejected')),
  carried_from       uuid,
  created_by         text not null,
  created_by_name    text,
  confirmed_by       text,
  confirmed_by_name  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (x >= 0 and x <= 1 and y >= 0 and y <= 1)
);
create index detections_sheet_idx on detections (sheet_id);
create index detections_item_idx  on detections (item_type_id);
