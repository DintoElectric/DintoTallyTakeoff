// Which counting tab an item belongs in: Fixtures (lighting), Fire alarm, or Devices (everything else).
import type { CategoryRow, ItemTypeRow } from './types.ts';

export type CountGroup = 'fixture' | 'device' | 'fire_alarm';
export const GROUPS: CountGroup[] = ['fixture', 'device', 'fire_alarm'];
export const GROUP_LABEL: Record<CountGroup, string> = { fixture: 'Fixtures', device: 'Devices', fire_alarm: 'Fire alarm' };

// The categories the fixture-schedule reader files lighting under (by mounting), and words that mean a light.
const FIXTURE_CATEGORIES = /^(recessed|pendant|surface|wall|track|suspended|exit signs?|lighting|light fixtures?|fixtures?|emergency lighting)$/i;
// fire alarm categories and devices: detectors, notification appliances, pull stations, modules, panels
const FA_CATEGORIES = /\b(fire alarm|fa devices?|life safety|notification appliances?|detectors?|initiating devices?)\b/i;
const FA_WORDS = /\b(fire alarm|smoke detector|heat detector|duct detector|beam detector|co detector|horn|strobe|horn\/strobe|speaker\/strobe|pull station|manual station|facp|fire alarm control|annunciator|nac panel|notification appliance|monitor module|control module|relay module|flow switch|tamper switch|sprinkler supervisory)\b/i;
const LIGHT_WORDS = /\b(led|lamp|lumens?|luminaire|fixture|troffer|downlight|down light|strip ?light|wall ?pack|pendant|sconce|high ?bay|low ?bay|flat panel|linear|lighting|exit sign|emergency light|wraparound|vapor ?tight|cove)\b/i;

/** The item's group: what it was set to, or else from its category, else from its name and spec. */
export function countGroupOf(item: Pick<ItemTypeRow, 'count_group' | 'category_id' | 'name' | 'spec'>, categories: Pick<CategoryRow, 'id' | 'name'>[]): CountGroup {
  if (item.count_group) return item.count_group;
  // An emergency or measured-length item is made from a fixture ("A1-16/EM", "P 7'", "..., emergency"): a fixture.
  const code = (item as { code?: string }).code ?? '';
  if (/\/EM$/i.test(code) || /\s\d+(\.\d+)?'$/.test(code) || /, emergency$/i.test(item.name)) return 'fixture';
  const cat = categories.find((c) => c.id === item.category_id)?.name ?? '';
  // a fixture category by name ("Lighting", "Fixtures"), or a schedule of them ("Luminaire schedule", "Light fixture schedule")
  if (FIXTURE_CATEGORIES.test(cat.trim()) || (/\b(luminaires?|light(ing)? fixtures?|fixture schedule|lighting schedule)\b/i.test(cat) && !/control/i.test(cat))) return 'fixture';
  if (FA_CATEGORIES.test(cat) || FA_WORDS.test(`${item.name} ${item.spec ?? ''}`)) return 'fire_alarm';
  if (cat && cat.toLowerCase() !== 'other') return 'device';
  return LIGHT_WORDS.test(`${item.name} ${item.spec ?? ''}`) ? 'fixture' : 'device';
}
