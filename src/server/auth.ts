import type { FastifyReply, FastifyRequest } from "fastify";
import { lookupApiClient, type ApiClient } from "./apiClients.js";

declare module "fastify" {
  interface FastifyRequest {
    apiClient?: ApiClient;
  }
}

const API_KEY_HEADER = "x-api-key";

/**
 * Validates the caller's API key before any route handler runs. Register as
 * an `onRequest` hook so it fires ahead of body parsing / handlers for every
 * route it's applied to.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers[API_KEY_HEADER];
  const apiKey = Array.isArray(header) ? header[0] : header;

  if (!apiKey) {
    await reply.code(401).send({ error: `Missing "${API_KEY_HEADER}" header` });
    return;
  }

  const client = lookupApiClient(apiKey);
  if (!client) {
    await reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  request.apiClient = client;
}
