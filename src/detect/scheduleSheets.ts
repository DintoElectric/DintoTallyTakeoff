// Which sheets are, or contain, schedules? Those must not be auto-counted: the tags printed in a schedule table
// (BC-14, EX-1 ...) would be counted as if they were fixtures on a plan.
export interface SheetLite { id: string; number: string | null; title: string | null; kind: string; count_enabled: boolean }
export interface ScheduleFinding {
  id: string;
  why: 'title' | 'table' | 'heading';
  detail: string;
  preselect: boolean;  // ticked by default
  setKind: boolean;    // also mark the sheet as a schedule (not just stop counting it)
}

const PLAN_KINDS = new Set(['floor_plan', 'site_plan']);
export const titleSaysSchedule = (t: string | null) => /\bSCHEDULES?\b/i.test(t ?? '');

const NOT_A_HEADING = /\b(REFER|SEE|PER|SHALL|PROVIDE|NOTE|MUST|TO BE|AS INDICATED|INDICATES)\b/i;
// A heading starts with what the table lists ("SITE LIGHTING SCHEDULE"); "IN SCHEDULE" is the end of a sentence.
const NOT_A_START = /^(IN|ON|AT|THE|A|AN|OF|AS|TO|FOR|PER|SEE|ALL|EACH|SHOWN|ON THE|IN THE|WITHIN|ABOVE|BELOW)\b/i;
/** Text that reads like a table heading ("SITE LIGHTING SCHEDULE"), not a note that mentions a schedule. */
export function scheduleHeadings(strings: string[]): string[] {
  const out: string[] = [];
  for (const raw of strings) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 10 || s.length > 80 || !/\bSCHEDULES?\b/i.test(s) || NOT_A_HEADING.test(s) || NOT_A_START.test(s) || /^[a-z]/.test(s) || s.split(' ').length < 2) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * `content` is what was found on the page itself (only needed for sheets not already titled as schedules).
 * Returns null when there is nothing to do: the sheet is not counting and already marked.
 */
export function classifySheet(s: SheetLite, content?: { tableTypes: number; headings: string[] }): ScheduleFinding | null {
  const isPlan = PLAN_KINDS.has(s.kind);
  if (s.kind === 'schedule' || titleSaysSchedule(s.title)) {
    if (!s.count_enabled && s.kind === 'schedule') return null;
    // "LIGHTING PLAN AND FIXTURE SCHEDULE": a plan with a schedule on it; the estimator decides.
    if (isPlan && /\bPLANS?\b/i.test(s.title ?? '')) return { id: s.id, why: 'heading', detail: s.title ?? '', preselect: false, setKind: false };
    return { id: s.id, why: 'title', detail: s.title ?? 'marked as a schedule', preselect: true, setKind: s.kind !== 'legend' };
  }
  if (!s.count_enabled || !content) return null; // a sheet that is not counting needs nothing
  if (content.tableTypes > 0) return { id: s.id, why: 'table', detail: `${content.tableTypes} types in a schedule table`, preselect: !isPlan, setKind: !isPlan };
  if (content.headings.length) return { id: s.id, why: 'heading', detail: content.headings[0], preselect: false, setKind: false };
  return null;
}
