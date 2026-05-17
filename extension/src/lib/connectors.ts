export type ConnectorId =
  | "notion"
  | "slack"
  | "github"
  | "jira"
  | "asana"
  | "linear"
  | "google-drive"
  | "google-sheets"
  | "gmail"
  | "google-calendar"
  | "trello"
  | "figma";
export type ConnectorStatus = "connected" | "disconnected";

export interface ConnectorDefinition {
  id: ConnectorId;
  label: string;
  workspace: string;
  description: string;
  actions: string[];
}

export interface ConnectorInfo {
  id: ConnectorId;
  label: string;
  status: ConnectorStatus;
  workspace: string;
  description: string;
  actions: string[];
}

export const CONNECTOR_CATALOG: ConnectorDefinition[] = [
  {
    id: "notion",
    label: "Notion",
    workspace: "Mock Notion",
    description: "Save approved repeatable interactions as structured Notion pages.",
    actions: ["Create database", "Create page", "Auto-apply trusted patterns"],
  },
  {
    id: "slack",
    label: "Slack",
    workspace: "Mock Slack",
    description: "Post repeatable interaction summaries into a Slack channel.",
    actions: ["Post channel message", "Notify owner", "Attach source URL"],
  },
  {
    id: "github",
    label: "GitHub",
    workspace: "Mock GitHub",
    description: "Create issues or project items from repeatable engineering workflows.",
    actions: ["Create issue", "Add labels", "Attach source URL"],
  },
  {
    id: "jira",
    label: "Jira",
    workspace: "Mock Jira",
    description: "Create tracked work items for repeated operational workflows.",
    actions: ["Create ticket", "Set project", "Attach context"],
  },
  {
    id: "asana",
    label: "Asana",
    workspace: "Mock Asana",
    description: "Create tasks from repeated processes and research activity.",
    actions: ["Create task", "Assign workspace", "Attach context"],
  },
  {
    id: "linear",
    label: "Linear",
    workspace: "Mock Linear",
    description: "Create Linear issues for repeatable product and engineering signals.",
    actions: ["Create issue", "Set team", "Attach source URL"],
  },
  {
    id: "google-drive",
    label: "Google Drive",
    workspace: "Mock Google Drive",
    description: "Store summaries and source links as Drive artifacts.",
    actions: ["Create document", "Add source link", "Save summary"],
  },
  {
    id: "google-sheets",
    label: "Google Sheets",
    workspace: "Mock Google Sheets",
    description: "Append structured rows for repeatable research and tracking workflows.",
    actions: ["Append row", "Map fields", "Attach source URL"],
  },
  {
    id: "gmail",
    label: "Gmail",
    workspace: "Mock Gmail",
    description: "Draft follow-up messages from repeated browser workflows.",
    actions: ["Create draft", "Summarize context", "Attach source URL"],
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    workspace: "Mock Google Calendar",
    description: "Create calendar holds from repeated scheduling workflows.",
    actions: ["Create event", "Set title", "Attach source URL"],
  },
  {
    id: "trello",
    label: "Trello",
    workspace: "Mock Trello",
    description: "Create cards for repeated lightweight tracking workflows.",
    actions: ["Create card", "Choose list", "Attach context"],
  },
  {
    id: "figma",
    label: "Figma",
    workspace: "Mock Figma",
    description: "Capture repeated design references and handoff signals.",
    actions: ["Save reference", "Attach source URL", "Notify workspace"],
  },
];

export function getConnectorDefinition(id: ConnectorId): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOG.find((connector) => connector.id === id);
}

function keyFor(id: ConnectorId): string {
  return `connector:${id}:connected`;
}

export async function isConnectorConnected(id: ConnectorId): Promise<boolean> {
  const key = keyFor(id);
  const r = await chrome.storage.local.get([key]);
  return r[key] === true;
}

export async function setConnectorConnected(
  id: ConnectorId,
  connected: boolean,
): Promise<void> {
  const key = keyFor(id);
  if (connected) {
    await chrome.storage.local.set({ [key]: true });
  } else {
    await chrome.storage.local.remove([key]);
  }
}
