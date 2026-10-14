import type { PDFPageProxy } from 'pdfjs-dist';
import { api, apiPutBytes, ApiError } from '../auth/api.ts';
import { destroyPdf, openPdf, PdfOpenError } from '../viewer/pdf.ts';
import {
  CHUNK_BYTES, MAX_PAGES_PER_FILE, SHEET_BATCH_SIZE, THUMB_WIDTH_PX, UPLOAD_RETRIES, limitMessages,
} from '../../shared/limits.ts';
import { inferFloor, inferKind, readScale, readTitleBlock, type TextRun } from './titleBlock.ts';

export interface Progress { phase: 'uploading' | 'splitting' | 'done'; pct: number; text: string }
export interface UploadOptions {
  maxBytes: number;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

async function checkAbort(signal: AbortSignal, fileId: string | null) {
  if (!signal.aborted) return;
  if (fileId) await api(`/files/${fileId}/cancel`, { method: 'POST', body: {} }).catch(() => undefined);
  throw new DOMException('Upload cancelled', 'AbortError');
}

async function postChunk(fileId: string, index: number, blob: Blob) {
  const dataB64 = await blobToBase64(blob);
  let lastErr: unknown;
  for (let attempt = 0; attempt < UPLOAD_RETRIES; attempt++) {
    try {
      await api('/files/chunk', { body: { fileId, index, dataB64 } });
      return;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retryable) throw e;
      await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Converts pdf.js text items to normalized runs on the displayed page. Rotated text is skipped. */
async function pageText(page: PDFPageProxy): Promise<TextRun[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const it of content.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const len = Math.hypot(a, b) || 1;
    const [x1, y1] = vp.convertToViewportPoint(e, f);
    const [x2, y2] = vp.convertToViewportPoint(e + (a / len) * it.width, f + (b / len) * it.width);
    if (Math.abs(y2 - y1) > Math.abs(x2 - x1) * 0.2) continue; // not horizontal on the displayed page
    const h = Math.hypot(c, d) || it.height || 1;
    runs.push({ str: it.str, x: Math.min(x1, x2) / vp.width, y: (Math.min(y1, y2) - h) / vp.height, w: Math.abs(x2 - x1) / vp.width, h: h / vp.height });
  }
  return runs;
}

async function thumbnail(page: PDFPageProxy): Promise<Blob | null> {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: THUMB_WIDTH_PX / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  await page.render({ canvas, viewport: vp, annotationMode: 0 }).promise;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.72));
  canvas.width = canvas.height = 0; // release the bitmap
  return blob;
}

interface SheetMeta {
  page: number;
  number: string | null;
  title: string | null;
  kind: string;
  floor: string | null;
  scale: string | null;
  page_width_pt: number;
  page_height_pt: number;
  rotation: number;
  count_enabled: boolean;
  read_source: 'text' | 'manual';
  title_unsure: boolean;
}

export async function uploadDrawingSet(projectId: string, file: File, opts: UploadOptions): Promise<{ fileId: string; sheets: number }> {
  const { onProgress, signal } = opts;

  // 1. Choose: magic bytes and size, before anything leaves the browser.
  if (file.size > opts.maxBytes) throw new Error(limitMessages.tooBig(file.size, opts.maxBytes));
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== '%PDF-') throw new Error(limitMessages.notPdf);

  // 2. Begin.
  const begin = await api<{ fileId: string; chunkBytes: number; chunks: number }>('/files/begin', {
    body: { projectId, fileName: file.name, size: file.size },
  });
  const fileId = begin.fileId;

  try {
    // 3. Upload in 3 MB pieces: the first half of the progress bar.
    for (let i = 0; i < begin.chunks; i++) {
      await checkAbort(signal, fileId);
      await postChunk(fileId, i, file.slice(i * CHUNK_BYTES, Math.min(file.size, (i + 1) * CHUNK_BYTES)));
      const pct = ((i + 1) / begin.chunks) * 0.5;
      onProgress({ phase: 'uploading', pct, text: `Uploading… ${Math.round(pct * 200)}%` });
    }
    await checkAbort(signal, fileId);

    // 4. Commit: the server re-checks that every piece arrived.
    await api('/files/commit', { body: { fileId } });

    // 5. Read the pages in the browser. The file is already here, so no download.
    onProgress({ phase: 'splitting', pct: 0.5, text: 'Splitting… 0%' });
    let pdf;
    try {
      pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      throw e instanceof PdfOpenError ? e : new Error(limitMessages.brokenPdf);
    }
    if (pdf.numPages === 0) throw new Error(limitMessages.emptyPdf);
    if (pdf.numPages > MAX_PAGES_PER_FILE) throw new Error(limitMessages.tooManyPages(pdf.numPages));

    let created = 0;
    let batch: { meta: SheetMeta; thumb: Blob | null }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const res = await api<{ sheets: { id: string; page: number }[] }>(`/files/${fileId}/sheets`, { body: { sheets: batch.map((b) => b.meta) } });
      const byPage = new Map(batch.map((b) => [b.meta.page, b.thumb]));
      // Thumbnails are small; send a few at a time.
      const queue = [...res.sheets];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (queue.length) {
            const s = queue.shift()!;
            const t = byPage.get(s.page);
            if (t) await apiPutBytes(`/sheets/${s.id}/thumb`, t, 'image/jpeg').catch(() => undefined); // a missing thumbnail is not fatal
          }
        }),
      );
      created += batch.length;
      batch = [];
    };

    for (let n = 1; n <= pdf.numPages; n++) {
      await checkAbort(signal, fileId);
      let meta: SheetMeta;
      let thumb: Blob | null = null;
      try {
        const page = await pdf.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const runs = await pageText(page);
        const tb = readTitleBlock(runs);
        const kind = inferKind(tb.title, tb.number);
        const hasText = runs.length > 0;
        meta = {
          page: n,
          number: tb.number,
          title: tb.title,
          kind,
          floor: inferFloor(tb.title, tb.number, kind),
          scale: readScale(runs),
          page_width_pt: vp.width,
          page_height_pt: vp.height,
          rotation: page.rotate,
          count_enabled: kind === 'floor_plan', // plans on, legends and schedules off (Part 1, 1b)
          read_source: hasText && tb.number ? 'text' : 'manual',
          title_unsure: tb.unsure,
        };
        thumb = await thumbnail(page).catch(() => null);
        page.cleanup(); // release this page so memory stays flat
      } catch {
        // One unreadable page does not stop the file (spec 2.9).
        meta = {
          page: n, number: null, title: "Couldn't read this page", kind: 'other', floor: null, scale: null,
          page_width_pt: 792, page_height_pt: 612, rotation: 0, count_enabled: false, read_source: 'manual', title_unsure: true,
        };
      }
      batch.push({ meta, thumb });
      const pct = 0.5 + (n / pdf.numPages) * 0.5;
      onProgress({ phase: 'splitting', pct, text: `Splitting… ${Math.round((n / pdf.numPages) * 100)}%` });
      if (batch.length >= SHEET_BATCH_SIZE) await flush();
      await yieldToUi();
    }
    await flush();
    await destroyPdf(pdf);

    // 6/7. Finish.
    await api(`/files/${fileId}/finish`, { body: { pageCount: created } });
    onProgress({ phase: 'done', pct: 1, text: `${created} sheet${created === 1 ? '' : 's'} indexed` });
    return { fileId, sheets: created };
  } catch (e) {
    // Anything that goes wrong leaves nothing behind.
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (!aborted) {
      await api(`/files/${fileId}/finish`, { body: { error: (e instanceof Error ? e.message : 'Upload failed').slice(0, 280) } }).catch(() => undefined);
    }
    throw e;
  }
}
