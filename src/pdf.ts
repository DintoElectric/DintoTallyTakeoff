import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { apiBytes } from '../auth/api.ts';
import { limitMessages } from '../../shared/limits.ts';

// The pdf.js worker is bundled with the app (no CDN), which keeps the CSP tight.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// CMaps, standard fonts and wasm decoders are copied into /pdfjs by scripts/copy-pdfjs-assets.mjs.
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
};

export class PdfOpenError extends Error {}

/** Opens a PDF from bytes. Plain-language errors for password-protected and damaged files. */
export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  try {
    const task = pdfjs.getDocument({ data, ...ASSETS });
    return await task.promise;
  } catch (e) {
    if (e instanceof pdfjs.PasswordException) throw new PdfOpenError(limitMessages.passwordPdf);
    if (e instanceof pdfjs.InvalidPDFException) throw new PdfOpenError(limitMessages.brokenPdf);
    throw new PdfOpenError(limitMessages.brokenPdf);
  }
}

export interface FileRef { id: string; chunk_count: number }

const cache = new Map<string, Promise<PDFDocumentProxy>>();
const MAX_CACHED = 2;

/** Downloads a stored drawing set piece by piece and opens it. Cached for the session. */
export function loadFilePdf(file: FileRef, onProgress?: (pct: number) => void): Promise<PDFDocumentProxy> {
  const hit = cache.get(file.id);
  if (hit) {
    // refresh recency
    cache.delete(file.id);
    cache.set(file.id, hit);
    return hit;
  }
  const p = (async () => {
    const parts: Uint8Array[] = new Array(file.chunk_count);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < file.chunk_count) {
        const n = next++;
        parts[n] = new Uint8Array(await apiBytes(`/files/${file.id}/chunk/${n}`));
        done++;
        onProgress?.(done / file.chunk_count);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const total = parts.reduce((s, a) => s + a.length, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const a of parts) {
      bytes.set(a, off);
      off += a.length;
    }
    return openPdf(bytes);
  })();
  cache.set(file.id, p);
  p.catch(() => cache.delete(file.id));
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string;
    const old = cache.get(oldest);
    cache.delete(oldest);
    old?.then(destroyPdf).catch(() => undefined);
  }
  return p;
}

/** Frees a document and its worker resources (pdf.js 6: via the loading task). */
export function destroyPdf(doc: PDFDocumentProxy): Promise<void> {
  return doc.loadingTask.destroy();
}

export function clearPdfCache() {
  for (const p of cache.values()) p.then(destroyPdf).catch(() => undefined);
  cache.clear();
}

/** Page size as displayed (honouring the page's own rotation), in PDF points. */
export function pageSize(page: PDFPageProxy) {
  const vp = page.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
}

export { pdfjs };
