import { describe, expect, it } from "vitest";
import { seededRandom } from "@rps/game-core";
import { RoomManager } from "../src/room-manager.js";
import { snapshotFor } from "../src/snapshots.js";

describe("RoomManager", () => {
  it("starts a computer match and never exposes the bot hand in preparation", () => {
    const manager = new RoomManager(seededRandom(44));
    const receipt = manager.createRoom("Human", "socket-1", true, 1_000);
    const { room, player } = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const view = snapshotFor(room, player, 1_001);

    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    const bot = view.players.find((candidate) => candidate.isBot)!;
    expect(bot.handCount).toBe(3);
    expect(bot.slots[0]).toMatchObject({ occupied: true, symbol: null });
    expect(bot.slots.slice(1).every((slot) => !slot.occupied && slot.symbol === null)).toBe(true);
    expect(view.activeLane).toBe(0);
    expect(view.self.hand).toHaveLength(3);
  });

  it("reveals both card symbols only after battle resolution", () => {
    const manager = new RoomManager(seededRandom(8));
    const receipt = manager.createRoom("Human", "socket-1", true, 1_000);
    const { room, player } = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const game = room.game!;
    const human = game.players.find((candidate) => !candidate.isBot)!;
    for (const [lane, hearts] of [4, 3, 0].entries()) {
      manager.placeCard(room.code, human.id, lane as 0 | 1 | 2, human.hand[lane]!.id, 1_100 + lane);
      if (lane < 2) manager.adjustHearts(room.code, human.id, lane as 0 | 1, hearts, 1_100 + lane);
      manager.lock(room.code, human.id, 1_200 + lane);
      if (lane < 2) {
        const staged = snapshotFor(room, player, 1_201 + lane);
        expect(staged.kind).toBe("match");
        if (staged.kind === "match") {
          expect(staged.activeLane).toBe(lane + 1);
          const bot = staged.players.find((candidate) => candidate.isBot)!;
          expect(bot.slots[lane]!.symbol).not.toBeNull();
        }
      }
    }

    const view = snapshotFor(room, player, 1_201);
    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    expect(view.phase === "battle" || view.phase === "finished").toBe(true);
    expect(view.battle?.lanes.every((lane) => lane.sides.every((side) => side.symbol !== null))).toBe(true);
  });

  it("keeps fresh-draw identifiers in the owner's private view", () => {
    const manager = new RoomManager(seededRandom(19));
    const receipt = manager.createRoom("Human", "socket-1", true, 1_000);
    const { room, player } = manager.roomForPlayer(receipt.roomCode, receipt.playerId);
    const human = room.game!.players.find((candidate) => candidate.id === player.id)!;
    human.drawnCardIds = [human.hand[0]!.id];

    const view = snapshotFor(room, player, 1_001);
    expect(view.kind).toBe("match");
    if (view.kind !== "match") return;
    expect(view.self.drawnCardIds).toEqual([human.hand[0]!.id]);
    expect(view.players.every((candidate) => !("drawnCardIds" in candidate))).toBe(true);
  });

  it("forfeits a disconnected player after thirty seconds", () => {
    const manager = new RoomManager(seededRandom(3));
    const first = manager.createRoom("One", "socket-1", false, 1_000);
    manager.joinRoom(first.roomCode, "Two", "socket-2", 1_100);
    manager.disconnectSocket("socket-1", 2_000);
    expect(manager.rooms.get(first.roomCode)?.game?.outcome).toBeNull();
    manager.tick(32_000);
    expect(manager.rooms.get(first.roomCode)?.game?.outcome?.reason).toBe("forfeit");
  });
});
