// Only in files that run under jsdom: the browser pieces jsdom lacks, and cleanup between tests.
import { afterEach } from "vitest"

if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react")
  afterEach(() => cleanup())

  class Stub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  const w = window as unknown as Record<string, unknown>
  w["ResizeObserver"] ??= Stub
  w["IntersectionObserver"] ??= Stub
  w["matchMedia"] ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  Element.prototype.scrollTo ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}
