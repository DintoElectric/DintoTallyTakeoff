import type { Context } from '@netlify/functions';
import { requireRole, type Actor } from './_lib/auth.ts';
import { db, transaction } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { int, num, oneOf, onlyKeys, reqStr, str, uuid } from './_lib/validate.ts';
import { chunkKeys, deleteKeys, exists, getBytes, keys, putBytes, sleep } from './_lib/blobs.ts';
import { CHUNK_BYTES, MAX_PAGES_PER_FILE, SHEET_BATCH_SIZE, limitMessages } from '../../shared/limits.ts';
import { maxFileBytes } from './_lib/limits.ts';

interface FileRow {
  id: string;
  project_id: string;
  file_name: string;
  size_bytes: number;
  page_count: number | null;
  chunk_count: number;
  rev_no: number;
  upload_status: 'uploading' | 'processing' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  uploaded_by: string;
}

const FILE_COLS = `id, project_id, file_name, size_bytes::float8 as size_bytes, page_count, chunk_count, rev_no, upload_status, progress, error, uploaded_by`;

async function loadFile(id: string): Promise<FileRow> {
  const rows = await db().pool.query(`select ${FILE_COLS} from drawing_files where id = $1`, [id]);
  if (!rows.rows[0]) throw notFound('That drawing set');
  return rows.rows[0] as FileRow;
}

function publicFile(f: FileRow) {
  const { uploaded_by: _u, progress: _p, ...rest } = f;
  return rest;
}

/** The uploader (or an admin) may continue or cancel an upload. */
function ownUpload(f: FileRow, actor: Actor) {
  if (f.uploaded_by !== actor.id && actor.role !== 'admin') {
    throw new HttpError(403, 'Only the person who started this upload can change it.');
  }
}

function safeFileName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'drawings.pdf').slice(0, 200);
}

async function resetProjectStatusIfIdle(projectId: string) {
  await db().sql`
    update projects set status = 'counting', updated_at = now()
     where id = ${projectId} and status = 'splitting'
       and not exists (select 1 from drawing_files where project_id = ${projectId}
                        and upload_status in ('uploading','processing'))`;
}

async function purgeFile(f: Pick<FileRow, 'id' | 'chunk_count'>) {
  const sheets = await db().sql<{ id: string }>`select id from sheets where file_id = ${f.id}`;
  await db().sql`delete from drawing_files where id = ${f.id}`;
  await deleteKeys([...chunkKeys(f.id, f.chunk_count), ...sheets.map((s) => keys.thumb(s.id))]);
}

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req); // ['files', ...]
  const sql = db().sql;
  const second = seg[1];

  // GET /api/files?project=ID
  if (!second && req.method === 'GET') {
    await requireRole('viewer');
    const project = uuid(new URL(req.url).searchParams.get('project'), 'project id');
    const rows = await db().pool.query(`select ${FILE_COLS} from drawing_files where project_id = $1 order by rev_no, created_at`, [project]);
    return json({ files: (rows.rows as FileRow[]).map(publicFile) });
  }

  // POST /api/files/begin
  if (second === 'begin' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['projectId', 'fileName', 'size']);
    const projectId = uuid(b.projectId, 'project id');
    const fileName = safeFileName(reqStr(b.fileName, 'File name'));
    const size = int(b.size, 'File size', 1, Number.MAX_SAFE_INTEGER);
    const max = maxFileBytes();
    if (size > max) throw new HttpError(413, limitMessages.tooBig(size, max));
    const [proj] = await sql<{ id: string }>`select id from projects where id = ${projectId} and archived_at is null`;
    if (!proj) throw notFound('That project');
    const chunks = Math.ceil(size / CHUNK_BYTES);
    const [{ next_rev }] = await sql<{ next_rev: number }>`select (coalesce(max(rev_no), 0) + 1)::int as next_rev from drawing_files where project_id = ${projectId} and upload_status = 'ready'`;
    const [row] = await sql<{ id: string }>`
      insert into drawing_files (project_id, file_name, size_bytes, chunk_count, rev_no, uploaded_by)
      values (${projectId}, ${fileName}, ${size}, ${chunks}, ${next_rev}, ${actor.id}) returning id`;
    await sql`update projects set status = 'splitting', updated_at = now() where id = ${projectId}`;
    return json({ fileId: row.id, chunkBytes: CHUNK_BYTES, chunks }, 201);
  }

  // POST /api/files/chunk
  if (second === 'chunk' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['fileId', 'index', 'dataB64']);
    const f = await loadFile(uuid(b.fileId, 'file id'));
    ownUpload(f, actor);
    if (f.upload_status !== 'uploading') throw new HttpError(409, 'This upload is no longer accepting data.');
    const index = int(b.index, 'Chunk number', 0, f.chunk_count - 1);
    if (typeof b.dataB64 !== 'string' || b.dataB64.length > Math.ceil((CHUNK_BYTES * 4) / 3) + 16) {
      throw new HttpError(413, 'That piece of the file is too large.');
    }
    const bytes = Buffer.from(b.dataB64, 'base64');
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new HttpError(400, 'That piece of the file is empty or too large.');
    if (index === 0 && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(400, limitMessages.notPdf);
    }
    await putBytes(keys.chunk(f.id, index), bytes, 'application/octet-stream');
    return json({ ok: true, index });
  }

  // POST /api/files/commit
  if (second === 'commit' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const b = await readJson(req);
    onlyKeys(b, ['fileId']);
    const f = await loadFile(uuid(b.fileId, 'file id'));
    ownUpload(f, actor);
    if (f.upload_status === 'processing') return json({ ok: true });
    if (f.upload_status !== 'uploading') throw new HttpError(409, 'This upload is not in progress.');
    // Storage can lag behind writes: re-check missing pieces for a few seconds.
    let missing: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      missing = [];
      for (let n = 0; n < f.chunk_count; n++) if (!(await exists(keys.chunk(f.id, n)))) missing.push(n);
      if (missing.length === 0) break;
      await sleep(1000);
    }
    if (missing.length) {
      throw new HttpError(409, `Part of the file didn't arrive (${missing.length} piece${missing.length === 1 ? '' : 's'}). Please upload it again.`);
    }
    await sql`update drawing_files set upload_status = 'processing', progress = 0.5 where id = ${f.id}`;
    return json({ ok: true });
  }

  const fileId = second ? uuid(second, 'file id') : null;
  if (!fileId) throw new HttpError(404, 'That address was not found.');
  const action = seg[2];

  // GET /api/files/:id/chunk/:n
  if (action === 'chunk' && req.method === 'GET') {
    await requireRole('viewer');
    const f = await loadFile(fileId);
    const n = int(Number(seg[3]), 'Chunk number', 0, Math.max(0, f.chunk_count - 1));
    let bytes = await getBytes(keys.chunk(f.id, n));
    for (let attempt = 0; !bytes && attempt < 3; attempt++) {
      await sleep(500);
      bytes = await getBytes(keys.chunk(f.id, n));
    }
    if (!bytes) throw notFound('That part of the file');
    return new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' },
    });
  }

  // POST /api/files/:id/sheets  (batches of up to 50)
  if (action === 'sheets' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const f = await loadFile(fileId);
    ownUpload(f, actor);
    if (f.upload_status !== 'processing') throw new HttpError(409, 'This upload is not ready for sheets.');
    const b = await readJson(req);
    onlyKeys(b, ['sheets']);
    if (!Array.isArray(b.sheets) || b.sheets.length === 0 || b.sheets.length > SHEET_BATCH_SIZE) {
      throw new HttpError(400, `Send between 1 and ${SHEET_BATCH_SIZE} sheets at a time.`);
    }
    const kinds = ['floor_plan', 'legend', 'site_plan', 'schedule', 'other'] as const;
    const sources = ['text', 'ocr', 'manual'] as const;
    const created = await transaction(async (q) => {
      const out: { id: string; page: number }[] = [];
      for (const raw of b.sheets as Record<string, unknown>[]) {
        onlyKeys(raw, ['page', 'number', 'title', 'kind', 'floor', 'scale', 'page_width_pt', 'page_height_pt', 'rotation', 'count_enabled', 'read_source', 'title_unsure']);
        const r = await q(
          `insert into sheets (project_id, file_id, page, number, title, kind, floor, scale, page_width_pt, page_height_pt,
                               rotation, count_enabled, read_source, title_unsure)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (file_id, page) do update set number = excluded.number, title = excluded.title, kind = excluded.kind,
                floor = excluded.floor, scale = excluded.scale, page_width_pt = excluded.page_width_pt,
                page_height_pt = excluded.page_height_pt, rotation = excluded.rotation,
                count_enabled = excluded.count_enabled, read_source = excluded.read_source, title_unsure = excluded.title_unsure
           returning id, page`,
          [
            f.project_id,
            f.id,
            int(raw.page, 'Page', 1, MAX_PAGES_PER_FILE),
            str(raw.number, 'Sheet number', { max: 60 }),
            str(raw.title, 'Sheet title', { max: 200 }),
            oneOf(raw.kind ?? 'other', kinds, 'Kind'),
            str(raw.floor, 'Floor', { max: 60 }),
            str(raw.scale, 'Scale', { max: 60 }),
            num(raw.page_width_pt, 'Page width', 1, 100000),
            num(raw.page_height_pt, 'Page height', 1, 100000),
            int(raw.rotation ?? 0, 'Rotation', 0, 359),
            raw.count_enabled === true,
            oneOf(raw.read_source ?? 'text', sources, 'Read source'),
            raw.title_unsure === true,
          ],
        );
        out.push(r.rows[0]);
      }
      return out;
    });
    return json({ sheets: created }, 201);
  }

  // POST /api/files/:id/finish
  if (action === 'finish' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    const f = await loadFile(fileId);
    ownUpload(f, actor);
    const b = await readJson(req);
    onlyKeys(b, ['pageCount', 'error']);
    if (b.error) {
      const msg = reqStr(b.error, 'Error', 300);
      await sql`update drawing_files set upload_status = 'failed', error = ${msg} where id = ${f.id}`;
      await purgeFile(f); // a failed set leaves nothing behind
      await resetProjectStatusIfIdle(f.project_id);
      return json({ ok: false, error: msg });
    }
    const pageCount = int(b.pageCount, 'Page count', 1, MAX_PAGES_PER_FILE);
    await sql`update drawing_files set upload_status = 'ready', page_count = ${pageCount}, progress = 1, error = null where id = ${f.id}`;
    await resetProjectStatusIfIdle(f.project_id);
    return json({ ok: true });
  }

  // POST /api/files/:id/cancel  (uploader or admin; removes the partial upload)
  if (action === 'cancel' && req.method === 'POST') {
    const actor = await requireRole('estimator');
    let f: FileRow;
    try {
      f = await loadFile(fileId);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return json({ ok: true }); // already gone is success
      throw e;
    }
    ownUpload(f, actor);
    if (f.upload_status === 'ready') throw new HttpError(409, 'This drawing set is already uploaded. Ask an admin to delete it.');
    await purgeFile(f);
    await resetProjectStatusIfIdle(f.project_id);
    return json({ ok: true });
  }

  // DELETE /api/files/:id  (admin; removes the set, its sheets and detections)
  if (!action && req.method === 'DELETE') {
    await requireRole('admin');
    let f: FileRow;
    try {
      f = await loadFile(fileId);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return json({ ok: true });
      throw e;
    }
    await purgeFile(f);
    await resetProjectStatusIfIdle(f.project_id);
    return json({ ok: true });
  }

  throw methodNotAllowed();
});
