import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { signSessionJwt, verifySessionJwt, type SessionClaims } from "./jwt";

export const SESSION_COOKIE = "tgp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface IssuedSession {
  jti: string;
  token: string;
  expiresAt: number;
}

export async function issueSession(c: Context<{ Bindings: Env; Variables: any }>, userId: string): Promise<IssuedSession> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const claims: SessionClaims = {
    sub: userId,
    jti,
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS,
  };
  const token = await signSessionJwt(claims, c.env.SESSION_JWT_SECRET);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { jti, token, expiresAt: claims.exp };
}

export async function readSession(c: Context<{ Bindings: Env; Variables: any }>): Promise<SessionClaims | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return verifySessionJwt(token, c.env.SESSION_JWT_SECRET);
}

export function clearSession(c: Context<{ Bindings: Env; Variables: any }>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
