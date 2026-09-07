import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
): ServerActionEventHandler {
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
      reportError(`RPS private server log could not be written: ${message}`);
    }
  };
}
