/**
 * UI test preload — installs happy-dom globals BEFORE any test module loads.
 *
 * Why this exists: `react-dom` caches its environment probes
 * (`canUseDOM`, `isInputEventSupported`) at *import* time. Several test files
 * statically import `react`/`@testing-library/react` at the top and only then
 * assign `globalThis.window`, so whichever of those files the runner loads
 * first decides the whole process's fate. If react-dom is evaluated while
 * `document` is undefined, it permanently disables synthetic text-input
 * `change` events — clicks keep working, so the symptom is a handful of
 * "typed value never registered" failures far away from the culprit, and the
 * outcome depends on file ordering (green on macOS, red on CI).
 *
 * Registering globals here removes the ordering dependency entirely. Test
 * files that build their own Window still work — they simply replace these.
 */

import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;

// Seed ONLY what react-dom probes at import time: `canUseDOM` checks for
// window + window.document, and `isInputEventSupported` calls
// document.createElement. Deliberately NOT overriding the global Event /
// CustomEvent / EventTarget constructors — happy-dom's event classes don't
// interop with bun's native EventTarget, and at least one suite
// (lib/ntfy-push.test.ts) relies on the native pair. Suites that need a
// richer DOM still install their own Window on top of this.
if (!g.window) {
    g.window = win;
    g.document = win.document;
    g.navigator = win.navigator;
}
