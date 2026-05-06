import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface FaqItem {
  q: string;
  a: ReactNode;
  technical?: ReactNode;
  badge?: "Coming soon";
}

interface FaqSection {
  title: string;
  blurb?: string;
  items: FaqItem[];
}

const SECTIONS: FaqSection[] = [
  {
    title: "The race & how Claude trades",
    blurb: "What you're actually playing, and what Claude does on your behalf.",
    items: [
      {
        q: "What is Trading Grand Prix?",
        a: (
          <>
            A 30-day paper-trading competition for four friends. Each player writes a strategy in
            plain English. Claude reads it before each routine, decides what to buy or sell, and
            places paper orders through Alpaca. Highest equity on Lap 30 wins. F1 themed because we
            wanted it to feel like a season, not a slog.
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
            Whoever's Alpaca paper equity is highest on Lap 30. No bonuses, no penalties, no
            weighting. Final equity, full stop.
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
            Haiku 4.5 with 4-layer prompt caching — system / plan / account context / market
            snapshot. Cache breakpoints are stable across the day so repeat runs read mostly from
            cache.
          </>
        ),
      },
      {
        q: "When do routines fire?",
        a: (
          <>
            Five times per US trading day — premarket, market open, mid-morning, afternoon, and
            pre-close. The next fire-time shows on the Leaderboard. Plus a sixth "warm" slot 30
            minutes before premarket that pre-fetches market data so the trading routines don't
            wait.
          </>
        ),
        technical: (
          <>
            Six Cloudflare Cron Triggers. Race-gated (no fires pre-race / post-race), weekday-gated
            to US trading days. Holidays are absorbed by Alpaca's market-closed signal — routines
            run, but validators downgrade or skip orders.
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
    title: "Privacy",
    blurb: "What other players see, what stays hidden, and for how long.",
    items: [
      {
        q: "What can my friends see?",
        a: (
          <>
            Only your display name, team color, current paper equity, equity curve (24h / 7d /
            30d), and your rank. That's it.
          </>
        ),
        technical: (
          <>
            Public projection in <code>getPublicLeaderboardRow</code> physically selects only those
            fields. Holdings, playbook, plan, reasoning, and trades are never selected by the
            public endpoint — never just masked.
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
            The winner — based on final equity — and final standings for everyone. That's it.{" "}
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
    ],
  },
  {
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
        q: "Why two Claude models?",
        a: (
          <>
            Opus 4.7 is smart and slow — perfect for translating your playbook into a structured
            plan once. Haiku 4.5 is fast and cheap — perfect for the 30+ routines per week per
            player. Each model is used where it fits.
          </>
        ),
        technical: (
          <>
            Opus 4.7 with adaptive thinking + <code>effort: high</code> for plan translation. Haiku
            4.5 with 4-layer prompt caching for routines. A separate Sonnet 4.6 coach handles
            back-and-forth playbook revision before you commit a draft.
          </>
        ),
      },
      {
        q: "What's prompt caching and why does it matter?",
        a: (
          <>
            Claude can re-use parts of a prompt it has already processed. We cache four layers —
            system instructions, your plan, your account context, the fresh market snapshot.
            Repeat routines are dramatically cheaper and faster than reading everything from
            scratch.
          </>
        ),
        technical: (
          <>
            Four <code>cache_control: ephemeral</code> breakpoints on Haiku, ordered by stability
            (most stable outermost). Cache hit verified on call 2+.
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
            Union universe across all approved plans, scored once per warm and refreshed during
            the day. If the warm fails, the premarket slot detects the missing successful run and
            triggers an inline fallback refresh before routines fire.
          </>
        ),
      },
    ],
  },
  {
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
  return (
    <div className="space-y-10 max-w-3xl">
      <header className="space-y-2">
        <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Info</div>
        <h1 className="text-3xl font-black tracking-tight">How Trading Grand Prix works</h1>
        <p className="text-sm text-zinc-400">
          Plain-English answers, with a "show the technical bit" toggle on each one if you want to
          see what's actually happening underneath.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <SectionBlock key={section.title} section={section} />
      ))}

      <footer className="border-t border-[var(--color-race-border)] pt-6 text-xs text-zinc-500">
        Missing an answer? Tell Lekhaj — this page is meant to grow.
      </footer>
    </div>
  );
}

function SectionBlock({ section }: { section: FaqSection }) {
  return (
    <section className="space-y-3">
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
