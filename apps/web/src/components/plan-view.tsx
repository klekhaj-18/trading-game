import type { OperationalPlan } from "shared/playbook";

export function PlanView({ plan }: { plan: OperationalPlan }) {
  return (
    <div className="space-y-6">
      <Section title="Universe">
        <div className="grid grid-cols-2 gap-2">
          {plan.universe.map((u) => (
            <div
              key={u.symbol}
              className="rounded border border-zinc-800 bg-black/40 px-3 py-2"
            >
              <div className="tabular-digits font-semibold">{u.symbol}</div>
              <div className="text-xs text-zinc-400 mt-0.5">{u.rationale}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Sizing">
        <StatRow label="Position size" value={`${plan.sizing.position_size_pct}% of equity`} />
        <StatRow label="Max positions" value={`${plan.sizing.max_positions}`} />
        <StatRow label="Single-position cap" value={`${plan.sizing.concentration_cap_pct}%`} />
      </Section>

      <Section title="Risk">
        <StatRow label="Max daily loss" value={`${plan.risk.max_daily_loss_pct}%`} />
        <StatRow label="Stop loss" value={`${plan.risk.stop_loss_pct}%`} />
        <StatRow label="Take profit" value={`${plan.risk.take_profit_pct}%`} />
      </Section>

      <Section title="Entry rules">
        <ul className="space-y-2">
          {plan.entry_rules.map((r, i) => (
            <li key={i} className="text-sm">
              <span className="text-zinc-400">If</span> {r.condition} <span className="text-zinc-400">→</span> {r.action}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Exit rules">
        <ul className="space-y-2">
          {plan.exit_rules.map((r, i) => (
            <li key={i} className="text-sm">
              <span className="text-zinc-400">If</span> {r.condition} <span className="text-zinc-400">→</span> {r.action}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Per-slot emphasis">
        <SlotRow label="09:15 Premarket" value={plan.per_slot_emphasis.premarket} />
        <SlotRow label="09:35 Open" value={plan.per_slot_emphasis.open} />
        <SlotRow label="11:30 Midmorning" value={plan.per_slot_emphasis.midmorning} />
        <SlotRow label="14:00 Afternoon" value={plan.per_slot_emphasis.afternoon} />
        <SlotRow label="15:45 Close" value={plan.per_slot_emphasis.close} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs tracking-[0.25em] text-zinc-500 uppercase mb-2">{title}</div>
      <div className="rounded border border-[var(--color-race-border)] bg-black/40 p-4">{children}</div>
    </div>
  );
}
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-digits font-medium">{value}</span>
    </div>
  );
}
function SlotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1.5 border-b border-zinc-900 last:border-0">
      <div className="text-xs tabular-digits text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className="text-sm mt-0.5">{value}</div>
    </div>
  );
}
