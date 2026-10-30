import { describe, it, expect, vi } from 'vitest';

import {
  createClient,
  ApiError,
  isTerminal,
  type HttpRequest,
  type HttpTransport,
} from '../src/api';

const OK = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(fetchImpl: HttpTransport) {
  return createClient({
    url: 'https://api.transglot.ai',
    token: 'tgl_x',
    version: '0.1.0',
    fetchImpl,
  });
}

describe('project()', () => {
  it('maps the ProjectResource shape and sends the Bearer token + Sketch UA', async () => {
    const f = vi.fn(async (_u: string, _init?: RequestInit) =>
      OK({
        id: 1,
        name: 'Site',
        slug: 'site',
        source_locale: 'en',
        locales: [
          { locale: 'en', name: 'English', rtl: false, is_source: true },
          { locale: 'fr', name: 'French', rtl: false, is_source: false },
        ],
        keys_count: 0,
      }),
    );
    const p = await client(f as unknown as HttpTransport).project();
    expect(p.source_locale).toBe('en');
    expect(p.locales.map((l) => l.locale)).toEqual(['en', 'fr']);
    const init = (f.mock.calls[0][1] ?? {}) as HttpRequest;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tgl_x');
    expect(headers['User-Agent']).toBe('transglot-sketch/0.1.0');
  });
});

describe('push()', () => {
  it('sends json_flat multipart with the source locale + merge (never sync_removals)', async () => {
    let sent: FormData | undefined;
    const f = vi.fn(async (_u: string, init: HttpRequest) => {
      sent = await new Response(init.body, {
        headers: init.headers,
      }).formData();

      return OK({
        keys_created: 2,
        keys_deleted: 0,
        source_updated: 1,
        translations_written: 0,
        conflicts: [],
        unknown_keys: [],
        warnings: [],
        batch: null,
        quota_exceeded: false,
      });
    });
    const diff = await client(f as unknown as HttpTransport).push({
      entries: [
        { key: 'a', text: 'Hi' },
        { key: 'b', text: 'Bye' },
      ],
      sourceLocale: 'en',
    });
    expect(diff.keys_created).toBe(2);
    expect(sent?.get('format')).toBe('json_flat');
    expect(sent?.get('locale')).toBe('en');
    expect(sent?.get('mode')).toBeNull(); // merge is the default; sync_removals is NEVER sent
  });
});

describe('pull()', () => {
  it('parses json_flat body + X-Skipped-Keys header into an entry map', async () => {
    const f = vi.fn(async () =>
      OK({ a: 'Bonjour' }, { 'X-Skipped-Keys': '3' }),
    );
    const out = await client(f as unknown as HttpTransport).pull({
      locale: 'fr',
    });
    expect(out.entries).toEqual({ a: 'Bonjour' });
    expect(out.skippedKeys).toBe(3);
  });
});

describe('translate() + batch()', () => {
  it('posts the scope and polls a batch by id', async () => {
    let sentScope: FormDataEntryValue | null = null;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/translate')) {
        sentScope = new URLSearchParams(String(init!.body)).get('scope');

        return OK({
          id: 7,
          status: 'processing',
          total: 3,
          completed: 0,
          failed: 0,
        });
      }

      return OK({
        id: 7,
        status: 'completed',
        total: 3,
        completed: 3,
        failed: 0,
      });
    });
    const c = client(f as unknown as HttpTransport);
    const started = await c.translate('missing');
    expect(sentScope).toBe('missing');
    expect(isTerminal(started.status)).toBe(false);
    const done = await c.batch(started.id);
    expect(isTerminal(done.status)).toBe(true);
  });
});

describe('rate-limit retry', () => {
  it('retries a 429 after Retry-After and then succeeds (no throw)', async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;

      if (calls === 1) {
        return new Response(
          JSON.stringify({
            type: '/problems/rate-limited',
            title: 'Too Many',
            status: 429,
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/problem+json',
              'Retry-After': '1',
            },
          },
        );
      }

      return OK({
        id: 1,
        name: 'Site',
        slug: 'site',
        source_locale: 'en',
        locales: [],
        keys_count: 0,
      });
    });
    const c = createClient({
      url: 'https://api.transglot.ai',
      token: 't',
      version: '0.1.0',
      fetchImpl: f as unknown as HttpTransport,
      sleep: async () => {},
    });
    const project = await c.project();
    expect(project.name).toBe('Site');
    expect(calls).toBe(2);
  });
});

describe('problem+json mapping', () => {
  it('maps missing-ability to a clear, actionable error', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: '/problems/missing-ability',
            title: 'Forbidden',
            status: 403,
            ability: 'push',
          }),
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );
    await expect(
      client(f as unknown as HttpTransport).push({
        entries: [],
        sourceLocale: 'en',
      }),
    ).rejects.toMatchObject({
      slug: 'missing-ability',
    });
  });

  it('maps locale-not-configured to an ApiError', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: '/problems/locale-not-configured',
            title: 'Unprocessable',
            status: 422,
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );
    await expect(
      client(f as unknown as HttpTransport).push({
        entries: [{ key: 'a', text: 'x' }],
        sourceLocale: 'en',
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('native transport contract', () => {
  it('sends a complete UTF-8 multipart body and timeout without relying on browser globals', async () => {
    let request: HttpRequest | undefined;
    const f: HttpTransport = async (_url, init) => {
      request = init;
      return OK({ keys_created: 1 });
    };
    await client(f).push({
      entries: [{ key: 'a', text: 'Café € 日本語 😀' }],
      sourceLocale: 'en',
    });
    expect(request?.timeoutMs).toBe(30_000);
    const form = await new Response(request!.body, {
      headers: request!.headers,
    }).formData();
    expect(await (form.get('file') as Blob).text()).toBe(
      JSON.stringify({ a: 'Café € 日本語 😀' }),
    );
    expect(form.get('format')).toBe('json_flat');
    expect(form.get('locale')).toBe('en');
    expect(form.get('sync_removals')).toBeNull();
  });
});
