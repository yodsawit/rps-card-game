import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/room-manager.js";
import { RateLimit } from "../src/rate-limit.js";
import { chooseLearnedPair } from "../src/learned-ai.js";
import { advancePreparationPair, beginPreparation, setCardPlacement, seededRandom, assertMatchInvariants } from "@rps/game-core";

describe("server review regressions", () => {
  it.each([303, 306, 309, 311])("completes six-seat high-HP GTO seed %s without numerical cycling", (seed) => {
    const manager = new RoomManager(seededRandom(seed));
    const host = manager.createRoom("ARC", "test", 0);
    const room = manager.rooms.get(host.roomCode)!;
    room.players[0]!.isBot = true;
    room.players[0]!.botDifficulty = "basic";
    for (let seat = 1; seat < 6; seat += 1) {
      manager.addBot(room.code, host.playerId, 0, seat === 1 ? "advanced" : seat === 2 ? "learned" : "basic");
    }
    manager.startRoom(room.code, host.playerId, 0);
    for (let step = 0; step < 500 && room.game!.phase !== "finished"; step += 1) {
      manager.tick(room.game!.deadlineAt ?? (step + 1) * 30_000);
      assertMatchInvariants(room.game!);
    }
    expect(room.game!.phase).toBe("finished");
    expect(room.game!.outcome?.reason).not.toBe("error");
  }, 20_000);
  it("prevents one socket from leaving orphan rooms", () => {
    const manager = new RoomManager();
    manager.createRoom("A", "same", 0);
    expect(() => manager.createRoom("B", "same", 0)).toThrow("Leave your current room");
    manager.disconnectSocket("same", 1);
    manager.tick(31_001);
    expect(manager.rooms.size).toBe(0);
  });
  it("cleans up explicitly abandoned games", () => {
    const manager = new RoomManager();
    const host = manager.createRoom("A", "a", 0);
    manager.addBot(host.roomCode, host.playerId, 0);
    manager.startRoom(host.roomCode, host.playerId, 0);
    manager.leaveRoom(host.roomCode, host.playerId, 1);
    expect(manager.rooms.size).toBe(0);
  });
  it("rematches connected participants without requiring departed players", () => {
    const manager = new RoomManager();
    const host = manager.createRoom("A", "a", 0);
    const guest = manager.joinRoom(host.roomCode, "B", "b", 0);
    manager.addBot(host.roomCode, host.playerId, 0);
    manager.startRoom(host.roomCode, host.playerId, 0);
    const room = manager.rooms.get(host.roomCode)!;
    manager.leaveRoom(room.code, guest.playerId, 1);
    room.game!.phase = "finished";
    room.game!.outcome = { kind: "winner", winnerId: host.playerId, reason: "hp" };
    manager.requestRematch(room.code, host.playerId, 2);
    expect(room.game!.phase).toBe("targeting");
    expect(room.game!.players).toHaveLength(2);
  });
  it("commits every remaining heart with legacy RL even above 20 HP", () => {
    const manager = new RoomManager();
    const host = manager.createRoom("A", "a", 0);
    const guest = manager.joinRoom(host.roomCode, "B", "b", 0);
    manager.startRoom(host.roomCode, host.playerId, 0);
    const room = manager.rooms.get(host.roomCode)!;
    const game = room.game!;
    beginPreparation(game, 3_000);
    game.players[0]!.hp = 22;
    for (const lane of [0, 1] as const) {
      setCardPlacement(game, host.playerId, lane, game.players[0]!.hand[lane]!.id);
      setCardPlacement(game, guest.playerId, lane, game.players[1]!.hand[lane]!.id);
      advancePreparationPair(game, 4_000 + lane);
    }
    const choice = chooseLearnedPair(room, host.playerId, () => 0.5);
    expect(choice.hearts).toBe(22);
    expect(choice.cardId).toBe(game.players[0]!.hand[2]!.id);
  });
  it("bounds rate-limit windows and restores allowance after expiry", () => {
    const limit = new RateLimit(2, 1000);
    expect(limit.allow("client", 0)).toBe(true);
    expect(limit.allow("client", 1)).toBe(true);
    expect(limit.allow("client", 2)).toBe(false);
    expect(limit.allow("client", 1000)).toBe(true);
  });
});
