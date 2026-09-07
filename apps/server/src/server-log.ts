import { createBufferedLogger, type BufferedLogger } from "./buffered-log.js";

export type ServerActionSource = "human" | "bot" | "timeout" | "system";

export interface ServerActionEvent {
  schemaVersion: 1;
  visibility: "server_only";
  recordedAt: string;
  timestamp: number;
  roomCode: string;
  gameId: string;
  round: number;
  type: string;
  source: ServerActionSource;
  actorId: string | null;
  data: Record<string, unknown>;
  /** Complete authoritative state, including deck order and every hidden hand. */
  state: Record<string, unknown>;
}

export type ServerActionEventHandler = (event: ServerActionEvent) => void;

export function createJsonlServerLogger(
  path: string,
  reportError: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): BufferedLogger<ServerActionEvent> {
  return createBufferedLogger(path, reportError);
}
