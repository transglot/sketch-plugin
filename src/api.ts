/**
 * The transglot deploy API client for the Sketch plugin. A self-contained copy of the
 * Figma plugin's client (packages/figma-plugin/src/api.ts) — problem+json parsing,
 * multipart push, X-Skipped-Keys, Retry-After retry — trimmed to what the plugin needs:
 * project, push, translate, batch, pull.
 *
 * PURE: it never imports the Sketch runtime (`sketch`, `sketch/dom`, …). `fetch` is
 * injected so vitest exercises every path with a fake; the Sketch host adapter passes the
 * native transport. Duplicated per plugin package on purpose (each package is a
 * standalone, self-contained build).
 */

/** Every user-facing failure. `slug` is the problem slug; `hint` is the what-to-do-next line. */
export class ApiError extends Error {
  constructor(
    readonly slug: string,
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Parsed RFC 7807 body. slug is derived from `type: "/problems/{slug}"` — never a wire field. */
interface Problem {
  slug: string;
  status: number;
  title: string;
  detail?: string;
  extensions: Record<string, unknown>;
}

export interface ProjectInfo {
  id: number;
  name: string;
  slug: string;
  source_locale: string;
  locales: { locale: string; name: string; rtl: boolean; is_source: boolean }[];
  keys_count: number;
}

export type BatchStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

/** Active = pending|processing; everything else is terminal (BatchStatus::isTerminal parity). */
export function isTerminal(status: BatchStatus): boolean {
  return status !== 'pending' && status !== 'processing';
}

export interface Batch {
  id: number;
  status: BatchStatus;
  total: number;
  completed: number;
  failed: number;
}

export interface PushDiff {
  keys_created: number;
  keys_deleted: number;
  source_updated: number;
  translations_written: number;
  conflicts: { key: string; locale: string; reason: string }[];
  unknown_keys: string[];
  warnings: string[];
  batch: Batch | null;
  quota_exceeded: boolean;
}

export interface Entry {
  key: string;
  text: string;
}

/** Scope of an AI batch (POST /translate). Default 'missing' translates untranslated keys. */
export type TranslateScope = 'missing' | 'selected' | 'stale' | 'all';

export interface ApiClient {
  project(): Promise<ProjectInfo>;
  push(p: { entries: Entry[]; sourceLocale: string }): Promise<PushDiff>; // json_flat, mode=merge
  translate(scope?: TranslateScope): Promise<Batch>; // POST /v1/translate (manage)
  batch(id: number): Promise<Batch>;
  pull(q: {
    locale: string;
    minState?: string;
  }): Promise<{ entries: Record<string, string>; skippedKeys: number }>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_CAP_S = 60;
const MAX_RATE_LIMIT_RETRIES = 2;

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type HttpTransport = (
  url: string,
  request: HttpRequest,
) => Promise<HttpResponse>;

export function createClient(opts: {
  url: string;
  token: string;
  version: string;
  fetchImpl: HttpTransport; // the host supplies Cocoa networking, tests supply a transport
  sleep?: (ms: number) => Promise<void>; // injected in tests (Retry-After waits)
}): ApiClient {
  const fetchImpl = opts.fetchImpl;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const base = `${opts.url.replace(/\/+$/, '')}/v1`;

  /**
   * One request with the shared headers + 30s timeout. Non-2xx parses problem+json;
   * `rate-limited` is retried HERE (Retry-After capped 60s, max 2 retries) so callers
   * never see a transient 429. Everything else throws the slug-mapped ApiError.
   */
  async function send(
    path: string,
    init: { method: string; body?: string; contentType?: string },
  ): Promise<HttpResponse> {
    const url = `${base}${path}`;

    for (let attempt = 0; ; attempt++) {
      let response: HttpResponse;

      try {
        response = await fetchImpl(url, {
          method: init.method,
          body: init.body,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: 'application/json',
            'User-Agent': `transglot-sketch/${opts.version}`,
            ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
          },
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        throw new ApiError(
          'network-error',
          `Network error calling ${url}: ${error instanceof Error ? error.message : String(error)}`,
          0,
          'Check the server URL and that it is reachable from Sketch.',
        );
      }

      if (response.ok) {
        return response;
      }

      const problem = await parseProblem(response);

      if (problem.slug === 'rate-limited' && attempt < MAX_RATE_LIMIT_RETRIES) {
        const header = Number(response.headers.get('Retry-After') ?? '1');
        const waitS = Math.min(
          Number.isFinite(header) && header > 0 ? header : 1,
          RETRY_AFTER_CAP_S,
        );
        await sleep(waitS * 1000);
        continue;
      }

      throw toApiError(problem);
    }
  }

  async function getJson<T>(path: string): Promise<T> {
    const response = await send(path, { method: 'GET' });

    return (await response.json()) as T;
  }

  return {
    project: () => getJson<ProjectInfo>('/project'),

    async push(p) {
      // json_flat = { [key]: text } (spec §5.1). Always the SOURCE locale, mode=merge
      // (the default): the plugin NEVER sends sync_removals, so deleting a layer never
      // deletes a project key.
      const flat: Record<string, string> = {};

      for (const e of p.entries) {
        flat[e.key] = e.text;
      }

      // Encode multipart as a UTF-8 string: Sketch has no browser FormData or Blob.
      const source = JSON.stringify(flat);
      let boundary = `Transglot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      while (source.includes(boundary) || p.sourceLocale.includes(boundary))
        boundary += 'x';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="sketch-source.json"',
        'Content-Type: application/json; charset=utf-8',
        '',
        source,
        `--${boundary}`,
        'Content-Disposition: form-data; name="format"',
        '',
        'json_flat',
        `--${boundary}`,
        'Content-Disposition: form-data; name="locale"',
        '',
        p.sourceLocale,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const response = await send('/push', {
        method: 'POST',
        body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });

      return (await response.json()) as PushDiff;
    },

    async translate(scope = 'missing') {
      const response = await send('/translate', {
        method: 'POST',
        body: `scope=${encodeURIComponent(scope)}`,
        contentType: 'application/x-www-form-urlencoded',
      });

      return (await response.json()) as Batch;
    },

    batch: (id) => getJson<Batch>(`/batches/${id}`),

    async pull(q) {
      const params =
        `format=json_flat&locale=${encodeURIComponent(q.locale)}` +
        (q.minState === undefined
          ? ''
          : `&min_state=${encodeURIComponent(q.minState)}`);
      const response = await send(`/pull?${params}`, { method: 'GET' });
      const entries = (await response.json()) as Record<string, string>;
      const header = Number(response.headers.get('X-Skipped-Keys') ?? '0');

      return { entries, skippedKeys: Number.isFinite(header) ? header : 0 };
    },
  };
}

/** Parses an RFC 7807 body; non-JSON or type-less bodies are server errors outright. */
async function parseProblem(response: HttpResponse): Promise<Problem> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      'server-error',
      `Server returned HTTP ${response.status} with a non-JSON body.`,
      response.status,
      'Check that the URL points at a transglot server.',
    );
  }

  const record = (
    typeof body === 'object' && body !== null ? body : {}
  ) as Record<string, unknown>;
  const typeField = typeof record.type === 'string' ? record.type : '';
  const match = typeField.match(/^\/problems\/(.+)$/);

  if (match === null) {
    throw new ApiError(
      'server-error',
      `Server returned HTTP ${response.status} without a problem type.`,
      response.status,
      'Check that the URL points at a transglot server.',
    );
  }

  // Extensions (errors, ability, quota, batch_id, …) ride as TOP-LEVEL siblings of
  // detail — collect everything that is not an RFC 7807 base key.
  const extensions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (
      key !== 'type' &&
      key !== 'title' &&
      key !== 'status' &&
      key !== 'detail'
    ) {
      extensions[key] = value;
    }
  }

  return {
    slug: match[1],
    status: response.status,
    title:
      typeof record.title === 'string'
        ? record.title
        : `HTTP ${response.status}`,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
    extensions,
  };
}

/** slug → a friendly, actionable ApiError. Message is the server's detail; hint is the fix. */
function toApiError(problem: Problem): ApiError {
  const message = problem.detail ?? problem.title;

  switch (problem.slug) {
    case 'unauthenticated':
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        'Check your token. Create a project access token in transglot.',
      );
    case 'missing-ability':
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        `The token lacks the "${String(problem.extensions.ability ?? 'required')}" ability. Mint a token with the push/pull/manage ability.`,
      );
    case 'locale-not-configured':
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        'Add your source language in the project settings first.',
      );
    case 'quota-exceeded':
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        'Raise the organization word limit or wait for the monthly reset.',
      );
    case 'active-batch': {
      const id = String(problem.extensions.batch_id ?? '?');

      return new ApiError(
        problem.slug,
        `${message} (batch #${id})`,
        problem.status,
        'Wait for the running batch to finish, then retry.',
      );
    }
    case 'not-found':
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        'Check the id. It may not exist or belong to a different project.',
      );
    case 'rate-limited': // only reached after the in-client retries are exhausted
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        'Still rate-limited after retries. Try again shortly.',
      );
    default:
      return new ApiError(
        problem.slug,
        message,
        problem.status,
        problem.status >= 500
          ? 'Server error. Retry; if it persists check the server logs.'
          : undefined,
      );
  }
}
