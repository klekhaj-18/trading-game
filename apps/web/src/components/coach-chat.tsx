import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CoachMessage } from "shared/coach";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/utils";

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
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.assistantText || "(drafted above)" },
      ]);
      if (res.draft) {
        onCommitDraft(res.draft);
        setDraftedAt(Date.now());
      }
    },
  });
  const err = m.error as ApiError | null;

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
          <div className="text-[10px] text-zinc-600 mt-0.5">Sonnet 4.6 · interviews you before Opus translates</div>
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
          <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
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
          <span>Coach may call commit_draft when ready \u2014 your textareas auto-fill.</span>
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
