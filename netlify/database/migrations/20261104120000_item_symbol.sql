-- An item's symbol, read from a legend: how it looks (the points along its linework in its own box, its fill) and the
-- letters that tell it from another item drawn with the same symbol (a duplex with "GF" beside it). Auto-count finds it on
-- the plans by its look. Null: the item has no symbol (it is counted by its tag). Safe to run twice.
alter table item_types add column if not exists symbol jsonb;
