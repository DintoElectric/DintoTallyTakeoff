// Panels: the counting logic shared by the screens, the export and the tests. Pure functions only.

export type CircuitKind = 'load' | 'spare' | 'space';

export interface Circuit {
  circuit: number;              // its first circuit number; a 3-pole breaker at 1 also takes 3 and 5
  description: string | null;
  kind: CircuitKind;
  breaker_amps: number | null;  // empty for a space
  poles: number;                // 1, 2 or 3
  load_kva: number | null;
}

export interface Panel {
  id: string;
  project_id: string;
  sheet_id: string | null;
  name: string;
  alt_name: string | null;
  voltage: string | null;
  phases: number | null;
  wires: number | null;
  main_type: 'MCB' | 'MLO' | null;
  main_amps: number | null;
  bus_amps: number | null;
  kaic: number | null;
  iso_ground: boolean | null;
  surge: boolean | null;
  fed_from: string | null;
  location: string | null;
  manufacturer: string | null;
  mounting: string | null;
  positions: number | null;
  notes: string | null;
  source: 'manual' | 'read';
  created_by_name: string | null;
  updated_at: string;
  circuits: Circuit[];
}

/** The circuit numbers a breaker takes: same side of the panel, so it steps by 2 (1, 3, 5). */
export const takes = (c: Pick<Circuit, 'circuit' | 'poles'>) => Array.from({ length: Math.max(1, c.poles) }, (_, i) => c.circuit + 2 * i);

/** A breaker's size, as estimators say it: "20 A 1-pole". */
export const breakerLabel = (amps: number, poles: number) => `${amps} A ${poles}-pole`;

export interface BreakerCount { amps: number; poles: number; qty: number; spares: number }

/**
 * Breakers by size and poles. Every breaker counts once, however many poles it has. A SPARE is a breaker (it is
 * bought and installed, with nothing on it yet); a SPACE is an empty position and is not.
 */
export function breakerCounts(circuits: Circuit[]): BreakerCount[] {
  const by = new Map<string, BreakerCount>();
  for (const c of circuits) {
    if (c.kind === 'space' || !c.breaker_amps) continue;
    const k = `${c.breaker_amps}/${c.poles}`;
    const b = by.get(k) ?? { amps: c.breaker_amps, poles: c.poles, qty: 0, spares: 0 };
    b.qty += 1;
    if (c.kind === 'spare') b.spares += 1;
    by.set(k, b);
  }
  return [...by.values()].sort((a, b) => a.poles - b.poles || a.amps - b.amps);
}

/** Adds several panels' breaker counts together. */
export function sumBreakers(lists: BreakerCount[][]): BreakerCount[] {
  const by = new Map<string, BreakerCount>();
  for (const l of lists) for (const b of l) {
    const k = `${b.amps}/${b.poles}`;
    const t = by.get(k) ?? { amps: b.amps, poles: b.poles, qty: 0, spares: 0 };
    t.qty += b.qty; t.spares += b.spares; by.set(k, t);
  }
  return [...by.values()].sort((a, b) => a.poles - b.poles || a.amps - b.amps);
}

export interface CircuitStats {
  positions: number;   // the panel's circuit positions (given, or the highest one used, rounded up to even)
  used: number;        // positions taken by loads
  spare: number;       // positions taken by spare breakers
  space: number;       // positions empty
  breakers: number;    // breakers, of any size
}

export function circuitStats(panel: Pick<Panel, 'positions'>, circuits: Circuit[]): CircuitStats {
  const taken = (k: CircuitKind) => circuits.filter((c) => c.kind === k).reduce((n, c) => n + Math.max(1, c.poles), 0);
  const highest = circuits.reduce((m, c) => Math.max(m, ...takes(c)), 0);
  const positions = panel.positions ?? (highest % 2 ? highest + 1 : highest);
  const used = taken('load'), spare = taken('spare');
  return { positions, used, spare, space: Math.max(0, positions - used - spare), breakers: circuits.filter((c) => c.kind !== 'space' && c.breaker_amps).length };
}

/** Problems a person should fix before the counts can be trusted: overlapping breakers, circuits past the panel's size, breakers without a size. */
export function circuitProblems(panel: Pick<Panel, 'positions'>, circuits: Circuit[]): string[] {
  const out: string[] = [];
  const owner = new Map<number, number>();
  for (const c of circuits) {
    for (const n of takes(c)) {
      if (owner.has(n)) out.push(`Circuit ${n} is used twice (by the entries at ${owner.get(n)} and ${c.circuit}).`);
      else owner.set(n, c.circuit);
      if (panel.positions && n > panel.positions) out.push(`Circuit ${n} is past the panel's ${panel.positions} positions.`);
    }
    if (c.kind !== 'space' && !c.breaker_amps) out.push(`The ${c.kind === 'spare' ? 'spare' : 'breaker'} at circuit ${c.circuit} has no size.`);
  }
  return [...new Set(out)];
}

/** The next free circuit number for a new breaker of this many poles, on either side (odd first). */
export function nextFree(circuits: Circuit[], poles: number, positions: number | null): number | null {
  const used = new Set(circuits.flatMap(takes));
  const max = positions ?? 200;
  for (let n = 1; n <= max; n++) {
    const want = takes({ circuit: n, poles });
    if (want.every((m) => m <= max && !used.has(m))) return n;
  }
  return null;
}

/** "MCB 225 A", "MLO 600 A", or what is known. */
export const mainLabel = (p: Pick<Panel, 'main_type' | 'main_amps'>) =>
  [p.main_type, p.main_amps ? `${p.main_amps} A` : null].filter(Boolean).join(' ') || '';
