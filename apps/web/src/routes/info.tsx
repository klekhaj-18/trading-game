import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface FaqItem {
  q: string;
  a: ReactNode;
  technical?: ReactNode;
  badge?: "Coming soon";
}

interface FaqSection {
  id: string;
  /** Short label for the sticky pill nav. */
  pillLabel: string;
  title: string;
  blurb?: string;
  items: FaqItem[];
}

const SECTIONS: FaqSection[] = [
  {
    id: "race",
    pillLabel: "Race",
    title: "The race & how Claude trades",
    blurb: "What you're actually playing, and what Claude does on your behalf.",
    items: [
      {
        q: "What is Trading Grand Prix?",
        a: (
          <>
            A 30-day paper-trading competition for four friends. Each player writes a strategy in
            plain English. Claude reads it before each routine, decides what to buy or sell, and
            places paper orders through Alpaca. Highest <span className="font-semibold">% return</span>{" "}
            on Lap 30 wins. F1 themed because we wanted it to feel like a season, not a slog.
          </>
        ),
      },
      {
        q: 'How long is the race? What\'s a "lap"?',
        a: (
          <>
            Exactly 30 days. Each day is one lap. The banner across the top shows{" "}
            <span className="font-semibold text-zinc-200">Lap N / 30</span> while the race is live,
            and either <span className="font-semibold">Pre-race</span> or{" "}
            <span className="font-semibold">Chequered flag</span> outside that window.
          </>
        ),
      },
      {
        q: "Who wins?",
        a: (
          <>
            Whoever has the highest <span className="font-semibold">% return</span> on Lap 30. We
            rank by percentage so the leaderboard is fair across players whose Alpaca paper
            accounts started with different balances — what matters is how much you grew it, not
            the dollar number underneath. No bonuses, no penalties, no weighting.
          </>
        ),
        technical: (
          <>
            Each player's baseline = the earliest <code>equity_snapshots</code> row at-or-after{" "}
            <code>competitionStartAt</code>. Return = <code>(equity / baseline) - 1</code>. Computed
            in <code>getPublicLeaderboardRow</code>; client sorts by{" "}
            <code>returnPct</code> desc, falls back to display name when null (pre-race or before
            the first post-start snapshot lands).
          </>
        ),
      },
      {
        q: "What's a playbook?",
        a: (
          <>
            Your strategy in plain English — goals, rules, risk tolerance, preferred names, things
            Claude must never do. You write it once during onboarding and revise it any time during
            the race from the Strategy tab.
          </>
        ),
        technical: (
          <>
            Stored as text on your user row. Versioned — every revision creates a new playbook
            record; the prior one is marked superseded so we can audit how your strategy evolved.
          </>
        ),
      },
      {
        q: 'What\'s a "plan"?',
        a: (
          <>
            When you save a playbook, Claude Opus turns it into a structured operational document —
            your stock universe, position sizing rules, when to act, when to wait. You review and
            approve (or reject with feedback) before any routine fires.
          </>
        ),
        technical: (
          <>
            Opus 4.7 with adaptive thinking, 16K max tokens, <code>submit_plan</code> tool with{" "}
            <code>tool_choice: auto</code> (Opus 4.7 rejects forced tool use combined with adaptive
            thinking). Stored as JSON. Every Haiku routine reads the latest approved plan.
          </>
        ),
      },
      {
        q: 'What\'s a "routine"?',
        a: (
          <>
            One Claude run that reads your plan, looks at fresh market data, and decides what to
            do. Each routine produces a list of decisions, validates them against safety caps, and
            (when applicable) places paper orders.
          </>
        ),
        technical: (
          <>
            Model is picked per slot: <span className="font-semibold">Opus 4.7</span> for the two
            highest-leverage slots (premarket and close), <span className="font-semibold">Sonnet 4.6</span>{" "}
            for the three intraday slots. 3 cache breakpoints (system / plan / account) plus a
            fresh market-snapshot layer; cache hits on call 2+. Tool call:{" "}
            <code>submit_decisions</code>.
          </>
        ),
      },
      {
        q: "When do routines fire?",
        a: (
          <>
            Five trading routines per US trading day — premarket, open, mid-morning, afternoon,
            and pre-close. Plus a "warm" slot every day at 08:45 ET (yes, weekends too) that
            pre-fetches market data so trading routines don't wait, and an equity-tick that
            snapshots your Alpaca account every 5 minutes during market hours so the leaderboard
            moves in near real time. The next routine fire-time shows on the Leaderboard banner.
            See the next item for what each slot does.
          </>
        ),
        technical: (
          <>
            Seven Cloudflare Cron Triggers, fixed in UTC. Trading routines + equity tick are
            weekday-gated (Mon–Fri); the warm runs every day, including weekends, so Monday's
            09:15 slot never has to rebuild from a cold cache. All routines are race-gated (no
            fires pre-race / post-race). Holidays are absorbed by Alpaca's market-closed signal —
            routines run, but validators downgrade live orders to "plan" actions. The 5-min
            equity tick (<code>*/5 13-20 * * MON-FRI</code>) only hits Alpaca for the snapshot;
            no Claude, no factor refresh — invisible on the Anthropic budget.
          </>
        ),
      },
      {
        q: "What does each cron trigger actually do?",
        a: (
          <>
            <p className="mb-3">
              Five trading slots that touch the market, one "warm" slot that just refreshes cached
              data, plus an every-5-min equity tick that pulls your Alpaca balance for the
              leaderboard. Times below are in <span className="font-semibold">US Eastern (EDT)</span>{" "}
              — the cron is fixed in UTC and tuned for daylight time, so during EST (Nov–Mar) every
              slot fires <span className="italic">one hour earlier</span> in ET.
            </p>
            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              <table className="w-full text-xs min-w-[640px]">
                <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left py-2 pr-3 font-semibold">UTC cron</th>
                    <th className="text-left py-2 pr-3 font-semibold">ET (EDT)</th>
                    <th className="text-left py-2 pr-3 font-semibold">Slot</th>
                    <th className="text-left py-2 pr-3 font-semibold">Model</th>
                    <th className="text-left py-2 font-semibold">Job</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300 align-top">
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">12:45</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">08:45</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300">warm</span>
                    </td>
                    <td className="py-2 pr-3 text-[11px]">Haiku 4.5 (per-headline)</td>
                    <td className="py-2 text-zinc-400">
                      Refresh the union universe across all approved players: Alpaca news +
                      bars, Finnhub profile/metrics/earnings, FMP earnings revenue, FRED macro,
                      sector momentum, Haiku-classified per-headline sentiment. Runs every day
                      (including weekends) so Monday's 09:15 slot has fresh data. No LLM trade
                      decisions, no orders. If this fails, the 09:15 slot runs an inline fallback.
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">13:15</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">09:15</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-blue-500/20 border border-blue-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-200">
                        premarket
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px] font-semibold text-amber-200">Opus 4.7</td>
                    <td className="py-2 text-zinc-400">
                      Review overnight news; set the day's posture. Market is closed, so live
                      orders are auto-downgraded to "plan" actions. High-leverage slot — uses Opus.
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">13:35</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">09:35</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-blue-500/20 border border-blue-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-200">
                        open
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px]">Sonnet 4.6</td>
                    <td className="py-2 text-zinc-400">
                      Execute conviction entries after opening spreads settle (~5 min after the
                      bell).
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">15:30</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">11:30</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-blue-500/20 border border-blue-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-200">
                        midmorning
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px]">Sonnet 4.6</td>
                    <td className="py-2 text-zinc-400">Trim losers, add to winners per the plan.</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">18:00</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">14:00</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-blue-500/20 border border-blue-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-200">
                        afternoon
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px]">Sonnet 4.6</td>
                    <td className="py-2 text-zinc-400">Sizing review, reassess stops.</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3 font-mono text-[11px]">19:45</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">15:45</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-blue-500/20 border border-blue-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-200">
                        close
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-[11px] font-semibold text-amber-200">Opus 4.7</td>
                    <td className="py-2 text-zinc-400">
                      Square up or protect gains per the plan. Pre-close (~15 min before bell);
                      another high-leverage slot, uses Opus.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-3 font-mono text-[11px]">*/5 13–20</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">9:00–16:55</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300">tick</span>
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-zinc-400">none</td>
                    <td className="py-2 text-zinc-400">
                      Pure equity snapshot — fetches your Alpaca balance and writes one row to{" "}
                      <code>equity_snapshots</code>. No Claude, no orders, no factor work. This is
                      what makes the leaderboard move in near real time during market hours.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              Equity snapshots also still piggyback on each routine slot (cheap, harmless overlap)
              — but the every-5-min tick is what keeps the leaderboard live between routine fires.
            </p>
          </>
        ),
        technical: (
          <>
            Each <span className="font-semibold">trading</span> routine is built from these
            context layers, in this order:
            <ul className="mt-2 ml-4 space-y-1 list-disc">
              <li>
                <span className="font-semibold text-zinc-200">System</span> (cached) — instructions
                + hard constraints + per-slot emphasis
              </li>
              <li>
                <span className="font-semibold text-zinc-200">Plan</span> (cached) — your structured
                operational plan as JSON + a markdown summary
              </li>
              <li>
                <span className="font-semibold text-zinc-200">Account</span> (cached) — equity,
                cash, BP, positions, open / working orders, last 10 fills, recent validation
                failures
              </li>
              <li>
                <span className="font-semibold text-zinc-200">Market snapshot</span> (fresh) — Alpaca
                clock, bid/ask/mid, last 5 daily bars, last 48h news, next earnings (Finnhub), plus
                broader-market context (SPY, QQQ, VIXY)
              </li>
              <li>
                <span className="font-semibold text-zinc-200">User intents</span> (fresh,
                conditional) — only injected when you have pending intents
              </li>
            </ul>
            <p className="mt-2">
              Data sources:{" "}
              <span className="font-semibold text-zinc-200">Alpaca paper API</span> (account,
              positions, orders, clock, quotes, bars, news, tradable symbols);{" "}
              <span className="font-semibold text-zinc-200">Finnhub</span> (next earnings, profile,
              metrics, economic calendar);{" "}
              <span className="font-semibold text-zinc-200">FMP</span> (earnings revenue
              actual/estimate — what Finnhub free tier doesn't return);{" "}
              <span className="font-semibold text-zinc-200">FRED</span> (VIX, 10y-2y yield spread,
              DXY — used by warm cron's regime card). See the "Where the data comes from" section
              below for the full breakdown.
            </p>
            <p className="mt-2">
              The warm cron writes aggregated factor blobs to KV (sentiment-scored headlines,
              technicals, regime card) — those are read by the <span className="italic">coach</span>{" "}
              (playbook revision flow), not the trading routines. Trading routines benefit
              indirectly because their lib-level fetches (Alpaca news, daily bars, Finnhub
              earnings) hit the same KV caches the warm slot populates.
            </p>
          </>
        ),
      },
      {
        q: "Where do I see what Claude saw when it made a decision?",
        a: (
          <>
            <p className="mb-2">Two places, depending on how deep you want to go.</p>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">For each routine:</span> Pit Wall →
              scroll to <span className="italic">Radio messages</span> → click any routine row to
              expand. You'll see Claude's reasoning at the top, a{" "}
              <span className="font-semibold">macro regime card</span> (VIX, 10y-2y yield spread,
              DXY, top/bottom sectors), then one{" "}
              <span className="font-semibold">decision card</span> per buy/sell/plan/hold. Each
              decision card has a <span className="font-mono text-zinc-400">▸ Details</span> link
              at the bottom — click it for the full per-symbol context Claude saw at the moment of
              decision:
            </p>
            <ul className="mt-2 ml-4 space-y-1 list-disc text-zinc-300">
              <li>
                <span className="font-semibold">From your playbook</span> — the universe rationale
                you wrote for that symbol
              </li>
              <li>
                <span className="font-semibold">Market context</span> — bid/ask, day OHLC, today's
                volume vs 30d avg, RSI 14, SMA 20/50/200 stack, vs-50d %, 52w hi/lo, ATR %, rel
                vol
              </li>
              <li>
                <span className="font-semibold">Last 5 sessions</span> — daily OHLCV, close
                color-coded
              </li>
              <li>
                <span className="font-semibold">Earnings</span> — EPS actual vs estimate with
                surprise %, revenue actual vs estimate with surprise %, quarter + reporting hour
              </li>
              <li>
                <span className="font-semibold">News & sentiment</span> — Claude-classified mood +
                numeric score, bull/neutral/bear counts, headline list with per-headline label +
                score + Claude's one-line rationale
              </li>
              <li>
                <span className="font-semibold">Your position at decision time</span> — shares,
                avg entry, unrealized P&amp;L, book weight, cash, buying power
              </li>
              <li>
                <span className="font-semibold">Outcome</span> — order status / fill / timestamps;
                or the validation reason that blocked it; or "no order placed" for plan/hold
              </li>
            </ul>
            <p className="mt-3">
              <span className="font-semibold text-zinc-200">For each FAQ item on this page:</span>{" "}
              the gray <span className="font-mono text-zinc-400">+ Show the technical bit</span>{" "}
              button below most answers reveals implementation detail — function names, file
              paths, model configs, schema specifics. Useful when you want to know exactly what
              code is running under a given behavior.
            </p>
          </>
        ),
        technical: (
          <>
            Detail is lazy-loaded via <code>/api/me/routine-runs/:id</code> only when you expand a
            row — keeps the list payload small. The endpoint returns the parsed{" "}
            <code>marketSnapshotJson</code> + <code>accountContextJson</code> columns from D1
            (everything captured at routine fire time), plus the universe entries from the active{" "}
            <code>operationalPlan</code>. Pre-deploy-of-this-feature routines render "Position
            context not captured" gracefully where the column is empty. See the new{" "}
            <span className="italic">"What's saved per routine"</span> section below for the row
            schema and full JSON shape.
          </>
        ),
      },
      {
        q: "What about orders I place directly (via Direct order, or in Alpaca itself)?",
        a: (
          <>
            <p className="mb-2">
              Anything in your Alpaca account is visible to Claude on the next routine — whether
              the AI placed it, you placed it via{" "}
              <span className="font-semibold">+ Direct order</span> on Pit Wall, or it came from
              Alpaca's own UI/API.
            </p>
            <ul className="mt-2 ml-4 space-y-1 list-disc text-zinc-300">
              <li>
                <span className="font-semibold">Open orders</span> — shown to Claude as "already
                submitted, do not duplicate". A duplicate-guard in the validator rejects a 2nd buy
                on the same symbol while one is still open.
              </li>
              <li>
                <span className="font-semibold">Filled positions</span> — Claude treats them as
                normal holdings; can hold or sell them.
              </li>
              <li>
                <span className="font-semibold">Recent fills (last 10)</span> — show in the
                account context regardless of source.
              </li>
            </ul>
            <p className="mt-3 text-zinc-300">Two gotchas worth knowing:</p>
            <ol className="mt-1 ml-4 space-y-1 list-decimal text-zinc-300">
              <li>
                <span className="font-semibold">Out-of-universe positions</span>: if you bought
                XYZ directly and XYZ isn't in your plan's universe, Claude can't sell it via a
                normal decision (universe check fails). Three escape hatches: sell directly via{" "}
                "+ Direct order" or "Close position", submit a player intent ("sell my XYZ
                position" — intents bypass the universe check), or add XYZ to the universe via a
                playbook revision.
              </li>
              <li>
                <span className="font-semibold">P&amp;L attribution</span>: every trade is tagged{" "}
                <code>source = "ai"</code> or <code>"direct"</code>. Pit Wall splits realized
                P&amp;L between AI strategy and Discretionary so you can see how each is doing
                separately.
              </li>
            </ol>
          </>
        ),
      },
      {
        q: "Can I edit my playbook mid-race?",
        a: (
          <>
            Yes. Open Strategy and revise. Claude re-translates your playbook into a new plan; you
            approve it; subsequent routines use the new plan. Prior versions are archived (private
            to you).
          </>
        ),
      },
      {
        q: "I want to tell Claude something. What are my options?",
        a: (
          <>
            There are three ways to act, ranging from "long-term strategy change" to "trade right
            now without Claude":
            <div className="mt-3 space-y-3">
              <div className="rounded border border-zinc-800 bg-black/30 p-3">
                <div className="text-xs font-semibold text-zinc-100 uppercase tracking-wider">
                  1. Update your playbook
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Slowest. Rewrites your whole strategy. Claude re-translates into a new plan; you
                  approve; every future routine uses it. Use for big changes.
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">Where: Strategy tab</div>
              </div>
              <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
                <div className="text-xs font-semibold text-blue-200 uppercase tracking-wider">
                  2. Player intent — three flavors
                </div>
                <div className="mt-1 text-xs text-zinc-300">
                  Tell Claude something without rewriting the playbook. Bypasses your universe
                  restriction; risk caps still apply.
                </div>
                <ul className="mt-2 space-y-2 text-xs text-zinc-400">
                  <li>
                    <span className="font-semibold text-blue-100">Standing</span> · multi-hour
                    conditional. "Scale into AAPL on weakness over the next 24h." Lasts up to 72h.
                    Claude checks every slot and acts when conditions match. Stays pending until
                    honored, rejected, or expired.
                  </li>
                  <li>
                    <span className="font-semibold text-blue-100">Binding</span> · must be
                    addressed at the very next routine slot (max ~3h wait). "Buy 5 NVDA at
                    market." Claude has to honor it or explicitly reject it with a reason.
                  </li>
                  <li>
                    <span className="font-semibold text-blue-100">Fire immediately</span> · same
                    as binding, but also kicks off a routine{" "}
                    <span className="italic">right now</span> instead of waiting for the next
                    slot. Tick the "Fire immediately" checkbox in the composer. Rate-limited
                    (5/hour, 15/day) so you can't burn the whole budget on one panicked moment.
                    Use when news drops between slots.
                  </li>
                </ul>
                <div className="mt-2 text-[11px] text-zinc-500">
                  Where: Pit Wall → "+ I want…"
                </div>
              </div>
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="text-xs font-semibold text-amber-200 uppercase tracking-wider">
                  3. Direct order
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Fastest. Skips Claude entirely. You place the paper order directly through
                  Alpaca. Only buying-power and tradability checks apply — no plan/universe
                  validation. Pit Wall splits realized P&amp;L between AI strategy and
                  Discretionary so you can see how each is doing.
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Where: Pit Wall → "+ Direct order"
                </div>
              </div>
            </div>
          </>
        ),
      },
      {
        q: "When should I use which option?",
        a: (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left py-2 pr-3 font-semibold">If you want…</th>
                    <th className="text-left py-2 font-semibold">Use this</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3">Long-term strategy change</td>
                    <td className="py-2 font-medium">Update playbook</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3">Multi-hour conditional ("scale in on weakness")</td>
                    <td className="py-2 font-medium">Standing intent</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3">One-off trade, can wait up to ~3h</td>
                    <td className="py-2 font-medium">Binding intent</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3">Claude to act on something right now</td>
                    <td className="py-2 font-medium">Fire immediately</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-3">Place a specific trade right now, no AI</td>
                    <td className="py-2 font-medium">Direct order</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-3">React to news between slots, but think it through</td>
                    <td className="py-2 font-medium">Fire immediately or binding intent</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ),
      },
      {
        q: "Is this real money?",
        a: (
          <>
            <span className="font-semibold text-zinc-100">No.</span> Every account is an Alpaca
            paper-trading account — fake $100K to start, no real cash, no real positions, nothing
            connects to a real broker. You cannot lose actual money.
          </>
        ),
      },
      {
        q: "What stops Claude from doing something reckless?",
        a: (
          <>
            A validation layer between Claude and Alpaca enforces hard caps: dollar size per
            order, position-size cap, max 5 orders per routine, limit price within 10% of the last
            quote, only buy/sell (no shorts), only stocks in your plan's universe (unless you've
            submitted an intent that overrides it). Anything that fails validation never reaches
            Alpaca.
          </>
        ),
        technical: (
          <>
            <code>apps/worker/src/trading/validate.ts</code>: universe + tradable + sizing +
            buying-power + position cap + sell-qty + limit-10% + 5-order cap + market-closed
            downgrade + open-order dup guard.
          </>
        ),
      },
      {
        q: "What's an ADR?",
        a: (
          <>
            American Depositary Receipt — a foreign company's stock packaged so it trades on US
            exchanges. That's why TSM (Taiwan Semi) or ASML (Netherlands) can show up alongside
            US-listed names.
          </>
        ),
      },
    ],
  },
  {
    id: "privacy",
    pillLabel: "Privacy",
    title: "Privacy",
    blurb: "What other players see, what stays hidden, and for how long.",
    items: [
      {
        q: "What can my friends see?",
        a: (
          <>
            Only your display name, team color, your <span className="font-semibold">% return
            since race start</span> (the headline number on the leaderboard), current paper equity,
            equity curve (24h / 7d / 30d), and your rank. That's it.
          </>
        ),
        technical: (
          <>
            Public projection in <code>getPublicLeaderboardRow</code> physically selects only those
            fields and computes <code>returnPct</code> from a per-user race-start baseline.
            Holdings, playbook, plan, reasoning, and trades are never selected by the public
            endpoint — never just masked.
          </>
        ),
      },
      {
        q: "What stays hidden — and for how long?",
        a: (
          <>
            Your holdings, playbook text, operational plan, every routine's reasoning, every
            individual trade, and every player intent.{" "}
            <span className="font-semibold text-zinc-100">Forever.</span> These never become
            visible to other players, not even after the race ends.
          </>
        ),
      },
      {
        q: "Why so much hiding, even after the race?",
        a: (
          <>
            Two reasons. <span className="font-semibold">During the race</span>: so nobody copies a
            winning playbook mid-race — that would drag everyone toward the same trades and
            collapse the whole point of four different strategies fighting it out.{" "}
            <span className="font-semibold">Forever after</span>: your playbook reflects your
            personal trading philosophy. It's yours. Nobody else's business.
          </>
        ),
      },
      {
        q: "What gets revealed at the chequered flag?",
        a: (
          <>
            The winner — based on final % return — and final standings for everyone. That's it.{" "}
            <span className="font-semibold">No playbooks, plans, holdings, or trades are revealed
            to other players.</span>{" "}
            Privacy is permanent.
          </>
        ),
      },
      {
        q: "Does the admin see my data?",
        a: (
          <>
            No. Privacy applies to admin too. Admin can manage race dates, the player roster, and
            start/extend the race, but cannot read anyone's playbook, plan, holdings, or trades.
          </>
        ),
        technical: (
          <>
            Every <code>/api/me/*</code>, <code>/api/playbook/*</code>,{" "}
            <code>/api/alpaca/*</code>, and <code>/api/coach/*</code> route scopes by{" "}
            <code>c.get("user").id</code>. Spoofing <code>X-User-Id</code> is ignored.
          </>
        ),
      },
      {
        q: "What about the Paddock view — what does admin see there?",
        a: (
          <>
            The Paddock (admin's home tab) shows a cross-user routines list — but only the{" "}
            <span className="font-semibold">status</span> of each routine (succeeded / partial /
            error / running). No reasoning, no decisions, no orders, no symbols. Admin can also
            kill a stuck routine from there. The rich routine detail with reasoning + decisions +
            market context lives only on <span className="font-semibold">your</span> Pit Wall,
            scoped to your user id.
          </>
        ),
        technical: (
          <>
            <code>/api/admin/routines</code> projects only{" "}
            <code>{`{ id, userId, displayName, kind, scheduledSlot, status, startedAt, completedAt }`}</code>
            . The detailed <code>/api/me/routine-runs/:id</code> enforces{" "}
            <code>eq(routineRuns.userId, sessionUserId)</code> — spoofing a different user id in
            the URL returns 404.
          </>
        ),
      },
    ],
  },
  {
    id: "tech",
    pillLabel: "Tech",
    title: "Tech under the hood",
    blurb: "For the curious. Skip if you're here to race.",
    items: [
      {
        q: "What's the stack?",
        a: (
          <>
            A single Cloudflare Worker handles auth, AI calls, and trading. A React app on
            Cloudflare Pages is the UI. Data lives in Cloudflare D1 (SQL) and KV (cache). Cron
            Triggers fire the routine dispatcher.
          </>
        ),
        technical: (
          <>
            Worker = Hono + TypeScript. DB = D1 + Drizzle ORM. Cache = Workers KV (60s minimum
            TTL). UI = React + Vite + Tailwind v4 + shadcn/ui + framer-motion + uPlot. SDK ={" "}
            <code>@anthropic-ai/sdk</code> ≥ 0.90 invoked directly from the Worker.
          </>
        ),
      },
      {
        q: "Why three Claude models?",
        a: (
          <>
            Each model is used where its trade-off between speed, cost, and reasoning fits best:
            <ul className="mt-2 ml-4 space-y-1.5 list-disc text-zinc-300">
              <li>
                <span className="font-semibold">Opus 4.7</span> — smart and slow. Plan translation
                (your playbook → structured operational plan, runs once per playbook revision)
                plus the two highest-leverage routines: premarket and close.
              </li>
              <li>
                <span className="font-semibold">Sonnet 4.6</span> — balanced. The three intraday
                routines (open, mid-morning, afternoon), plus the conversational coach that helps
                you revise your playbook before you commit a draft.
              </li>
              <li>
                <span className="font-semibold">Haiku 4.5</span> — fast and cheap. Per-headline
                sentiment classification during the warm cron (each headline gets a label +
                directional score; KV-cached, only new headlines hit the API).
              </li>
            </ul>
          </>
        ),
        technical: (
          <>
            Opus 4.7: adaptive thinking + <code>effort: high</code> for plan translation;{" "}
            <code>tool_choice: auto</code> because Opus 4.7 rejects forced tool use combined with
            adaptive thinking. Sonnet 4.6 coach uses adaptive thinking + <code>commit_draft</code>{" "}
            tool. Haiku 4.5 sentiment scorer uses <code>tool_choice: tool</code> with{" "}
            <code>score_headline</code>. Routine model selection lives in{" "}
            <code>modelForSlot()</code> in <code>apps/worker/src/claude/routine-llm.ts</code>.
          </>
        ),
      },
      {
        q: "What's prompt caching and why does it matter?",
        a: (
          <>
            Claude can re-use parts of a prompt it has already processed. Each trading routine
            caches three layers — the system prompt, your operational plan, and your account
            state — and reads a fresh market-snapshot layer on top. Repeat routines hit the cache
            on call 2+ and are dramatically cheaper and faster than re-reading everything from
            scratch.
          </>
        ),
        technical: (
          <>
            Three <code>cache_control: ephemeral</code> breakpoints, ordered by stability
            (system → plan → account). The market-snapshot layer is always fresh; user-intents
            block (when present) is also fresh. Stable cache breakpoints across the day mean Opus
            premarket and close routines reuse the same plan + account caches as the intraday
            Sonnet runs.
          </>
        ),
      },
      {
        q: "What's the factor pipeline?",
        a: (
          <>
            Thirty minutes before the premarket routine fires, a "warm" cron pre-fetches news,
            earnings calendars, technicals, and macro factors for every stock in every approved
            universe. By the time routines run, the data is already in cache and Claude doesn't
            wait on it.
          </>
        ),
        technical: (
          <>
            Union universe across all approved plans, refreshed by the warm cron at 08:45 ET{" "}
            <span className="font-semibold">every day</span> (including weekends — keeps Monday
            warm). Per-symbol blob cached in KV: Alpaca news + bars, Finnhub
            profile/metrics/earnings, FMP earnings revenue merged into the Finnhub earnings
            record, computed technicals (SMA 20/50/200, RSI 14, ATR, 52w hi/lo, rel vol),
            Haiku-classified per-headline sentiment with score + label + rationale. Plus a single
            macro regime blob (FRED VIX/curve/DXY + sector momentum). If the warm fails, the
            premarket slot detects the missing successful run and triggers an inline fallback
            refresh.
          </>
        ),
      },
    ],
  },
  {
    id: "schema",
    pillLabel: "Schema",
    title: "What's saved per routine",
    blurb:
      "Every routine writes one row to the routine_runs table. Here's what's in it and how to read it.",
    items: [
      {
        q: "What columns are on a routine_runs row?",
        a: (
          <>
            <p className="mb-2">
              Every Claude run that fires — scheduled or fire-immediately — produces one row. The
              row holds everything needed to reconstruct what Claude was looking at, what it
              decided, and what happened. Plain English first, schema below.
            </p>
            <ul className="mt-2 ml-4 space-y-1 list-disc text-zinc-300">
              <li>
                <span className="font-semibold">Identity & context</span> — <code>id</code> (the
                run's ULID), <code>userId</code>, <code>operationalPlanId</code> (the plan version
                that was active), <code>kind</code> (scheduled / on_demand),{" "}
                <code>scheduledSlot</code> (premarket/open/midmorning/afternoon/close/warm),{" "}
                <code>oneShotInstruction</code> (intent text, when fire-immediate)
              </li>
              <li>
                <span className="font-semibold">What Claude saw</span> —{" "}
                <code>marketSnapshotJson</code> (full market context: quotes, bars, news with
                per-headline sentiment, earnings, technicals, macro regime),{" "}
                <code>accountContextJson</code> (equity, cash, buying power, positions, open
                orders, recent fills at decision time)
              </li>
              <li>
                <span className="font-semibold">What Claude did</span> — <code>claudeModel</code>,{" "}
                <code>claudeReasoning</code> (the prose paragraph), <code>decisionsJson</code>{" "}
                (decisions + validation failures + placed orders), token counts (
                <code>inputTokens</code>, <code>outputTokens</code>, <code>cacheReadTokens</code>,{" "}
                <code>cacheWriteTokens</code>)
              </li>
              <li>
                <span className="font-semibold">Outcome</span> — <code>status</code> (running /
                succeeded / partial / validation_failed / error / noop_market_closed /
                noop_race_not_active), <code>errorText</code>, <code>startedAt</code>,{" "}
                <code>completedAt</code>
              </li>
            </ul>
          </>
        ),
        technical: (
          <>
            <p className="mb-2">
              Drizzle schema in <code>apps/worker/src/db/schema.ts</code>:
            </p>
            <Code>{`export const routineRuns = sqliteTable("routine_runs", {
  id: ulid(),
  userId: text("user_id").notNull(),
  operationalPlanId: text("operational_plan_id"),
  kind: text("kind").notNull(),                  // scheduled | on_demand | admin_test
  scheduledSlot: text("scheduled_slot"),         // premarket|open|midmorning|afternoon|close|warm
  oneShotInstruction: text("one_shot_instruction"),
  marketSnapshotJson: text("market_snapshot_json"),  // full snapshot at fire time
  accountContextJson: text("account_context_json"),  // equity/positions/orders at fire time
  claudeModel: text("claude_model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  claudeReasoning: text("claude_reasoning"),
  decisionsJson: text("decisions_json"),
  status: text("status").notNull(),
  errorText: text("error_text"),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
});`}</Code>
          </>
        ),
      },
      {
        q: "What's inside marketSnapshotJson?",
        a: (
          <>
            <p className="mb-2">
              Everything Claude saw about the market when the routine fired. Quotes, bars, news,
              sentiment, technicals, earnings, and the macro regime card — all in one JSON blob.
              The same blob the LLM was prompted with.
            </p>
            <p className="mb-2">
              Per-symbol slice (one entry per stock in your plan's universe): bid/ask quote, last
              5 daily OHLCV bars, last 5 news headlines (each with Claude-scored sentiment label,
              score, and one-line rationale), the next earnings date, computed technicals (SMAs,
              RSI, ATR, 52w hi/lo, relative volume), and the per-symbol sentiment summary.
            </p>
            <p>
              Plus a <span className="font-semibold">broader-market</span> slice (SPY, QQQ, VIXY)
              and a <span className="font-semibold">regime</span> card (VIX from FRED, 10y-2y
              yield spread, DXY, sector momentum from SPDR sleeve 20-day returns).
            </p>
          </>
        ),
        technical: (
          <>
            <p className="mb-2">
              Defined in <code>apps/worker/src/trading/snapshot.ts</code>:
            </p>
            <Code>{`interface MarketSnapshot {
  asOf: string;
  marketIsOpen: boolean;
  nextOpen: string;
  nextClose: string;
  symbols: {
    symbol: string;
    lastQuote: { bid; ask; mid } | null;
    dailyBars: { date; open; high; low; close; volume }[];
    news: {
      headline; source; createdAt;
      score?: number;            // -1..+1, Haiku-classified
      label?: "bullish" | "bearish" | "neutral" | "mixed";
      rationale?: string;        // Claude's one-line read
    }[];
    earnings: EarningsItem | null;             // EPS + revenue actual/estimate
    earningsHint: string | null;
    sentiment: SymbolSentimentSummary | null;  // mood + counts + top headlines
    technicals: TechnicalsCard | null;          // SMA, RSI, ATR, 52w, relVol
  }[];
  broaderMarket: { symbol; label; lastQuote; dailyBars }[];
  regime: AggregatedRegime | null;     // VIX, 10y-2y, DXY, sector momentum
  factorSource: "warm" | "cold";       // "cold" if KV agg blobs missed
}`}</Code>
          </>
        ),
      },
      {
        q: "What's inside accountContextJson?",
        a: (
          <>
            Your Alpaca account state at the exact moment the routine fired. So when you're
            looking at a decision a week later, you can see "I had $18K cash and was already 14%
            in AAPL when Claude decided to add 5 more shares" — not whatever your account looks
            like now. Snapshot includes equity, cash, buying power, long market value, every open
            position (qty, avg entry, current, unrealized P&L), every working order, and the last
            10 fills.
          </>
        ),
        technical: (
          <>
            <p className="mb-2">
              Defined in <code>apps/worker/src/trading/snapshot.ts</code>:
            </p>
            <Code>{`interface AccountContext {
  accountId: string;
  equity: number;
  cash: number;
  buyingPower: number;
  longMarketValue: number;
  dayUnrealizedPl: number;
  positions: {
    symbol; qty; avgEntry; current; unrealizedPl; unrealizedPlPct;
  }[];
  openOrders: {
    id; symbol; side; qty; type; limitPrice; timeInForce; status; submittedAtIso;
  }[];
  recentFills: (OpenOrderSummary & {
    filledQty; filledAvgPrice; filledAtIso;
  })[];
}`}</Code>
          </>
        ),
      },
    ],
  },
  {
    id: "data",
    pillLabel: "Data",
    title: "Where the data comes from",
    blurb:
      "Every routine is a function of two things: the playbook you wrote, and the market data Claude reads when it fires. Here's where each piece comes from.",
    items: [
      {
        q: "Alpaca paper API — broker + market data",
        a: (
          <>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">What we get:</span> account (equity,
              cash, buying power, day P&L), positions (qty, avg entry, current, unrealized P&L),
              open orders + last 10 fills, market clock, latest quotes (bid/ask) per plan symbol,
              daily bars (last 5 for snapshots, 220 for technicals), 48h news per symbol,
              tradability, and order placement.
            </p>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">How Claude uses it:</span> account +
              positions + open orders are the cached <span className="italic">Account</span>{" "}
              prompt layer. Quotes + bars + news live in the fresh{" "}
              <span className="italic">Market snapshot</span> layer. The validator uses
              tradability to reject decisions on unsupported symbols before they reach Alpaca.
            </p>
            <p className="text-zinc-400">
              <span className="font-semibold text-zinc-300">Why we picked it:</span> free paper
              trading, real intraday data, simple REST API, doubles as broker so we don't glue two
              providers together.
            </p>
          </>
        ),
      },
      {
        q: "Finnhub — earnings calendar + fundamentals",
        a: (
          <>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">What we get:</span> next earnings
              (date, hour, EPS estimate, EPS actual when reported), company profile (sector,
              industry, market cap), key metrics (P/E, P/S, ROE, dividend yield), 14-day economic
              calendar.
            </p>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">How Claude uses it:</span> earnings
              hint goes into the per-symbol market snapshot ("Q1 reports in 3 days, AMC, $2.11 EPS
              est"). Sector + market cap into the universe context the coach uses when revising
              playbooks.
            </p>
            <p className="text-zinc-400">
              <span className="font-semibold text-zinc-300">Constraint:</span> free tier — EPS
              only, no revenue. That's why FMP exists.
            </p>
          </>
        ),
      },
      {
        q: "FMP (Financial Modeling Prep) — revenue actuals",
        a: (
          <>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">What we get:</span>{" "}
              <code>revActual</code> / <code>revEstimate</code> for the most recently reported (or
              upcoming) quarter, plus EPS as a Finnhub fallback.
            </p>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">How Claude uses it:</span> the
              earnings card shows revenue surprise % alongside EPS surprise %. Lets Claude tell
              "EPS beat from genuine revenue acceleration" apart from "EPS beat that's just
              buyback math".
            </p>
            <p className="text-zinc-400">
              <span className="font-semibold text-zinc-300">Constraint:</span> free tier — 250
              req/day, max 5 results per call. Batched per warm-cron run, KV-cached by symbol.
            </p>
          </>
        ),
      },
      {
        q: "FRED (Federal Reserve Economic Data) — macro regime",
        a: (
          <>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">What we get:</span> three series —{" "}
              <span className="font-semibold">VIX</span> (<code>VIXCLS</code>) implied
              volatility / fear gauge; <span className="font-semibold">10y-2y yield spread</span>{" "}
              (<code>T10Y2Y</code>) recession indicator (negative = inverted curve);{" "}
              <span className="font-semibold">DXY</span> (<code>DTWEXBGS</code>) trade-weighted
              dollar strength index.
            </p>
            <p className="mb-2">
              <span className="font-semibold text-zinc-200">How Claude uses it:</span> feeds the
              macro regime card at the top of every routine. Sector momentum (top/bottom 3 SPDR
              sleeves by 20-day return) is computed from Alpaca bars, not FRED.
            </p>
            <p className="text-zinc-400">
              <span className="font-semibold text-zinc-300">Constraint:</span> free, no rate
              limits, but end-of-day data only — values lag 1 trading day.
            </p>
          </>
        ),
      },
      {
        q: "Anthropic API — Claude itself",
        a: (
          <>
            <ul className="mt-2 ml-4 space-y-1.5 list-disc text-zinc-300">
              <li>
                <span className="font-semibold">Opus 4.7</span> — plan translation (your
                playbook → operational plan), premarket and close routines.
              </li>
              <li>
                <span className="font-semibold">Sonnet 4.6</span> — open / mid-morning / afternoon
                routines + the conversational coach.
              </li>
              <li>
                <span className="font-semibold">Haiku 4.5</span> — per-headline sentiment
                classification (label + score + one-line rationale), runs during the warm cron
                and KV-cached so re-classification only hits the API for new headlines.
              </li>
            </ul>
            <p className="mt-3 text-zinc-400">
              Each trading routine has 3 prompt cache breakpoints (system → plan → account) with
              the market snapshot fresh on top. After the first routine of the day, every
              subsequent fire hits the cache for ~80% of input tokens.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "friction",
    pillLabel: "Friction",
    title: "FAQ — friction",
    blurb: "Things people actually run into.",
    items: [
      {
        q: "I forgot my password.",
        a: (
          <>
            Ping the admin (Lekhaj). There's no self-serve reset by design — only four people are
            in the room and password reset endpoints add attack surface for almost no benefit.
          </>
        ),
      },
      {
        q: "A routine didn't fire — what happened?",
        a: (
          <>
            Most likely the market was closed (weekend, US holiday, after-hours) or the race
            hasn't started / has ended. Routines fire only on US trading days, only during the
            race window. If it's a market hour and your slot is silent, ping admin.
          </>
        ),
      },
      {
        q: "Can I link a real Alpaca account?",
        a: <>No — paper accounts only. The app rejects keys that aren't paper-trading keys. This is a game.</>,
      },
      {
        q: "What if Alpaca is down during a routine?",
        a: <>The routine logs the error and skips. The next scheduled slot tries again. Nothing crashes the race.</>,
      },
      {
        q: "Who's the admin and what can they actually do?",
        a: (
          <>
            Lekhaj. Admin can set race start/end dates (must be exactly 30 days apart), lock the
            dates once everyone is onboarded, extend the end date, reset state pre-race, replay
            routines for testing, and manage the roster. Admin{" "}
            <span className="font-semibold">cannot</span> read anyone's playbook, plan, holdings,
            or trades.
          </>
        ),
      },
    ],
  },
];

export function InfoPage() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>(SECTIONS[0]!.id);
  const trimmed = query.trim().toLowerCase();
  const isSearching = trimmed.length > 0;

  // Track which section is closest to the top of the viewport so the matching
  // pill can be highlighted as the user scrolls. Disabled while searching
  // because the section list is replaced with results.
  useEffect(() => {
    if (isSearching) return;
    const els = SECTIONS
      .map((s) => document.getElementById(`section-${s.id}`))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
        );
        const id = topmost.target.id.replace(/^section-/, "");
        setActiveId(id);
      },
      // The negative top margin pushes the trigger line below the sticky nav
      // (~110px tall) so the pill flips when a section's heading actually
      // crosses below the bar. -50% bottom = trigger only while the section
      // is still in the upper half of the viewport.
      { rootMargin: "-110px 0px -50% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [isSearching]);

  const matches = useMemo(() => {
    if (!isSearching) return [] as { section: FaqSection; item: FaqItem }[];
    const out: { section: FaqSection; item: FaqItem }[] = [];
    for (const section of SECTIONS) {
      for (const item of section.items) {
        const hay = (
          item.q +
          " " +
          nodeToText(item.a) +
          " " +
          (item.technical ? nodeToText(item.technical) : "")
        ).toLowerCase();
        if (hay.includes(trimmed)) out.push({ section, item });
      }
    }
    return out;
  }, [trimmed, isSearching]);

  const handlePillClick = (id: string) => {
    // Clicking a pill while a search is active clears the search so the user
    // lands on the actual section content rather than a filtered subset.
    if (isSearching) setQuery("");
    requestAnimationFrame(() => {
      const el = document.getElementById(`section-${id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(id);
    });
  };

  return (
    <div className="max-w-3xl">
      <header className="space-y-2">
        <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Info</div>
        <h1 className="text-3xl font-black tracking-tight">How Trading Grand Prix works</h1>
        <p className="text-sm text-zinc-400">
          Plain-English answers, with a "show the technical bit" toggle on each one if you want to
          see what's actually happening underneath.
        </p>
      </header>

      <InfoNav
        query={query}
        onQueryChange={setQuery}
        activeId={isSearching ? null : activeId}
        onPillClick={handlePillClick}
      />

      {isSearching ? (
        <SearchResults
          matches={matches}
          query={query}
          onClear={() => setQuery("")}
        />
      ) : (
        <div className="space-y-10 mt-6">
          {SECTIONS.map((section) => (
            <SectionBlock key={section.id} section={section} />
          ))}
        </div>
      )}

      <footer className="border-t border-[var(--color-race-border)] pt-6 mt-10 text-xs text-zinc-500">
        Missing an answer? Tell Lekhaj — this page is meant to grow.
      </footer>
    </div>
  );
}

function InfoNav({
  query,
  onQueryChange,
  activeId,
  onPillClick,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  activeId: string | null;
  onPillClick: (id: string) => void;
}) {
  return (
    <div className="sticky top-0 z-20 -mx-4 sm:-mx-2 px-4 sm:px-2 py-2 mt-4 bg-[var(--color-race-bg,#0a0a0a)]/95 backdrop-blur border-b border-[var(--color-race-border)]">
      <div className="space-y-2">
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-zinc-500"
          >
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search the FAQ…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="w-full rounded border border-zinc-800 bg-black/40 pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-xs text-zinc-500 hover:text-zinc-200"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <nav
          aria-label="FAQ sections"
          className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0"
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => onPillClick(s.id)}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-[10px] uppercase tracking-wider whitespace-nowrap border transition",
                activeId === s.id
                  ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
                  : "border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700",
              )}
            >
              {s.pillLabel}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function SearchResults({
  matches,
  query,
  onClear,
}: {
  matches: { section: FaqSection; item: FaqItem }[];
  query: string;
  onClear: () => void;
}) {
  if (matches.length === 0) {
    return (
      <div className="mt-6 rounded border border-dashed border-zinc-800 bg-black/30 p-8 text-center text-sm text-zinc-500">
        No matches for "{query}".{" "}
        <button onClick={onClear} className="ml-1 text-zinc-300 underline hover:text-white">
          Clear
        </button>
      </div>
    );
  }
  return (
    <div className="mt-6 space-y-3">
      <div className="text-xs text-zinc-500">
        Showing {matches.length} match{matches.length === 1 ? "" : "es"} for "{query}"
        <button
          onClick={onClear}
          className="ml-2 text-zinc-300 hover:text-white hover:underline"
        >
          [Clear]
        </button>
      </div>
      {matches.map(({ section, item }, i) => (
        <div key={`${section.id}-${i}`}>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 font-mono">
            {section.pillLabel} ▸ {item.q}
          </div>
          <FaqEntry item={item} />
        </div>
      ))}
    </div>
  );
}

function SectionBlock({ section }: { section: FaqSection }) {
  return (
    <section
      id={`section-${section.id}`}
      // Sticky nav is ~110px tall; offset section anchors so the heading
      // doesn't end up underneath the bar after a pill click.
      className="space-y-3 scroll-mt-32"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-bold tracking-tight">{section.title}</h2>
        {section.blurb && <p className="text-xs text-zinc-500">{section.blurb}</p>}
      </div>
      <div className="space-y-2">
        {section.items.map((item, i) => (
          <FaqEntry key={i} item={item} />
        ))}
      </div>
    </section>
  );
}

/**
 * Walk a ReactNode tree and concatenate visible text. Used to build the
 * search index across answer + technical bodies (which are JSX, not strings).
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join(" ");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeToText(props?.children);
  }
  return "";
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="my-2 overflow-x-auto rounded border border-zinc-800 bg-black/60 p-3 text-[11px] leading-relaxed text-zinc-300">
      <code className="!bg-transparent !p-0 !text-[11px]">{children}</code>
    </pre>
  );
}

function FaqEntry({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-100">{item.q}</h3>
        {item.badge && (
          <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
            {item.badge}
          </span>
        )}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-zinc-300">{item.a}</div>
      {item.technical && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "mt-3 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] uppercase tracking-wider transition",
              open
                ? "border-zinc-700 text-zinc-300"
                : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
            )}
            aria-expanded={open}
          >
            <span className="font-mono">{open ? "−" : "+"}</span>
            {open ? "Hide technical" : "Show the technical bit"}
          </button>
          {open && (
            <div className="mt-2 rounded border border-dashed border-zinc-800 bg-black/30 p-3 text-xs leading-relaxed text-zinc-400 [&_code]:rounded [&_code]:bg-black/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_code]:text-zinc-300">
              {item.technical}
            </div>
          )}
        </>
      )}
    </div>
  );
}
