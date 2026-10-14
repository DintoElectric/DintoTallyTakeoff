-- Several items may share a code when their descriptions differ (for example two D9 fixtures:
-- "4' SURFACE/WET" and "4' SURFACE/WET/EM/OPEN"). A code plus description must still be unique.
alter table item_types drop constraint if exists item_types_code_key;
create unique index if not exists item_types_code_name_uniq on item_types (lower(code), lower(name));
