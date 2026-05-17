// Floating "agent stack" UI shown on the host page.
//
// Replaces the single-bubble prompt with a Notion-styled column of avatars
// (one per pending workflow). Each avatar:
//   - pulses with a glow while awaiting user input,
//   - opens an inline card on click,
//   - persists across multiple concurrent workflows.
//
// One card is open at a time. Clicking another avatar switches the open card.
// The card walks through these states:
//
//   prompt   →  "Pattern identified. Want me to build an agentic workflow…?"
//                 [ Yes ] [ Tell me more ]
//   details  →  proposal summary (db name + description + property list)
//                 [ Yes ] [ No ]
//   building →  "Building agents…" loading row
//   saved    →  "Workflow saved to Notion" + View ↗
//   skipped  →  "Already in Notion" + View ↗
//   error    →  message + [ Retry ] [ Dismiss ]
//
// All host-page event handlers in content/index.ts guard on
// `isExtensionUiEvent` (matches `closest(#STACK_ROOT_ID)`), so clicks inside
// the stack don't leak back into the observation pipeline.

import { send, type Msg } from "../lib/messages";
import { makeLog } from "../lib/log";
import type { CompletionCandidate } from "../lib/types";

const log = makeLog("content");

export const STACK_ROOT_ID = "notion-hack-agent-stack-root";
const STACK_STYLE_ID = "notion-hack-agent-stack-style";

type PromptMsg = Extract<Msg, { t: "completionPrompt" }>;

type CardStep = "prompt" | "details" | "building" | "saved" | "skipped" | "error";

interface AgentEntry {
  id: string;
  promptInfo: PromptMsg;
  step: CardStep;
  /** True until the user takes a terminal action (yes/no). Drives the glow ring. */
  needsInput: boolean;
  /** Loaded lazily for "Tell me more". */
  full?: CompletionCandidate | null;
  pageUrl?: string;
  error?: string;
  /** Pending auto-dismiss handle for saved / skipped states. */
  dismissTimer?: number;
  /** Avatar DOM node (re-used across re-renders). */
  avatarEl?: HTMLLIElement;
  /** Set when getCompletion is mid-flight so we don't double-fire. */
  loadingDetails?: boolean;
  /** Set when applyCandidate is in flight. */
  applying?: boolean;
}

export interface AgentStackController {
  push(prompt: PromptMsg): void;
}

export function createAgentStack(): AgentStackController {
  const entries = new Map<string, AgentEntry>();
  /** Insertion-ordered ids; drives avatar column order (top → bottom). */
  const order: string[] = [];
  let activeId: string | null = null;

  let root: HTMLElement | null = null;
  let cardEl: HTMLElement | null = null;
  let avatarsEl: HTMLOListElement | null = null;

  function ensureMounted() {
    if (root && document.documentElement.contains(root)) return;

    if (!document.getElementById(STACK_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STACK_STYLE_ID;
      style.textContent = STACK_CSS;
      document.documentElement.appendChild(style);
    }

    const host = document.body || document.documentElement;
    if (!host) {
      window.setTimeout(ensureMounted, 50);
      return;
    }

    document.getElementById(STACK_ROOT_ID)?.remove();
    const aside = document.createElement("aside");
    aside.id = STACK_ROOT_ID;
    aside.setAttribute("aria-label", "Notion Dance — pending workflows");
    aside.innerHTML = `
      <div class="nh-stack-card" data-open="false" aria-hidden="true"></div>
      <ol class="nh-stack-avatars" role="list"></ol>
    `;
    host.appendChild(aside);
    root = aside;
    cardEl = aside.querySelector(".nh-stack-card");
    avatarsEl = aside.querySelector(".nh-stack-avatars");
  }

  function rerenderAvatars() {
    if (!avatarsEl) return;
    // Diff-light: just rebuild children. The list is small (typically 1–5).
    avatarsEl.replaceChildren();
    for (const id of order) {
      const e = entries.get(id);
      if (!e) continue;
      const li = document.createElement("li");
      li.className = "nh-avatar";
      if (e.needsInput) li.classList.add("is-pending");
      if (e.step === "building") li.classList.add("is-building");
      if (e.step === "saved" || e.step === "skipped") li.classList.add("is-done");
      if (e.step === "error") li.classList.add("is-error");
      if (id === activeId) li.classList.add("is-active");
      li.dataset.id = id;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nh-avatar-btn";
      btn.setAttribute("aria-label", labelForAvatar(e));
      btn.innerHTML = AVATAR_INNER_HTML;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleActive(id);
      });
      li.appendChild(btn);

      // Glow ring (pure-CSS, but injected only when pending to avoid paint cost
      // on resolved cards).
      if (e.needsInput || e.step === "building") {
        const ring = document.createElement("span");
        ring.className = "nh-avatar-glow";
        ring.setAttribute("aria-hidden", "true");
        li.appendChild(ring);
      }

      e.avatarEl = li;
      avatarsEl.appendChild(li);
    }
  }

  function toggleActive(id: string) {
    if (activeId === id) {
      activeId = null;
    } else {
      activeId = id;
    }
    rerenderAvatars();
    rerenderCard();
  }

  function closeCard() {
    activeId = null;
    rerenderAvatars();
    rerenderCard();
  }

  function removeEntry(id: string) {
    const e = entries.get(id);
    if (!e) return;
    if (e.dismissTimer) window.clearTimeout(e.dismissTimer);
    entries.delete(id);
    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);
    if (activeId === id) activeId = null;
    if (entries.size === 0 && root) {
      root.remove();
      root = null;
      cardEl = null;
      avatarsEl = null;
      return;
    }
    rerenderAvatars();
    rerenderCard();
  }

  function rerenderCard() {
    if (!cardEl) return;
    if (!activeId) {
      cardEl.dataset.open = "false";
      cardEl.setAttribute("aria-hidden", "true");
      cardEl.replaceChildren();
      return;
    }
    const e = entries.get(activeId);
    if (!e) {
      cardEl.dataset.open = "false";
      cardEl.setAttribute("aria-hidden", "true");
      cardEl.replaceChildren();
      return;
    }
    cardEl.dataset.open = "true";
    cardEl.dataset.step = e.step;
    cardEl.setAttribute("aria-hidden", "false");
    cardEl.replaceChildren(buildCardBody(e));
  }

  function buildCardBody(e: AgentEntry): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "nh-card-inner";

    // Close button (top-right of card). Always present.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "nh-card-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeCard();
    });
    wrap.appendChild(close);

    const name = workflowName(e);

    if (e.step === "prompt") {
      const h = el("div", "nh-card-heading");
      h.textContent = "Pattern identified.";
      const body = el("div", "nh-card-body");
      body.append(
        document.createTextNode("Want me to build an agentic workflow for you for "),
        boldSpan(name),
        document.createTextNode("?"),
      );
      const meta = el("div", "nh-card-meta");
      meta.textContent = labelForReason(e.promptInfo.reason);
      const actions = el("div", "nh-card-actions");
      actions.append(
        linkButton("Yes", () => void onYes(e), { primary: true }),
        linkButton("Tell me more", () => void onTellMore(e)),
      );
      wrap.append(h, body, meta, actions);
    } else if (e.step === "details") {
      const h = el("div", "nh-card-heading");
      h.textContent = "Proposed workflow";
      const sub = el("div", "nh-card-subheading");
      sub.append(
        document.createTextNode("for "),
        boldSpan(name),
      );
      const summary = el("div", "nh-card-body");
      summary.textContent =
        e.full?.judgement?.reasoning?.trim() ||
        e.full?.judgement?.proposal?.database.description?.trim() ||
        "Watches for this pattern and saves a structured row to Notion the moment it happens again.";

      const proposalEl = renderProposalSummary(e);
      const actions = el("div", "nh-card-actions");
      actions.append(
        linkButton("Yes, build it", () => void onYes(e), { primary: true }),
        linkButton("No thanks", () => void onNo(e)),
      );
      const back = el("button", "nh-card-back") as HTMLButtonElement;
      back.type = "button";
      back.textContent = "← back";
      back.addEventListener("click", (ev) => {
        ev.stopPropagation();
        e.step = "prompt";
        rerenderCard();
      });

      wrap.append(h, sub, summary);
      if (proposalEl) wrap.append(proposalEl);
      wrap.append(actions, back);
    } else if (e.step === "building") {
      const h = el("div", "nh-card-heading");
      h.textContent = "Building agents…";
      const body = el("div", "nh-card-body");
      body.append(
        document.createTextNode("Wiring up "),
        boldSpan(name),
        document.createTextNode(" in your Notion workspace."),
      );
      const dots = el("div", "nh-card-buildrow");
      dots.innerHTML = BUILD_ICONS_HTML;
      wrap.append(h, body, dots);
    } else if (e.step === "saved" || e.step === "skipped") {
      const h = el("div", "nh-card-heading is-success");
      h.textContent = e.step === "saved" ? "Workflow saved" : "Already in Notion";
      const body = el("div", "nh-card-body");
      body.textContent =
        e.step === "saved"
          ? `${name} is now wired up. You can review or undo from the popup.`
          : `${name} already exists — opened the existing row.`;
      const actions = el("div", "nh-card-actions");
      if (e.pageUrl) {
        const view = document.createElement("a");
        view.className = "nh-card-link is-primary";
        view.textContent = "View in Notion ↗";
        view.target = "_blank";
        view.rel = "noreferrer noopener";
        view.href = e.pageUrl;
        actions.appendChild(view);
      }
      actions.appendChild(linkButton("Close", () => removeEntry(e.id)));
      wrap.append(h, body, actions);
    } else {
      // error
      const h = el("div", "nh-card-heading is-error");
      h.textContent = "Couldn't save to Notion";
      const body = el("div", "nh-card-body");
      body.textContent = e.error || "Unknown error.";
      const actions = el("div", "nh-card-actions");
      actions.append(
        linkButton("Retry", () => void onYes(e), { primary: true }),
        linkButton("Dismiss", () => removeEntry(e.id)),
      );
      wrap.append(h, body, actions);
    }

    return wrap;
  }

  function renderProposalSummary(e: AgentEntry): HTMLElement | null {
    const prop = e.full?.judgement?.proposal;
    if (!prop) return null;
    const root = el("div", "nh-card-proposal");

    const dbRow = el("div", "nh-card-proposal-db");
    const dbLabel = el("span", "nh-card-proposal-label");
    dbLabel.textContent = prop.database.mode === "use-existing" ? "Log to" : "New database";
    const dbName = el("span", "nh-card-proposal-name");
    dbName.textContent = prop.database.name;
    dbRow.append(dbLabel, dbName);
    root.append(dbRow);

    const props = prop.database.properties.slice(0, 6);
    if (props.length > 0) {
      const propsRow = el("div", "nh-card-proposal-props");
      for (const p of props) {
        const chip = el("span", "nh-card-proposal-chip");
        chip.textContent = p.name;
        propsRow.append(chip);
      }
      if (prop.database.properties.length > props.length) {
        const more = el("span", "nh-card-proposal-chip is-more");
        more.textContent = `+${prop.database.properties.length - props.length}`;
        propsRow.append(more);
      }
      root.append(propsRow);
    }

    return root;
  }

  async function onTellMore(e: AgentEntry) {
    if (e.loadingDetails) return;
    e.loadingDetails = true;
    rerenderCard();
    try {
      const resp = await send({ t: "getCompletion", id: e.id });
      if (resp.t === "completion") {
        e.full = resp.completion;
      }
    } catch (err) {
      log.warn("getCompletion failed", (err as Error).message);
    } finally {
      e.loadingDetails = false;
      e.step = "details";
      rerenderCard();
    }
  }

  async function onYes(e: AgentEntry) {
    if (e.applying) return;
    e.applying = true;
    e.needsInput = false;
    e.step = "building";
    rerenderAvatars();
    rerenderCard();
    try {
      const resp = await send({ t: "applyCandidate", id: e.id });
      e.applying = false;
      if (resp.t === "error") {
        e.step = "error";
        e.error = resp.message;
        rerenderAvatars();
        rerenderCard();
        return;
      }
      if (resp.t === "completion" && resp.completion?.applied) {
        const a = resp.completion.applied;
        if (a.status === "applied") {
          e.step = "saved";
          e.pageUrl = a.pageUrl;
          scheduleAutoDismiss(e, 8000);
        } else if (a.status === "skipped") {
          e.step = "skipped";
          e.pageUrl = a.pageUrl;
          scheduleAutoDismiss(e, 6000);
        } else if (a.status === "failed") {
          e.step = "error";
          e.error = a.errorMessage || "apply failed";
        } else {
          e.step = "error";
          e.error = "unexpected apply status: " + a.status;
        }
      } else {
        e.step = "error";
        e.error = "unexpected response from background";
      }
    } catch (err) {
      e.applying = false;
      e.step = "error";
      e.error = (err as Error).message || "send failed";
    }
    rerenderAvatars();
    rerenderCard();
  }

  async function onNo(e: AgentEntry) {
    e.needsInput = false;
    void send({ t: "denyCandidate", id: e.id });
    removeEntry(e.id);
  }

  function scheduleAutoDismiss(e: AgentEntry, ms: number) {
    if (e.dismissTimer) window.clearTimeout(e.dismissTimer);
    e.dismissTimer = window.setTimeout(() => removeEntry(e.id), ms);
  }

  function push(prompt: PromptMsg) {
    ensureMounted();
    // If we've already seen this id, refresh its prompt info but keep state.
    const existing = entries.get(prompt.id);
    if (existing) {
      existing.promptInfo = prompt;
      rerenderAvatars();
      if (activeId === prompt.id) rerenderCard();
      return;
    }
    const entry: AgentEntry = {
      id: prompt.id,
      promptInfo: prompt,
      step: "prompt",
      needsInput: true,
    };
    entries.set(prompt.id, entry);
    order.push(prompt.id);
    rerenderAvatars();
  }

  return { push };
}

// ---- helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function boldSpan(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "nh-card-emphasis";
  s.textContent = text;
  return s;
}

function linkButton(
  label: string,
  onClick: () => void,
  opts: { primary?: boolean } = {},
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "nh-card-link" + (opts.primary ? " is-primary" : "");
  b.textContent = label;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function workflowName(e: AgentEntry): string {
  return (
    e.full?.judgement?.proposal?.database.name ||
    e.promptInfo.databaseName ||
    "this workflow"
  );
}

function labelForAvatar(e: AgentEntry): string {
  const name = workflowName(e);
  switch (e.step) {
    case "prompt":
    case "details":
      return `${name} — awaiting your input`;
    case "building":
      return `${name} — building…`;
    case "saved":
      return `${name} — saved`;
    case "skipped":
      return `${name} — already in Notion`;
    case "error":
      return `${name} — error`;
  }
}

function labelForReason(reason: PromptMsg["reason"]): string {
  switch (reason) {
    case "activity":
      return "Recent activity";
    case "action-click":
      return "Repeated action";
    case "repetition":
      return "Repeated pattern";
    case "content-dwell":
      return "Meaningful page interaction";
    case "form-submit":
      return "Submitted workflow";
    case "terminal-nav":
      return "Completed workflow";
    case "rich-page":
      return "Saveable page";
  }
}

// ---- assets ----------------------------------------------------------------

/** Placeholder avatar mark — soft circle with subtle dot. We'll swap for the
 *  real Notion Dance face once we have an asset. */
const AVATAR_INNER_HTML = `
  <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    <circle cx="20" cy="20" r="18" fill="#ffffff" stroke="#e7e7e4" stroke-width="1"/>
    <circle cx="20" cy="20" r="3" fill="#37352f" opacity="0.55"/>
  </svg>
`;

/** Tool-icon row shown during the "building" state. Tiny inline SVGs. */
const BUILD_ICONS_HTML = `
  <span class="nh-build-pill" style="--nh-delay: 0ms">
    <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2L13 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
  </span>
  <span class="nh-build-pill" style="--nh-delay: 120ms">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5L4 11l7-7 2.5 2.5-7 7L4 14l-1.5-.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
  </span>
  <span class="nh-build-pill" style="--nh-delay: 240ms">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4L2.5 8L6 12M10 4L13.5 8L10 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </span>
  <span class="nh-build-pill" style="--nh-delay: 360ms">
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 7h11M7 3v10" stroke="currentColor" stroke-width="1.2"/></svg>
  </span>
`;

// ---- CSS -------------------------------------------------------------------
//
// All selectors scoped under #${STACK_ROOT_ID} to avoid bleeding into the host
// page. Layout: card on the left, avatar column on the right, fixed top-right.
// Notion-inspired palette: warm off-white card, soft borders, near-black ink,
// blue link accents (#2383E2).

const STACK_CSS = `
#${STACK_ROOT_ID} {
  --nh-ink: #37352f;
  --nh-ink-soft: #6f6e69;
  --nh-ink-muted: #9b9a96;
  --nh-bg: #ffffff;
  --nh-bg-soft: #f7f6f3;
  --nh-border: #e7e7e4;
  --nh-border-strong: #d9d9d6;
  --nh-blue: #2383e2;
  --nh-blue-strong: #1b6dc1;
  --nh-green: #0f7b6c;
  --nh-red: #b54b3b;
  --nh-shadow: 0 12px 32px rgba(15, 15, 15, 0.12), 0 2px 6px rgba(15, 15, 15, 0.06);
  --nh-glow: 0 0 0 6px rgba(35, 131, 226, 0.16), 0 0 24px rgba(35, 131, 226, 0.35);

  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2147483647;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: var(--nh-ink);
  pointer-events: none;
}

#${STACK_ROOT_ID} *,
#${STACK_ROOT_ID} *::before,
#${STACK_ROOT_ID} *::after {
  box-sizing: border-box;
}

/* ----- card ----- */

#${STACK_ROOT_ID} .nh-stack-card {
  width: 340px;
  max-width: calc(100vw - 96px);
  padding: 18px 20px 16px;
  border-radius: 14px;
  background: var(--nh-bg);
  border: 1px solid var(--nh-border);
  box-shadow: var(--nh-shadow);
  pointer-events: auto;
  opacity: 0;
  transform: translateX(8px) scale(0.985);
  transition:
    opacity 180ms cubic-bezier(0.22, 0.61, 0.36, 1),
    transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1);
  visibility: hidden;
}

#${STACK_ROOT_ID} .nh-stack-card[data-open="true"] {
  opacity: 1;
  transform: translateX(0) scale(1);
  visibility: visible;
}

#${STACK_ROOT_ID} .nh-card-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

#${STACK_ROOT_ID} .nh-card-close {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--nh-ink-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}

#${STACK_ROOT_ID} .nh-card-close:hover {
  background: var(--nh-bg-soft);
  color: var(--nh-ink);
}

#${STACK_ROOT_ID} .nh-card-heading {
  font-size: 16px;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--nh-ink);
  padding-right: 18px;
}

#${STACK_ROOT_ID} .nh-card-heading.is-success {
  color: var(--nh-green);
}

#${STACK_ROOT_ID} .nh-card-heading.is-error {
  color: var(--nh-red);
}

#${STACK_ROOT_ID} .nh-card-subheading {
  font-size: 13px;
  color: var(--nh-ink-soft);
  margin-top: -2px;
}

#${STACK_ROOT_ID} .nh-card-body {
  font-size: 14px;
  line-height: 1.45;
  color: var(--nh-ink-soft);
  font-weight: 400;
}

#${STACK_ROOT_ID} .nh-card-emphasis {
  color: var(--nh-ink);
  font-weight: 600;
}

#${STACK_ROOT_ID} .nh-card-meta {
  margin-top: 2px;
  font-size: 11.5px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--nh-ink-muted);
}

#${STACK_ROOT_ID} .nh-card-actions {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 8px;
}

#${STACK_ROOT_ID} .nh-card-link {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--nh-blue);
  cursor: pointer;
  text-decoration: none;
  transition: color 120ms ease;
}

#${STACK_ROOT_ID} .nh-card-link:hover {
  color: var(--nh-blue-strong);
}

#${STACK_ROOT_ID} .nh-card-link.is-primary {
  font-weight: 600;
}

#${STACK_ROOT_ID} .nh-card-back {
  margin-top: 6px;
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--nh-ink-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

#${STACK_ROOT_ID} .nh-card-back:hover {
  color: var(--nh-ink);
}

/* ----- proposal preview ----- */

#${STACK_ROOT_ID} .nh-card-proposal {
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--nh-bg-soft);
  border: 1px solid var(--nh-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

#${STACK_ROOT_ID} .nh-card-proposal-db {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

#${STACK_ROOT_ID} .nh-card-proposal-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--nh-ink-muted);
}

#${STACK_ROOT_ID} .nh-card-proposal-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--nh-ink);
}

#${STACK_ROOT_ID} .nh-card-proposal-props {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

#${STACK_ROOT_ID} .nh-card-proposal-chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--nh-bg);
  border: 1px solid var(--nh-border-strong);
  color: var(--nh-ink-soft);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

#${STACK_ROOT_ID} .nh-card-proposal-chip.is-more {
  color: var(--nh-ink-muted);
  background: transparent;
  border-style: dashed;
}

/* ----- building row ----- */

#${STACK_ROOT_ID} .nh-card-buildrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

#${STACK_ROOT_ID} .nh-build-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--nh-bg);
  border: 1px solid var(--nh-border-strong);
  color: var(--nh-ink-soft);
  animation: nh-build-bounce 1.3s ease-in-out infinite;
  animation-delay: var(--nh-delay, 0ms);
}

#${STACK_ROOT_ID} .nh-build-pill svg {
  width: 14px;
  height: 14px;
}

@keyframes nh-build-bounce {
  0%, 100% {
    transform: translateY(0);
    opacity: 0.55;
  }
  40% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

/* ----- avatar column ----- */

#${STACK_ROOT_ID} .nh-stack-avatars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
}

#${STACK_ROOT_ID} .nh-avatar {
  position: relative;
  width: 44px;
  height: 44px;
  pointer-events: auto;
  animation: nh-avatar-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

@keyframes nh-avatar-in {
  from {
    opacity: 0;
    transform: scale(0.7);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

#${STACK_ROOT_ID} .nh-avatar-btn {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 50%;
  transition: transform 140ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

#${STACK_ROOT_ID} .nh-avatar-btn:hover {
  transform: scale(1.04);
}

#${STACK_ROOT_ID} .nh-avatar-btn svg {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 4px 10px rgba(15, 15, 15, 0.12));
}

#${STACK_ROOT_ID} .nh-avatar.is-active .nh-avatar-btn svg circle:first-child {
  stroke: var(--nh-blue);
  stroke-width: 1.4;
}

#${STACK_ROOT_ID} .nh-avatar.is-done .nh-avatar-btn svg circle:last-child {
  fill: var(--nh-green);
  opacity: 1;
}

#${STACK_ROOT_ID} .nh-avatar.is-error .nh-avatar-btn svg circle:last-child {
  fill: var(--nh-red);
  opacity: 1;
}

/* Glow ring — pulses while the avatar awaits user input. */
#${STACK_ROOT_ID} .nh-avatar-glow {
  position: absolute;
  top: -4px;
  left: -4px;
  right: -4px;
  bottom: -4px;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    rgba(35, 131, 226, 0.45) 0%,
    rgba(35, 131, 226, 0.15) 55%,
    rgba(35, 131, 226, 0) 100%
  );
  filter: blur(2px);
  pointer-events: none;
  animation: nh-glow-pulse 1.8s ease-in-out infinite;
}

#${STACK_ROOT_ID} .nh-avatar.is-building .nh-avatar-glow {
  background: radial-gradient(
    closest-side,
    rgba(15, 123, 108, 0.35) 0%,
    rgba(15, 123, 108, 0.12) 55%,
    rgba(15, 123, 108, 0) 100%
  );
}

@keyframes nh-glow-pulse {
  0%, 100% {
    opacity: 0.55;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  #${STACK_ROOT_ID} .nh-avatar,
  #${STACK_ROOT_ID} .nh-stack-card,
  #${STACK_ROOT_ID} .nh-avatar-glow,
  #${STACK_ROOT_ID} .nh-build-pill {
    animation: none !important;
    transition: none !important;
  }
}
`;
