#!/usr/bin/env node
// Pin every cron trigger we expect Cloudflare to register on `wrangler deploy`.
// A drift between wrangler.toml `[triggers].crons` and this list (or between
// either of those and the dispatch table in src/routines/cron.ts) means a
// past incident: a bad deploy stripped the schedule, leaving the worker
// healthy but silently un-triggered.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, "..");

const EXPECTED_CRONS = [
  "45 12 * * MON-FRI",      // factor warm (pre-premarket)
  "15 13 * * MON-FRI",      // premarket routine
  "35 13 * * MON-FRI",      // open routine
  "30 15 * * MON-FRI",      // midmorning routine
  "0 18 * * MON-FRI",       // afternoon routine
  "45 19 * * MON-FRI",      // close routine
  "*/5 13-20 * * MON-FRI",  // 5-min equity tick during US market hours
];

function fail(msg) {
  console.error(`\n❌ cron-config check failed:\n   ${msg}\n`);
  process.exit(1);
}

function readWranglerCrons() {
  const p = path.join(workerDir, "wrangler.toml");
  const txt = fs.readFileSync(p, "utf8");
  const m = txt.match(/\[triggers\][^[]*?crons\s*=\s*\[([\s\S]*?)\]/);
  if (!m) fail(`wrangler.toml: missing [triggers].crons block at ${p}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].trim());
}

function readCronHandlerKeys() {
  const p = path.join(workerDir, "src/routines/cron.ts");
  const txt = fs.readFileSync(p, "utf8");
  const slotKeys = [...txt.matchAll(/"([^"]+)"\s*:\s*"(?:premarket|open|midmorning|afternoon|close)"/g)].map((x) => x[1]);
  const warm = (txt.match(/FACTOR_WARM_CRON\s*=\s*"([^"]+)"/) ?? [, null])[1];
  const tick = (txt.match(/EQUITY_TICK_CRON\s*=\s*"([^"]+)"/) ?? [, null])[1];
  if (!warm) fail(`src/routines/cron.ts: FACTOR_WARM_CRON constant not found`);
  if (!tick) fail(`src/routines/cron.ts: EQUITY_TICK_CRON constant not found`);
  return [warm, ...slotKeys, tick];
}

function diff(label, actual, expected) {
  const aSet = new Set(actual);
  const eSet = new Set(expected);
  const missing = expected.filter((c) => !aSet.has(c));
  const extra = actual.filter((c) => !eSet.has(c));
  if (missing.length === 0 && extra.length === 0) return;
  const lines = [`${label} drift:`];
  if (missing.length) lines.push(`  missing: ${JSON.stringify(missing)}`);
  if (extra.length) lines.push(`  extra:   ${JSON.stringify(extra)}`);
  fail(lines.join("\n   "));
}

const wranglerCrons = readWranglerCrons();
const handlerCrons = readCronHandlerKeys();

diff("wrangler.toml [triggers].crons vs expected", wranglerCrons, EXPECTED_CRONS);
diff("src/routines/cron.ts handler keys vs expected", handlerCrons, EXPECTED_CRONS);

console.log(`✅ cron-config OK — ${EXPECTED_CRONS.length} schedules pinned across wrangler.toml + cron.ts.`);
