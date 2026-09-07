import { expect, it } from "vitest";
import { beginPreparation, seededRandom, type BotDifficulty } from "@rps/game-core";
import { RoomManager } from "../src/room-manager.js";

function setup(difficulty: BotDifficulty) {
  const manager = new RoomManager(seededRandom(19));
  manager.setComputerScheduler(() => undefined);
  const host = manager.createRoom("A", "a", 0);
  manager.addBot(host.roomCode, host.playerId, 0, difficulty);
  const room = manager.rooms.get(host.roomCode)!;
  room.players[0]!.isBot = true;
  room.players[0]!.botDifficulty = difficulty;
  manager.startRoom(room.code, host.playerId, 0);
  const target = manager.computerTurn(room, 0);
  target.next();
  target.return();
  beginPreparation(room.game!, 3000);
  return { manager, room };
}

it.each(["basic", "advanced", "learned"] as const)("%s decision input is independent of unrevealed opponent cards and deck order", (difficulty) => {
  const { manager, room } = setup(difficulty);
  const first = manager.computerTurn(room, 3000);
  const request = structuredClone(first.next().value);
  first.return();
  const opponent = room.game!.players[1]!;
  const original = opponent.hand[0]!;
  opponent.hand[0] = room.game!.deck[0]!;
  room.game!.deck[0] = original;
  room.game!.deck.reverse();
  const second = manager.computerTurn(room, 3000);
  expect(second.next().value).toEqual(request);
  second.return();
  const encoded = JSON.stringify(request);
  for (const player of room.players) {
    if (player.token !== "computer") expect(encoded).not.toContain(player.token);
  }
  for (const card of opponent.hand) expect(encoded).not.toContain(card.id);
});

it("does not reroll a skipped purchase when a bot turn is interrupted", () => {
  const { manager, room } = setup("basic");
  room.game!.phase = "discard";
  const turn = manager.computerTurn(room, 3000);
  expect(turn.next().value).toMatchObject({ method: "shouldComputerPurchaseExtraDraw" });
  const secondPurchase = structuredClone(turn.next(false).value);
  expect(secondPurchase).toMatchObject({ method: "shouldComputerPurchaseExtraDraw" });
  turn.return();
  const restarted = manager.computerTurn(room, 3001);
  expect(restarted.next().value).toEqual(secondPurchase);
  expect(restarted.next(false).value).toMatchObject({ method: "chooseComputerDiscards" });
  restarted.return();
});
