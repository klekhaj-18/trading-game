import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { PlanView } from "../components/plan-view";
import { CoachChat } from "../components/coach-chat";
import { cn } from "../lib/utils";

type Step = "alpaca" | "playbook" | "review";

export function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pbQ = useQuery({ queryKey: ["playbook"], queryFn: api.playbookCurrent });
  const [step, setStep] = useState<Step | null>(null);

  const fullyOnboarded =
    !!pbQ.data && pbQ.data.alpacaLinked && pbQ.data.plan?.approvalState === "approved";
  if (fullyOnboarded) return <Navigate to="/" replace />;

  const initialStep: Step = pbQ.data?.plan
    ? "review"
    : pbQ.data?.alpacaLinked
      ? "playbook"
      : "alpaca";
  const active: Step = step ?? initialStep;

  return (
    <div className="min-h-screen bg-[var(--color-race-bg)]">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="mb-10 text-center">
          <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Pre-race setup</div>
          <div className="text-3xl font-black tracking-tight mt-2">Fuel the car</div>
          <div className="mt-2 text-sm text-zinc-500">
            Three steps: link Alpaca · write your playbook · approve Claude's plan.
          </div>
        </div>

        <div className="mb-8 flex gap-2">
          <Pip n={1} label="Alpaca" state={stateFor(active, "alpaca", pbQ.data)} />
          <Pip n={2} label="Playbook" state={stateFor(active, "playbook", pbQ.data)} />
          <Pip n={3} label="Plan" state={stateFor(active, "review", pbQ.data)} />
        </div>

        {active === "alpaca" && (
          <AlpacaStep
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["playbook"] });
              setStep("playbook");
            }}
          />
        )}
        {active === "playbook" && (
          <PlaybookStep
            draft={pbQ.data?.playbook}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["playbook"] });
              setStep("review");
            }}
          />
        )}
        {active === "review" && pbQ.data?.plan && (
          <ReviewStep
            onBack={() => setStep("playbook")}
            onApproved={() => {
              qc.invalidateQueries({ queryKey: ["me"] });
              qc.invalidateQueries({ queryKey: ["playbook"] });
              navigate("/");
            }}
          />
        )}
      </div>
    </div>
  );
}

function stateFor(
  active: Step,
  target: Step,
  data: { alpacaLinked: boolean; playbook: unknown; plan: { approvalState: string } | null } | undefined,
): "done" | "active" | "pending" {
  if (active === target) return "active";
  const done: Record<Step, boolean> = {
    alpaca: !!data?.alpacaLinked,
    playbook: !!data?.playbook,
    review: data?.plan?.approvalState === "approved",
  };
  return done[target] ? "done" : "pending";
}

function Pip({
  n,
  label,
  state,
}: {
  n: number;
  label: string;
  state: "done" | "active" | "pending";
}) {
  return (
    <div
      className={cn(
        "flex-1 rounded border px-3 py-2 text-xs tracking-wider uppercase",
        state === "done" && "border-emerald-700/60 bg-emerald-950/30 text-emerald-300",
        state === "active" && "border-zinc-400 bg-zinc-900 text-zinc-100",
        state === "pending" && "border-zinc-800 bg-black/30 text-zinc-600",
      )}
    >
      <span className="font-bold tabular-digits mr-2">{String(n).padStart(2, "0")}</span>
      {label} {state === "done" && "✓"}
    </div>
  );
}

function AlpacaStep({ onDone }: { onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const m = useMutation({
    mutationFn: () => api.linkAlpaca({ apiKey, apiSecret }),
    onSuccess: onDone,
  });
  const err = m.error as ApiError | null;

  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-6">
      <div className="text-sm text-zinc-400 mb-4">
        Paste your <a className="underline" href="https://app.alpaca.markets/paper/dashboard/overview" target="_blank" rel="noreferrer">paper account</a> keys. They're
        AES-GCM encrypted before touching the database.
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="API Key (APCA-API-KEY-ID)">
          <input
            className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 tabular-digits text-sm"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="API Secret (APCA-API-SECRET-KEY)">
          <input
            type="password"
            className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 tabular-digits text-sm"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {err && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {err.message}
          </div>
        )}
        <button
          type="submit"
          disabled={m.isPending || apiKey.length < 10 || apiSecret.length < 10}
          className="w-full rounded bg-zinc-100 py-2.5 font-semibold text-zinc-900 disabled:opacity-40 hover:bg-white transition"
        >
          {m.isPending ? "Verifying…" : "Validate & link"}
        </button>
      </form>
    </div>
  );
}

function PlaybookStep({
  draft,
  onDone,
}: {
  draft: { goalText: string; playbookText: string } | null | undefined;
  onDone: () => void;
}) {
  const [goal, setGoal] = useState(draft?.goalText ?? "");
  const [playbook, setPlaybook] = useState(draft?.playbookText ?? "");
  const m = useMutation({
    mutationFn: () => api.submitPlaybook({ goal, playbook }),
    onSuccess: onDone,
  });
  const err = m.error as ApiError | null;

  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-4">
      <div className="text-sm text-zinc-400 mb-4 px-2">
        Chat with the coach on the left to draft your goal + playbook, or type directly on the right. When ready,
        Claude Opus 4.7 translates it into a concrete operational plan.
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="lg:min-h-[540px]">
          <CoachChat
            onCommitDraft={(d) => {
              setGoal(d.goal);
              setPlaybook(d.playbook);
            }}
          />
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <CountedField
            label="Goal"
            value={goal}
            setValue={setGoal}
            min={20}
            minHeight={100}
            placeholder="e.g. Finish 30 days up 15%, top-3 on the leaderboard. I'd rather miss upside than blow up."
          />
          <CountedField
            label="Playbook"
            value={playbook}
            setValue={setPlaybook}
            min={40}
            minHeight={220}
            placeholder="Universe I care about, how I pick entries, how I size, when I sell, what risk I tolerate…"
          />
          {err && (
            <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {err.message}
            </div>
          )}
          <button
            type="submit"
            disabled={m.isPending || goal.trim().length < 20 || playbook.trim().length < 40}
            className="w-full rounded bg-zinc-100 py-2.5 font-semibold text-zinc-900 disabled:opacity-40 hover:bg-white transition"
          >
            {m.isPending ? "Asking Opus… this takes 20–40s" : "Translate with Claude Opus 4.7"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ReviewStep({
  onApproved,
  onBack,
}: {
  onApproved: () => void;
  onBack: () => void;
}) {
  const pbQ = useQuery({ queryKey: ["playbook"], queryFn: api.playbookCurrent });
  const plan = pbQ.data?.plan;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const qc = useQueryClient();

  const approveM = useMutation({
    mutationFn: () => api.approvePlan(plan!.id),
    onSuccess: onApproved,
  });
  const rejectM = useMutation({
    mutationFn: () => api.rejectPlan(plan!.id, reason),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["playbook"] });
      onBack();
    },
  });

  if (!plan) return null;
  const pending = plan.approvalState === "pending";
  const busy = approveM.isPending || rejectM.isPending;
  const err = (approveM.error ?? rejectM.error) as ApiError | null;

  return (
    <div className="rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)] p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div className="text-xs tracking-wider text-zinc-500 uppercase">Claude's plan · {plan.claudeModel}</div>
        <div
          className={cn(
            "text-[10px] font-bold uppercase tracking-wider rounded px-2 py-0.5",
            plan.approvalState === "approved" && "bg-emerald-950/50 text-emerald-300 border border-emerald-900/60",
            plan.approvalState === "pending" && "bg-zinc-800 text-zinc-300",
            plan.approvalState === "rejected" && "bg-red-950/50 text-red-300 border border-red-900/60",
            plan.approvalState === "superseded" && "bg-zinc-900 text-zinc-500",
          )}
        >
          {plan.approvalState}
        </div>
      </div>
      <PlanView plan={plan.planJson} />

      {err && (
        <div className="mt-4 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {err.message}
        </div>
      )}

      {!pending && (
        <div className="mt-6 rounded border border-zinc-800 bg-black/40 p-4 text-sm text-zinc-400">
          This plan is <span className="text-zinc-200 font-semibold">{plan.approvalState}</span> and can't be changed.
          {plan.approvalState === "approved" && (
            <> Go to the <span className="text-zinc-200 font-semibold">Strategy</span> page and re-translate to generate a new version.</>
          )}
        </div>
      )}

      {pending && rejecting && (
        <div className="mt-6 space-y-3">
          <Field label="What's wrong? (Claude will use this on the next translation)">
            <textarea
              className="w-full min-h-[100px] rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex gap-3">
            <button
              onClick={() => setRejecting(false)}
              className="flex-1 rounded border border-zinc-700 py-2.5 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => rejectM.mutate()}
              disabled={reason.trim().length < 5 || busy}
              className="flex-1 rounded bg-red-600 py-2.5 font-semibold text-white disabled:opacity-40"
            >
              {rejectM.isPending ? "…" : "Reject & retry"}
            </button>
          </div>
        </div>
      )}

      {pending && !rejecting && (
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="flex-1 rounded border border-zinc-700 py-2.5 text-sm disabled:opacity-40"
          >
            Reject with feedback
          </button>
          <button
            onClick={() => approveM.mutate()}
            disabled={busy}
            className="flex-1 rounded bg-emerald-600 py-2.5 font-semibold text-white disabled:opacity-40"
          >
            {approveM.isPending ? "…" : "Approve — start my engine"}
          </button>
        </div>
      )}
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

function CountedField({
  label,
  value,
  setValue,
  min,
  minHeight,
  placeholder,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  min: number;
  minHeight: number;
  placeholder: string;
}) {
  const count = value.trim().length;
  const ok = count >= min;
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs tracking-wider text-zinc-500 uppercase">{label}</span>
        <span
          className={cn(
            "text-[10px] tabular-digits tracking-wider uppercase",
            ok ? "text-emerald-500" : "text-zinc-500",
          )}
        >
          {count} / {min} min {ok ? "✓" : ""}
        </span>
      </div>
      <textarea
        style={{ minHeight: `${minHeight}px` }}
        className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 text-sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
