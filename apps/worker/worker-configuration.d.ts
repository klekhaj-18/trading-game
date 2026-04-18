interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ORIGIN: string;
  ADMIN_DISPLAY_NAME: string;
  ANTHROPIC_API_KEY: string;
  ALPACA_KEY_ENCRYPTION_KEY: string;
  SESSION_JWT_SECRET: string;
}
