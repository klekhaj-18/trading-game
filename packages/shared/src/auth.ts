import { z } from "zod";

export const MAX_PLAYERS = 4;

export const TEAM_COLORS = ["ferrari", "mercedes", "mclaren", "redbull"] as const;
export type TeamColor = (typeof TEAM_COLORS)[number];

export const TEAM_COLOR_META: Record<TeamColor, { label: string; hex: string }> = {
  ferrari: { label: "Ferrari Red", hex: "#DC0000" },
  mercedes: { label: "Mercedes Teal", hex: "#00D2BE" },
  mclaren: { label: "McLaren Papaya", hex: "#FF8700" },
  redbull: { label: "Red Bull Navy", hex: "#1E2D6B" },
};

const displayName = z
  .string()
  .trim()
  .min(2, "At least 2 characters")
  .max(24, "Keep it under 25 characters")
  .regex(/^[A-Za-z0-9 _-]+$/u, "Letters, numbers, spaces, _ or - only");

const password = z.string().min(8, "Minimum 8 characters").max(200);

export const signupSchema = z.object({
  displayName,
  password,
  teamColor: z.enum(TEAM_COLORS),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  displayName,
  password,
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUser {
  id: string;
  displayName: string;
  teamColor: TeamColor;
  onboardedAt: number | null;
  isAdmin: boolean;
}

export interface AuthStatusResponse {
  usersCount: number;
  roomFull: boolean;
  maxPlayers: number;
}
