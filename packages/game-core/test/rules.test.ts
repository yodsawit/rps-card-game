import { describe, expect, it } from "vitest";
import {
  adjustSlotHearts,
  advanceBattle,
  advancePreparationPair,
  assertMatchInvariants,
  autoCompleteDiscards,
  autoCompletePreparationPair,
  beginPreparation,
  compareSymbols,
  countAllCards,
  createMatch,
  duelistsLocked,
  finalizeDiscards,
  forfeitPlayers,
  lockPlayer,
  purchaseExtraDraw,
  seededRandom,
  selectOpponent,
  setCardPlacement,
  setDiscardSelection,
  startDiscardPhase,
  type CardSymbol,
  type MatchState,
  type PlayerState
} from "../src/index.js";

const NOW = 1_000;

function makeMatch(seats = 2, seed = 7): MatchState {
  return createMatch(
    "match",
    Array.from({ length: seats }, (_, index) => ({ id: `p${index}`, name: `Player ${index + 1}` })),
    NOW,
    seededRandom(seed)
  );
}

function player(state: MatchState, id: string): PlayerState {
  return state.players.find((candidate) => candidate.id === id)!;
}

function startDuel(state: MatchState, defenderId = "p1"): void {
  selectOpponent(state, state.attackerId, defenderId, NOW + 1);
  beginPreparation(state, NOW + 1 + state.config.duelIntroMs);
}

function giveSymbols(
  state: MatchState,
  leftSymbols: readonly CardSymbol[],
  rightSymbols: readonly CardSymbol[]
): void {
  const [left, right] = [player(state, state.attackerId), player(state, state.defenderId!)];
  const allCards = [...state.deck, ...state.players.flatMap((candidate) => candidate.hand)];
  const reservedIds = new Set(
    state.players
      .filter((candidate) => candidate.id !== left.id && candidate.id !== right.id)
      .flatMap((candidate) => candidate.hand.map((card) => card.id))
  );
  const take = (symbol: CardSymbol) => {
    const card = allCards.find((candidate) => candidate.symbol === symbol && !reservedIds.has(candidate.id));
    if (!card) throw new Error(`No ${symbol} card remains for the test.`);
    reservedIds.add(card.id);
    return card;
  };
  left.hand = leftSymbols.map(take);
  right.hand = rightSymbols.map(take);
  state.deck = allCards.filter((card) => !reservedIds.has(card.id));
  assertMatchInvariants(state);
}

function commitLane(state: MatchState, allocations: readonly [number, number], now: number): void {
  const lane = state.preparationLane;
  const duelists = [player(state, state.attackerId), player(state, state.defenderId!)];
  for (let index = 0; index < duelists.length; index += 1) {
    const duelist = duelists[index]!;
    setCardPlacement(state, duelist.id, lane, duelist.hand[lane]!.id);
    if (lane < 2 && allocations[index]! > 0) {
      adjustSlotHearts(state, duelist.id, lane, allocations[index]!);
    }
    lockPlayer(state, duelist.id);
  }
  expect(duelistsLocked(state)).toBe(true);
  advancePreparationPair(state, now, seededRandom(now));
}

function resolveDuel(
  state: MatchState,
  leftAllocations: readonly [number, number] = [4, 3],
  rightAllocations: readonly [number, number] = [4, 3]
): void {
  commitLane(state, [leftAllocations[0], rightAllocations[0]], 2_000);
  commitLane(state, [leftAllocations[1], rightAllocations[1]], 3_000);
  commitLane(state, [0, 0], 4_000);
}

describe("RPS rules", () => {
  it.each([
    ["rock", "scissors", "win"],
    ["scissors", "paper", "win"],
    ["paper", "rock", "win"],
    ["rock", "paper", "loss"],
    ["rock", "rock", "draw"]
  ] as const)("compares %s against %s as %s", (left, right, expected) => {
    expect(compareSymbols(left, right)).toBe(expected);
  });

  it.each([2, 3, 4, 5, 6])("creates a %i-seat deck with seats + 4 copies per symbol", (seats) => {
    const state = makeMatch(seats);
    expect(state.phase).toBe("targeting");
    expect(state.attackerId).toBe("p0");
    expect(state.defenderId).toBeNull();
    expect(state.config.copiesPerSymbol).toBe(seats + 4);
    expect(state.config.duelIntroMs).toBe(2_000);
    expect(state.config.battleRevealMs).toBe(13_000);
    expect(countAllCards(state)).toBe((seats + 4) * 3);
    const allCards = [...state.deck, ...state.players.flatMap((candidate) => candidate.hand)];
    expect(["rock", "paper", "scissors"].map((symbol) =>
      allCards.filter((card) => card.symbol === symbol).length
    )).toEqual([seats + 4, seats + 4, seats + 4]);
    expect(state.players.every((candidate) => candidate.hand.length === 3)).toBe(true);
    assertMatchInvariants(state);
  });

  it("lets only the clockwise attacker choose a different living opponent", () => {
    const state = makeMatch(4);
    expect(() => selectOpponent(state, "p1", "p2", NOW)).toThrow("active attacker");
    expect(() => selectOpponent(state, "p0", "p0", NOW)).toThrow("different living opponent");

    selectOpponent(state, "p0", "p3", NOW);
    expect(state.phase).toBe("targeting");
    expect(state.defenderId).toBe("p3");
    expect(state.deadlineAt).toBe(NOW + state.config.duelIntroMs);
    expect(() => selectOpponent(state, "p0", "p2", NOW)).toThrow("already been selected");
    expect(() => setCardPlacement(state, "p0", 0, player(state, "p0").hand[0]!.id)).toThrow("preparation phase");
    beginPreparation(state, state.deadlineAt!);
    expect(state.phase).toBe("preparation");
  });

  it("makes both the card and every committed heart irreversible", () => {
    const state = makeMatch();
    startDuel(state);
    const first = player(state, "p0");
    setCardPlacement(state, "p0", 0, first.hand[0]!.id);
    setCardPlacement(state, "p0", 0, first.hand[0]!.id);
    expect(() => setCardPlacement(state, "p0", 0, first.hand[1]!.id)).toThrow("cannot be replaced");
    expect(() => setCardPlacement(state, "p0", 0, null as unknown as string)).toThrow();
    adjustSlotHearts(state, "p0", 0, 3);
    expect(() => adjustSlotHearts(state, "p0", 0, -1)).toThrow("only increase");
    expect(first.slots[0]).toMatchObject({ cardId: first.hand[0]!.id, hearts: 3 });
  });

  it("commits pairs left-to-right and puts every remaining heart on pair three", () => {
    const state = makeMatch();
    startDuel(state);
    commitLane(state, [4, 2], 2_000);
    expect(state.preparationLane).toBe(1);
    expect(player(state, "p0").locked).toBe(false);
    commitLane(state, [1, 5], 3_000);
    expect(state.preparationLane).toBe(2);
    commitLane(state, [0, 0], 4_000);

    expect(player(state, "p0").slots.map((slot) => slot.hearts)).toEqual([4, 1, 5]);
    expect(player(state, "p1").slots.map((slot) => slot.hearts)).toEqual([2, 5, 3]);
  });

  it("uses each duelist's leftmost uncommitted card on pair timeout without changing early HP", () => {
    const state = makeMatch();
    startDuel(state);
    const first = player(state, "p0");
    const second = player(state, "p1");
    const firstOrder = first.hand.map((card) => card.id);
    const secondOrder = second.hand.map((card) => card.id);

    autoCompletePreparationPair(state);
    expect(first.slots[0]).toEqual({ cardId: firstOrder[0], hearts: 0 });
    expect(second.slots[0]).toEqual({ cardId: secondOrder[0], hearts: 0 });
    advancePreparationPair(state, 2_000, seededRandom(2));

    setCardPlacement(state, first.id, 1, firstOrder[2]!);
    adjustSlotHearts(state, first.id, 1, 3);
    autoCompletePreparationPair(state);
    expect(first.slots[1]).toEqual({ cardId: firstOrder[2], hearts: 3 });
    expect(second.slots[1]).toEqual({ cardId: secondOrder[1], hearts: 0 });
    advancePreparationPair(state, 3_000, seededRandom(3));

    autoCompletePreparationPair(state);
    expect(first.slots[2]).toEqual({ cardId: firstOrder[1], hearts: 7 });
    expect(second.slots[2]).toEqual({ cardId: secondOrder[2], hearts: 10 });
  });

  it("commits the leftmost available card when a player locks an empty pair", () => {
    const state = makeMatch();
    startDuel(state);
    const duelists = [player(state, "p0"), player(state, "p1")];
    const originalOrders = duelists.map((duelist) => duelist.hand.map((card) => card.id));

    for (let lane = 0; lane < 3; lane += 1) {
      for (const duelist of duelists) lockPlayer(state, duelist.id);
      for (let playerIndex = 0; playerIndex < duelists.length; playerIndex += 1) {
        expect(duelists[playerIndex]!.slots[lane]!.cardId).toBe(originalOrders[playerIndex]![lane]);
        expect(duelists[playerIndex]!.slots[lane]!.hearts).toBe(0);
      }
      advancePreparationPair(state, 2_000 + lane, seededRandom(lane));
    }
  });

  it("transfers losing stakes minus one and returns each winner's own stake", () => {
    const state = makeMatch();
    startDuel(state);
    giveSymbols(state, ["rock", "paper", "scissors"], ["scissors", "rock", "paper"]);
    resolveDuel(state);

    expect(state.phase).toBe("finished");
    expect(state.outcome).toMatchObject({ kind: "winner", winnerId: "p0", reason: "hp" });
    expect(player(state, "p0").hp).toBe(17);
    expect(player(state, "p1").hp).toBe(0);
  });

  it("turns equal-symbol draws into wins for the sole triple player", () => {
    const state = makeMatch();
    startDuel(state);
    giveSymbols(state, ["rock", "rock", "rock"], ["rock", "paper", "scissors"]);
    resolveDuel(state);

    expect(state.battle?.lanes.map((lane) => lane.sides[0].result)).toEqual(["win", "loss", "win"]);
    expect(state.battle?.lanes[0].tripleOverride).toBe(true);
  });

  it("lets a surviving duelist draw and discard before advancing after an elimination", () => {
    const state = makeMatch(3);
    startDuel(state, "p1");
    giveSymbols(state, ["rock", "paper", "scissors"], ["scissors", "rock", "paper"]);
    resolveDuel(state);

    expect(state.phase).toBe("battle");
    expect(player(state, "p1").eliminated).toBe(true);
    expect(player(state, "p1").hand).toHaveLength(0);
    expect(countAllCards(state)).toBe(21);
    advanceBattle(state, 15_000);
    expect(state.phase).toBe("discard");
    expect(player(state, "p0").drawnCardIds.length).toBeGreaterThan(0);
    expect(player(state, "p1").drawnCardIds).toHaveLength(0);
    expect(player(state, "p1").locked).toBe(true);
    autoCompleteDiscards(state);
    finalizeDiscards(state, 16_000, seededRandom(8));
    expect(state.phase).toBe("targeting");
    expect(state.attackerId).toBe("p2");
    expect(state.defenderId).toBeNull();
    assertMatchInvariants(state);
  });

  it("declares a draw when both final players reach zero HP", () => {
    const state = makeMatch();
    startDuel(state);
    for (const duelist of state.players) duelist.hp = 0;
    resolveDuel(state, [0, 0], [0, 0]);
    expect(state.outcome).toMatchObject({ kind: "draw", winnerId: null, reason: "hp" });
  });

  it("draws and discards only for the two active duelists", () => {
    const state = makeMatch(3);
    startDuel(state, "p2");
    giveSymbols(state, ["rock", "paper", "scissors"], ["paper", "rock", "scissors"]);
    const spectatorHand = player(state, "p1").hand.map((card) => card.id);
    resolveDuel(state);
    expect(state.phase).toBe("battle");
    startDiscardPhase(state, 12_000);

    expect(player(state, "p0").drawnCardIds.length).toBeGreaterThan(0);
    expect(player(state, "p2").drawnCardIds.length).toBeGreaterThan(0);
    expect(player(state, "p1").hand.map((card) => card.id)).toEqual(spectatorHand);
    autoCompleteDiscards(state);
    finalizeDiscards(state, 13_000, seededRandom(1));
    expect(state.phase).toBe("targeting");
    expect(state.attackerId).toBe("p1");
    expect(player(state, "p1").hand.map((card) => card.id)).toEqual(spectatorHand);
    assertMatchInvariants(state);
  });

  it("charges one HP and one extra discard for the optional extra draw", () => {
    const state = makeMatch();
    startDuel(state);
    giveSymbols(state, ["rock", "paper", "scissors"], ["paper", "rock", "scissors"]);
    resolveDuel(state);
    advanceBattle(state, 12_000);
    const first = player(state, "p0");
    const hpBefore = first.hp;
    const discardBefore = first.requiredDiscards;
    const drawn = purchaseExtraDraw(state, "p0");

    expect(first.hp).toBe(hpBefore - 1);
    expect(first.requiredDiscards).toBe(discardBefore + 1);
    expect(first.drawnCardIds).toContain(drawn.id);
    expect(() => purchaseExtraDraw(state, "p0")).toThrow("already been purchased");
  });

  it("forfeits one group seat without ending a three-player match", () => {
    const state = makeMatch(3);
    forfeitPlayers(state, ["p2"], 2_000, seededRandom(2));
    expect(state.phase).toBe("targeting");
    expect(player(state, "p2").eliminated).toBe(true);
    expect(player(state, "p2").hand).toHaveLength(0);
    expect(state.outcome).toBeNull();
    assertMatchInvariants(state);
  });

  it("requires exact discard selection before a player can lock", () => {
    const state = makeMatch();
    startDuel(state);
    giveSymbols(state, ["rock", "paper", "scissors"], ["paper", "rock", "scissors"]);
    resolveDuel(state);
    if (state.phase === "finished") throw new Error("Test duel unexpectedly ended the match.");
    advanceBattle(state, 12_000);
    const first = player(state, "p0");
    expect(() => lockPlayer(state, first.id)).toThrow("required discard");
    setDiscardSelection(state, first.id, first.hand.slice(0, first.requiredDiscards).map((card) => card.id));
    lockPlayer(state, first.id);
    expect(first.locked).toBe(true);
  });
});
