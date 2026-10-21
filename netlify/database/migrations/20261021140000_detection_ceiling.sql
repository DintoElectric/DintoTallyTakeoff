-- The ceiling a count sits in, read from the ceiling plan's texture: a drop (grid) ceiling, sheetrock, or open.
-- Empty when it was not read (the sheet has no ceiling textures, or the count was made before this was added).
alter table detections add column if not exists ceiling text
  check (ceiling is null or ceiling in ('drop', 'sheetrock', 'open'));
