// Turns position-read schedules (outlet counts, security device lists) into library items.
import type { PageRun } from './pageRuns.ts';
import type { Prim } from './primitives.ts';
import { clean, type ScheduleRow } from './scheduleParse.ts';
import { readTextTables, type TextTable } from './scheduleText.ts';

const blank = (code: string, name: string, extra: Partial<ScheduleRow>): ScheduleRow => ({
  code, mounting: '', name, description: name, lumens: '', cct: '', optics: '', watts: '', volts: '', dimming: '',
  manufacturer: '', alternates: [], catalog: '', removed: false, similarTo: null, ...extra,
});

const STOP = new Set(['WITH', 'AND', 'OF', 'THE', 'FOR', 'INTEGRATED', '-']);
/** "VIDEO INTERCOM MASTER" -> "VIM", "MASTER DOOR RELEASE" -> "MDR". */
export function initials(name: string): string {
  const w = name.toUpperCase().replace(/[^A-Z0-9°\s-]/g, ' ').split(/\s+/).filter((x) => x && !STOP.has(x));
  return w.map((x) => (/^\d/.test(x) ? x.replace(/\D/g, '') : x[0])).join('').slice(0, 6) || 'DEV';
}

const col = (t: TextTable, re: RegExp) => t.headers.findIndex((h) => re.test(h));

function outletCategory(name: string): string {
  if (/CAMERA/.test(name)) return 'Camera outlets';
  if (/WIRELESS ACCESS/.test(name)) return 'Wireless access points';
  if (/INTERCOM/.test(name)) return 'Intercom outlets';
  if (/BLUE LIGHT/.test(name)) return 'Blue light stations';
  if (/PARATA/.test(name)) return 'BD Parata outlets';
  if (/TIME CLOCK/.test(name)) return 'Time clock outlets';
  if (/MONITOR/.test(name)) return 'Monitor outlets';
  return 'Telecom outlets';
}

function outletRows(t: TextTable, into: Map<string, ScheduleRow>) {
  const iType = col(t, /^OUTLET TYPE$/), iSub = col(t, /^SUBSCRIPT$/), iQty = col(t, /QUANTITY/);
  for (const r of t.rows) {
    let name = r[iType] ?? '', code = (r[iSub] ?? '').trim();
    if (!code) {
      // "...OUTLET 4AC": a subscript that ran against its description
      const m = /\s([A-Z0-9]{1,5})$/.exec(name);
      if (m && /\d/.test(m[1])) { code = m[1]; name = name.slice(0, -m[0].length).trim(); }
    }
    if (!code || !name) continue;
    const key = `${code}|${name}`.toUpperCase();
    const qty = Number((r[iQty] ?? '').replace(/,/g, '')) || 0;
    const ports = /(\d+)-PORT/.exec(name)?.[1];
    const have = into.get(key);
    if (have) { have.count = (have.count ?? 0) + qty; continue; }
    into.set(key, blank(code, name, { key, category: outletCategory(name), spec: ports ? `${ports}-port outlet` : '', count: qty }));
  }
}

function deviceRows(t: TextTable, into: Map<string, ScheduleRow>) {
  const iType = col(t, /(CAMERA|DEVICE) TYPE$/), iMount = col(t, /MOUNTING/), iModel = col(t, /MODEL/), iRate = col(t, /FRAME RATE/);
  const cat = /CAMERA/.test(t.title) ? 'Cameras' : /INTERCOM/.test(t.title) ? 'Intercoms' : /PHONE/.test(t.title) ? 'Emergency phones' : 'Security devices';
  for (const r of t.rows) {
    const type = r[iType] ?? '';
    if (!type) continue;
    const mount = iMount >= 0 ? r[iMount] ?? '' : '';
    const model = iModel >= 0 ? clean(r[iModel] ?? '') : '';
    const name = [type, mount].filter(Boolean).join(', ');
    const key = `${type}|${mount}|${model}`.toUpperCase();
    const have = into.get(key);
    if (have) { have.count = (have.count ?? 0) + 1; continue; }
    // "HANWHA PNM-C16013RVQ": maker, then catalog number; a lone word ("TALKAPHONE") is just the maker.
    const parts = model.split(' ');
    const hasCatalog = parts.length >= 2 && /^[A-Z]+$/.test(parts[0]) && /\d/.test(parts.slice(1).join(' '));
    const manufacturer = hasCatalog ? parts[0] : model;
    const catalog = hasCatalog ? parts.slice(1).join(' ') : '';
    const rate = iRate >= 0 ? r[iRate] ?? '' : '';
    into.set(key, blank(catalog || initials(name), name, {
      key, category: cat, manufacturer: hasCatalog || !/\d/.test(model) ? manufacturer : '', catalog: catalog || (/\d/.test(model) && !hasCatalog ? model : ''),
      spec: [model, rate].filter(Boolean).join(' · '), count: 1,
    }));
  }
}

/** A table that lists one kind of device with no type column (duress alarms, master door releases): one item. */
function singleDeviceRows(t: TextTable, into: Map<string, ScheduleRow>) {
  const name = clean(t.title.replace(/^SECURITY[_\s]+/i, '').replace(/\s*SCHEDULE\s*$/i, '').replace(/_/g, ' ')).toUpperCase();
  if (!name || t.rows.length === 0) return;
  const iNotes = col(t, /INSTALLER NOTES/);
  const notes = [...new Set(t.rows.map((r) => (iNotes >= 0 ? r[iNotes] ?? '' : '')).filter(Boolean))];
  const key = `|${name}|`;
  into.set(key, blank(initials(name), name, { key, category: 'Security devices', spec: notes.join(' · '), count: t.rows.length }));
}

export function textTablesToRows(tables: TextTable[]): ScheduleRow[] {
  const into = new Map<string, ScheduleRow>();
  for (const t of tables) {
    // Only tables titled "... SCHEDULE". Legends have similar columns (DEVICE TYPE, BACKBOX SIZE) but wrapped notes, not rows of items.
    if (!/SCHEDULE/i.test(t.title)) continue;
    if (col(t, /^OUTLET TYPE$/) >= 0 && col(t, /^SUBSCRIPT$/) >= 0) outletRows(t, into);
    else if (col(t, /(CAMERA|DEVICE) TYPE$/) >= 0) deviceRows(t, into);
    else if (col(t, /^DEVICE LOCATION$/) >= 0 && col(t, /DOOR|ALARM/) >= 0) singleDeviceRows(t, into);
    // Door schedules list door openings, not kinds of device, so they make no library items.
  }
  return [...into.values()];
}

export function parseTextSchedules(runs: PageRun[], prims: Prim[], pageW: number, pageH: number): ScheduleRow[] {
  return textTablesToRows(readTextTables(runs, prims, pageW, pageH));
}
