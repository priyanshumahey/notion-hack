import type {
  CompletionCandidate,
  HybridActionOverride,
  HybridActionType,
  NotionPropertySpec,
  NotionProposal,
  NotionRowCell,
} from "../types";
import type { NotionNativeConnector } from "./connectors";
import { getNotionNativeConnectorMatches } from "./connectors";

const ACTION_FIELDS: NotionPropertySpec[] = [
  {
    name: "Action Type",
    type: "select",
    options: ["Save to Notion", "Send Slack message", "Draft email", "Create task"],
  },
  {
    name: "Action Status",
    type: "select",
    options: ["Needs review", "Ready", "Done", "Blocked"],
  },
  {
    name: "Suggested Connector",
    type: "select",
    options: ["Notion", "Slack", "Gmail", "Google Drive", "GitHub", "Jira", "Asana"],
  },
  { name: "Action Target", type: "rich_text", options: [] },
  { name: "Action Draft", type: "rich_text", options: [] },
  { name: "Source URL", type: "url", options: [] },
];

export const HYBRID_ACTION_TYPES: HybridActionType[] = [
  "Save to Notion",
  "Send Slack message",
  "Draft email",
  "Create task",
];

export const HYBRID_CONNECTORS = [
  "Notion",
  "Slack",
  "Gmail",
  "Google Drive",
  "GitHub",
  "Jira",
  "Asana",
] as const;

export function withHybridActionPlan(
  proposal: NotionProposal,
  candidate: CompletionCandidate,
): NotionProposal {
  const plan = candidate.hybridAction
    ? fromOverride(candidate.hybridAction, candidate)
    : inferHybridAction(candidate, getNotionNativeConnectorMatches(candidate));
  const existingProps = new Set(proposal.database.properties.map((p) => p.name));
  const properties = [
    ...proposal.database.properties,
    ...ACTION_FIELDS.filter((field) => !existingProps.has(field.name)),
  ];

  const existingCells = new Set(proposal.row.map((cell) => cell.property));
  const row: NotionRowCell[] = [
    ...proposal.row,
    ...plan.row.filter((cell) => !existingCells.has(cell.property)),
  ];

  return {
    ...proposal,
    database: {
      ...proposal.database,
      properties,
    },
    row,
  };
}

interface HybridActionPlan {
  row: NotionRowCell[];
}

export function defaultHybridAction(candidate: CompletionCandidate): HybridActionOverride {
  const plan = inferHybridAction(candidate, getNotionNativeConnectorMatches(candidate));
  return {
    actionType: String(cellValue(plan.row, "Action Type") ?? "Save to Notion") as HybridActionType,
    connector: String(cellValue(plan.row, "Suggested Connector") ?? "Notion"),
    target: String(cellValue(plan.row, "Action Target") ?? ""),
    draft: String(cellValue(plan.row, "Action Draft") ?? ""),
  };
}

function fromOverride(
  action: HybridActionOverride,
  candidate: CompletionCandidate,
): HybridActionPlan {
  return {
    row: [
      { property: "Action Type", value: action.actionType },
      { property: "Action Status", value: action.actionType === "Save to Notion" ? "Ready" : "Needs review" },
      { property: "Suggested Connector", value: action.connector },
      { property: "Action Target", value: action.target },
      { property: "Action Draft", value: action.draft },
      { property: "Source URL", value: candidate.trigger.url },
    ],
  };
}

function cellValue(row: NotionRowCell[], property: string): NotionRowCell["value"] | undefined {
  return row.find((cell) => cell.property === property)?.value;
}

function inferHybridAction(
  candidate: CompletionCandidate,
  connectors: NotionNativeConnector[],
): HybridActionPlan {
  const host = candidate.scope.hosts[0] ?? safeHost(candidate.trigger.url) ?? "";
  const title = candidate.judgement?.proposal?.database.name ??
    candidate.trigger.pageContext?.title ??
    candidate.trigger.pageKey;
  const reasoning = candidate.judgement?.reasoning ?? candidate.triggerNote ?? "Repeatable interaction identified.";
  const sourceUrl = candidate.trigger.url;
  const text = `${reasoning}\n\nSource: ${sourceUrl}`;
  const connectorIds = new Set(connectors.map((connector) => connector.id));

  if (connectorIds.has("slack") || /slack/i.test(host)) {
    return {
      row: [
        { property: "Action Type", value: "Send Slack message" },
        { property: "Action Status", value: "Needs review" },
        { property: "Suggested Connector", value: "Slack" },
        { property: "Action Target", value: "#repeatable-interactions" },
        { property: "Action Draft", value: `Repeatable interaction: ${title}\n${text}` },
        { property: "Source URL", value: sourceUrl },
      ],
    };
  }

  if (connectorIds.has("google-drive") || /gmail|mail\.google|google/i.test(host)) {
    return {
      row: [
        { property: "Action Type", value: "Draft email" },
        { property: "Action Status", value: "Needs review" },
        { property: "Suggested Connector", value: "Gmail" },
        { property: "Action Target", value: "" },
        { property: "Action Draft", value: `Subject: ${title}\n\n${text}` },
        { property: "Source URL", value: sourceUrl },
      ],
    };
  }

  if (connectorIds.has("github") || connectorIds.has("jira") || connectorIds.has("asana")) {
    const connector = connectors.find((c) => ["github", "jira", "asana"].includes(c.id));
    return {
      row: [
        { property: "Action Type", value: "Create task" },
        { property: "Action Status", value: "Needs review" },
        { property: "Suggested Connector", value: connector?.label ?? "Notion" },
        { property: "Action Target", value: connector?.label ?? "" },
        { property: "Action Draft", value: `${title}\n${text}` },
        { property: "Source URL", value: sourceUrl },
      ],
    };
  }

  return {
    row: [
      { property: "Action Type", value: "Save to Notion" },
      { property: "Action Status", value: "Ready" },
      { property: "Suggested Connector", value: connectors[0]?.label ?? "Notion" },
      { property: "Action Target", value: "" },
      { property: "Action Draft", value: text },
      { property: "Source URL", value: sourceUrl },
    ],
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
