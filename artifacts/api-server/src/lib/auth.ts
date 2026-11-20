import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { eq } from "drizzle-orm";
import { db, pool, usersTable, isDatabaseConnected } from "@workspace/db";
import type { Request, RequestHandler } from "express";
import { logger } from "./logger";
import { memoryStore } from "./memoryStore";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      authUserId?: number;
      tenantId?: number;
    }
  }
}

const PgSessionStore = connectPgSimple(session);
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

const SESSION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
`;

let sessionTableEnsured: Promise<void> | null = null;
async function ensureSessionTable(): Promise<void> {
  if (sessionTableEnsured) return sessionTableEnsured;
  sessionTableEnsured = pool.query(SESSION_TABLE_DDL).then(() => undefined);
  return sessionTableEnsured;
}

function getSessionSecret(): string {
  return (
    process.env["SESSION_SECRET"] || "smartbuy-dev-session-secret-change-me"
  );
}

export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string") {
    return proto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  return false;
}

export function createAuthToken(userId: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      exp: Date.now() + SESSION_MAX_AGE_MS,
    }),
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAuthToken(token: string): number | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!payload || !sig) return null;

  const expectedSig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { uid?: unknown; exp?: unknown };
    if (
      typeof parsed.uid !== "number" ||
      !Number.isInteger(parsed.uid) ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= Date.now()
    ) {
      return null;
    }
    return parsed.uid;
  } catch {
    return null;
  }
}

export function getAuthUserId(req: Request): number | undefined {
  return req.session?.userId ?? req.authUserId;
}

export function createSessionMiddleware(): RequestHandler {
  const secret = getSessionSecret();
  if (!process.env["SESSION_SECRET"]) {
    logger.warn("SESSION_SECRET not set — using fallback dev secret");
  }

  const databaseUrl = process.env["DATABASE_URL"];

  let store: session.Store | undefined;
  if (isDatabaseConnected && databaseUrl) {
    store = new PgSessionStore({
      conString: databaseUrl,
      createTableIfMissing: false,
      tableName: "user_sessions",
    });
    void ensureSessionTable();
  } else {
    store = new session.MemoryStore();
    logger.warn("Using in-memory session store (sessions reset on restart)");
  }

  const sessionMiddleware = session({
    store,
    secret,
    name: "duka.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
    },
  });

  return (req, res, next) => {
    sessionMiddleware(req, res, (err) => {
      if (err) {
        next(err);
        return;
      }
      if (req.session?.cookie && isHttpsRequest(req)) {
        req.session.cookie.secure = true;
        req.session.cookie.sameSite = "none";
        (
          req.session.cookie as session.Cookie & { partitioned?: boolean }
        ).partitioned = true;
      }
      if (!req.session?.userId) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
          const userId = verifyAuthToken(authHeader.slice(7).trim());
          if (userId !== null) {
            req.authUserId = userId;
          }
        }
      }
      next();
    });
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function resolveTenantId(req: Request): Promise<number | null> {
  if (req.tenantId) return req.tenantId;
  const userId = getAuthUserId(req);
  if (!userId) return null;

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const user = memoryStore.users.find((u) => u.id === userId);
    if (!user) return null;
    const tid = user.ownerId ?? user.id;
    req.tenantId = tid;
    return tid;
  }

  const [user] = await db
    .select({ id: usersTable.id, ownerId: usersTable.ownerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) return null;
  const tid = user.ownerId ?? user.id;
  req.tenantId = tid;
  return tid;
}

export function getTenantId(req: Request): number {
  return req.tenantId!;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const tenantId = await resolveTenantId(req);
  if (!tenantId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
};
