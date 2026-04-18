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

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-race-border)] bg-black/40 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-3">
            <div className="text-[10px] tracking-[0.3em] text-zinc-500 uppercase leading-none">
              Trading
            </div>
            <div className="text-lg font-black tracking-tight">GRAND PRIX</div>
          </Link>

          <nav className="flex items-center gap-1 text-xs">
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
            {user.isAdmin && <ShellLink to="/paddock">Paddock</ShellLink>}
          </nav>

          <div className="flex items-center gap-4">
            <RaceBanner />
            <div className="flex items-center gap-2 rounded border border-zinc-800 bg-black/40 px-2.5 py-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: teamHex }} />
              <span className="text-sm font-semibold">{user.displayName}</span>
              {user.isAdmin && (
                <span className="rounded bg-[var(--color-flag-gold)]/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-flag-gold)]">
                  Paddock
                </span>
              )}
            </div>
            <button
              onClick={() => logoutM.mutate()}
              className="text-xs text-zinc-500 hover:text-zinc-300 uppercase tracking-wider"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
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
        "text-xs tabular-digits uppercase tracking-wider px-2 py-1 rounded border",
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
          "rounded px-3 py-1.5 uppercase tracking-wider transition",
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
