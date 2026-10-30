// Which sheets Auto-count leaves alone. Schedules and legends (their tables list tags, they are not fixtures on a plan), and
// architectural drawings: their tags are wall types, doors and rooms, not electrical devices. Architectural sheets are told
// by their number: A1.02B, A0.03, A10.02 and AD (demolition) sheets; not AV (audio-visual), whose devices are counted.
export const isArchitectural = (s: { number: string | null }) => /^A(D)?\s?-?\d/i.test((s.number ?? '').trim());

export type Skipped = 'schedule' | 'legend' | 'architectural';
/** Why Auto-count skips a sheet, or null when it counts it. */
export const autoCountSkips = (s: { kind: string; number: string | null }): Skipped | null =>
  s.kind === 'schedule' ? 'schedule' : s.kind === 'legend' ? 'legend' : isArchitectural(s) ? 'architectural' : null;

/**
 * What kind of plan a sheet is, from its title: a lighting plan counts fixtures, a power plan devices, a fire alarm plan fire
 * alarm devices. Decides between library items sharing a code (a fixture C and a receptacle C). Null when the title says
 * neither.
 */
export const planGroup = (s: { title: string | null }): 'fixture' | 'device' | 'fire_alarm' | null => {
  const t = (s.title ?? '').toUpperCase();
  return /FIRE ALARM/.test(t) ? 'fire_alarm' : /LIGHTING/.test(t) ? 'fixture' : /POWER|SYSTEMS|TECHNOLOGY|TELECOM|\bDATA\b|SECURITY|AUDIO/.test(t) ? 'device' : null;
};
