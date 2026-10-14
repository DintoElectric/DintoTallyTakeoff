// Every limit and constant lives here (spec 2.17). Imported by both the browser
// bundle and the Netlify functions. Each user-facing limit has a plain message.

export const APP_NAME = 'Tally'; // placeholder product name (spec decision 9)

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_PAGES_PER_FILE = 400;
export const CHUNK_BYTES = 3 * 1024 * 1024;
export const STALE_UPLOAD_MS = 60 * 60 * 1000;
export const BATCH_MAX_OPS = 500;
export const SHEET_BATCH_SIZE = 50;
export const AUTOSAVE_DELAY_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 5000;
export const AUTOSAVE_RETRY_MS = 6000;
export const TEAMMATE_POLL_MS = 15000;
export const BASE_MAX_PX = 8e6;
export const DETAIL_MAX_PX = 9e6;
export const THUMB_WIDTH_PX = 300;
export const DEFAULT_REVIEW_THRESHOLD = 0.85;
export const MARKER_CANVAS_SWITCH = 2000; // canvas overlay is used for every sheet; see viewer/MarkerLayer
export const MAX_STR = 200;
export const MAX_NOTE = 2000;
export const UPLOAD_RETRIES = 3;

export const limitMessages = {
  tooBig: (bytes: number, max = MAX_FILE_BYTES) =>
    `This file is ${Math.round(bytes / 1048576)} MB. Drawing sets can be up to ${Math.round(max / 1048576)} MB. Split it or reduce its size.`,
  tooManyPages: (pages: number) =>
    `This drawing set has ${pages} pages. The limit is ${MAX_PAGES_PER_FILE} pages per file. Split it into smaller sets.`,
  notPdf: "That isn't a PDF.",
  passwordPdf: 'This PDF is password protected. Remove the password and upload it again.',
  brokenPdf: "This PDF couldn't be opened. It may be damaged. Try exporting it again from the CAD or PDF program.",
  emptyPdf: 'This PDF has no pages.',
} as const;
