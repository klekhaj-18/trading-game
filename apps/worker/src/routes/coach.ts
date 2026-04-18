import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { coachChatRequestSchema } from "shared/coach";
import { coachTurn } from "../claude/coach";
import { requireSession, type AppEnv } from "../middleware/session";

export const coachRoutes = new Hono<AppEnv>();

coachRoutes.use("*", requireSession);

coachRoutes.post("/chat", zValidator("json", coachChatRequestSchema), async (c) => {
  const { messages } = c.req.valid("json");
  if (messages[messages.length - 1]?.role !== "user") {
    return c.json({ error: "last_message_must_be_user" }, 400);
  }
  try {
    const result = await coachTurn(c.env, messages);
    return c.json({
      assistantText: result.assistantText,
      draft: result.draft,
      usage: result.usage,
    });
  } catch (err) {
    console.error("coach chat error", err);
    return c.json({ error: "coach_failed", message: "Coach had a hiccup. Try again." }, 502);
  }
});
