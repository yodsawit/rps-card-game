import { describe, expect, it } from "vitest";
import {
  chooseComputerDiscards,
  chooseComputerPair,
  chooseComputerPreparation,
  seededRandom,
  shouldComputerPurchaseExtraDraw,
  type Card
} from "../src/index.js";

const cards = (symbols: Array<Card["symbol"]>): Card[] =>
  symbols.map((symbol, index) => ({ id: `${symbol}-${index}`, symbol }));

describe("computer opponent", () => {
  it("uses exactly three owned cards and every HP", () => {
    const hand = cards(["rock", "rock", "rock", "paper", "scissors"]);
    const choice = chooseComputerPreparation(
      {
        playerId: "bot",
        hand,
        hp: 10,
        opponentPositions: [
          { occupied: true, hearts: 4 },
          { occupied: true, hearts: 3 },
          { occupied: true, hearts: 3 }
        ]
      },
      seededRandom(3)
    );

    expect(new Set(choice.cardIds).size).toBe(3);
    expect(choice.cardIds.every((id) => hand.some((card) => card.id === id))).toBe(true);
    expect(choice.hearts.reduce((total, value) => total + value, 0)).toBe(10);
    expect(choice.cardIds.every((id) => id.startsWith("rock"))).toBe(true);
  });

  it("keeps a completed five-of-a-kind when selecting discards", () => {
    const hand = cards(["rock", "rock", "rock", "rock", "rock", "paper", "scissors"]);
    const discarded = chooseComputerDiscards(hand, 2, seededRandom(9));
    const remaining = hand.filter((card) => !discarded.includes(card.id));

    expect(remaining).toHaveLength(5);
    expect(remaining.every((card) => card.symbol === "rock")).toBe(true);
  });

  it("chooses only an uncommitted card and saves HP for later pairs", () => {
    const hand = cards(["rock", "rock", "rock", "paper", "scissors"]);
    const choice = chooseComputerPair({
      playerId: "bot",
      hand,
      hp: 10,
      activeLane: 1,
      ownSlots: [
        { cardId: hand[0]!.id, hearts: 4 },
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 }
      ],
      opponentPositions: [
        { occupied: true, hearts: 3 },
        { occupied: true, hearts: 2 },
        { occupied: false, hearts: 0 }
      ]
    }, seededRandom(4));

    expect(choice.cardId).not.toBe(hand[0]!.id);
    expect(choice.hearts).toBeGreaterThanOrEqual(0);
    expect(choice.hearts).toBeLessThan(6);
  });

  it("never buys an extra draw with the final HP", () => {
    const hand = cards(["rock", "rock", "rock", "rock"]);
    expect(shouldComputerPurchaseExtraDraw(hand, 1, 5, seededRandom(1))).toBe(false);
    expect(shouldComputerPurchaseExtraDraw(hand, 5, 5, seededRandom(1))).toBe(true);
  });
});
