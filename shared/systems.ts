// The systems a takeoff is counted and reported by. Lighting takes the fixtures and their controls (switches, sensors,
// lighting control panels) together. An item's system is set by hand, or worked out from what it counts as (fixture,
// device, fire alarm), its category and its description.
import type { CategoryRow, ItemTypeRow } from './types.ts';
import { countGroupOf } from './countGroup.ts';

export type SystemKey = 'lighting' | 'power' | 'fire_alarm' | 'hvac' | 'telecom' | 'security' | 'other';
export const SYSTEMS: SystemKey[] = ['lighting', 'power', 'fire_alarm', 'hvac', 'telecom', 'security', 'other'];
export const SYSTEM_LABEL: Record<SystemKey, string> = { lighting: 'Lighting', power: 'Power', fire_alarm: 'Fire alarm', hvac: 'HVAC', telecom: 'Telecom / AV', security: 'Security', other: 'Other' };

const LIGHTING_CONTROL = /LIGHTING CONTROL|SWITCH|DIMMER|OCCUPANCY|VACANCY|DAYLIGHT|PHOTOCELL|LIGHTING RELAY|\bLCP\b|TIME ?CLOCK|SCENE/;
const SECURITY = /CAMERA|CARD READER|DOOR CONTACT|ACCESS CONTROL|INTRUSION|MOTION DETECTOR|SECURITY|INTERCOM|DURESS|PANIC/;
const TELECOM = /\bDATA\b|TELECOM|\bWAP\b|WIRELESS ACCESS|CATV|\bTV\b|TELEVISION|AUDIO|VIDEO|\bAV\b|PROJECT(OR|ION)|SPEAKER|\bCLOCK\b|PAGING|FIBER|TELEPHONE|VOICE|NETWORK/;
const HVAC = /\bMECH|HVAC|\bVAV\b|\bAHU\b|\bRTU\b|EXHAUST FAN|\bFAN\b|\bEF-?\d|UNIT HEATER|PUMP|BOILER|CHILLER|MOTOR|STARTER|\bVFD\b|VARIABLE FREQUENCY|EQUIPMENT CONNECTION|HARDWIRE|DAMPER|THERMOSTAT|CONDENS/;
const POWER = /RECEPT|OUTLET|DUPLEX|QUAD|GFCI|\bGFI\b|JUNCTION|DISCONNECT|PANEL|FLOOR ?BOX|POWER|PLUG|\bUSB\b|NEMA|\bSPD\b|WIREMOLD/;

/** The system an item is counted under: as set on the item, else from its kind, category and description. */
export function systemOf(item: Pick<ItemTypeRow, 'code' | 'name' | 'spec' | 'category_id' | 'count_group'> & { system?: SystemKey | null }, categories: CategoryRow[]): SystemKey {
  if (item.system) return item.system;
  const group = countGroupOf(item as ItemTypeRow, categories);
  if (group === 'fire_alarm') return 'fire_alarm';
  if (group === 'fixture') return 'lighting';
  const cat = (categories.find((c) => c.id === item.category_id)?.name ?? '').toUpperCase();
  if (/DRAWING NOTE/.test(cat) || /^DRAWING NOTE/i.test(item.name)) return 'other';
  if (item.code.startsWith('$') || /LIGHTING CONTROL/.test(cat)) return 'lighting';
  if (/^CAMERAS?$/.test(cat.trim())) return 'security';
  if (/^OUTLETS?$/.test(cat.trim())) return 'telecom';           // triangle outlets (data, WAP): telecom
  const text = `${cat} ${item.name} ${item.spec ?? ''}`.toUpperCase();
  if (LIGHTING_CONTROL.test(text)) return 'lighting';
  if (SECURITY.test(text)) return 'security';
  if (TELECOM.test(text)) return 'telecom';
  if (HVAC.test(text)) return 'hvac';
  if (POWER.test(text)) return 'power';
  return group === 'device' ? 'power' : 'other';
}
