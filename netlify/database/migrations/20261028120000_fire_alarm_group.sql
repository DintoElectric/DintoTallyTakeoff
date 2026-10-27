-- Fire alarm as a third counting group, beside fixtures and devices.
-- The rule on item_types.count_group is replaced (dropped if there, added again with the new value): safe to run twice.
alter table item_types drop constraint if exists item_types_count_group_check;
alter table item_types add constraint item_types_count_group_check
  check (count_group is null or count_group in ('fixture', 'device', 'fire_alarm'));
