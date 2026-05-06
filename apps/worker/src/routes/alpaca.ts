import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { alpacaKeysSchema } from "shared/playbook";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { seal } from "../lib/crypto";
import { AlpacaAuthError, fetchAccount } from "../lib/alpaca";
import { captureEquitySnapshotForUser } from "../routines/cron";
import { requireSession, type AppEnv } from "../middleware/session";

export const alpacaRoutes = new Hono<AppEnv>();

alpacaRoutes.use("*", requireSession);

alpacaRoutes.post("/keys", zValidator("json", alpacaKeysSchema), async (c) => {
  const { apiKey, apiSecret } = c.req.valid("json");
  const user = c.get("user");

  let account;
  try {
    account = await fetchAccount(apiKey, apiSecret);
  } catch (err) {
    if (err instanceof AlpacaAuthError) {
      return c.json(
        { error: "alpaca_auth_failed", message: "Alpaca rejected those keys. Double-check paper-trading credentials at app.alpaca.markets/paper." },
        401,
      );
    }
    console.error("alpaca fetch error", err);
    return c.json(
      { error: "alpaca_unreachable", message: "Could not reach Alpaca. Try again." },
      502,
    );
  }

  try {
    const sealedKey = await seal(apiKey, c.env.ALPACA_KEY_ENCRYPTION_KEY);
    const sealedSecret = await seal(apiSecret, c.env.ALPACA_KEY_ENCRYPTION_KEY);
    const db = getDb(c.env.DB);
    await db
      .update(users)
      .set({
        alpacaKeyCiphertext: sealedKey.ciphertext,
        alpacaKeyIv: sealedKey.iv,
        alpacaSecretCiphertext: sealedSecret.ciphertext,
        alpacaSecretIv: sealedSecret.iv,
        alpacaAccountId: account.id,
      })
      .where(eq(users.id, user.id));
    const [userRow] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (userRow) await captureEquitySnapshotForUser(c.env, userRow);
    return c.json({
      accountId: account.id,
      accountNumber: account.account_number,
      status: account.status,
      equity: account.equity,
      buyingPower: account.buying_power,
    });
  } catch (err) {
    console.error("alpaca store error", err);
    return c.json(
      { error: "encrypt_or_store_failed", message: "Alpaca keys are valid but we couldn't save them. Check the worker log." },
      500,
    );
  }
});
