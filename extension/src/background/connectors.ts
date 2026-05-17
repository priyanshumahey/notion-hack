import { applyCandidate } from "./apply";
import { getCompletionStore } from "../lib/store";
import { getNotionGateway } from "../lib/notion/gateway";
import {
  CONNECTOR_CATALOG,
  getConnectorDefinition,
  isConnectorConnected,
  setConnectorConnected,
  type ConnectorId,
  type ConnectorInfo,
} from "../lib/connectors";
import type { CompletionCandidate } from "../lib/types";

const completions = getCompletionStore();

export async function listConnectors(): Promise<ConnectorInfo[]> {
  return Promise.all(CONNECTOR_CATALOG.map((connector) => connectorInfo(connector.id)));
}

export async function connectConnector(id: ConnectorId): Promise<ConnectorInfo> {
  assertKnownConnector(id);
  await setConnectorConnected(id, true);
  return connectorInfo(id);
}

export async function disconnectConnector(id: ConnectorId): Promise<ConnectorInfo> {
  assertKnownConnector(id);
  await setConnectorConnected(id, false);
  return connectorInfo(id);
}

export async function executeConnectorFlow(
  connectorId: ConnectorId,
  candidateId?: string,
  opts: { auto?: boolean } = {},
): Promise<{ connector: ConnectorInfo; completion: CompletionCandidate | null }> {
  assertKnownConnector(connectorId);
  const connector = await connectorInfo(connectorId);

  const id = candidateId ?? (await latestSaveableCandidateId(connectorId));
  if (!id) {
    return { connector, completion: null };
  }
  if (connectorId === "notion") {
    const completion = await applyCandidate(id, opts);
    return { connector: await connectorInfo(connectorId), completion };
  }
  const completion = await executeMockConnector(connectorId, id, opts);
  return { connector: await connectorInfo(connectorId), completion };
}

async function connectorInfo(id: ConnectorId): Promise<ConnectorInfo> {
  const definition = getConnectorDefinition(id);
  if (!definition) throw new Error(`Unknown connector: ${id}`);
  const connected = await isConnectorConnected(id);
  const workspace = id === "notion" ? getNotionGateway().workspaceLabel() : definition.workspace;
  return {
    id: definition.id,
    label: definition.label,
    status: connected ? "connected" : "disconnected",
    workspace,
    description: definition.description,
    actions: definition.actions,
  };
}

async function executeMockConnector(
  connectorId: ConnectorId,
  candidateId: string,
  opts: { auto?: boolean },
): Promise<CompletionCandidate | null> {
  const connector = await connectorInfo(connectorId);
  const candidate = await completions.get(candidateId);
  if (!candidate) return null;

  const now = Date.now();
  if (connector.status !== "connected") {
    candidate.connectorRuns = [
      ...(candidate.connectorRuns ?? []),
      {
        connectorId,
        connectorLabel: connector.label,
        action: "Execute flow",
        status: "failed",
        message: `${connector.label} connector is not connected.`,
        ranAt: now,
        auto: opts.auto,
      },
    ];
    await completions.update(candidate);
    return candidate;
  }

  const title =
    candidate.judgement?.proposal?.database.name ??
    candidate.trigger.pageContext?.title ??
    candidate.trigger.pageKey;
  const sourceUrl = candidate.trigger.url;
  const action = connectorId === "slack" ? "Post channel message" : connector.actions[0] ?? "Execute flow";
  const message = connectorId === "slack"
    ? `Posted "${title}" to #repeatable-interactions.`
    : `${connector.label} flow ran for "${title}".`;

  candidate.status = "promoted";
  candidate.connectorRuns = [
    ...(candidate.connectorRuns ?? []),
    {
      connectorId,
      connectorLabel: connector.label,
      action,
      status: "applied",
      message,
      url: sourceUrl,
      ranAt: now,
      auto: opts.auto,
    },
  ];
  await completions.update(candidate);
  return candidate;
}

async function latestSaveableCandidateId(connectorId: ConnectorId): Promise<string | null> {
  const recent = await completions.recent(100);
  const candidate = recent.find((c) => (
    c.judgement?.meaningful &&
    c.judgement.proposal &&
    (
      connectorId === "notion"
        ? (!c.applied || c.applied.status === "failed")
        : !(c.connectorRuns ?? []).some((run) => (
            run.connectorId === connectorId && run.status === "applied"
          ))
    )
  ));
  return candidate?.id ?? null;
}

function assertKnownConnector(id: ConnectorId): void {
  if (!getConnectorDefinition(id)) {
    throw new Error(`Unknown connector: ${id}`);
  }
}
