import type { MiddlewareHandler } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { readSession } from "../auth/session";

export interface AuthUser {
  id: string;
  displayName: string;
  teamColor: string;
  onboardedAt: number | null;
  isAdmin: boolean;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const claims = await readSession(c);
  if (!claims) return c.json({ error: "unauthenticated" }, 401);

  const db = getDb(c.env.DB);
  const [sessionRow] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.jti, claims.jti), isNull(sessions.revokedAt)))
    .limit(1);
  if (!sessionRow) return c.json({ error: "unauthenticated" }, 401);

  const [userRow] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!userRow) return c.json({ error: "unauthenticated" }, 401);

  c.set("user", {
    id: userRow.id,
    displayName: userRow.displayName,
    teamColor: userRow.teamColor,
    onboardedAt: userRow.onboardedAt,
    isAdmin: userRow.displayName === c.env.ADMIN_DISPLAY_NAME,
  });
  await next();
};
