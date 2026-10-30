/** CocoaScript networking and timers, without browser globals or Node built-ins. */
import type { HttpRequest, HttpResponse, HttpTransport } from './api';

interface NativeFiber {
  cleanup(): void;
  onCleanup(callback: () => void): void;
}
interface NativeTask {
  resume(): void;
  cancel(): void;
}
interface NativeString {
  initWithString(value: string): NativeString;
  initWithData_encoding(data: unknown, encoding: number): unknown;
  dataUsingEncoding(encoding: number): unknown;
}
interface NativeRequest {
  setHTTPMethod(method: string): void;
  setValue_forHTTPHeaderField(value: string, name: string): void;
  setHTTPBody(data: unknown): void;
  setHTTPShouldHandleCookies(value: boolean): void;
  setCachePolicy(policy: number): void;
  setTimeoutInterval(seconds: number): void;
}
interface NativeResponse {
  statusCode(): number;
  allHeaderFields(): {
    allKeys(): { length: number; [i: number]: unknown };
    objectForKey(key: unknown): unknown;
  };
}
interface NativeError {
  localizedDescription: string | (() => string);
}
type Completion = (
  data: unknown,
  response: NativeResponse | null,
  error: NativeError | null,
) => void;

declare const coscript: {
  createFiber(): NativeFiber;
  scheduleWithInterval_jsFunction(
    seconds: number,
    callback: () => void,
  ): { cancel(): void };
};
declare const NSURL: { alloc(): { initWithString(url: string): unknown } };
declare const NSMutableURLRequest: {
  requestWithURL(url: unknown): NativeRequest;
};
declare const NSString: { alloc(): NativeString };
declare const NSUTF8StringEncoding: number;
declare const NSURLSession: {
  sharedSession(): {
    dataTaskWithRequest_completionHandler(
      request: NativeRequest,
      callback: unknown,
    ): NativeTask;
  };
};
declare const __mocha__: {
  createBlock_function(signature: string, callback: Completion): unknown;
};

/** CocoaScript's scheduler owns a fiber until the callback completes. */
export function nativeSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    coscript.scheduleWithInterval_jsFunction(milliseconds / 1000, resolve);
  });
}

export const nativeFetch: HttpTransport = (
  url: string,
  init: HttpRequest,
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const fiber = coscript.createFiber();
    let task: NativeTask | undefined;
    let deadline: { cancel(): void } | undefined;
    let settled = false;

    const finish = (error?: Error, response?: HttpResponse, cleanup = true) => {
      if (settled) return;
      settled = true;
      deadline?.cancel();
      if (error) task?.cancel();
      if (cleanup) fiber.cleanup();
      if (error) reject(error);
      else resolve(response!);
    };

    fiber.onCleanup(() =>
      finish(new Error('The Sketch command was closed.'), undefined, false),
    );

    try {
      const request = NSMutableURLRequest.requestWithURL(
        NSURL.alloc().initWithString(url),
      );
      request.setHTTPMethod(init.method);
      request.setHTTPShouldHandleCookies(false);
      request.setCachePolicy(1);
      request.setTimeoutInterval(init.timeoutMs / 1000);
      for (const [name, value] of Object.entries(init.headers)) {
        request.setValue_forHTTPHeaderField(value, name);
      }
      if (init.body !== undefined) {
        request.setHTTPBody(
          NSString.alloc()
            .initWithString(init.body)
            .dataUsingEncoding(NSUTF8StringEncoding),
        );
      }

      const callback: Completion = (data, response, error) => {
        if (settled) return;
        if (error || !response) {
          const message = error
            ? typeof error.localizedDescription === 'function'
              ? error.localizedDescription()
              : error.localizedDescription
            : 'Sketch received no HTTP response.';
          finish(new Error(String(message)));
          return;
        }
        try {
          // Copy Cocoa values while the request fiber is alive; parsing later uses plain JS.
          const text = String(
            NSString.alloc().initWithData_encoding(
              data,
              NSUTF8StringEncoding,
            ) ?? '',
          );
          const fields = response.allHeaderFields();
          const keys = fields.allKeys();
          const headers: Record<string, string> = {};
          for (let i = 0; i < keys.length; i++) {
            headers[String(keys[i]).toLowerCase()] = String(
              fields.objectForKey(keys[i]),
            );
          }
          const status = Number(response.statusCode());
          finish(undefined, {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
            json: async () => JSON.parse(text) as unknown,
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      task = NSURLSession.sharedSession().dataTaskWithRequest_completionHandler(
        request,
        __mocha__.createBlock_function(
          'v32@?0@"NSData"8@"NSURLResponse"16@"NSError"24',
          callback,
        ),
      );
      deadline = coscript.scheduleWithInterval_jsFunction(
        init.timeoutMs / 1000,
        () =>
          finish(
            new Error(
              'The request timed out. Check the project before retrying.',
            ),
          ),
      );
      task.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
