import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { registerRoutes } from "./routes.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(sensible);
  await registerRoutes(app);
  return app;
}
