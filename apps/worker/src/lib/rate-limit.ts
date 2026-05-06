import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { rateLimits } from "../db/schema";
import { ulid } from "./ids";

export interface RateLimitWindow {
  bucket: string;
  windowSeconds: number;
  limit: number;
}

export interface RateLimitResult {
  ok: boolean;
  bucket: string;
  remaining: number;
  resetAt: number;
}

/**
 * Atomically increment-and-check counters across one or more rolling-aligned
 * windows. If any window is already at its limit, no counter is incremented
 * and the failing bucket is returned with its resetAt timestamp.
 *
 * Window alignment: `floor(now / windowSeconds) * windowSeconds`. Both the
 * hourly and daily fire-now buckets use that pattern.
 */
export async function checkAndIncrementRateLimits(
  env: Env,
  userId: string,
  windows: RateLimitWindow[],
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; results: RateLimitResult[] } | { ok: false; failed: RateLimitResult }> {
  const db = getDb(env.DB);

  const computed = windows.map((w) => {
    const windowStart = Math.floor(nowSec / w.windowSeconds) * w.windowSeconds;
    return { ...w, windowStart, resetAt: windowStart + w.windowSeconds };
  });

  // Read current counts for all relevant (bucket, windowStart) rows.
  const counts = new Map<string, number>();
  for (const w of computed) {
    const [row] = await db
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(
        and(
          eq(rateLimits.userId, userId),
          eq(rateLimits.bucket, w.bucket),
          eq(rateLimits.windowStart, w.windowStart),
        ),
      )
      .limit(1);
    counts.set(w.bucket, row?.count ?? 0);
  }

  // Reject before incrementing if any window is already full.
  for (const w of computed) {
    const current = counts.get(w.bucket) ?? 0;
    if (current >= w.limit) {
      return {
        ok: false,
        failed: {
          ok: false,
          bucket: w.bucket,
          remaining: 0,
          resetAt: w.resetAt,
        },
      };
    }
  }

  // All windows have headroom — increment each.
  const results: RateLimitResult[] = [];
  for (const w of computed) {
    await db
      .insert(rateLimits)
      .values({
        id: ulid(),
        userId,
        bucket: w.bucket,
        windowStart: w.windowStart,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [rateLimits.userId, rateLimits.bucket, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      });
    const newCount = (counts.get(w.bucket) ?? 0) + 1;
    results.push({
      ok: true,
      bucket: w.bucket,
      remaining: Math.max(0, w.limit - newCount),
      resetAt: w.resetAt,
    });
  }

  return { ok: true, results };
}
