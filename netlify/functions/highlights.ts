// Highlights on a sheet: translucent marks drawn over the drawing, saved one by one.
//   GET    /api/highlights?sheet=<id>      -> { highlights }     (viewer)
//   POST   /api/highlights { sheet_id, kind, color, width, points } -> { highlight }   (estimator)
//   DELETE /api/highlights/:id             -> { ok }             (estimator)
//   DELETE /api/highlights?sheet=<id>      -> { ok, removed }    (estimator: clear the sheet)
import type { Context } from '@netlify/functions';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, readJson, segments } from './_lib/http.ts';
import { requireRole } from './_lib/auth.ts';
import { num, oneOf, onlyKeys, uuid } from './_lib/validate.ts';

const KINDS = ['free', 'line', 'rect'] as const;
const COLORS = ['yellow', 'green', 'pink', 'blue'] as const;
const COLS = `id, sheet_id, kind, color, width::float8 as width, points, created_by_name, created_at`;

/** The points of a highlight: [x, y] pairs on the page (0..1), at least two, at most 2000. */
function pointsOf(v: unknown): [number, number][] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 2000) throw new HttpError(400, 'A highlight needs between 2 and 2000 points.');
  return v.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= -0.05 && c <= 1.05)) throw new HttpError(400, 'A highlight point is not valid.');
    return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5] as [number, number];
  });
}

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req);   // ['highlights', id?]
  const id = seg[1] ? uuid(seg[1], 'highlight id') : null;
  const url = new URL(req.url);
  const sql = db().sql;
  if (!id && req.method === 'GET') {
    await requireRole('viewer');
    const sheet = uuid(url.searchParams.get('sheet'), 'sheet');
    return json({ highlights: (await db().pool.query(`select ${COLS} from highlights where sheet_id = $1 order by created_at, id`, [sheet])).rows });
  }
  if (!id && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['sheet_id', 'kind', 'color', 'width', 'points']);
    const sheet = uuid(b.sheet_id, 'sheet');
    const [exists] = await sql`select 1 from sheets where id = ${sheet}`;
    if (!exists) throw new HttpError(404, 'That sheet no longer exists.');
    const kind = oneOf(b.kind, KINDS, 'Kind'), color = oneOf(b.color, COLORS, 'Colour');
    const width = num(b.width, 'Width', 0.5, 200);
    const points = pointsOf(b.points);
    if (kind !== 'free' && points.length !== 2) throw new HttpError(400, 'A straight or box highlight has two points.');
    const { rows } = await db().pool.query(`insert into highlights (sheet_id, kind, color, width, points, created_by, created_by_name) values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning ${COLS}`,
      [sheet, kind, color, width, JSON.stringify(points), actor.id, actor.name]);
    return json({ highlight: rows[0] }, 201);
  }
  if (id && req.method === 'DELETE') {
    await requireRole('estimator');
    await sql`delete from highlights where id = ${id}`;   // already gone is fine
    return json({ ok: true });
  }
  if (!id && req.method === 'DELETE') {
    await requireRole('estimator');
    const sheet = uuid(url.searchParams.get('sheet'), 'sheet');
    const rows = await sql`delete from highlights where sheet_id = ${sheet} returning id`;
    return json({ ok: true, removed: rows.length });
  }
  throw methodNotAllowed();
});
