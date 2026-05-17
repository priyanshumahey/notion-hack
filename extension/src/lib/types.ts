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
  | "key-shortcut"  // future: modifier-key combos
  | "page-dwell";   // user engaged with a page (foreground time, scroll, interactions)

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
  /** Structured snapshot of the page at this event's moment. Present on nav
   *  and submit events; omitted on click/input to keep storage bounded. */
  pageContext?: PageContext;
  /** Set only on submit events. */
  formContext?: FormContext;
  meta?: Record<string, unknown>;
}

/** Caller-side payload before bg assigns id/ts/tabId (id+ts may be present from content side too). */
export type RawEvent = Omit<AppEvent, "id" | "tabId"> & {
  id?: string;
  tabId?: number;
};

// ---------------------------------------------------------------------------
// Page-context capture
//
// A small, bounded snapshot of the live page used to give the LLM real
// information to reason over. See lib/page-context.ts for construction.
// ---------------------------------------------------------------------------

export interface PageContext {
  capturedAt: number;
  url: string;
  canonicalUrl?: string;
  title: string;
  lang?: string;
  description?: string;
  og?: Record<string, string>;
  twitter?: Record<string, string>;
  /** Lines like "h1: Foo", "h2: Bar". Capped. */
  headings: string[];
  /** Normalized JSON-LD blocks (from <script type=application/ld+json>). */
  jsonLd: unknown[];
  /** Plain-text excerpt of <main>/<article>/body, whitespace-collapsed, capped. */
  mainText: string;
  /** window.getSelection() if non-empty at capture time. */
  selectionText?: string;
  /** FNV-1a hash for change detection between successive snapshots. */
  contentHash: string;
  /** Non-fatal capture errors, if any. */
  errors?: string[];
}

export interface FormField {
  /** Form field name or id; undefined if neither is set. */
  name?: string;
  /** Input type, or "textarea"/"select" for non-input tags. */
  type: string;
  /** Associated <label>, aria-label, aria-labelledby, or placeholder text. */
  label?: string;
  /** Captured value. Undefined for password (security) and file (we record filename instead). */
  value?: string | string[];
  /** For type=file inputs: the chosen file name(s). */
  filename?: string;
}

export interface FormContext {
  action: string;
  method: string;
  formName?: string;
  fields: FormField[];
  errors?: string[];
}

/**
 * Engagement metrics attached to page-dwell events. Emitted when the user
 * navigates away from / hides a page they spent meaningful time on.
 */
export interface DwellMeta {
  /** Time the page was actually focused & visible, ms. */
  foregroundMs: number;
  /** Total wall-clock time on the page, ms. */
  totalMs: number;
  /** 0..100 — the deepest scroll the user reached, as % of scrollable height. */
  maxScrollPct: number;
  /** Clicks + input-edits observed while on this page. */
  interactionCount: number;
  /** What caused the dwell event to be emitted. */
  reason: "visibility-hidden" | "spa-nav" | "page-hide" | "manual";
}

// ---------------------------------------------------------------------------
// LLM judgement → Notion proposal
//
// The whole point of the judge step: turn a sequence of browser events into
// a concrete artifact we could write to Notion. We deliberately do NOT have
// an intermediate "category" concept — the LLM goes straight to Notion-shaped
// output (a target database + a row). Categories emerge implicitly as DBs.
// ---------------------------------------------------------------------------

/** Subset of Notion property types we'll support in v1. */
export type NotionPropertyType =
  | "title" | "rich_text" | "url" | "date" | "select" | "multi_select" | "number";

export interface NotionPropertySpec {
  name: string;
  type: NotionPropertyType;
  /** Used by select / multi_select. Empty for other types. */
  options: string[];
}

export interface NotionRowCell {
  /** Must match a property `name` in the database's schema. */
  property: string;
  /** Value type depends on the property type; we keep it loose at the boundary. */
  value: string | number | string[];
}

export interface NotionDatabaseProposal {
  mode: "use-existing" | "create-new";
  /** Set when mode === "use-existing". */
  existingId: string | null;
  /** Display name (either existing DB's name or proposed new name). */
  name: string;
  /** Free-text description for new DBs; empty string otherwise. */
  description: string;
  /** Proposed schema (for create-new) or expected schema (for use-existing). */
  properties: NotionPropertySpec[];
}

export interface NotionProposal {
  database: NotionDatabaseProposal;
  row: NotionRowCell[];
}

export interface Judgement {
  meaningful: boolean;
  confidence: number;       // 0..1
  reasoning: string;        // one sentence, surfaced in the UI
  proposal: NotionProposal | null;  // present iff meaningful
}

export type HybridActionType =
  | "Save to Notion"
  | "Send Slack message"
  | "Draft email"
  | "Create task";

export interface HybridActionOverride {
  actionType: HybridActionType;
  connector: string;
  target: string;
  draft: string;
}

/** A detected completion candidate, with optional LLM judgement attached. */
export interface CompletionCandidate {
  id: string;
  detectedAt: number;
  reason: "form-submit" | "terminal-nav" | "content-dwell" | "repetition" | "action-click";
  /** Free-form, human-readable explanation of why the trigger fired. */
  triggerNote?: string;
  trigger: AppEvent;
  context: AppEvent[];        // oldest → newest, ending at trigger (inclusive)
  scope: {
    tabId: number;
    sinceTs: number;
    untilTs: number;
    pageKeys: string[];
    hosts: string[];
  };
  judgement: Judgement | null;
  /** Populated when the judge call failed; null on success. */
  error: string | null;
  status: "new" | "dismissed" | "promoted";
  /** Notion application state. Undefined = never applied. */
  applied?: {
    status: "pending" | "applied" | "skipped" | "failed";
    databaseId?: string;
    pageId?: string;
    pageUrl?: string;
    errorMessage?: string;
    /** Fields that didn't match the DB schema and weren't written. */
    droppedFields?: { property: string; reason: string }[];
    appliedAt?: number;
    /** True when applied automatically (cluster previously approved by user). */
    auto?: boolean;
  };
  hybridAction?: HybridActionOverride;
}
