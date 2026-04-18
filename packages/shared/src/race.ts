import { z } from "zod";

export type RaceState = "pre_race" | "in_race" | "post_race";

export interface RaceStateResponse {
  state: RaceState;
  competitionStartAt: number | null;
  competitionEndAt: number | null;
  datesLocked: boolean;
  nowSec: number;
  lap: number | null;
  totalLaps: 30;
}

export const setDatesSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
});

export const extendEndSchema = z.object({
  newEndAt: z.string().datetime(),
});

export function deriveRaceState(
  startSec: number | null,
  endSec: number | null,
  nowSec: number,
): RaceState {
  if (!startSec || !endSec) return "pre_race";
  if (nowSec < startSec) return "pre_race";
  if (nowSec >= endSec) return "post_race";
  return "in_race";
}

export function lapOf(startSec: number | null, nowSec: number): number | null {
  if (!startSec) return null;
  if (nowSec < startSec) return 0;
  const days = Math.floor((nowSec - startSec) / (24 * 60 * 60));
  return Math.min(30, days + 1);
}
