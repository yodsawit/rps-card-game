import type { BotDifficulty } from "@rps/game-core";
import type { ActionTimeLimit } from "./types.js";

export function cleanActionTimeLimit(value: unknown): ActionTimeLimit {
  if (value === 20_000 || value === 30_000 || value === null) return value;
  throw new Error("Action timer must be 20 seconds, 30 seconds, or no limit.");
}

export function cleanBotDifficulty(value: unknown): BotDifficulty {
  if (value === "basic" || value === "advanced" || value === "learned") return value;
  throw new Error("Computer difficulty is invalid.");
}

export function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a player name.");
  const result = value.trim().replace(/\s+/g, " ").slice(0, 18);
  if (result.length < 1) throw new Error("Enter a player name.");
  return result;
}

export function cleanRoomCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a room code.");
  const result = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (result.length !== 5) throw new Error("Room codes contain five characters.");
  return result;
}

export function cleanSlotIndex(value: unknown): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new Error("Battle position is invalid.");
}

export function cleanHeartDelta(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 100) {
    throw new Error("HP adjustment is invalid.");
  }
  return value;
}

export function cleanCardId(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 40) {
    throw new Error("Card selection is invalid.");
  }
  return value;
}

export function cleanCardIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("Discard selection is invalid.");
  return value.map((cardId) => cleanCardId(cardId) as string);
}
