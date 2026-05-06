import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CoachMessage, CoachPlanRevision, CoachPlaybookRevision } from "shared/coach";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/utils";

type Proposal =
  | { kind: "playbook"; revision: CoachPlaybookRevision; turnIndex: number }
  | { kind: "plan"; revision: CoachPlanRevision; turnIndex: number };

const OPENER: CoachMessage = {
  role: "assistant",
  content:
    "Welcome to the paddock. I'm the pit-wall engineer — my job is to pressure-test your strategy before Claude Opus builds the operational plan.\n\nStart wherever: what's the result you want from these 30 days?",
};

export interface CoachChatProps {
  onCommitDraft: (draft: { goal: string; playbook: string }) => void;
  storageKey?: string;
}

export function CoachChat({ onCommitDraft, storageKey = "tgp:coach" }: CoachChatProps) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<CoachMessage[]>(() => {
    if (typeof window === "undefined") return [OPENER];
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved) as CoachMessage[];
    } catch {
      /* ignore */
    }
    return [OPENER];
  });
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, storageKey]);

  const [draftedAt, setDraftedAt] = useState<number | null>(null);
  const m = useMutation({
    mutationFn: async (next: CoachMessage[]) => api.coachChat(next),
    onSuccess: (res) => {
      const turnIndex = messages.length + 1;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.assistantText || "(see proposal above)" },
      ]);
      if (res.draft) {
        onCommitDraft(res.draft);
        setDraftedAt(Date.now());
      }
      if (res.playbookRevision) {
        setProposals((p) => [...p, { kind: "playbook", revision: res.playbookRevision!, turnIndex }]);
      }
      if (res.planRevision) {
        setProposals((p) => [...p, { kind: "plan", revision: res.planRevision!, turnIndex }]);
      }
    },
  });
  const err = m.error as ApiError | null;

  const applyPlaybookM = useMutation({
    mutationFn: (rev: CoachPlaybookRevision) =>
      api.submitPlaybook({ goal: rev.goal, playbook: rev.playbook }),
    onSuccess: (_data, rev) => {
      qc.invalidateQueries({ queryKey: ["playbook"] });
      setProposals((p) =>
        p.filter((x) => !(x.kind === "playbook" && x.revision === rev)),
      );
    },
  });
  const applyPlanM = useMutation({
    mutationFn: (rev: CoachPlanRevision) =>
      api.proposePlan({ plan: rev.plan, rationale: rev.rationale }),
    onSuccess: (_data, rev) => {
      qc.invalidateQueries({ queryKey: ["playbook"] });
      setProposals((p) => p.filter((x) => !(x.kind === "plan" && x.revision === rev)));
    },
  });

  function send() {
    const text = input.trim();
    if (!text || m.isPending) return;
    const next: CoachMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    m.mutate(next);
  }

  function reset() {
    setMessages([OPENER]);
    setProposals([]);
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col h-full rounded-lg border border-[var(--color-race-border)] bg-[var(--color-race-panel)]">
      <div className="flex items-baseline justify-between border-b border-zinc-900 px-4 py-3">
        <div>
          <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase">Pit-wall coach</div>
          <div className="text-[10px] text-zinc-600 mt-0.5">Opus 4.7 · sees your strategy and can propose revisions</div>
        </div>
        <button
          onClick={reset}
          className="text-[10px] text-zinc-500 hover:text-zinc-300 uppercase tracking-wider"
        >
          Reset
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-[300px] max-h-[60vh]">
        {messages.map((msg, i) => (
          <div key={i} className="space-y-2">
            <div className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-zinc-100 text-zinc-900"
                    : "bg-black/40 border border-zinc-800 text-zinc-200",
                )}
              >
                {msg.content}
              </div>
            </div>
            {proposals
              .filter((p) => p.turnIndex === i)
              .map((p, j) =>
                p.kind === "playbook" ? (
                  <PlaybookProposalCard
                    key={`pb-${i}-${j}`}
                    revision={p.revision}
                    onApply={() => applyPlaybookM.mutate(p.revision)}
                    pending={applyPlaybookM.isPending}
                    error={applyPlaybookM.error as ApiError | null}
                  />
                ) : (
                  <PlanProposalCard
                    key={`pl-${i}-${j}`}
                    revision={p.revision}
                    onApply={() => applyPlanM.mutate(p.revision)}
                    pending={applyPlanM.isPending}
                    error={applyPlanM.error as ApiError | null}
                  />
                ),
              )}
          </div>
        ))}
        {m.isPending && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-black/40 border border-zinc-800 px-3 py-2 text-sm text-zinc-500">
              · · ·
            </div>
          </div>
        )}
        {err && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {err.message}
          </div>
        )}
        {draftedAt && (
          <div className="rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            Coach drafted your goal + playbook. The textareas on the right are filled in —
            edit if you want, then hit <span className="font-semibold">Re-translate with Claude</span>.
          </div>
        )}
      </div>

      <div className="border-t border-zinc-900 px-4 py-3">
        <textarea
          className="w-full rounded bg-black/60 border border-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500 resize-none"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type\u2026 (Enter to send, Shift+Enter for newline)"
          disabled={m.isPending}
        />
        <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
          <span>Coach can rewrite the playbook or propose a plan revision \u2014 apply inline.</span>
          <button
            onClick={send}
            disabled={!input.trim() || m.isPending}
            className="rounded bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-900 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function PlaybookProposalCard({
  revision,
  onApply,
  pending,
  error,
}: {
  revision: CoachPlaybookRevision;
  onApply: () => void;
  pending: boolean;
  error: ApiError | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 max-w-[95%]">
      <div className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold">
        Coach proposes a playbook revision
      </div>
      <div className="mt-1 text-xs text-zinc-300">{revision.rationale}</div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-[10px] text-blue-200 hover:text-blue-100 uppercase tracking-wider"
      >
        {open ? "Hide" : "Show"} draft
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Goal</div>
            <div className="whitespace-pre-wrap text-zinc-200 mt-0.5">{revision.goal}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Playbook</div>
            <div className="whitespace-pre-wrap text-zinc-200 mt-0.5">{revision.playbook}</div>
          </div>
        </div>
      )}
      {error && <div className="mt-2 text-[11px] text-red-400">{error.message}</div>}
      <div className="mt-3 flex justify-end">
        <button
          onClick={onApply}
          disabled={pending}
          className="text-xs rounded border border-blue-400 bg-blue-500/20 px-3 py-1.5 uppercase tracking-wider font-semibold text-blue-100 hover:bg-blue-500/30 disabled:opacity-40"
        >
          {pending ? "Submitting\u2026" : "Apply (re-translates)"}
        </button>
      </div>
    </div>
  );
}

function PlanProposalCard({
  revision,
  onApply,
  pending,
  error,
}: {
  revision: CoachPlanRevision;
  onApply: () => void;
  pending: boolean;
  error: ApiError | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 max-w-[95%]">
      <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">
        Coach proposes a surgical plan revision
      </div>
      <div className="mt-1 text-xs text-zinc-300">{revision.rationale}</div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-[10px] text-emerald-200 hover:text-emerald-100 uppercase tracking-wider"
      >
        {open ? "Hide" : "Show"} plan JSON
      </button>
      {open && (
        <pre className="mt-2 text-[11px] text-zinc-300 bg-black/40 border border-zinc-800 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
          {JSON.stringify(revision.plan, null, 2)}
        </pre>
      )}
      {error && <div className="mt-2 text-[11px] text-red-400">{error.message}</div>}
      <div className="mt-3 flex justify-end">
        <button
          onClick={onApply}
          disabled={pending}
          className="text-xs rounded border border-emerald-400 bg-emerald-500/20 px-3 py-1.5 uppercase tracking-wider font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
        >
          {pending ? "Submitting\u2026" : "Apply (skip re-translate)"}
        </button>
      </div>
    </div>
  );
}
