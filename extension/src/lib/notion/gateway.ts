// Singleton accessor for the active NotionGateway.
//
// Today: always returns MockNotionGateway.
// Later: read a preference and return Mock or Real (or hybrid).

import type { NotionGateway } from "./types";
import { MockNotionGateway } from "./mock";

let _instance: NotionGateway | null = null;

export function getNotionGateway(): NotionGateway {
  if (!_instance) _instance = new MockNotionGateway();
  return _instance;
}
