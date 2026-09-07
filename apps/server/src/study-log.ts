import { createBufferedLogger, type BufferedLogger } from "./buffered-log.js";

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
): BufferedLogger<GameStudyEvent> {
  return createBufferedLogger(path, reportError);
}
