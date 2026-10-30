# Changelog

## 0.1.1 — release candidate

- Register the four manifest commands as global Sketch handlers in the compiled bundle.
- Use native CocoaScript networking, UTF-8 request bodies and scheduling instead of browser-only globals.
- Cancel timed-out native requests and ignore late callbacks before saving credentials.
- Correct the resource icon path and disable the CocoaScript preprocessor for the bundled JavaScript.
- Add compiled-host smoke coverage for connection, Unicode upload, locale application, AI polling and timeout handling.

- Verify the core connection → push → AI → pull/apply flow in real Sketch 2026.3.1 on a fictional three-string design.
- Configure the JSON appcast for GitHub-hosted updates and include native before/after design renders.

The official directory submission is pending; manual native error edge cases are recorded separately from compiled-host coverage.

## 0.1.0

- Initial source implementation of connection, selected text push, AI translation and locale application.
