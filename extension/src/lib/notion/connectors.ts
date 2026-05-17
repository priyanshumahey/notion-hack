import type { CompletionCandidate } from "../types";

export type NotionNativeConnectorKind =
  | "link-preview"
  | "synced-database"
  | "connected-property"
  | "ai-connector";

export interface NotionNativeConnector {
  id: string;
  label: string;
  kind: NotionNativeConnectorKind;
  description: string;
  hostPatterns: string[];
}

export const NOTION_NATIVE_CONNECTORS: NotionNativeConnector[] = [
  {
    id: "slack",
    label: "Slack",
    kind: "ai-connector",
    description: "Ask Notion AI questions over connected Slack workspace knowledge.",
    hostPatterns: ["slack.com"],
  },
  {
    id: "github",
    label: "GitHub",
    kind: "synced-database",
    description: "Show GitHub PRs, issues, and repository links inside Notion.",
    hostPatterns: ["github.com"],
  },
  {
    id: "jira",
    label: "Jira",
    kind: "synced-database",
    description: "Keep Jira project and ticket information visible in Notion.",
    hostPatterns: ["atlassian.net", "jira.com"],
  },
  {
    id: "asana",
    label: "Asana",
    kind: "synced-database",
    description: "Bring Asana tasks and project context into Notion.",
    hostPatterns: ["asana.com"],
  },
  {
    id: "trello",
    label: "Trello",
    kind: "link-preview",
    description: "Preview Trello links and cards from Notion pages.",
    hostPatterns: ["trello.com"],
  },
  {
    id: "google-drive",
    label: "Google Drive",
    kind: "connected-property",
    description: "Link Drive files to Notion database items.",
    hostPatterns: ["drive.google.com", "docs.google.com"],
  },
  {
    id: "figma",
    label: "Figma",
    kind: "connected-property",
    description: "Link Figma files and design references to Notion database items.",
    hostPatterns: ["figma.com"],
  },
  {
    id: "zendesk",
    label: "Zendesk",
    kind: "connected-property",
    description: "Link support tickets and customer context to Notion database items.",
    hostPatterns: ["zendesk.com"],
  },
];

export function getNotionNativeConnectorMatches(
  candidate: CompletionCandidate,
): NotionNativeConnector[] {
  const hosts = new Set<string>();
  for (const host of candidate.scope.hosts) hosts.add(host);
  for (const event of [candidate.trigger, ...candidate.context]) {
    try {
      hosts.add(new URL(event.url).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // Ignore malformed URLs from historical records.
    }
  }

  const matches = NOTION_NATIVE_CONNECTORS.filter((connector) => (
    connector.hostPatterns.some((pattern) => (
      Array.from(hosts).some((host) => host === pattern || host.endsWith(`.${pattern}`))
    ))
  ));

  if (matches.length > 0) return matches;
  return NOTION_NATIVE_CONNECTORS.filter((connector) => (
    connector.kind === "link-preview" || connector.kind === "connected-property"
  )).slice(0, 3);
}

