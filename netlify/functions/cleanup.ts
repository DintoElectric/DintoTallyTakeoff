import type { Config } from '@netlify/functions';
import { db } from './_lib/db.ts';
import { chunkKeys, deleteKeys, keys } from './_lib/blobs.ts';
import { STALE_UPLOAD_MS } from '../../shared/limits.ts';

// Half-finished uploads (tab closed mid-upload) are removed after an hour (spec 2.9).
export default async () => {
  const sql = db().sql;
  const cutoff = new Date(Date.now() - STALE_UPLOAD_MS).toISOString();
  const stale = await sql<{ id: string; chunk_count: number; project_id: string }>`
    select id, chunk_count, project_id from drawing_files
     where upload_status in ('uploading', 'processing') and created_at < ${cutoff}::timestamptz`;
  for (const f of stale) {
    const sheets = await sql<{ id: string }>`select id from sheets where file_id = ${f.id}`;
    await sql`delete from drawing_files where id = ${f.id}`;
    await deleteKeys([...chunkKeys(f.id, f.chunk_count), ...sheets.map((s) => keys.thumb(s.id))]);
    await sql`
      update projects set status = 'counting', updated_at = now()
       where id = ${f.project_id} and status = 'splitting'
         and not exists (select 1 from drawing_files where project_id = ${f.project_id}
                          and upload_status in ('uploading','processing'))`;
  }
  return new Response(JSON.stringify({ removed: stale.length }));
};

export const config: Config = { schedule: '@hourly' };
