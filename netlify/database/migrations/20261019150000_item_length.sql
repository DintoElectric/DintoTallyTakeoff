-- Linear fixtures (strips, slots, wraparounds): how long one fixture is, in feet, so the export can total footage.
-- Empty for everything else, and for continuous runs whose length is read from the plans.
alter table item_types add column if not exists length_ft numeric(8,2)
  check (length_ft is null or (length_ft > 0 and length_ft <= 1000));
