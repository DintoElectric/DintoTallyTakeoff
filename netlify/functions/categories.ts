import type { Context } from '@netlify/functions';
import { requireRole } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { int, onlyKeys, reqStr, uuid } from './_lib/validate.ts';

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req);
  const sql = db().sql;
  if (!seg[1]) {
    if (req.method === 'GET') {
      await requireRole('viewer');
      return json({ categories: await sql`select id, name, sort from item_categories order by sort, name` });
    }
    if (req.method === 'POST') {
      await requireRole('estimator');
      const b = await readJson(req);
      onlyKeys(b, ['name']);
      const name = reqStr(b.name, 'Category name', 60);
      const [row] = await sql`
        insert into item_categories (name, sort)
        values (${name}, (select coalesce(max(sort), 0) + 1 from item_categories))
        returning id, name, sort`;
      return json({ category: row }, 201);
    }
    throw methodNotAllowed();
  }
  const id = uuid(seg[1], 'category id');
  if (req.method === 'PATCH') {
    await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['name', 'sort']);
    const [cur] = await sql<{ name: string; sort: number }>`select name, sort from item_categories where id = ${id}`;
    if (!cur) throw notFound('That category');
    const name = 'name' in b ? reqStr(b.name, 'Category name', 60) : cur.name;
    const sort = 'sort' in b ? int(b.sort, 'Order', 0, 10000) : cur.sort;
    const [row] = await sql`update item_categories set name = ${name}, sort = ${sort} where id = ${id} returning id, name, sort`;
    return json({ category: row });
  }
  throw new HttpError(405, 'That action is not supported.');
});
