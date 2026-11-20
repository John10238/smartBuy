import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

export const isDatabaseConnected = Boolean(process.env.DATABASE_URL);

let poolInstance: pg.Pool;
let dbInstance: NodePgDatabase<typeof schema>;

if (process.env.DATABASE_URL) {
  poolInstance = new Pool({ connectionString: process.env.DATABASE_URL });
  dbInstance = drizzle(poolInstance, { schema });
} else {
  console.warn(
    "[AI Studio] DATABASE_URL not set — PostgreSQL disabled, using in-memory store",
  );
  const noOpClient = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };
  poolInstance = {
    query: async () => ({ rows: [] }),
    connect: async () => noOpClient,
  } as unknown as pg.Pool;

  const noOp = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (d: { data?: unknown }) => d?.data ?? {},
    update: async (d: { data?: unknown }) => d?.data ?? {},
    delete: async () => ({}),
  };
  dbInstance = new Proxy({} as NodePgDatabase<typeof schema>, {
    get: (_, prop) =>
      prop === "query"
        ? new Proxy({}, { get: () => noOp })
        : async () => [],
  });
}

export const pool = poolInstance;
export const db = dbInstance;

export * from "./schema";
