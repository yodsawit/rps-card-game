import { Worker } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import type { RoomManager } from "./room-manager.js";
import type { Room } from "./types.js";
import type { BotDecisionResult } from "./bot-decisions.js";

/** Bounded computations; only the main server advances the game and journals. */
export class BotPool {
  private readonly queue = new Map<string, Room>();
  private readonly busy = new Set<string>();
  private readonly workers = new Set<Worker>();
  private closed = false;

  constructor(private readonly manager: RoomManager) {}

  schedule(room: Room): void {
    const game = room.game;
    if (this.closed || this.manager.rooms.get(room.code) !== room || !game || game.phase === "finished") return;
    const automaticTarget = game.phase === "targeting" && game.defenderId === null
      && (game.players.filter((player) => !player.eliminated).length === 2
        || game.players.find((player) => player.id === game.attackerId)?.isBot);
    const botAction = (game.phase === "preparation" || game.phase === "discard")
      && game.players.some((player) => player.isBot && !player.eliminated && !player.locked
        && (player.id === game.attackerId || player.id === game.defenderId));
    if (!automaticTarget && !botAction) return;
    this.queue.set(room.code, room);
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    while (this.workers.size < 2) {
      const room = [...this.queue.values()].find((candidate) => !this.busy.has(candidate.code));
      if (!room) return;
      this.queue.delete(room.code);
      if (this.manager.rooms.get(room.code) !== room || room.game?.phase === "finished") continue;
      this.start(room);
    }
  }

  private start(room: Room): void {
    this.busy.add(room.code);
    const startedAt = Date.now();
    const turn = this.manager.computerTurn(room, startedAt);
    let revision = room.revision;
    const seed = randomBytes(4).readUInt32LE();
    const worker = new Worker(new URL(
      import.meta.url.endsWith(".ts") ? "./bot-worker-loader.mjs" : "./bot-worker.js", import.meta.url
    ), { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    this.workers.add(worker);
    let settled = false;
    const current = (): boolean => this.manager.rooms.get(room.code) === room && room.revision === revision;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.workers.delete(worker);
      this.busy.delete(room.code);
      turn.return();
      void worker.terminate();
      if (error && current() && !this.closed) this.manager.failRoom(room, error);
      else if (!this.closed) this.schedule(room);
      this.pump();
    };
    const timer = setTimeout(() => finish(new Error("Bot calculation exceeded its 12-second budget.")), 12_000);
    const advance = (decision?: BotDecisionResult): void => {
      if (this.closed || !current()) { finish(); return; }
      try {
        const deadline = room.game?.deadlineAt;
        const step = decision === undefined ? turn.next() : turn.next(decision);
        if (room.game && room.game.deadlineAt !== null && room.game.deadlineAt !== deadline) {
          room.game.deadlineAt += Date.now() - startedAt;
        }
        this.manager.publishComputerTurn(room, Date.now());
        revision = room.revision;
        if (step.done) { finish(); return; }
        // This DTO contains only the bot's hand, public information or encoded policy inputs.
        worker.postMessage({ request: structuredClone(step.value), seed });
      } catch (error) {
        revision = room.revision;
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", (code) => { if (!settled) finish(new Error(`Bot worker exited (${code}).`)); });
    worker.on("message", (result: { decision?: BotDecisionResult; error?: string }) => {
      if (settled) return;
      if (result.error) finish(new Error(result.error));
      else advance(result.decision);
    });
    advance();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.clear();
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
  }
}
