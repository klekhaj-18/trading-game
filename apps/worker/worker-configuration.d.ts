interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  ADMIN_DISPLAY_NAME: string;
  ANTHROPIC_API_KEY: string;
  ALPACA_KEY_ENCRYPTION_KEY: string;
  SESSION_JWT_SECRET: string;
  FINNHUB_API_KEY?: string;
}
