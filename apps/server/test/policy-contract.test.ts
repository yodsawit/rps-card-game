import { expect, it } from "vitest";
import { CARD_SYMBOLS, POLICY_SCHEMA } from "@rps/game-core";
import fixtures from "../../../packages/game-core/test/fixtures/policy-observations.json";
import { RoomManager } from "../src/room-manager.js";
import { makeLearnedInput } from "../src/learned-ai.js";

it.each(fixtures)("matches the shared Python observation: $name", (fixture) => {
  const manager = new RoomManager();
  manager.setComputerScheduler(() => undefined);
  const host = manager.createRoom("A", "a", 0);
  const guest = manager.joinRoom(host.roomCode, "B", "b", 0);
  manager.startRoom(host.roomCode, host.playerId, 0);
  const room = manager.rooms.get(host.roomCode)!;
  const game = room.game!;
  game.attackerId = host.playerId;
  game.defenderId = guest.playerId;
  game.phase = fixture.phase === "battle" ? "preparation" : "discard";
  game.preparationLane = fixture.lane as 0 | 1 | 2;
  game.config.copiesPerSymbol = fixture.copiesPerSymbol;
  game.deck = Array.from({ length: fixture.deckCount }, (_, i) => ({ id: `deck-${i}`, symbol: "rock" }));
  game.players.forEach((player, index) => {
    player.hp = fixture.hp[index]!;
    player.hand = fixture.hands[index]!.map((symbol, card) => ({ id: `${index}-${card}`, symbol: CARD_SYMBOLS[symbol]! }));
    const used = new Set<string>();
    player.slots.forEach((slot, lane) => {
      const symbol = fixture.cards[index]![lane];
      const card = symbol === null ? null : player.hand.find((card) => card.symbol === CARD_SYMBOLS[symbol!] && !used.has(card.id));
      slot.cardId = card?.id ?? null;
      if (card) used.add(card.id);
      slot.hearts = fixture.hearts[index]![lane]!;
    });
  });
  const phase = fixture.phase === "battle" ? "pair" : fixture.phase as "buy" | "discard";
  expect(makeLearnedInput(room, host.playerId, phase).observation).toEqual(fixture.observation);
  expect(fixture.observation).toHaveLength(POLICY_SCHEMA.observationSize);
});
