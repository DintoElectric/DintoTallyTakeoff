-- Areas of a sheet whose counts are ignored (past a matchline, or outlined by an estimator).
-- null = automatic (worked out from the matchlines on the sheet); a list (even an empty one) = set by hand.
alter table sheets add column if not exists exclusion_zones jsonb;
