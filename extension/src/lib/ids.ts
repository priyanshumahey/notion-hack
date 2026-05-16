// Lightweight monotonic id generator. Not a real ULID — we don't need the
// crockford alphabet, just sortability + uniqueness across an extension
// instance. Format: `<base36-timestamp>-<base36-counter>-<random>`.

let counter = 0;
let lastTs = 0;

export function newId(): string {
  const now = Date.now();
  if (now === lastTs) counter++;
  else {
    counter = 0;
    lastTs = now;
  }
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `${now.toString(36)}-${counter.toString(36)}-${rand}`;
}
