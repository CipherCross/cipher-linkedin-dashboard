/**
 * Shared test setup.
 *
 * jsdom implements no layout, so the observer APIs that real component
 * libraries use to measure themselves simply do not exist there. `cmdk`
 * constructs a `ResizeObserver` on mount, which throws before any assertion
 * runs — a missing environment feature, not a defect in the code under test.
 *
 * The stubs are inert: they record nothing and fire no callbacks, so a test
 * can never accidentally assert on a measurement jsdom did not take. Anything
 * that genuinely depends on layout is verified in a browser instead.
 *
 * Guarded on `window` because the default environment is `node`, where these
 * globals are neither present nor wanted.
 */
if (typeof window !== 'undefined') {
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver

  // jsdom does not implement these; Base UI and cmdk call them while opening.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {}
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
