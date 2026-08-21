import "@testing-library/jest-dom/vitest";

// jsdom implements neither, and both are called by code under test: Radix and
// sonner query media, and the conversation scrolls itself to the newest turn.
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as typeof window.matchMedia;

Element.prototype.scrollIntoView = () => {};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
