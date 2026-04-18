import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { count } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { signupSchema, loginSchema, MAX_PLAYERS } from "shared/auth";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { hashPassword, verifyPassword, timingSafeDummyVerify } from "../auth/password";
import { clearSession, issueSession, readSession, SESSION_COOKIE } from "../auth/session";
import { ulid } from "../lib/ids";
import type { AppEnv } from "../middleware/session";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/status", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select({ n: count() }).from(users);
  const n = rows[0]?.n ?? 0;
  return c.json({ usersCount: n, roomFull: n >= MAX_PLAYERS, maxPlayers: MAX_PLAYERS });
});

authRoutes.post("/signup", zValidator("json", signupSchema), async (c) => {
  const { displayName, password, teamColor } = c.req.valid("json");
  const db = getDb(c.env.DB);

  const rows = await db.select({ n: count() }).from(users);
  const n = rows[0]?.n ?? 0;
  if (n >= MAX_PLAYERS) {
    return c.json({ error: "room_full", message: "The paddock is full." }, 409);
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.displayName, displayName))
    .limit(1);
  if (existing.length) {
    return c.json({ error: "name_taken", message: "That display name is already claimed." }, 409);
  }

  const colorTaken = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.teamColor, teamColor))
    .limit(1);
  if (colorTaken.length) {
    return c.json({ error: "color_taken", message: "That team color is already chosen." }, 409);
  }

  const passwordHash = await hashPassword(password);
  const id = ulid();
  await db.insert(users).values({ id, displayName, passwordHash, teamColor });

  const session = await issueSession(c, id);
  await db.insert(sessions).values({ jti: session.jti, userId: id, expiresAt: session.expiresAt });

  return c.json({
    user: {
      id,
      displayName,
      teamColor,
      onboardedAt: null,
      isAdmin: displayName === c.env.ADMIN_DISPLAY_NAME,
    },
  });
});

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const { displayName, password } = c.req.valid("json");
  const db = getDb(c.env.DB);

  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.displayName, displayName))
    .limit(1);

  if (!userRow) {
    await timingSafeDummyVerify(password);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const ok = await verifyPassword(password, userRow.passwordHash);
  if (!ok) return c.json({ error: "invalid_credentials" }, 401);

  const session = await issueSession(c, userRow.id);
  await db
    .insert(sessions)
    .values({ jti: session.jti, userId: userRow.id, expiresAt: session.expiresAt });

  return c.json({
    user: {
      id: userRow.id,
      displayName: userRow.displayName,
      teamColor: userRow.teamColor,
      onboardedAt: userRow.onboardedAt,
      isAdmin: userRow.displayName === c.env.ADMIN_DISPLAY_NAME,
    },
  });
});

authRoutes.post("/logout", async (c) => {
  const claims = await readSession(c);
  if (claims) {
    const db = getDb(c.env.DB);
    await db
      .update(sessions)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(eq(sessions.jti, claims.jti));
  }
  clearSession(c);
  return c.json({ ok: true });
});
