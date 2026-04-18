import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { alpacaRoutes } from "./routes/alpaca";
import { playbookRoutes } from "./routes/playbook";
import { coachRoutes } from "./routes/coach";
import { adminRoutes } from "./routes/admin";
import { raceRoutes } from "./routes/race";
import type { AppEnv } from "./middleware/session";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const origin = c.env.APP_ORIGIN;
  return cors({ origin, credentials: true })(c, next);
});

app.get("/api/health", (c) => c.json({ ok: true, service: "trading-grand-prix" }));

app.route("/api/auth", authRoutes);
app.route("/api/me", meRoutes);
app.route("/api/alpaca", alpacaRoutes);
app.route("/api/playbook", playbookRoutes);
app.route("/api/coach", coachRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/race", raceRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("worker error", err);
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: async (controller, env, ctx) => {
    const { handleScheduled } = await import("./routines/cron");
    await handleScheduled(controller.cron, env, ctx);
  },
} satisfies ExportedHandler<Env>;
