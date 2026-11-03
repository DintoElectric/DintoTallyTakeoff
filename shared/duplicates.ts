// Copies of one fixture in a library: the same code in the same category, neither an emergency version of the other (a
// schedule read again, a library imported). The same rule everywhere: Auto-count keeps a code's counts on one copy, the
// Library and Auto-count offer to merge them, and the server's merge (netlify/functions/_lib/library.ts) uses it too.
import type { ItemTypeRow } from './types.ts';

export const isEmergencyVersion = (name: string) => /\bEM\b|EMERGENCY|\/EM\b|BATTERY/i.test(name);

/** The codes that are in the library more than once in the same category, as copies of one fixture. */
export function duplicateCopies(items: Pick<ItemTypeRow, 'id' | 'code' | 'name' | 'category_id' | 'detection_count'>[]): { code: string; ids: string[] }[] {
  const groups = new Map<string, typeof items>();
  for (const it of items) { const k = `${it.code.toUpperCase()}|${it.category_id ?? ''}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(it); }
  return [...groups.values()]
    .filter((g) => g.length > 1 && !(g.some((i) => isEmergencyVersion(i.name)) && g.some((i) => !isEmergencyVersion(i.name))))
    .map((g) => ({ code: g[0].code, ids: g.map((i) => i.id) }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}
