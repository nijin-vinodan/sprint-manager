import pg from "pg";
import { serverConfig } from "./config.js";

// One pool per process, shared by the lock table and reused nowhere else —
// the checkpointer manages its own separate pool internally (PostgresSaver.fromConnString).
export const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl });
