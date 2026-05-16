// Per-page dwell tracker.
//
// Tracks user engagement with a single URL: foreground time, max scroll
// depth, interaction count. Emits one `page-dwell` event when the page is
// "leaving" — by visibility hide, SPA nav, or page-hide. After emission the
// tracker is sealed; a fresh tracker is created when the URL changes.
//
// We deliberately do NOT emit dwell mid-session. One snapshot per page-life
// is sufficient signal; the lookback in ingest will marry it with the rest.

import { makeLog } from "./log";
import { capturePageContext } from "./page-context";
import type { DwellMeta, PageContext } from "./types";

const log = makeLog("dwell");

export interface DwellSnapshot {
  url: string;
  pageKey: string;
  pageContext: PageContext;
  meta: DwellMeta;
}

/** Minimum total foreground time for a dwell event to be worth emitting. */
const MIN_EMIT_FOREGROUND_MS = 2_000;

export class DwellTracker {
  private url: string;
  private pageKey: string;
  private startedAt: number;
  private foregroundMs = 0;
  /** Timestamp of the last visibility→visible transition. null = currently hidden. */
  private lastVisibleAt: number | null;
  private maxScrollPct = 0;
  private interactionCount = 0;
  private emitted = false;

  constructor(url: string, pageKey: string) {
    this.url = url;
    this.pageKey = pageKey;
    this.startedAt = Date.now();
    this.lastVisibleAt = document.hidden ? null : Date.now();
  }

  /** Caller signals a click / input-edit. */
  recordInteraction(): void {
    this.interactionCount++;
  }

  /** Caller signals a scroll position update — we compute % internally. */
  recordScroll(): void {
    const doc = document.documentElement;
    const denom = (doc.scrollHeight || 0) - (window.innerHeight || 0);
    if (denom <= 0) return;
    const pct = Math.min(100, Math.max(0, (window.scrollY / denom) * 100));
    if (pct > this.maxScrollPct) this.maxScrollPct = pct;
  }

  /** Caller signals visibilitychange. */
  onVisibilityChange(): void {
    this.accumulateForeground();
    this.lastVisibleAt = document.hidden ? null : Date.now();
  }

  /**
   * Emit a snapshot if we have enough signal. Returns null if the dwell is
   * too brief to be interesting, or if we've already emitted for this page.
   */
  flush(reason: DwellMeta["reason"]): DwellSnapshot | null {
    if (this.emitted) return null;
    this.accumulateForeground();
    if (this.foregroundMs < MIN_EMIT_FOREGROUND_MS) {
      log("skip flush; foreground too brief", this.foregroundMs);
      return null;
    }
    this.emitted = true;
    // Capture page context AT THE MOMENT of emission so we reflect any
    // late-loaded content (lazy hydration, infinite scroll, modal content).
    let ctx: PageContext;
    try {
      ctx = capturePageContext();
    } catch (e) {
      log.error("page-context capture during dwell flush failed", e);
      // Fall back to a minimal snapshot — the dwell metrics are still useful.
      ctx = {
        capturedAt: Date.now(),
        url: this.url,
        title: document.title,
        headings: [],
        jsonLd: [],
        mainText: "",
        contentHash: "",
      };
    }
    const meta: DwellMeta = {
      foregroundMs: this.foregroundMs,
      totalMs: Date.now() - this.startedAt,
      maxScrollPct: Math.round(this.maxScrollPct),
      interactionCount: this.interactionCount,
      reason,
    };
    return { url: this.url, pageKey: this.pageKey, pageContext: ctx, meta };
  }

  private accumulateForeground(): void {
    if (this.lastVisibleAt != null && !document.hidden) {
      const now = Date.now();
      this.foregroundMs += now - this.lastVisibleAt;
      this.lastVisibleAt = now;
    }
  }
}
