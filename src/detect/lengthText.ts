// How long is one of these fixtures, according to its schedule entry? Used to fill the "length each (ft)" of linear
// fixtures (strips, slots, wraparounds), so the export can total their footage. Only a length the schedule states
// plainly is returned; anything ambiguous or variable gives null, because a wrong length would silently corrupt a total.

const LINEAR = /STRIP|LINEAR|SLOT|WRAPAROUND|CHANNEL|TAPE|BATTEN|TRACK|GRAZER|PERIMETER|COVE/;
// The length is left to the drawings: continuous runs, "length as shown", or a per-foot rating.
const VARIABLE = /CONTINUOUS\s+(?:RUN\s+)?LENGTHS?|LENGTHS?\s+(?:AS\s+)?(?:SHOWN|INDICATED)|AS\s+(?:SHOWN|INDICATED)\s+(?:ON|IN)\s+(?:THE\s+)?(?:PLANS?|DRAWINGS?)|\bLENGTHS?\s+AS\s+REQUIRED\b|RUN\s+LENGTHS?|\/\s*LF\b|PER\s+(?:LINEAR\s+)?(?:FOOT|FT)\b|\bINCREMENTS?\b|\bPER\s+PLANS?\b|LENGTH\s+PER\s+PLANS?/;
const sane = (n: number) => (Number.isFinite(n) && n >= 0.5 && n <= 100 ? Math.round(n * 100) / 100 : null);

/**
 * `description` is the schedule's description, `catalog` its catalog number, `rated` any lumens/watts text
 * ("700 LM/LF" means a per-foot rating, so the length is not fixed).
 */
export function lengthFeetFromText(description: string, catalog = '', rated = ''): number | null {
  const d = description.toUpperCase(), c = catalog.toUpperCase(), r = rated.toUpperCase();
  if (!LINEAR.test(d) || VARIABLE.test(`${d} ${r}`)) return null;

  // 1. Stated in the description: "4'L", "8' L", "4 FOOT LONG", "4-FOOT", "4 FEET", "4 FT". One distinct length only.
  const found = new Set<number>();
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)\s*'\s*L\b/g)) found.add(Number(m[1]));
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)\s*-?\s*(?:FOOT|FEET|FT)\b/g)) found.add(Number(m[1]));
  // "16' LED SUSPENDED LINEAR": a length leading the description (not a size "2' X 4'", not a "3' DIAMETER")
  const lead = /^\s*(\d+(?:\.\d+)?)\s*'(?:\s*-\s*\d+\s*")?\s+(?!X\b|DIA)/.exec(d);
  if (lead) found.add(Number(lead[1]));
  if (found.size > 1) return null;                       // "2 FOOT, 3 FOOT AND 4 FOOT": it depends
  if (found.size === 1) return sane([...found][0]);

  // 2. Otherwise from the catalog number: "6FT0IN", "4FT", or a length code L48 / L96 (inches). Only the standard
  //    lengths count as a code, so lumen and wattage codes such as L50 or L62 are left alone.
  const fi = /(?:^|[\s-])(\d+)FT(\d+)IN(?=$|[\s-])/.exec(c);
  if (fi) return sane(Number(fi[1]) + Number(fi[2]) / 12);
  const ft = /(?:^|[\s-])(\d+)\s*FT(?=$|[\s-])/.exec(c);
  if (ft) return sane(Number(ft[1]));
  const li = /(?:^|[\s-])L(24|36|48|60|72|84|96|120)(?=$|[\s-])/.exec(c);
  if (li) return sane(Number(li[1]) / 12);
  return null;
}

/**
 * True for a linear fixture whose length is left to the drawings: no length in the library, none stated in its schedule text
 * (or the text says "specified in 1\" increments", "length per plans"). These are measured on the plans.
 */
export function measuredOnPlans(item: { name: string; spec?: string | null; length_ft?: number | null }): boolean {
  if (item.length_ft != null) return false;
  if (!LINEAR.test(item.name.toUpperCase()) && !LINEAR.test((item.spec ?? '').toUpperCase())) return false;
  return lengthFeetFromText(item.name, item.spec ?? '') == null;
}
