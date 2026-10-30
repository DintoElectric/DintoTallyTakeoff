-- An electrical plan lined up with the architectural floor plan of the same level and area, so the architect's walls (and
-- their wall-type tags) can be read at each device. ref_align: { s, dx, dy, across, down, how } where a point E on this sheet
-- is at s * E + d on the architectural one (PDF points); how: 'grid' (found from the shared column grid) or 'hand'.
-- Deleting the architectural sheet clears the pairing. Safe to run twice.
alter table sheets add column if not exists ref_sheet_id uuid references sheets(id) on delete set null;
alter table sheets add column if not exists ref_align jsonb;
