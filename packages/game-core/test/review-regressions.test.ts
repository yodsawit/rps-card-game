import { describe, expect, it } from "vitest";
import { createMatch, selectOpponent, beginPreparation, setCardPlacement, lockPlayer,
  advancePreparationPair, advanceBattle, forfeitPlayers, assertMatchInvariants, finalizeDiscards,
  purchaseExtraDraw, type CardSymbol, type MatchState } from "../src/index.js";

const R = "rock", P = "paper", S = "scissors";
function fullTable(count: 5 | 6): MatchState {
  const game = createMatch("regression", Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `P${index}` })), 0);
  const hands: CardSymbol[][] = count === 5
    ? [[R,R,P,P,S], [R,R,P,S,S], [R,P,P,S,S], [R,P,P,S,S], [R,R,P,P,S]]
    : [[R,R,P,P,S], [R,R,P,S,S], [R,P,P,S,S], [R,R,P,P,S], [R,R,P,S,S], [R,P,P,S,S]];
  const pool = [...game.deck, ...game.players.flatMap((player) => player.hand)];
  hands.forEach((symbols, index) => {
    game.players[index]!.hand = symbols.map((symbol) => pool.splice(pool.findIndex((card) => card.symbol === symbol), 1)[0]!);
  });
  game.deck = pool;
  assertMatchInvariants(game);
  selectOpponent(game, "p0", "p1", 0);
  beginPreparation(game, 2_000);
  for (const lane of [0, 1, 2] as const) {
    for (const player of game.players.slice(0, 2)) {
      const card = player.hand.find((card) => card.symbol === [R,R,P][lane] && !player.slots.some((slot) => slot.cardId === card.id))!;
      setCardPlacement(game, player.id, lane, card.id);
      lockPlayer(game, player.id);
    }
    advancePreparationPair(game, 3_000 + lane);
  }
  return game;
}

describe("review regressions", () => {
  it("stops mandatory draws at an empty deck and owes only received discards", () => {
    const game = fullTable(5);
    advanceBattle(game, 15_000);
    expect(game.players.slice(0, 2).map((player) => [player.drawnCardIds.length, player.requiredDiscards])).toEqual([[2,2], [0,0]]);
    expect(game.players[1]!.locked).toBe(true);
    expect(() => assertMatchInvariants(game)).not.toThrow();
  });
  it("skips every draw without taking HP or shrinking hands when the deck is empty", () => {
    const game = fullTable(6);
    advanceBattle(game, 15_000);
    expect(game.players.slice(0, 2).every((player) => player.locked && player.requiredDiscards === 0)).toBe(true);
    expect(() => purchaseExtraDraw(game, "p0")).toThrow();
    expect(game.players[0]!.hp).toBe(10);
    finalizeDiscards(game, 15_001);
    expect(game.players.every((player) => player.hand.length === 5)).toBe(true);
    assertMatchInvariants(game);
  });
  it("settles the remaining player's discard debt when the other duelist leaves", () => {
    const game = fullTable(5);
    advanceBattle(game, 15_000);
    forfeitPlayers(game, ["p1"], 15_001);
    expect(game.players[0]!.hand).toHaveLength(5);
    expect(game.phase).toBe("targeting");
    assertMatchInvariants(game);
  });
  it("does not interrupt a live duel when an already eliminated player leaves", () => {
    const game = fullTable(5);
    forfeitPlayers(game, ["p4"], 5_000);
    const phase = game.phase;
    forfeitPlayers(game, ["p4"], 5_001);
    expect(game.phase).toBe(phase);
    expect(game.round).toBe(1);
    assertMatchInvariants(game);
  });
});
