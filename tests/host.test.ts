import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let bundle: string;
beforeAll(() => {
  execFileSync(process.execPath, ['build.mjs']);
  bundle = readFileSync(
    'dist/transglot.sketchplugin/Contents/Sketch/transglot.js',
    'utf8',
  );
});

type WireRequest = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  timeout?: number;
};
type Callback = (data: string, response: unknown, error: unknown) => void;

function host(
  options: { hold?: boolean; status?: number; batchPending?: boolean } = {},
) {
  const settings = new Map<string, unknown>();
  const layerKeys = new Map<string, string>();
  const layer = {
    id: 'text-1',
    name: 'Title',
    type: 'Text',
    text: 'Café € 日本語 😀',
    parent: undefined,
  };
  const prompts = ['https://api.transglot.ai', 'tgl_synthetic_test'];
  const requests: WireRequest[] = [];
  const completions: (() => void)[] = [];
  const timers: {
    seconds: number;
    callback: () => void;
    cancelled: boolean;
  }[] = [];
  const cancel = vi.fn();
  const alerts = vi.fn();
  const messages = vi.fn();
  const project = {
    id: 1,
    name: 'Demo',
    source_locale: 'en',
    locales: [{ locale: 'en' }, { locale: 'fr' }],
  };

  const context: Record<string, any> = {
    require: (name: string) => {
      if (name === 'sketch/dom')
        return {
          getSelectedDocument: () => ({ selectedLayers: { layers: [layer] } }),
        };
      if (name === 'sketch/settings')
        return {
          settingForKey: (key: string) => settings.get(key),
          setSettingForKey: (key: string, value: unknown) =>
            settings.set(key, value),
          layerSettingForKey: (item: typeof layer) => layerKeys.get(item.id),
          setLayerSettingForKey: (
            item: typeof layer,
            _key: string,
            value: string,
          ) => layerKeys.set(item.id, value),
        };
      if (name === 'sketch/ui')
        return {
          getInputFromUser: (
            _label: string,
            _options: unknown,
            callback: (error: null, value: string) => void,
          ) => callback(null, prompts.shift() ?? ''),
          message: messages,
          alert: alerts,
        };
      throw new Error(`Unexpected native module: ${name}`);
    },
    coscript: {
      createFiber: () => {
        let cleanup: () => void = () => {};
        return {
          onCleanup: (fn: () => void) => {
            cleanup = fn;
          },
          cleanup: () => cleanup(),
        };
      },
      scheduleWithInterval_jsFunction: (
        seconds: number,
        callback: () => void,
      ) => {
        const timer = { seconds, callback, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    NSURL: { alloc: () => ({ initWithString: (url: string) => url }) },
    NSMutableURLRequest: {
      requestWithURL: (url: string) => {
        const request: WireRequest = { url, method: 'GET', headers: {} };
        requests.push(request);
        return {
          setHTTPMethod: (method: string) => {
            request.method = method;
          },
          setValue_forHTTPHeaderField: (value: string, name: string) => {
            request.headers[name] = value;
          },
          setHTTPBody: (body: string) => {
            request.body = body;
          },
          setHTTPShouldHandleCookies: vi.fn(),
          setCachePolicy: vi.fn(),
          setTimeoutInterval: (seconds: number) => {
            request.timeout = seconds;
          },
        };
      },
    },
    NSString: {
      alloc: () => ({
        initWithString: (value: string) => ({ dataUsingEncoding: () => value }),
        initWithData_encoding: (data: string) => data,
      }),
    },
    NSUTF8StringEncoding: 4,
    __mocha__: {
      createBlock_function: (_signature: string, callback: Callback) =>
        callback,
    },
    NSURLSession: {
      sharedSession: () => ({
        dataTaskWithRequest_completionHandler: (
          _request: unknown,
          callback: Callback,
        ) => {
          const wire = requests[requests.length - 1];
          const complete = () => {
            const body = wire.url.endsWith('/project')
              ? project
              : wire.url.endsWith('/push')
                ? { keys_created: 1, source_updated: 0 }
                : wire.url.includes('/pull?')
                  ? Object.fromEntries(
                      [...layerKeys.values()].map((key) => [key, 'Bonjour']),
                    )
                  : {
                      id: 7,
                      status:
                        options.batchPending && wire.url.endsWith('/translate')
                          ? 'processing'
                          : 'completed',
                      completed: 1,
                      total: 1,
                      failed: 0,
                    };
            const status = options.status ?? 200;
            callback(
              JSON.stringify(
                status >= 400
                  ? {
                      type: '/problems/unauthorized',
                      status,
                      title: 'Unauthorized',
                    }
                  : body,
              ),
              {
                statusCode: () => status,
                allHeaderFields: () => ({
                  allKeys: () => ['Content-Type'],
                  objectForKey: () => 'application/json',
                }),
              },
              null,
            );
          };
          completions.push(complete);
          return {
            resume: () => {
              if (!options.hold) complete();
            },
            cancel,
          };
        },
      }),
    },
  };
  // Deliberately no module, exports, fetch, AbortController, FormData, Blob,
  // URLSearchParams, TextEncoder, or browser/Node timer globals in this VM.
  runInNewContext(bundle, context);
  return {
    context,
    requests,
    settings,
    layer,
    layerKeys,
    prompts,
    timers,
    completions,
    cancel,
    alerts,
    messages,
  };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('compiled plugin in a native-only host', () => {
  it('exposes every manifest command as a global and verifies credentials before saving', async () => {
    const h = host();
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    for (const command of manifest.commands)
      expect(typeof h.context[command.handlers.run]).toBe('function');
    h.context.onSetToken();
    await flush();
    expect(h.requests[0].url).toBe('https://api.transglot.ai/v1/project');
    expect(h.requests[0].timeout).toBe(30);
    expect(h.settings.get('tgl_token')).toBe('tgl_synthetic_test');
    expect(h.alerts).not.toHaveBeenCalled();
  });

  it('pushes Unicode source through real multipart parsing and applies a pulled locale to the mapped layer', async () => {
    const h = host();
    h.settings.set('tgl_token', 'tgl_synthetic_test');
    h.context.onPush();
    await flush();
    const push = h.requests.find((request) => request.url.endsWith('/push'))!;
    const form = await new Response(push.body, {
      headers: push.headers,
    }).formData();
    expect(form.get('format')).toBe('json_flat');
    expect(form.get('locale')).toBe('en');
    expect(form.get('sync_removals')).toBeNull();
    expect(
      Object.values(JSON.parse(await (form.get('file') as Blob).text())),
    ).toEqual(['Café € 日本語 😀']);
    expect(h.layerKeys.size).toBe(1);
    h.prompts.splice(0, h.prompts.length, 'fr');
    h.context.onPullApply();
    await flush();
    expect(h.layer.text).toBe('Bonjour');
    expect(h.alerts).not.toHaveBeenCalled();
  });

  it('cancels a timed-out native request and ignores a late successful callback', async () => {
    const h = host({ hold: true });
    h.context.onSetToken();
    await flush();
    h.timers.find((timer) => timer.seconds === 30)!.callback();
    await flush();
    h.completions[0]();
    await flush();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.settings.has('tgl_token')).toBe(false);
    expect(h.alerts.mock.calls[0][1]).toContain('timed out');
  });

  it('waits for an AI batch with the native scheduler instead of browser timers', async () => {
    const h = host({ batchPending: true });
    h.settings.set('tgl_token', 'tgl_synthetic_test');
    h.context.onTranslate();
    await flush();
    const wait = h.timers.find((timer) => timer.seconds === 2)!;
    expect(wait).toBeDefined();
    wait.callback();
    await flush();
    expect(h.requests.map((request) => request.url)).toEqual([
      'https://api.transglot.ai/v1/translate',
      'https://api.transglot.ai/v1/batches/7',
    ]);
    expect(h.alerts).not.toHaveBeenCalled();
  });

  it('keeps a rejected token out of plugin settings', async () => {
    const h = host({ status: 401 });
    h.context.onSetToken();
    await flush();
    expect(h.settings.has('tgl_token')).toBe(false);
    expect(h.alerts).toHaveBeenCalledOnce();
  });
});
