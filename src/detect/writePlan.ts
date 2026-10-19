// Decides what Auto-count writes to one sheet: which earlier counts to remove and which new ones to add.
// Pure (no network), so it can be tested.
import type { Detection } from '../../shared/types.ts';
import { inZones, type Zone } from '../../shared/zones.ts';
import type { TagHit } from './tagScan.ts';
import { inBubble, type GridBubble } from './gridBubbles.ts';

export const CONF_TAG = 0.98;      // exact tag text or a drawing note: not flagged
export const CONF_SHORT = 0.7;     // short letter-only codes: always flagged for review
export const CONF_ROOMISH = 0.5;   // a single hit that looks like a room number inside an otherwise real tag
export const CONF_AMBIGUOUS = 0.6; // the code belongs to several library items (variants): flagged so you choose
export const CONF_EMERGENCY = 0.95; // matched a confirmed emergency label
export const CONF_NORMAL_SPLIT = 0.9; // no emergency label on a fixture type that has emergency versions

const NEAR = 0.004; // an existing confirmed or manual count this close blocks a duplicate

export interface PlanInput {
  hits: TagHit[];
  zones: Zone[];
  existing: Detection[];
  itemIdByCode: Map<string, string>; // ticked codes -> library item id
  ambiguous: Set<string>;
  /** Every library item whose code was found on the scan, ticked or not: their unreviewed auto counts are replaced. */
  clearItemIds: Set<string>;
  /** Items that are no longer counted at all (short codes): every earlier automatic count of them is removed. */
  dropItemIds?: Set<string>;
  /** Start fresh: erase every earlier automatic count on the sheet ('auto'), or every count including hand-placed ones ('all'). */
  reset?: false | 'auto' | 'all';
  ignorePast: boolean;
  /** Leave out the lettered and numbered grid-line bubbles: no new counts on them, and earlier automatic counts on them go. */
  leaveOutGrid?: boolean;
  bubbles?: GridBubble[];
  newId: () => string;
}
export type Op = { op: 'delete'; id: string } | { op: 'add'; detection: Record<string, unknown> };
export interface Plan { ops: Op[]; added: number; removedPast: number; removedDropped: number; removedGrid: number; erased: number }

export function planSheetWrite(p: PlanInput): Plan {
  const ops: Op[] = [];
  let removedPast = 0, removedDropped = 0, removedGrid = 0, erased = 0;
  const live = p.hits.filter((h) => !(p.ignorePast && h.past) && !(p.leaveOutGrid && h.grid) && p.itemIdByCode.has(h.code));
  const tickedItems = new Set(p.itemIdByCode.values());
  const keep: Detection[] = [];
  for (const d of p.existing) {
    if (p.reset === 'all' || (p.reset === 'auto' && d.source === 'auto')) {
      // Starting fresh: everything earlier of this kind goes, whatever its status.
      ops.push({ op: 'delete', id: d.id });
      erased++;
      continue;
    }
    const pastNow = p.ignorePast && d.source === 'auto' && d.status !== 'rejected' && inZones(d.x, d.y, p.zones);
    const onGrid = !!p.leaveOutGrid && d.source === 'auto' && d.status !== 'rejected' && !!p.bubbles && inBubble(d.x, d.y, p.bubbles);
    if (p.dropItemIds?.has(d.item_type_id) && d.source === 'auto' && d.status !== 'rejected') {
      // Short codes are not counted any more; earlier automatic counts of them go. Manual counts are never touched.
      ops.push({ op: 'delete', id: d.id });
      removedDropped++;
    } else if (onGrid) {
      // An earlier automatic count sitting on a grid bubble (a column or row letter or number), even a confirmed one. Manual counts are never touched.
      ops.push({ op: 'delete', id: d.id });
      removedGrid++;
    } else if (pastNow) {
      // An earlier automatic count inside an exclusion zone (past a matchline, or outlined by hand), even a confirmed one. Manual counts are never touched.
      ops.push({ op: 'delete', id: d.id });
      removedPast++;
    } else if (p.clearItemIds.has(d.item_type_id) && d.source === 'auto' && d.status === 'unreviewed') {
      ops.push({ op: 'delete', id: d.id });
    } else if (tickedItems.has(d.item_type_id)) {
      keep.push(d);
    }
  }
  let added = 0;
  for (const h of live) {
    const itemId = p.itemIdByCode.get(h.code)!;
    if (keep.some((d) => d.item_type_id === itemId && Math.abs(d.x - h.x) < NEAR * 3 && Math.abs(d.y - h.y) < NEAR * 3)) continue;
    const confidence = h.conf ?? (h.kind === 'room' ? CONF_ROOMISH : p.ambiguous.has(h.code) ? CONF_AMBIGUOUS : h.kind === 'short' ? CONF_SHORT : CONF_TAG);
    ops.push({ op: 'add', detection: {
      id: p.newId(), item_type_id: itemId, x: Math.min(1, Math.max(0, h.x)), y: Math.min(1, Math.max(0, h.y)),
      bbox: null, confidence, source: 'auto', status: 'unreviewed',
    } });
    added++;
  }
  return { ops, added, removedPast, removedDropped, removedGrid, erased };
}
