import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GameStudyEventType =
  | "match_started"
  | "target_selected"
  | "advanced_pair_decision"
  | "pair_revealed"
  | "battle_resolved"
  | "shuffle_resolved"
  | "match_finished";

export interface GameStudyEvent {
  schemaVersion: 1;
  recordedAt: string;
  timestamp: number;
  roomCode: string;
  gameId: string;
  round: number;
  type: GameStudyEventType;
  data: Record<string, unknown>;
}

export type GameStudyEventHandler = (event: GameStudyEvent) => void;

export function createJsonlStudyLogger(
  path: string,
  reportError: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): GameStudyEventHandler {
  let warned = false;
  return (event): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      warned = false;
    } catch (error) {
      if (warned) return;
      warned = true;
      const message = error instanceof Error ? error.message : "Unknown file error.";
      reportError(`RPS study log could not be written: ${message}`);
    }
  };
}
