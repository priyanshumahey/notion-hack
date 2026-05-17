// Singleton accessor for the active NotionGateway.
//
// Phase 1: this is still the MOCK gateway. Real-Notion code lives in
// notion/observations.ts (ObservationsClient) and runs in parallel —
// observations write to real Notion, completion-apply still writes to mock.

import type { NotionGateway } from "./types";
import { MockNotionGateway } from "./mock";

let _instance: NotionGateway | null = null;

export function getNotionGateway(): NotionGateway {
  if (!_instance) _instance = new MockNotionGateway();
  return _instance;
}
