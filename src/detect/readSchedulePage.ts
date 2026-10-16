// Reads whatever schedule a page holds: a text-only table (PSEB style), a ruled grid, or one laid out by position.
// Shared by the "Read schedule" dialog and the check that finds schedule sheets.
import { extractRuns, type PageRun } from './pageRuns.ts';
import { extractPrims, type OpsLike } from './primitives.ts';
import { parseSchedulePage, type ScheduleRow } from './scheduleParse.ts';
import { parseRuledSchedule } from './scheduleRuled.ts';
import { parseTextSchedules } from './scheduleDevices.ts';

type PageForRuns = Parameters<typeof extractRuns>[0];
type PageForPrims = Parameters<typeof extractPrims>[0];

/** A quick look at a page's words: does it hold a schedule table one of the readers understands? */
export function looksLikeSchedule(words: Set<string>): boolean {
  const any = (re: RegExp) => [...words].some((w) => re.test(w));
  return (
    (words.has('DESCRIPTION') && (words.has('MANUFACTURER') || words.has('CATALOG NUMBER') || words.has('CATALOG NO.') || words.has('MTG.'))) || // light fixture schedule
    (words.has('OUTLET TYPE') && words.has('SUBSCRIPT')) ||                                                                                     // communications outlet counts
    any(/^(CAMERA|DEVICE) TYPE$/) || words.has('DEVICE LOCATION') ||                                                                            // security device lists
    (words.has('SYMBOL') && words.has('NEMA'))                                                                                                  // special purpose receptacles
  );
}

export const wordsOf = (runs: PageRun[]) => new Set(runs.map((r) => r.str.trim().toUpperCase()));

/**
 * `onlyIfLooksLikeOne` skips pages whose words show no schedule table, which is cheap (text only) and avoids reading
 * line work for every sheet of a big set.
 */
export async function readSchedulePage(
  page: PageForRuns & PageForPrims & { getViewport: (o: { scale: number }) => { width: number; height: number } },
  ops: OpsLike,
  onlyIfLooksLikeOne = false,
  runs?: PageRun[],
): Promise<ScheduleRow[]> {
  const vp = page.getViewport({ scale: 1 });
  const r = runs ?? (await extractRuns(page));
  if (onlyIfLooksLikeOne && !looksLikeSchedule(wordsOf(r))) return [];
  // Schedules with a MTG. column (like PSEB) are read from the text alone; tables drawn with row and column
  // lines (like E0.3) are read from the lines; tables laid out by position (outlets, security) from the header.
  let found = parseSchedulePage(r, vp.width, vp.height);
  if (found.length === 0) {
    const { prims } = await extractPrims(page, ops);
    found = parseRuledSchedule(r, prims, vp.width, vp.height);
    if (found.length === 0) found = parseTextSchedules(r, prims, vp.width, vp.height);
  }
  return found;
}
