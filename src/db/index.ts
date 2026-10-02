import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

declare global {
  var _postgresPool: Pool | undefined;
}

export const createPool = () => {
  if (!process.env.SQL_HOST) {
    return null;
  }
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    });

    global._postgresPool.on("error", (err) => {
      // Scale-to-zero Cloud SQL instances routinely drop idle connections, which is normal behavior
      console.info("SQL pool idle connection cycle:", err?.message || err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = pool ? drizzle(pool, { schema }) : (null as any);
