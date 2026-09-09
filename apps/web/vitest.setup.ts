/**
 * jsdom setup for the web test project.
 *
 * jsdom implements the DOM, not the browser. Two of the APIs this app uses are
 * missing from it entirely, and they fail in different ways:
 *
 *  - `matchMedia` is *read defensively* by `lib/theme.ts` (`typeof matchMedia
 *    !== 'function'` → assume light), so its absence is survivable. It is stubbed
 *    anyway, because a component that resolves the theme should exercise the same
 *    branch here as in a browser rather than the fallback.
 *  - `ResizeObserver` is *constructed unguarded* by `LeadTable`, so its absence
 *    is a `ReferenceError` at mount. It has to exist.
 *
 * Both stubs are inert: they record nothing and never fire. A test that needs a
 * resize or a media change should drive it explicitly rather than rely on a
 * global pretending to be live.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // Deprecated, still called by some libraries.
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// `globals: false`, so RTL's own auto-cleanup (which keys off `afterEach` being
// on the global) never registers. Without this, every test mounts into the DOM
// the previous one left behind and `getByRole` starts finding two of everything.
afterEach(cleanup);
