-- Highlights: translucent marks an estimator draws over a sheet (a section checked, a run traced, an area to look at), like a
-- highlighter on paper. One row each, so teammates highlighting one sheet do not overwrite each other. points: [x, y] pairs,
-- normalized to the page (0..1); kind: free (as drawn), line (straight), rect (two corners); width: in page points.
-- Removed with their sheet. Safe to run twice.
create table if not exists highlights (
  id              uuid primary key default gen_random_uuid(),
  sheet_id        uuid not null references sheets(id) on delete cascade,
  kind            text not null check (kind in ('free', 'line', 'rect')),
  color           text not null check (color in ('yellow', 'green', 'pink', 'blue')),
  width           real not null check (width > 0 and width <= 200),
  points          jsonb not null,
  created_by      text not null,
  created_by_name text,
  created_at      timestamptz not null default now()
);
create index if not exists highlights_sheet_idx on highlights (sheet_id);
