/** The one item that every selected count belongs to, or null when nothing is selected or the selection mixes items. */
export function singleItemOf(dets: { id: string; item_type_id: string }[], selected: Set<string>): string | null {
  let item: string | null = null;
  for (const d of dets) {
    if (!selected.has(d.id)) continue;
    if (item === null) item = d.item_type_id;
    else if (item !== d.item_type_id) return null;
  }
  return item;
}
