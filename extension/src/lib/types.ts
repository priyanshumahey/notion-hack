// Shared types used across content / background / popup.
//
// `Event` is the atomic unit of memory. Everything we do later — episode
// segmentation, intent decoding, Notion writes — reads sequences of these.
// Keep the shape narrow and serializable (must survive structured clone
// across the chrome.runtime message boundary AND IndexedDB).

export type EventKind =
  | "nav"           // committed navigation (hard nav or SPA history change)
  | "click"         // user clicked an element
  | "submit"        // form submit
  | "input-edited"  // user changed an input/textarea (value NOT captured)
  | "key-shortcut"; // future: modifier-key combos

/**
 * A fingerprint is a stable, semantic-ish description of a DOM element.
 *
 * The point: a brittle CSS path like `div.aB3xZ > span:nth-child(2)` will
 * break the moment LinkedIn ships a refactor. A fingerprint of role +
 * accessible name + nearest landmark + href shape survives.
 *
 * At replay/extract time we *resolve* this back against the live DOM with
 * a scoring function — we never persist a raw selector as truth.
 */
export interface Fingerprint {
  tag: string;                       // lowercased tag name
  role?: string;                     // computed aria role
  accessibleName?: string;           // aria-label || label-text || trimmed innerText
  text?: string;                     // visible text, trimmed to 80 chars
  hrefPattern?: string;              // canonicalized href (same rules as pageKey paths)
  testid?: string;                   // data-testid / data-test / data-cy
  landmark?: string;                 // nearest ancestor with role=main|nav|banner|...
  attrs?: Record<string, string>;    // selected data-* attrs, max ~6 entries
}

export interface AppEvent {
  id: string;             // ulid-like, monotonic
  ts: number;             // Date.now()
  tabId: number;          // chrome tab id (-1 if unknown)
  url: string;            // full URL at time of event
  pageKey: string;        // canonicalized URL — same logical page across IDs
  kind: EventKind;
  fingerprint?: Fingerprint; // omitted for `nav`
  meta?: Record<string, unknown>;
}

/** Caller-side payload before bg assigns id/ts/tabId (id+ts may be present from content side too). */
export type RawEvent = Omit<AppEvent, "id" | "tabId"> & {
  id?: string;
  tabId?: number;
};
