import { readFileSync } from "node:fs";
import { serverConfig } from "./config.js";

export interface ApiClient {
  appName: string;
  description?: string;
}

// api-clients.json shape: { "<api-key>": { "appName": "...", "description": "..." } }
type ApiClientsFile = Record<string, ApiClient>;

let clients: ApiClientsFile | undefined;

function loadClients(): ApiClientsFile {
  let raw: string;
  try {
    raw = readFileSync(serverConfig.apiClientsPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read API clients config at "${serverConfig.apiClientsPath}" (set API_CLIENTS_PATH to override). ` +
        `See api-clients.json.example. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = JSON.parse(raw) as ApiClientsFile;
  for (const [key, client] of Object.entries(parsed)) {
    if (!client?.appName) {
      throw new Error(`API clients config entry for key "${key}" is missing required field "appName"`);
    }
  }
  return parsed;
}

/**
 * Loaded once per process and cached — every replica must be started with the
 * same api-clients.json content, and adding a key means redeploying all of them.
 */
export function getApiClients(): ApiClientsFile {
  if (!clients) clients = loadClients();
  return clients;
}

export function lookupApiClient(apiKey: string): ApiClient | undefined {
  return getApiClients()[apiKey];
}
