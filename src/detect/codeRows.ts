// The rows of Auto-count's table: one per code found, with how many and where. Pure, so it can be tested.
import type { TagKind } from './tagScan.ts';
import type { TagHit } from './tagScan.ts';

/** What discover() needs of a sheet's scan. */
export interface ScanLike { sheet: { id: string }; hits: TagHit[] }

export interface CodeRow { code: string; kind: TagKind; total: number; bySheet: Map<string, number>; name?: string; shape?: string; glyph?: string }
const KIND_RANK: Record<TagKind, number> = { camera: 0, note: 0, tag: 1, short: 2, room: 3 };
export function discover(scans: ScanLike[]): CodeRow[] {
  const m = new Map<string, CodeRow & { rooms: number; real: number; notes: number }>();
  for (const sc of scans) {
    for (const h of sc.hits) {
      const r = m.get(h.code) ?? { code: h.code, kind: h.kind, total: 0, bySheet: new Map(), rooms: 0, real: 0, notes: 0, name: h.name, shape: h.shape, glyph: h.glyph };
      r.total++;
      if (h.kind === 'room') r.rooms++;
      if (h.kind === 'tag') r.real++;
      if (h.kind === 'note') r.notes++;
      r.bySheet.set(sc.sheet.id, (r.bySheet.get(sc.sheet.id) ?? 0) + 1);
      m.set(h.code, r);
    }
  }
  // A code is a room number only if EVERY occurrence looks like one (EM2 is a fixture even if one hit sits under a room name).
  const rows = [...m.values()].map(({ rooms, real, notes, ...r }) => ({ ...r, kind: (r.kind === 'camera' ? 'camera' : notes > 0 && notes >= r.total - rooms ? 'note' : rooms === r.total ? 'room' : real > 0 ? 'tag' : 'short') as TagKind }));
  return rows.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.total - a.total || a.code.localeCompare(b.code));
}

