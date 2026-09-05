import { describe, expect, it } from "vitest";
import { seededRandom } from "@rps/game-core";
import { inferLearnedPolicy } from "../src/learned-ai.js";
import { RoomManager } from "../src/room-manager.js";

describe("deployed learned policy", () => {
  it("matches the selected PyTorch checkpoint on a fixed observation", () => {
    const logits = inferLearnedPolicy(Array.from({ length: 90 }, () => 0));
    expect(logits).toHaveLength(63);
    const expected = [
      -0.15244156122207642,
      -0.05023036152124405,
      0.2116522639989853,
      0.3192156255245209,
      -0.16691848635673523,
      -0.048840709030628204,
      -0.06467901170253754,
      -0.016435444355010986
    ];
    expected.forEach((value, index) => expect(logits[index]).toBeCloseTo(value, 5));
  });

  it("adds and runs a separately labeled learned bot", () => {
    const manager = new RoomManager(seededRandom(20260906));
    const receipt = manager.createRoom("Host", "socket-1", 1_000);
    manager.addBot(receipt.roomCode, receipt.playerId, 1_001, "learned");
    const room = manager.rooms.get(receipt.roomCode)!;
    const bot = room.players.find((player) => player.isBot)!;
    expect(bot.name).toBe("RL-1");
    expect(bot.botDifficulty).toBe("learned");

    manager.startRoom(receipt.roomCode, receipt.playerId, 1_002);
    const gameBot = room.game!.players.find((player) => player.id === bot.id)!;
    expect(gameBot.slots[0].cardId).not.toBeNull();
    expect(gameBot.locked).toBe(true);
  });

  it("uses the active duelist as its opponent at a six-seat table", () => {
    const manager = new RoomManager(seededRandom(606));
    const receipt = manager.createRoom("RL host", "evaluation", 1_000);
    for (let index = 0; index < 5; index += 1) {
      manager.addBot(receipt.roomCode, receipt.playerId, 1_001 + index, "basic");
    }
    const room = manager.rooms.get(receipt.roomCode)!;
    room.players[0]!.isBot = true;
    room.players[0]!.botDifficulty = "learned";
    room.players[0]!.socketId = null;
    manager.startRoom(receipt.roomCode, receipt.playerId, 1_010);

    for (let guard = 0; room.game!.phase !== "finished" && guard < 20; guard += 1) {
      expect(room.game!.phase).toBe("battle");
      manager.tick(room.game!.deadlineAt!);
    }
    expect(room.game!.round).toBeGreaterThan(1);
  });
});
