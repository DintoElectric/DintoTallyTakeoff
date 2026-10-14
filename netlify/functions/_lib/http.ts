import type { Context } from '@netlify/functions';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Path segments after the resource prefix. Works for both the public
 * `/api/<resource>/...` URL and the raw `/.netlify/functions/<resource>/...`
 * URL, so it does not matter which one the runtime reports for a rewrite.
 * Result: [resource, ...rest].
 */
export function segments(req: Request): string[] {
  const path = new URL(req.url).pathname;
  const m = path.match(/\/(?:api|\.netlify\/functions)\/(.*)$/);
  return (m ? m[1] : '').split('/').filter(Boolean).map(decodeURIComponent);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return body as T;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

type Handler = (req: Request, ctx: Context) => Promise<Response>;

/** Wraps a handler so every failure becomes `{ error }` with a plain message. */
export function handle(fn: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const code = (e as { code?: string } | null)?.code;
      if (code === '23505') return json({ error: 'That already exists.' }, 409);
      if (code === '23503') return json({ error: 'That refers to something that no longer exists.' }, 409);
      if (code === '22P02' || code === '23514') return json({ error: 'One of the values was not valid.' }, 400);
      console.error('Unhandled function error', e);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  };
}

export const methodNotAllowed = () => new HttpError(405, 'That action is not supported.');
export const notFound = (what = 'That') => new HttpError(404, `${what} was not found.`);
