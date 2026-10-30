-- Jobs: folders on the home page grouping a job's workspaces (projects), for example "Hillcrest Middle School" holding
-- "Hillcrest - Lighting" and "Hillcrest - Fire alarm", each with its own drawings, library and counts. A workspace may count
-- one system (its Auto-count and counts panel start on it). Deleting a job leaves its projects, out of any folder.
-- Safe to run twice.
create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(name) between 1 and 200),
  created_by      text not null,
  created_by_name text,
  created_at      timestamptz not null default now()
);
alter table projects add column if not exists job_id uuid references jobs(id) on delete set null;
alter table projects add column if not exists system text;
alter table projects drop constraint if exists projects_system_check;
alter table projects add constraint projects_system_check
  check (system is null or system in ('lighting', 'power', 'fire_alarm', 'hvac', 'telecom', 'security', 'other'));
create index if not exists projects_job_idx on projects (job_id);
