// Moving and copying library items between projects. Written against a plain query function so the same SQL runs in
// the app (inside a transaction) and in the database tests.
export type Q = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** The id of the category called `name` in a project, created if it is not there yet. */
export async function categoryIn(q: Q, projectId: string, name: string): Promise<string> {
  const have = await q(`select id from item_categories where project_id = $1 and lower(name) = lower($2)`, [projectId, name]);
  if (have.rows[0]) return have.rows[0].id;
  const made = await q(
    `insert into item_categories (name, sort, project_id)
     values ($2, (select coalesce(max(sort), 0) + 1 from item_categories where project_id = $1), $1) returning id`,
    [projectId, name],
  );
  return made.rows[0].id;
}

const sameItem = (q: Q, projectId: string, code: string, name: string) =>
  q(`select 1 from item_types where project_id = $1 and lower(code) = lower($2) and lower(name) = lower($3)`, [projectId, code, name]);

/** Adds unassigned (pre-project) items to a project, with their categories. An item the project already has is skipped. */
export async function claimItems(q: Q, projectId: string, itemIds: string[] | null): Promise<{ moved: number; skipped: number }> {
  const legacy = await q(
    `select i.id, i.code, i.name, c.name as cat from item_types i left join item_categories c on c.id = i.category_id
      where i.project_id is null order by i.code, i.created_at, i.id`, []);
  let moved = 0, skipped = 0;
  for (const it of legacy.rows) {
    if (itemIds && !itemIds.includes(it.id)) continue;
    if ((await sameItem(q, projectId, it.code, it.name)).rows[0]) { skipped++; continue; }
    const cat = it.cat ? await categoryIn(q, projectId, it.cat) : null;
    await q(`update item_types set project_id = $2, category_id = $3 where id = $1`, [it.id, projectId, cat]);
    moved++;
  }
  return { moved, skipped };
}

/** Copies one project's library into another (items and categories), leaving out what the target already has. */
export async function copyLibrary(q: Q, fromProject: string, toProject: string, actorId: string): Promise<{ copied: number; skipped: number }> {
  const src = await q(
    `select i.code, i.name, i.spec, i.unit, i.marker_shape, i.marker_glyph, c.name as cat
       from item_types i left join item_categories c on c.id = i.category_id
      where i.project_id = $1 order by i.code, i.created_at, i.id`, [fromProject]);
  let copied = 0, skipped = 0;
  for (const it of src.rows) {
    if ((await sameItem(q, toProject, it.code, it.name)).rows[0]) { skipped++; continue; }
    const cat = it.cat ? await categoryIn(q, toProject, it.cat) : null;
    await q(
      `insert into item_types (code, name, spec, category_id, unit, marker_shape, marker_glyph, created_by, project_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [it.code, it.name, it.spec, cat, it.unit, it.marker_shape, it.marker_glyph, actorId, toProject]);
    copied++;
  }
  return { copied, skipped };
}

/**
 * Deletes an item's counts: on every sheet, or on one sheet. `autoOnly` keeps the counts placed by hand.
 * Each affected sheet's version moves on, so anyone with that sheet open picks the change up.
 */
export async function clearItemCounts(q: Q, itemId: string, opts: { sheetId?: string | null; autoOnly?: boolean } = {}): Promise<{ deleted: number; sheets: number }> {
  const sheetId = opts.sheetId ?? null;
  const autoOnly = opts.autoOnly === true;
  const gone = await q(
    `delete from detections
      where item_type_id = $1 and ($2::uuid is null or sheet_id = $2::uuid) and ($3::boolean = false or source = 'auto')
      returning sheet_id`, [itemId, sheetId, autoOnly]);
  const sheets = [...new Set(gone.rows.map((r) => r.sheet_id as string))];
  for (const sid of sheets) await q(`update sheets set version = version + 1 where id = $1`, [sid]);
  return { deleted: gone.rows.length, sheets: sheets.length };
}
