// Finding an item by what you remember of it: its tag ("BC-14", "bc14"), or words from its description.
export interface Searchable { code: string; name: string; spec: string | null }

/** Case, spaces and punctuation do not matter: "BC 14", "bc-14" and "BC14" are the same. */
export const squash = (s: string) => s.toLowerCase().replace(/[\s\-_./(),]+/g, '');

/**
 * How well an item matches, lower is better, null is no match:
 * 0 the code is exactly what was typed, 1 the code starts with it, 2 the code contains it,
 * 3 every word typed is somewhere in the code, description, spec or category.
 */
export function itemRank(query: string, it: Searchable, category = ''): number | null {
  const q = squash(query);
  if (!q) return 0;
  const code = squash(it.code);
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (code.includes(q)) return 2;
  const hay = squash(`${it.code} ${it.name} ${it.spec ?? ''} ${category}`);
  const words = query.toLowerCase().split(/\s+/).map(squash).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w)) ? 3 : null;
}

/** The matching items, best match first (then by code). An empty query returns the list as it is. */
export function searchItems<T extends Searchable>(query: string, items: T[], categoryOf: (it: T) => string = () => ''): T[] {
  if (!squash(query)) return items;
  const ranked: { it: T; r: number }[] = [];
  for (const it of items) { const r = itemRank(query, it, categoryOf(it)); if (r !== null) ranked.push({ it, r }); }
  return ranked.sort((a, b) => a.r - b.r || a.it.code.localeCompare(b.it.code, undefined, { numeric: true })).map((x) => x.it);
}
