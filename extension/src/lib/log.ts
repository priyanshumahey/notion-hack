// Tiny namespaced logger so every layer is greppable in DevTools.
// Usage: const log = makeLog("content"); log("clicked", { ... });
// Filter in DevTools console: regex `\[nh:.*\]`.

type Scope = "content" | "bg" | "popup" | "store" | "capture" | "nav" | "dwell";

export function makeLog(scope: Scope) {
  const tag = `[nh:${scope}]`;
  const fn = (...args: unknown[]) => console.log(tag, ...args);
  fn.warn = (...args: unknown[]) => console.warn(tag, ...args);
  fn.error = (...args: unknown[]) => console.error(tag, ...args);
  fn.debug = (...args: unknown[]) => console.debug(tag, ...args);
  return fn;
}
