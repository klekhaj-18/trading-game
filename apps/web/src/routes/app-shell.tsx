import { Outlet, Link, Navigate, useLocation, NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { TEAM_COLOR_META } from "shared/auth";
import { cn } from "../lib/utils";

export function AppShell() {
  const location = useLocation();
  const qc = useQueryClient();

  const meQ = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const pbQ = useQuery({
    queryKey: ["playbook"],
    queryFn: api.playbookCurrent,
    retry: false,
    enabled: !!meQ.data?.user,
  });

  const logoutM = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      qc.removeQueries({ queryKey: ["me"] });
      qc.removeQueries({ queryKey: ["playbook"] });
      await qc.invalidateQueries({ queryKey: ["auth", "status"] });
    },
  });

  if (meQ.isLoading) {
    return <div className="min-h-screen grid place-items-center text-zinc-600">· · ·</div>;
  }

  if (meQ.error instanceof ApiError && meQ.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const user = meQ.data?.user;
  if (!user) return <Navigate to="/login" replace />;

  if (!pbQ.isFetched) {
    return <div className="min-h-screen grid place-items-center text-zinc-600">· · ·</div>;
  }

  const fullyOnboarded =
    !!pbQ.data && pbQ.data.alpacaLinked && pbQ.data.plan?.approvalState === "approved";

  if (!fullyOnboarded && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  const teamHex = TEAM_COLOR_META[user.teamColor]?.hex ?? "#888";

  const userChipDesktop = (
    <div className="flex items-center gap-2 rounded border border-zinc-800 bg-black/40 px-2.5 py-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: teamHex }} />
      <span className="text-sm font-semibold">{user.displayName}</span>
      {user.isAdmin && (
        <span className="rounded bg-[var(--color-flag-gold)]/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-flag-gold)]">
          Paddock
        </span>
      )}
    </div>
  );

  const userChipMobile = (
    <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-black/40 px-2 py-1">
      <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: teamHex }} />
      <span className="text-xs font-semibold truncate max-w-[90px]">{user.displayName}</span>
    </div>
  );

  const signoutDesktop = (
    <button
      onClick={() => logoutM.mutate()}
      className="text-xs text-zinc-500 hover:text-zinc-300 uppercase tracking-wider"
    >
      Sign out
    </button>
  );

  const signoutMobile = (
    <button
      onClick={() => logoutM.mutate()}
      aria-label="Sign out"
      className="text-[10px] text-zinc-400 uppercase tracking-wider rounded border border-zinc-800 px-2 py-1"
    >
      Exit
    </button>
  );

  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="border-b border-[var(--color-race-border)] bg-black/40 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          {/* Row 1 on mobile: logo + chip + exit. On desktop: just the logo. */}
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <Link to="/" className="flex items-baseline gap-2 min-w-0">
              <div className="hidden sm:block text-[10px] tracking-[0.3em] text-zinc-500 uppercase leading-none whitespace-nowrap">
                Trading
              </div>
              <div className="text-base sm:text-lg font-black tracking-tight whitespace-nowrap">
                GRAND PRIX
              </div>
            </Link>
            <div className="flex items-center gap-2 sm:hidden">
              {userChipMobile}
              {signoutMobile}
            </div>
          </div>

          {/* Row 2 on mobile: nav only, horizontally scrollable. */}
          <nav className="flex items-center gap-1 text-xs overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:overflow-visible">
            <ShellLink to="/">Leaderboard</ShellLink>
            <ShellLink
              to="/pit-wall"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["me"] });
              }}
            >
              Pit wall
            </ShellLink>
            <ShellLink to="/playbook">Strategy</ShellLink>
            <ShellLink to="/info">Info</ShellLink>
            {user.isAdmin && <ShellLink to="/paddock">Paddock</ShellLink>}
          </nav>

          {/* Row 3 on mobile: race banner on its own line, full-width but single-line. On desktop: inline. */}
          <div className="flex items-center gap-4 sm:justify-end sm:flex-1 sm:gap-4">
            <RaceBanner />
            <div className="hidden sm:flex items-center gap-4">
              {userChipDesktop}
              {signoutDesktop}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

function RaceBanner() {
  const raceQ = useQuery({
    queryKey: ["race"],
    queryFn: api.raceState,
    refetchInterval: 30_000,
  });
  const r = raceQ.data;
  if (!r) return <div className="text-xs text-zinc-600 uppercase tracking-wider">· · ·</div>;
  const label =
    r.state === "pre_race"
      ? r.competitionStartAt
        ? `Pre-race · Starts ${new Date(r.competitionStartAt * 1000).toLocaleString()}`
        : "Pre-race · Dates not set"
      : r.state === "in_race"
        ? `Lap ${r.lap ?? 0} / 30`
        : "Race finished · Chequered flag";
  return (
    <div
      className={cn(
        "text-[10px] sm:text-xs tabular-digits uppercase tracking-wider px-2 py-1 rounded border whitespace-nowrap overflow-hidden text-ellipsis",
        r.state === "in_race"
          ? "text-emerald-300 border-emerald-900/60 bg-emerald-950/30"
          : r.state === "post_race"
            ? "text-[var(--color-flag-gold)] border-yellow-900/60 bg-yellow-950/30"
            : "text-zinc-500 border-zinc-800 bg-black/30",
      )}
    >
      {label}
    </div>
  );
}

function ShellLink({
  to,
  children,
  onClick,
}: {
  to: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "rounded px-3 py-1.5 uppercase tracking-wider transition whitespace-nowrap flex-shrink-0",
          isActive ? "bg-zinc-100 text-zinc-900 font-semibold" : "text-zinc-400 hover:text-zinc-200",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function PlaceholderHome() {
  const { data } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const user = data?.user;
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-6">
        <div className="text-xs tracking-wider text-zinc-500 uppercase mb-2">Pit wall</div>
        <h1 className="text-2xl font-bold">
          On the grid,{" "}
          <span style={{ color: user ? TEAM_COLOR_META[user.teamColor].hex : undefined }}>
            {user?.displayName}
          </span>
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Alpaca account linked, playbook approved. Scheduled routines and live positions land in Phase 3.
        </p>
      </div>
      <PhaseGrid />
    </div>
  );
}

function PhaseGrid() {
  const phases = [
    { n: 1, label: "Skeleton + auth", done: true },
    { n: 2, label: "Onboarding + playbook + Opus", done: true },
    { n: 3, label: "Cron routines + Haiku + Alpaca", done: false },
    { n: 4, label: "Leaderboard + privacy", done: false },
    { n: 5, label: "On-demand fire + polish", done: false },
    { n: 6, label: "Paddock + chequered flag", done: false },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {phases.map((p) => (
        <div
          key={p.n}
          className={cn(
            "rounded border p-4",
            p.done ? "border-emerald-900/60 bg-emerald-950/20" : "border-zinc-800 bg-black/30",
          )}
        >
          <div className="flex items-baseline justify-between">
            <div className="text-xs tracking-wider text-zinc-500 uppercase">Phase {p.n}</div>
            {p.done && (
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                ✓ Green flag
              </span>
            )}
          </div>
          <div className="mt-1 text-sm">{p.label}</div>
        </div>
      ))}
    </div>
  );
}
