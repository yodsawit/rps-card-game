import { describe, expect, it } from "vitest";
import {
  chooseAdvancedDraw,
  chooseAdvancedDiscards,
  chooseAdvancedPair,
  chooseAdvancedTableDiscards,
  chooseAdvancedTarget,
  chooseComputerDiscards,
  chooseComputerPair,
  chooseComputerPreparation,
  chooseComputerTarget,
  seededRandom,
  sampleAllOpponentHands,
  sampleOpponentHands,
  shouldComputerPurchaseExtraDraw,
  solveBayesianMaximin,
  type Card
} from "../src/index.js";

const cards = (symbols: Array<Card["symbol"]>): Card[] =>
  symbols.map((symbol, index) => ({ id: `${symbol}-${index}`, symbol }));

describe("computer opponent", () => {
  it("solves the unbiased Rock-Paper-Scissors matrix as an equal mixed strategy", () => {
    const symbols = ["rock", "paper", "scissors"] as const;
    const value = (left: typeof symbols[number], right: typeof symbols[number]): number => {
      if (left === right) return 0;
      return (left === "rock" && right === "scissors")
        || (left === "scissors" && right === "paper")
        || (left === "paper" && right === "rock") ? 1 : -1;
    };
    const equilibrium = solveBayesianMaximin(
      symbols,
      [{ probability: 1, actions: symbols }],
      value
    );

    expect(equilibrium.value).toBeCloseTo(0, 7);
    expect(equilibrium.probabilities).toHaveLength(3);
    for (const probability of equilibrium.probabilities) expect(probability).toBeCloseTo(1 / 3, 7);
  });

  it("samples only hands compatible with public card totals and revealed memory", () => {
    const memory = {
      playedHands: [{
        round: 1,
        handCount: 3,
        symbols: ["rock", "rock", "rock"] as const,
        hearts: [3, 3, 4] as [number, number, number]
      }],
      drawChanges: []
    };
    const distribution = sampleOpponentHands({
      copiesPerSymbol: 3,
      observerHand: cards(["paper", "paper", "scissors", "scissors"]),
      opponentHandCount: 3,
      memory
    }, seededRandom(21), 100);

    expect(distribution).toEqual([{
      counts: { rock: 3, paper: 0, scissors: 0 },
      samples: 100,
      probability: 1
    }]);
    expect(chooseAdvancedTarget({
      playerId: "bot",
      hand: cards(["paper", "scissors"]),
      copiesPerSymbol: 3,
      opponents: [
        { id: "known", eliminated: false, handCount: 3, memory },
        { id: "out", eliminated: true, handCount: 0, memory: { playedHands: [], drawChanges: [] } }
      ],
      sampleCount: 100
    }, seededRandom(22))).toBe("known");
  });

  it("samples opponents jointly so their combined hidden hands cannot exceed the deck", () => {
    const rockMemory = {
      playedHands: [{
        round: 1,
        handCount: 3,
        symbols: ["rock", "rock", "rock"] as const,
        hearts: [3, 3, 4] as const
      }],
      drawChanges: []
    };
    const distributions = sampleAllOpponentHands({
      copiesPerSymbol: 3,
      observerHand: [],
      opponents: [
        { id: "one", handCount: 3, memory: rockMemory },
        { id: "two", handCount: 3, memory: rockMemory }
      ]
    }, seededRandom(24), 200);
    const expectedRocks = distributions.reduce((tableTotal, opponent) =>
      tableTotal + opponent.hands.reduce((total, hand) => total + hand.counts.rock * hand.probability, 0), 0
    );

    expect(expectedRocks).toBeLessThanOrEqual(3 + 1e-9);
  });

  it("uses the sampled maximin solution for an advanced pair without heuristic weights", () => {
    const hand = cards(["paper", "paper", "scissors"]);
    const choice = chooseAdvancedPair({
      playerId: "bot",
      hand,
      observerHand: hand,
      hp: 10,
      activeLane: 0,
      ownSlots: [
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 }
      ],
      opponentHp: 10,
      opponentPositions: [
        { occupied: false, hearts: 0 },
        { occupied: false, hearts: 0 },
        { occupied: false, hearts: 0 }
      ],
      copiesPerSymbol: 3,
      opponentHandCount: 3,
      memory: {
        playedHands: [{
          round: 1,
          handCount: 3,
          symbols: ["rock", "rock", "rock"],
          hearts: [3, 3, 4]
        }],
        drawChanges: []
      },
      sampleCount: 100
    }, seededRandom(23));

    expect(hand.find((card) => card.id === choice.cardId)?.symbol).toBe("paper");
    expect(choice.hearts).toBeGreaterThanOrEqual(0);
    expect(choice.hearts).toBeLessThanOrEqual(10);
    expect(choice.analysis).toMatchObject({
      sampleCount: 100,
      ownPlanCount: 198,
      opponentSequenceCount: 1,
      opponentPlanCount: 66,
      nextCardProbabilities: { rock: 1, paper: 0, scissors: 0 }
    });
    expect(choice.analysis.currentActions.reduce((sum, action) => sum + action.probability, 0)).toBeCloseTo(1, 8);
    expect(choice.analysis.currentActions).toContainEqual(expect.objectContaining({
      symbol: "paper",
      hearts: choice.hearts
    }));
  });

  it("rebuilds the remaining sequence and HP game after a public pair reveal", () => {
    const hand = cards(["paper", "paper", "scissors"]);
    const choice = chooseAdvancedPair({
      playerId: "bot",
      hand,
      observerHand: hand,
      hp: 10,
      activeLane: 1,
      ownSlots: [
        { cardId: hand[0]!.id, hearts: 4 },
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 }
      ],
      opponentHp: 10,
      opponentPositions: [
        { occupied: true, hearts: 3 },
        { occupied: false, hearts: 0 },
        { occupied: false, hearts: 0 }
      ],
      copiesPerSymbol: 3,
      opponentHandCount: 3,
      currentRevealedSymbols: ["rock"],
      memory: {
        playedHands: [{
          round: 1,
          handCount: 3,
          symbols: ["rock", "rock", "rock"],
          hearts: [3, 3, 4]
        }],
        drawChanges: []
      },
      sampleCount: 100
    }, seededRandom(26));

    expect(choice.analysis).toMatchObject({
      sampleCount: 100,
      ownPlanCount: 14,
      opponentSequenceCount: 1,
      opponentPlanCount: 8,
      nextCardProbabilities: { rock: 1, paper: 0, scissors: 0 }
    });
    expect(choice.analysis.currentActions.some((action) =>
      action.symbol === hand.find((card) => card.id === choice.cardId)!.symbol
      && action.hearts === choice.hearts
      && action.probability > 0
    )).toBe(true);
  });

  it("treats a locked opponent's visible current HP as exact", () => {
    const hand = cards(["paper", "paper", "scissors"]);
    const base = {
      playerId: "bot",
      hand,
      observerHand: hand,
      hp: 10,
      activeLane: 0 as const,
      ownSlots: [
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 }
      ],
      opponentHp: 10,
      opponentPositions: [
        { occupied: true, hearts: 3 },
        { occupied: false, hearts: 0 },
        { occupied: false, hearts: 0 }
      ],
      copiesPerSymbol: 3,
      opponentHandCount: 3,
      memory: {
        playedHands: [{
          round: 1,
          handCount: 3,
          symbols: ["rock", "rock", "rock"] as const,
          hearts: [3, 3, 4] as const
        }],
        drawChanges: []
      },
      sampleCount: 100
    };

    const unlocked = chooseAdvancedPair({ ...base, opponentLocked: false }, seededRandom(27));
    const locked = chooseAdvancedPair({ ...base, opponentLocked: true }, seededRandom(27));

    expect(unlocked.analysis.opponentPlanCount).toBe(36);
    expect(locked.analysis.opponentPlanCount).toBe(8);
  });

  it("evaluates every legal advanced discard and preserves an immediate showdown", () => {
    const hand = cards(["rock", "rock", "rock", "rock", "rock", "paper", "scissors"]);
    const discarded = chooseAdvancedDiscards(hand, 2, seededRandom(25));
    const remaining = hand.filter((card) => !discarded.includes(card.id));

    expect(discarded).toHaveLength(2);
    expect(remaining).toHaveLength(5);
    expect(remaining.every((card) => card.symbol === "rock")).toBe(true);
  });

  it("buys an advanced draw when its Bayesian value exceeds the one-HP cost", () => {
    const hand = cards(["rock", "rock", "rock", "rock", "paper", "scissors"]);
    const view = {
      playerId: "bot",
      hand,
      hp: 10,
      requiredDiscards: 1,
      deckCount: 9,
      copiesPerSymbol: 6,
      opponents: [{
        id: "opponent",
        eliminated: false,
        hp: 10,
        handCount: 3,
        memory: {
          playedHands: [{
            round: 1,
            handCount: 3,
            symbols: ["paper", "paper", "paper"] as const,
            hearts: [3, 3, 4] as const
          }],
          drawChanges: []
        }
      }],
      sampleCount: 64
    };
    const decision = chooseAdvancedDraw(view, seededRandom(71));

    expect(decision.drawProbabilities.rock).toBeCloseTo(2 / 9, 7);
    expect(decision.purchaseValue).toBeGreaterThan(decision.skipValue);
    expect(decision.purchase).toBe(true);

    const drawnHand = [...hand, { id: "new-rock", symbol: "rock" as const }];
    const discarded = chooseAdvancedTableDiscards({
      ...view,
      hand: drawnHand,
      hp: 9,
      requiredDiscards: 2,
      deckCount: 8
    }, seededRandom(72));
    const remaining = drawnHand.filter((card) => !discarded.includes(card.id));
    expect(remaining).toHaveLength(5);
    expect(remaining.every((card) => card.symbol === "rock")).toBe(true);
  });

  it("skips an advanced draw when it cannot earn back the one-HP cost", () => {
    const decision = chooseAdvancedDraw({
      playerId: "bot",
      hand: cards(["rock", "rock", "paper", "scissors"]),
      hp: 10,
      requiredDiscards: 1,
      deckCount: 11,
      copiesPerSymbol: 6,
      opponents: [{
        id: "opponent",
        eliminated: false,
        hp: 10,
        handCount: 3,
        memory: {
          playedHands: [{
            round: 1,
            handCount: 3,
            symbols: ["rock", "paper", "scissors"] as const,
            hearts: [3, 3, 4] as const
          }],
          drawChanges: []
        }
      }],
      sampleCount: 64
    }, seededRandom(73));

    expect(decision.purchaseValue).toBeLessThan(decision.skipValue);
    expect(decision.purchase).toBe(false);
  });

  it("targets a living opponent and prefers a vulnerable seat", () => {
    expect(chooseComputerTarget("bot", cards(["rock", "paper", "scissors"]), [
      { id: "bot", hp: 10, eliminated: false },
      { id: "healthy", hp: 9, eliminated: false },
      { id: "weak", hp: 2, eliminated: false },
      { id: "out", hp: 0, eliminated: true }
    ], seededRandom(2))).toBe("weak");
  });

  it("prefers a remembered hand that its own dominant symbol counters", () => {
    const rockHeavy = cards(["rock", "rock", "rock", "rock", "paper"]);
    expect(chooseComputerTarget("bot", rockHeavy, [
      { id: "bot", hp: 10, eliminated: false },
      { id: "scissors-player", hp: 10, eliminated: false, knownSymbols: ["scissors", "scissors", "paper"], turnsSinceObserved: 1 },
      { id: "paper-player", hp: 2, eliminated: false, knownSymbols: ["paper", "paper", "rock"], turnsSinceObserved: 1 }
    ], seededRandom(5))).toBe("scissors-player");
  });

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
    expect(chooseComputerDiscards(hand, 2, seededRandom(9), true)).toEqual(discarded);
  });

  it("uses a thirty-percent collection mode for a favorable four-plus-one hand", () => {
    const hand = cards(["rock", "rock", "rock", "rock", "paper", "scissors"]);
    let calls = 0;
    const collectionRoll = (): number => calls++ === 0 ? 0.29 : 0.5;
    const regularRoll = (): number => calls++ === 0 ? 0.3 : 0.5;

    const collectionDiscard = chooseComputerDiscards(hand, 1, collectionRoll);
    const collectionHand = hand.filter((card) => !collectionDiscard.includes(card.id));
    expect(collectionHand.map((card) => card.symbol).sort()).toEqual([
      "rock", "rock", "rock", "rock", "scissors"
    ]);

    calls = 0;
    const regularDiscard = chooseComputerDiscards(hand, 1, regularRoll);
    const regularHand = hand.filter((card) => !regularDiscard.includes(card.id));
    expect(regularHand.filter((card) => card.symbol === "rock")).toHaveLength(3);
    expect(new Set(regularHand.map((card) => card.symbol))).toEqual(new Set(["rock", "paper", "scissors"]));
  });

  it("changes out its dominant symbol after losing at least half its HP", () => {
    const hand = cards(["rock", "rock", "rock", "paper", "scissors"]);
    const discarded = chooseComputerDiscards(hand, 1, seededRandom(12), true);
    expect(hand.find((card) => card.id === discarded[0])?.symbol).toBe("rock");
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

  it("stakes heavily on remembered counters and lightly on vulnerable cards", () => {
    const positions = [
      { occupied: true, hearts: 3 },
      { occupied: false, hearts: 0 },
      { occupied: false, hearts: 0 }
    ];
    const emptySlots = [
      { cardId: null, hearts: 0 },
      { cardId: null, hearts: 0 },
      { cardId: null, hearts: 0 }
    ];
    const paperChoice = chooseComputerPair({
      playerId: "bot",
      hand: cards(["paper", "rock", "scissors"]),
      hp: 10,
      activeLane: 0,
      ownSlots: emptySlots,
      opponentPositions: positions,
      opponentKnownSymbols: ["rock", "rock", "rock"],
      turnsSinceObserved: 1
    }, seededRandom(6));
    const scissorsChoice = chooseComputerPair({
      playerId: "bot",
      hand: cards(["scissors", "scissors", "scissors"]),
      hp: 10,
      activeLane: 0,
      ownSlots: emptySlots,
      opponentPositions: positions,
      opponentKnownSymbols: ["rock", "rock", "rock"],
      turnsSinceObserved: 1
    }, seededRandom(6));

    expect(paperChoice.cardId).toMatch(/^paper-/);
    expect(paperChoice.hearts).toBe(5);
    expect(scissorsChoice.hearts).toBe(0);
  });

  it("commits every remaining HP to a counter after the opponent repeats one triple twice", () => {
    const hand = cards(["rock", "paper", "scissors", "paper"]);
    const choice = chooseComputerPair({
      playerId: "bot",
      hand,
      hp: 10,
      activeLane: 0,
      ownSlots: [
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 },
        { cardId: null, hearts: 0 }
      ],
      opponentPositions: [
        { occupied: true, hearts: 0 },
        { occupied: false, hearts: 0 },
        { occupied: false, hearts: 0 }
      ],
      opponentKnownSymbols: ["rock", "rock", "rock"],
      opponentRepeatedTripleSymbol: "rock",
      turnsSinceObserved: 1
    }, seededRandom(18));

    expect(hand.find((card) => card.id === choice.cardId)?.symbol).toBe("paper");
    expect(choice.hearts).toBe(10);
  });

  it("never buys an extra draw with the final HP", () => {
    const hand = cards(["rock", "rock", "rock", "rock"]);
    expect(shouldComputerPurchaseExtraDraw(hand, 1, 5, seededRandom(1))).toBe(false);
    expect(shouldComputerPurchaseExtraDraw(hand, 2, 5, seededRandom(1))).toBe(true);
    expect(shouldComputerPurchaseExtraDraw(hand, 5, 5, seededRandom(1))).toBe(true);
  });

  it("raises extra-draw willingness after a fifty-percent HP loss", () => {
    const mixedHand = cards(["rock", "paper", "scissors"]);
    const roll = () => 0.5;
    expect(shouldComputerPurchaseExtraDraw(mixedHand, 5, 5, roll, 0.49)).toBe(false);
    expect(shouldComputerPurchaseExtraDraw(mixedHand, 5, 5, roll, 0.5)).toBe(true);
    expect(shouldComputerPurchaseExtraDraw(mixedHand, 2, 5, roll, 0.8)).toBe(false);
  });
});
