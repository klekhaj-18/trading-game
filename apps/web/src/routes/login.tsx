import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { TEAM_COLOR_META, TEAM_COLORS, type TeamColor } from "shared/auth";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/utils";

type Mode = "signup" | "login";

export function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: ["auth", "status"], queryFn: api.authStatus });

  const defaultMode: Mode = statusQ.data?.roomFull ? "login" : "signup";
  const [mode, setMode] = useState<Mode | null>(null);
  const activeMode: Mode = mode ?? defaultMode;

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [teamColor, setTeamColor] = useState<TeamColor>("ferrari");

  const signupM = useMutation({
    mutationFn: () => api.signup({ displayName, password, teamColor }),
    onSuccess: async ({ user }) => {
      qc.setQueryData(["me"], { user });
      await qc.invalidateQueries({ queryKey: ["auth", "status"] });
      navigate("/");
    },
  });
  const loginM = useMutation({
    mutationFn: () => api.login({ displayName, password }),
    onSuccess: async ({ user }) => {
      qc.setQueryData(["me"], { user });
      await qc.invalidateQueries({ queryKey: ["auth", "status"] });
      navigate("/");
    },
  });

  const busy = signupM.isPending || loginM.isPending;
  const err = (signupM.error ?? loginM.error) as ApiError | null;

  const slotsOpen = useMemo(() => {
    if (!statusQ.data) return null;
    return statusQ.data.maxPlayers - statusQ.data.usersCount;
  }, [statusQ.data]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (activeMode === "signup") signupM.mutate();
    else loginM.mutate();
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Trading</div>
          <div className="text-4xl font-black tracking-tight text-zinc-50">GRAND PRIX</div>
          <div className="mt-3 text-xs tabular-digits text-zinc-500">
            {statusQ.isLoading
              ? "· · ·"
              : statusQ.data?.roomFull
                ? "PADDOCK FULL"
                : `${slotsOpen} of ${statusQ.data?.maxPlayers} slots open`}
          </div>
        </div>

        <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-6 shadow-2xl">
          <div className="mb-5 flex rounded-md bg-black/40 p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode("signup")}
              disabled={statusQ.data?.roomFull}
              className={cn(
                "flex-1 rounded py-2 font-medium transition",
                activeMode === "signup"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-200",
                statusQ.data?.roomFull && "opacity-40 cursor-not-allowed",
              )}
            >
              Claim a slot
            </button>
            <button
              type="button"
              onClick={() => setMode("login")}
              className={cn(
                "flex-1 rounded py-2 font-medium transition",
                activeMode === "login"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              Log in
            </button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <Field label="Display name">
              <input
                className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="your name"
                autoComplete="username"
                autoFocus
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="min 8 characters"
                autoComplete={activeMode === "signup" ? "new-password" : "current-password"}
              />
            </Field>

            {activeMode === "signup" && (
              <Field label="Team">
                <div className="grid grid-cols-4 gap-2">
                  {TEAM_COLORS.map((c) => {
                    const meta = TEAM_COLOR_META[c];
                    const selected = c === teamColor;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setTeamColor(c)}
                        className={cn(
                          "rounded border px-2 py-3 text-xs font-semibold transition",
                          selected
                            ? "border-zinc-100 text-zinc-50"
                            : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                        )}
                        style={
                          selected
                            ? { borderColor: meta.hex, boxShadow: `0 0 0 1px ${meta.hex}` }
                            : undefined
                        }
                      >
                        <div
                          className="mx-auto mb-1 h-2 w-full rounded"
                          style={{ background: meta.hex }}
                        />
                        {meta.label.split(" ")[0]}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            {err && (
              <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {err.message}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || (activeMode === "signup" && statusQ.data?.roomFull)}
              className="w-full rounded bg-zinc-100 py-2.5 font-semibold text-zinc-900 disabled:opacity-40 hover:bg-white transition"
            >
              {busy
                ? "· · ·"
                : activeMode === "signup"
                  ? "Claim my slot"
                  : "Log in"}
            </button>
          </form>
        </div>

        <div className="mt-6 text-center text-[11px] tracking-wider text-zinc-600 uppercase">
          Lap 0 / 30 · Pre-race
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs tracking-wider text-zinc-500 uppercase">{label}</div>
      {children}
    </label>
  );
}
