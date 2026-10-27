// Which counting tab an item belongs in: Fixtures (lighting) or Devices (everything else).
import type { CategoryRow, ItemTypeRow } from './types.ts';

export type CountGroup = 'fixture' | 'device';
export const GROUP_LABEL: Record<CountGroup, string> = { fixture: 'Fixtures', device: 'Devices' };

// The categories the fixture-schedule reader files lighting under (by mounting), and words that mean a light.
const FIXTURE_CATEGORIES = /^(recessed|pendant|surface|wall|track|suspended|exit signs?|lighting|light fixtures?|fixtures?|emergency lighting)$/i;
const LIGHT_WORDS = /\b(led|lamp|lumens?|luminaire|fixture|troffer|downlight|down light|strip ?light|wall ?pack|pendant|sconce|high ?bay|low ?bay|flat panel|linear|lighting|exit sign|emergency light|wraparound|vapor ?tight|cove)\b/i;

/** The item's group: what it was set to, or else from its category, else from its name and spec. */
export function countGroupOf(item: Pick<ItemTypeRow, 'count_group' | 'category_id' | 'name' | 'spec'>, categories: Pick<CategoryRow, 'id' | 'name'>[]): CountGroup {
  if (item.count_group) return item.count_group;
  const cat = categories.find((c) => c.id === item.category_id)?.name ?? '';
  if (FIXTURE_CATEGORIES.test(cat.trim())) return 'fixture';
  if (cat && cat.toLowerCase() !== 'other') return 'device';
  return LIGHT_WORDS.test(`${item.name} ${item.spec ?? ''}`) ? 'fixture' : 'device';
}
