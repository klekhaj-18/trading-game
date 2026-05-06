import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CoachPlanRevision, CoachPlaybookRevision } from "shared/coach";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/utils";

// Tiny inline-markdown renderer covering what the coach actually emits:
// **bold**, `code`, *italic* (single asterisk), and bullet lines starting with "- ".
// Whitespace + newlines are preserved by the wrapping element's whitespace-pre-wrap.
const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_TOKEN);
  return parts.map((part, i) => {
    const k = `${keyPrefix}-${i}`;
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={k} className="font-semibold text-zinc-50">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={k} className="rounded bg-zinc-800/80 px-1 py-0.5 text-[0.85em] text-zinc-100">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2 && !part.startsWith("**")) {
      return <em key={k} className="italic">{part.slice(1, -1)}</em>;
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1;
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;
        // Bullet rendering: turns "- foo" into "• foo" with stable spacing.
        if (/^[-*]\s+/.test(trimmed)) {
          const body = trimmed.replace(/^[-*]\s+/, "");
          return (
            <Fragment key={i}>
              <span style={{ paddingLeft: indent + "ch" }}>
                <span className="text-zinc-500">• </span>
                {renderInline(body, `b${i}`)}
              </span>
              {!isLast && "\n"}
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            {renderInline(line, `l${i}`)}
            {!isLast && "\n"}
          </Fragment>
        );
      })}
    </>
  );
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  proposal?:
    | { kind: "playbook"; revision: CoachPlaybookRevision }
    | { kind: "plan"; revision: CoachPlanRevision }
    | null;
}

const OPENER: ChatTurn = {
  role: "assistant",
  content:
    "Pit-wall coach here. I can see your goal, playbook, current positions, and recent trades. Ask me to walk through anything, propose a tweak, or rewrite a rule.",
};

export interface CoachChatProps {
  onCommitDraft: (draft: { goal: string; playbook: string }) => void;
  storageKey?: string;
}

export function CoachChat({ onCommitDraft, storageKey = "tgp:coach" }: CoachChatProps) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatTurn[]>(() => {
    if (typeof window === "undefined") return [OPENER];
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved) as ChatTurn[];
    } catch {
      /* ignore */
    }
    return [OPENER];
  });
  const [streamingText, setStreamingText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lookupStatus, setLookupStatus] = useState<{
    status: "started" | "completed";
    symbols: string[];
    rationale?: string;
    resolvedCount?: number;
    failedSymbols?: string[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamingText, storageKey]);

  const applyPlaybookM = useMutation({
    mutationFn: (rev: CoachPlaybookRevision) =>
      api.submitPlaybook({ goal: rev.goal, playbook: rev.playbook }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook"] }),
  });
  const applyPlanM = useMutation({
    mutationFn: (rev: CoachPlanRevision) =>
      api.proposePlan({ plan: rev.plan, rationale: rev.rationale }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["playbook"] }),
  });

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    const next: ChatTurn[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setStreamingText("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const apiPayload = next.map(({ role, content }) => ({ role, content }));
      const res = await fetch("/api/coach/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiPayload }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("Stream not supported by this browser");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let liveText = "";
      let finalDone: {
        assistantText: string;
        draft: { goal: string; playbook: string } | null;
        playbookRevision: CoachPlaybookRevision | null;
        planRevision: CoachPlanRevision | null;
      } | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let evtName = "";
          let evtData = "";
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("event:")) evtName = line.slice(6).trim();
            else if (line.startsWith("data:")) evtData = line.slice(5).trim();
          }
          if (evtName === "text") {
            try {
              const parsed = JSON.parse(evtData) as { delta: string };
              liveText += parsed.delta;
              setStreamingText(liveText);
            } catch {
              /* ignore malformed */
            }
          } else if (evtName === "lookup") {
            try {
              const parsed = JSON.parse(evtData) as {
                status: "started" | "completed";
                symbols: string[];
                rationale?: string;
                resolvedCount?: number;
                failedSymbols?: string[];
              };
              setLookupStatus(parsed);
            } catch {
              /* ignore malformed */
            }
          } else if (evtName === "done") {
            try {
              finalDone = JSON.parse(evtData);
            } catch {
              /* ignore */
            }
          } else if (evtName === "error") {
            try {
              const parsed = JSON.parse(evtData) as { message?: string };
              throw new Error(parsed.message ?? "Coach error");
            } catch (e) {
              throw e instanceof Error ? e : new Error("Coach error");
            }
          }
          sep = buffer.indexOf("\n\n");
        }
      }

      if (finalDone) {
        const proposal: ChatTurn["proposal"] = finalDone.planRevision
          ? { kind: "plan", revision: finalDone.planRevision }
          : finalDone.playbookRevision
            ? { kind: "playbook", revision: finalDone.playbookRevision }
            : null;
        const fallbackFromProposal = proposal ? proposal.revision.rationale : "";
        const finalText = (finalDone.assistantText || fallbackFromProposal || "").trim();
        const assistantTurn: ChatTurn = {
          role: "assistant",
          content: finalText,
          proposal,
        };
        setMessages((prev) => [...prev, assistantTurn]);
        if (finalDone.draft) onCommitDraft(finalDone.draft);
      } else if (liveText.trim().length > 0) {
        // Stream ended without a 'done' event but we have accumulated text — keep it.
        setMessages((prev) => [...prev, { role: "assistant", content: liveText.trim() }]);
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        // Cancelled by user — silent.
      } else {
        setError(e.message ?? "Coach had a hiccup. Try again.");
      }
    } finally {
      setStreaming(false);
      setStreamingText("");
      setLookupStatus(null);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([OPENER]);
    setStreamingText("");
    setError(null);
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
          <TurnView
            key={i}
            turn={msg}
            applyPlaybook={(rev) => applyPlaybookM.mutate(rev)}
            applyPlan={(rev) => applyPlanM.mutate(rev)}
            playbookPending={applyPlaybookM.isPending}
            planPending={applyPlanM.isPending}
            playbookError={applyPlaybookM.error as ApiError | null}
            planError={applyPlanM.error as ApiError | null}
          />
        ))}
        {lookupStatus && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              {lookupStatus.status === "started" ? (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse mr-2 align-middle" />
                  Looking up <span className="font-mono text-amber-100">{lookupStatus.symbols.join(", ")}</span>
                  {lookupStatus.rationale ? <span className="text-amber-300/80"> — {lookupStatus.rationale}</span> : null}
                </>
              ) : (
                <>
                  <span className="text-amber-300/80">✓</span>{" "}
                  Fetched {lookupStatus.resolvedCount ?? lookupStatus.symbols.length} of {lookupStatus.symbols.length}{" "}
                  symbol{lookupStatus.symbols.length !== 1 ? "s" : ""}
                  {lookupStatus.failedSymbols && lookupStatus.failedSymbols.length > 0 ? (
                    <span className="text-red-300/80"> (failed: {lookupStatus.failedSymbols.join(", ")})</span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-black/40 border border-zinc-800 text-zinc-200">
              {streamingText.length > 0 ? (
                <>
                  <MarkdownLite text={streamingText} />
                  <span className="inline-block w-1 h-4 ml-0.5 bg-zinc-400 animate-pulse align-text-bottom" />
                </>
              ) : (
                <span className="text-zinc-500">· · ·</span>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
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
          placeholder="Type… (Enter to send, Shift+Enter for newline)"
          disabled={streaming}
        />
        <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600 gap-3">
          <span className="min-w-0 flex-1">Coach can rewrite the playbook or propose a plan revision — apply inline.</span>
          {streaming ? (
            <button
              onClick={stop}
              className="rounded border border-red-500/60 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-200 hover:bg-red-500/20"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="rounded bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-900 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  applyPlaybook,
  applyPlan,
  playbookPending,
  planPending,
  playbookError,
  planError,
}: {
  turn: ChatTurn;
  applyPlaybook: (rev: CoachPlaybookRevision) => void;
  applyPlan: (rev: CoachPlanRevision) => void;
  playbookPending: boolean;
  planPending: boolean;
  playbookError: ApiError | null;
  planError: ApiError | null;
}) {
  return (
    <div className="space-y-2">
      {turn.content.length > 0 && (
        <div className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
          <div
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
              turn.role === "user"
                ? "bg-zinc-100 text-zinc-900"
                : "bg-black/40 border border-zinc-800 text-zinc-200",
            )}
          >
            {turn.role === "assistant" ? <MarkdownLite text={turn.content} /> : turn.content}
          </div>
        </div>
      )}
      {turn.proposal?.kind === "playbook" && (
        <PlaybookProposalCard
          revision={turn.proposal.revision}
          onApply={() => applyPlaybook(turn.proposal!.revision as CoachPlaybookRevision)}
          pending={playbookPending}
          error={playbookError}
        />
      )}
      {turn.proposal?.kind === "plan" && (
        <PlanProposalCard
          revision={turn.proposal.revision}
          onApply={() => applyPlan(turn.proposal!.revision as CoachPlanRevision)}
          pending={planPending}
          error={planError}
        />
      )}
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
          {pending ? "Submitting…" : "Apply (re-translates)"}
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
          {pending ? "Submitting…" : "Apply (skip re-translate)"}
        </button>
      </div>
    </div>
  );
}
