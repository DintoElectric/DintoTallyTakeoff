-- The system an item belongs to, for counting and reporting by system (Lighting with its controls, Power, Fire alarm, HVAC,
-- Telecom / AV, Security, Other). Null: worked out from the item's kind, category and description. Safe to run twice.
alter table item_types add column if not exists system text;
alter table item_types drop constraint if exists item_types_system_check;
alter table item_types add constraint item_types_system_check
  check (system is null or system in ('lighting', 'power', 'fire_alarm', 'hvac', 'telecom', 'security', 'other'));
