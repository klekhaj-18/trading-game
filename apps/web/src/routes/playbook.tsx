import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { PlanView } from "../components/plan-view";
import { CoachChat } from "../components/coach-chat";
import { cn } from "../lib/utils";

export function PlaybookPage() {
  const qc = useQueryClient();
  const pbQ = useQuery({ queryKey: ["playbook"], queryFn: api.playbookCurrent });

  const [goal, setGoal] = useState("");
  const [playbook, setPlaybook] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (pbQ.data?.playbook) {
      setGoal(pbQ.data.playbook.goalText);
      setPlaybook(pbQ.data.playbook.playbookText);
    }
  }, [pbQ.data?.playbook?.id]);

  const submitM = useMutation({
    mutationFn: () => api.submitPlaybook({ goal, playbook }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook"] }),
  });
  const approveM = useMutation({
    mutationFn: (planId: string) => api.approvePlan(planId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook"] }),
  });
  const rejectM = useMutation({
    mutationFn: ({ planId, reason }: { planId: string; reason: string }) => api.rejectPlan(planId, reason),
    onSuccess: async () => {
      setRejecting(false);
      setReason("");
      await qc.invalidateQueries({ queryKey: ["playbook"] });
    },
  });

  const plan = pbQ.data?.plan ?? null;
  const state = plan?.approvalState ?? null;
  const err = (submitM.error ?? approveM.error ?? rejectM.error) as ApiError | null;
  const [showCoach, setShowCoach] = useState(false);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Strategy</div>
          <div className="flex items-center gap-3">
            {pbQ.data?.playbook && (
              <div className="text-xs text-zinc-600">
                v{pbQ.data.playbook.version} · {pbQ.data.history.length} version{pbQ.data.history.length === 1 ? "" : "s"}
              </div>
            )}
            <button
              onClick={() => setShowCoach((s) => !s)}
              className="text-[10px] rounded border border-zinc-700 px-2 py-1 uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
            >
              {showCoach ? "Hide coach" : "Open coach"}
            </button>
          </div>
        </div>

        {showCoach && (
          <div className="h-[540px]">
            <CoachChat
              storageKey="tgp:coach:playbook"
              onCommitDraft={(d) => {
                setGoal(d.goal);
                setPlaybook(d.playbook);
              }}
            />
          </div>
        )}

        <label className="block">
          <div className="mb-1.5 text-xs tracking-wider text-zinc-500 uppercase">Goal</div>
          <textarea
            className="w-full min-h-[90px] rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 text-sm"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>

        <label className="block">
          <div className="mb-1.5 text-xs tracking-wider text-zinc-500 uppercase">Playbook</div>
          <textarea
            className="w-full min-h-[300px] rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 text-sm"
            value={playbook}
            onChange={(e) => setPlaybook(e.target.value)}
          />
        </label>

        {err && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {err.message}
          </div>
        )}

        <button
          onClick={() => submitM.mutate()}
          disabled={submitM.isPending || goal.trim().length < 20 || playbook.trim().length < 40}
          className="w-full rounded bg-zinc-100 py-2.5 font-semibold text-zinc-900 disabled:opacity-40 hover:bg-white transition"
        >
          {submitM.isPending ? "Asking Opus…" : "Re-translate with Claude"}
        </button>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-4">
          <div className="text-xs tracking-[0.3em] text-zinc-500 uppercase">Operational plan</div>
          {state && (
            <div
              className={cn(
                "text-[10px] font-bold uppercase tracking-wider rounded px-2 py-0.5",
                state === "approved" && "bg-emerald-950/50 text-emerald-300 border border-emerald-900/60",
                state === "pending" && "bg-zinc-800 text-zinc-300",
                state === "rejected" && "bg-red-950/50 text-red-300 border border-red-900/60",
                state === "superseded" && "bg-zinc-900 text-zinc-500",
              )}
            >
              {state}
            </div>
          )}
        </div>

        {!plan && (
          <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            Write a playbook, then translate with Claude.
          </div>
        )}

        {plan && (
          <>
            <PlanView plan={plan.planJson} />

            {state === "pending" && !rejecting && (
              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => setRejecting(true)}
                  className="flex-1 rounded border border-zinc-700 py-2.5 text-sm"
                >
                  Reject with feedback
                </button>
                <button
                  onClick={() => approveM.mutate(plan.id)}
                  disabled={approveM.isPending}
                  className="flex-1 rounded bg-emerald-600 py-2.5 font-semibold text-white disabled:opacity-40"
                >
                  {approveM.isPending ? "…" : "Approve"}
                </button>
              </div>
            )}

            {state === "pending" && rejecting && (
              <div className="mt-6 space-y-3">
                <label className="block">
                  <div className="mb-1.5 text-xs tracking-wider text-zinc-500 uppercase">
                    What's wrong?
                  </div>
                  <textarea
                    className="w-full min-h-[100px] rounded bg-black/60 border border-zinc-800 px-3 py-2 outline-none focus:border-zinc-500 text-sm"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setRejecting(false)}
                    className="flex-1 rounded border border-zinc-700 py-2.5 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => rejectM.mutate({ planId: plan.id, reason })}
                    disabled={reason.trim().length < 5 || rejectM.isPending}
                    className="flex-1 rounded bg-red-600 py-2.5 font-semibold text-white disabled:opacity-40"
                  >
                    {rejectM.isPending ? "…" : "Reject & retry"}
                  </button>
                </div>
              </div>
            )}

            {plan.rejectedReason && state !== "pending" && (
              <div className="mt-4 rounded border border-zinc-800 bg-black/40 p-3 text-xs text-zinc-400">
                <span className="uppercase tracking-wider text-zinc-500">Prior rejection reason:</span>{" "}
                {plan.rejectedReason}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
