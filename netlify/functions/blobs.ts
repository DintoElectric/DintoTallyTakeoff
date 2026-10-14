import { getStore } from '@netlify/blobs';

// All files live in one store; every read goes through a function that checks the user.
const store = () => getStore({ name: 'tally-files' });

export const keys = {
  chunk: (fileId: string, n: number) => `files/${fileId}/${n}`,
  thumb: (sheetId: string) => `thumbs/${sheetId}.jpg`,
  symbol: (itemTypeId: string) => `symbols/${itemTypeId}.png`,
  sample: (itemTypeId: string, sampleId: string) => `samples/${itemTypeId}/${sampleId}.png`,
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function putBytes(key: string, bytes: Uint8Array | ArrayBuffer, contentType: string) {
  const ab = bytes instanceof ArrayBuffer ? bytes : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  await store().set(key, ab, { metadata: { contentType } });
}

export async function getBytes(key: string): Promise<ArrayBuffer | null> {
  return (await store().get(key, { type: 'arrayBuffer' })) ?? null;
}

export async function exists(key: string): Promise<boolean> {
  return (await store().getMetadata(key)) !== null;
}

/**
 * Delete by exact key, never by listing a folder (listings can lag, spec 2.2).
 * Deleting something that is already gone counts as success.
 */
export async function deleteKeys(list: string[]): Promise<void> {
  const s = store();
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(
      list.slice(i, i + 10).map(async (k) => {
        try {
          await s.delete(k);
        } catch (e) {
          console.warn('blob delete failed (treated as gone)', k, e);
        }
      }),
    );
  }
}

export const chunkKeys = (fileId: string, chunkCount: number) =>
  Array.from({ length: chunkCount }, (_, n) => keys.chunk(fileId, n));
