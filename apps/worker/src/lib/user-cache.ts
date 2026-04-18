export async function invalidateUserAlpacaCaches(env: Env, userId: string): Promise<void> {
  await Promise.allSettled([
    env.CACHE.delete(`open-orders:${userId}`),
    env.CACHE.delete(`positions:${userId}`),
  ]);
}
