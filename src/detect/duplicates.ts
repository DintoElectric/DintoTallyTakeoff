// Finding the same drawing uploaded more than once. A sheet number alone is not enough (a revised drawing keeps its
// number), so sheets that share a number are compared by what is printed on them.
import { similarity } from './fingerprint.ts';

export const IDENTICAL = 0.99; // same drawing, re-exported or uploaded twice
export const SAME_SHEET = 0.6; // same number and mostly the same text: a different version of it

export interface DupSheet { id: string; number: string | null; file_id: string; page: number; detection_count: number }
export interface DupCluster { members: DupSheet[]; sim: number } // sim: how alike this cluster is to the group's first cluster (1 for the first)
export interface DupGroup { number: string; clusters: DupCluster[] }

export const numberKey = (n: string) => n.toUpperCase().replace(/\s+/g, '');

/** Sheets that share a number: the only ones worth comparing. */
export function candidateGroups(sheets: DupSheet[]): DupSheet[][] {
  const by = new Map<string, DupSheet[]>();
  for (const s of sheets) if (s.number && s.number.trim()) (by.get(numberKey(s.number)) ?? by.set(numberKey(s.number), []).get(numberKey(s.number))!).push(s);
  return [...by.values()].filter((g) => g.length >= 2);
}

/**
 * Within each number: cluster identical pages; order so the sheet to keep comes first (the one with counts, then the
 * earlier file, then the earlier page). Groups with nothing to say (different drawings under one number) are left out.
 */
export function findDuplicateGroups(sheets: DupSheet[], prints: Map<string, Set<string>>, fileOrder: Map<string, number>): DupGroup[] {
  const rank = (a: DupSheet, b: DupSheet) => b.detection_count - a.detection_count || (fileOrder.get(a.file_id) ?? 0) - (fileOrder.get(b.file_id) ?? 0) || a.page - b.page;
  const out: DupGroup[] = [];
  for (const g of candidateGroups(sheets)) {
    const list = [...g].sort(rank);
    // union-find over "identical"
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = prints.get(list[i].id), b = prints.get(list[j].id);
      if (a && b && similarity(a, b) >= IDENTICAL) parent[find(j)] = find(i);
    }
    const byRoot = new Map<number, DupSheet[]>();
    list.forEach((s, i) => (byRoot.get(find(i)) ?? byRoot.set(find(i), []).get(find(i))!).push(s));
    const clusters = [...byRoot.values()].map((members) => ({ members, sim: 1 })); // already in rank order
    const first = prints.get(clusters[0].members[0].id);
    for (const c of clusters.slice(1)) { const p = prints.get(c.members[0].id); c.sim = first && p ? similarity(first, p) : 0; }
    const shown = clusters.filter((c, i) => i === 0 || c.sim >= SAME_SHEET);
    const hasCopies = shown.some((c) => c.members.length >= 2);
    if (hasCopies || shown.length >= 2) out.push({ number: g[0].number!.trim(), clusters: shown });
  }
  return out.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** The sheets to remove by default: every extra copy of an identical page, never the one being kept. */
export function defaultRemovals(groups: DupGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) for (const c of g.clusters) for (const m of c.members.slice(1)) out.add(m.id);
  return out;
}
