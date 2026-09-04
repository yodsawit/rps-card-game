import { describe, expect, it } from "vitest";
import {
  adjustSlotHearts,
  advancePreparationPair,
  allPlayersLocked,
  assertMatchInvariants,
  autoCompleteDiscards,
  compareSymbols,
  createMatch,
  finalizeDiscards,
  lockPlayer,
  purchaseExtraDraw,
  seededRandom,
  setCardPlacement,
  setDiscardSelection,
  startDiscardPhase,
  type MatchState
} from "../src/index.js";

function match(seed = 7): MatchState {
  return createMatch(
    "test",
    [
      { id: "left", name: "Left" },
      { id: "right", name: "Right" }
    ],
    1_000,
    seededRandom(seed)
  );
}

function giveSymbols(state: MatchState, left: string[], right: string[]): void {
  const allCards = [...state.deck, ...state.players.flatMap((player) => player.hand)];
  const used = new Set<string>();
  const take = (symbol: string) => {
    const card = allCards.find((candidate) => candidate.symbol === symbol && !used.has(candidate.id));
    if (!card) throw new Error(`Missing ${symbol}`);
    used.add(card.id);
    return card;
  };
  state.players[0].hand = left.map(take);
  state.players[1].hand = right.map(take);
  state.deck = allCards.filter((card) => !used.has(card.id));
}

function prepareAll(
  state: MatchState,
  leftHearts: [number, number],
  rightHearts: [number, number],
  now = 2_000
) {
  let battle = null;
  for (let lane = 0; lane < 3; lane += 1) {
    for (const playerIndex of [0, 1] as const) {
      const player = state.players[playerIndex];
      setCardPlacement(state, player.id, lane, player.hand[lane]!.id);
      const hearts = playerIndex === 0 ? leftHearts[lane] : rightHearts[lane];
      if (lane < 2 && hearts) adjustSlotHearts(state, player.id, lane, hearts);
      lockPlayer(state, player.id);
    }
    battle = advancePreparationPair(state, now + lane);
  }
  if (!battle) throw new Error("Preparation did not resolve after the third pair.");
  return battle;
}

describe("RPS comparison", () => {
  it.each([
    ["rock", "scissors", "win"],
    ["scissors", "paper", "win"],
    ["paper", "rock", "win"],
    ["rock", "paper", "loss"],
    ["rock", "rock", "draw"]
  ] as const)("resolves %s against %s", (left, right, expected) => {
    expect(compareSymbols(left, right)).toBe(expected);
  });
});

describe("battle resolution", () => {
  it("transfers loser HP minus one and burns unassigned HP", () => {
    const state = match();
    giveSymbols(state, ["rock", "paper", "scissors"], ["scissors", "paper", "paper"]);
    const battle = prepareAll(state, [4, 3], [3, 2]);

    expect(battle.lanes.map((lane) => lane.sides[0].result)).toEqual(["win", "draw", "win"]);
    expect(battle.unassignedLost).toEqual([0, 0]);
    expect(battle.resultingHp).toEqual([16, 2]);
    expect(state.players.map((player) => player.hp)).toEqual([16, 2]);
    expect(state.phase).toBe("battle");
    expect(state.deadlineAt).toBe(12_002);
    assertMatchInvariants(state);
  });

  it("turns a triple's matching pair into a win", () => {
    const state = match();
    giveSymbols(state, ["rock", "rock", "rock"], ["rock", "paper", "scissors"]);
    const battle = prepareAll(state, [4, 3], [4, 3]);

    expect(battle.lanes.map((lane) => lane.sides[0].result)).toEqual(["win", "loss", "win"]);
    expect(battle.lanes[0].tripleOverride).toBe(true);
  });

  it("counts two empty positions as losses for both", () => {
    const state = match();
    let battle = null;
    for (let lane = 0; lane < 3; lane += 1) {
      lockPlayer(state, "left");
      lockPlayer(state, "right");
      battle = advancePreparationPair(state, 2_000 + lane);
    }
    if (!battle) throw new Error("Empty preparation did not resolve.");

    expect(battle.lanes.every((lane) => lane.sides[0].result === "loss")).toBe(true);
    expect(battle.lanes.every((lane) => lane.sides[1].result === "loss")).toBe(true);
    expect(state.outcome).toEqual({ kind: "draw", winnerId: null, reason: "hp" });
  });

  it("allows both players to lock preparation early", () => {
    const state = match();
    lockPlayer(state, "left");
    expect(allPlayersLocked(state)).toBe(false);
    lockPlayer(state, "right");
    expect(allPlayersLocked(state)).toBe(true);
    advancePreparationPair(state, 1_100);
    expect(state.preparationLane).toBe(1);
    expect(state.players.every((player) => !player.locked)).toBe(true);
  });

  it("locks prior pairs and assigns every remaining HP to the final pair", () => {
    const state = match();
    const [left, right] = state.players;
    setCardPlacement(state, left.id, 0, left.hand[0]!.id);
    setCardPlacement(state, right.id, 0, right.hand[0]!.id);
    adjustSlotHearts(state, left.id, 0, 6);
    adjustSlotHearts(state, right.id, 0, 2);
    lockPlayer(state, left.id);
    lockPlayer(state, right.id);
    advancePreparationPair(state, 2_000);

    expect(() => setCardPlacement(state, left.id, 0, left.hand[1]!.id)).toThrow(/current battle pair/i);
    setCardPlacement(state, left.id, 1, left.hand[1]!.id);
    setCardPlacement(state, right.id, 1, right.hand[1]!.id);
    adjustSlotHearts(state, left.id, 1, 1);
    adjustSlotHearts(state, right.id, 1, 3);
    lockPlayer(state, left.id);
    lockPlayer(state, right.id);
    advancePreparationPair(state, 2_100);

    setCardPlacement(state, left.id, 2, left.hand[2]!.id);
    setCardPlacement(state, right.id, 2, right.hand[2]!.id);
    expect(left.slots[2].hearts).toBe(3);
    expect(right.slots[2].hearts).toBe(5);
    expect(() => adjustSlotHearts(state, left.id, 2, 1)).toThrow(/automatically/i);
  });

  it("awards no enemy HP when the loser risked one or less", () => {
    const state = match();
    giveSymbols(state, ["rock", "paper", "scissors"], ["scissors", "rock", "paper"]);
    const battle = prepareAll(state, [10, 0], [1, 9]);

    expect(battle.lanes[0].sides[0].receivedHp).toBe(10);
    expect(battle.lanes[2].sides[0].receivedHp).toBe(0);
  });
});

describe("discard phase", () => {
  it("draws for both players before returning and shuffling discards", () => {
    const state = match(12);
    giveSymbols(state, ["rock", "paper", "scissors"], ["rock", "paper", "scissors"]);
    prepareAll(state, [4, 3], [4, 3]);
    expect(state.players.every((player) => player.noLossBonus)).toBe(true);

    startDiscardPhase(state, 7_000);

    expect(state.players.map((player) => player.hand.length)).toEqual([5, 5]);
    expect(state.players.map((player) => player.requiredDiscards)).toEqual([1, 1]);
    expect(state.deck).toHaveLength(5);
    setDiscardSelection(state, "left", [state.players[0].hand[4]!.id]);
    setDiscardSelection(state, "right", [state.players[1].hand[4]!.id]);
    lockPlayer(state, "left");
    lockPlayer(state, "right");
    finalizeDiscards(state, 8_000, seededRandom(5));

    expect(state.phase).toBe("preparation");
    expect(state.players.map((player) => player.hand.length)).toEqual([4, 4]);
    expect(state.deck).toHaveLength(7);
    assertMatchInvariants(state);
  });

  it("auto-discards newest draws on timeout", () => {
    const state = match(18);
    giveSymbols(state, ["rock", "paper", "scissors"], ["rock", "paper", "scissors"]);
    prepareAll(state, [4, 3], [4, 3]);
    startDiscardPhase(state, 7_000);
    const newest = state.players.map((player) => player.drawnCardIds.at(-1));

    autoCompleteDiscards(state);

    expect(state.players.map((player) => player.discardSelection[0])).toEqual(newest);
    expect(allPlayersLocked(state)).toBe(true);
  });

  it("spends one HP for one extra draw and one extra required discard", () => {
    const state = match(31);
    giveSymbols(state, ["rock", "paper", "scissors"], ["rock", "paper", "scissors"]);
    prepareAll(state, [4, 3], [4, 3]);
    startDiscardPhase(state, 7_000);
    const player = state.players[0];
    const before = {
      hp: player.hp,
      hand: player.hand.length,
      deck: state.deck.length,
      required: player.requiredDiscards,
      draws: player.drawnCardIds.length
    };

    const card = purchaseExtraDraw(state, player.id);

    expect(player.hp).toBe(before.hp - 1);
    expect(player.hand).toHaveLength(before.hand + 1);
    expect(state.deck).toHaveLength(before.deck - 1);
    expect(player.requiredDiscards).toBe(before.required + 1);
    expect(player.drawnCardIds).toHaveLength(before.draws + 1);
    expect(player.drawnCardIds.at(-1)).toBe(card.id);
    expect(player.extraDrawPurchased).toBe(true);
    expect(() => purchaseExtraDraw(state, player.id)).toThrow(/already been purchased/i);
    assertMatchInvariants(state);
  });

  it("does not allow the extra draw to spend a player's final HP", () => {
    const state = match(32);
    state.phase = "discard";
    state.players[0].hp = 1;
    const handSize = state.players[0].hand.length;
    const deckSize = state.deck.length;

    expect(() => purchaseExtraDraw(state, "left")).toThrow(/at least 2 HP/i);
    expect(state.players[0].hp).toBe(1);
    expect(state.players[0].hand).toHaveLength(handSize);
    expect(state.deck).toHaveLength(deckSize);
  });

  it("resolves simultaneous five-of-a-kind with normal RPS", () => {
    const state = match(22);
    const allCards = [...state.deck, ...state.players.flatMap((player) => player.hand)];
    const rocks = allCards.filter((card) => card.symbol === "rock");
    const papers = allCards.filter((card) => card.symbol === "paper");
    const scissors = allCards.filter((card) => card.symbol === "scissors");
    state.players[0].hand = [...rocks, papers[0]!];
    state.players[1].hand = [...scissors, papers[1]!];
    state.deck = papers.slice(2);
    state.phase = "discard";
    state.players[0].requiredDiscards = 1;
    state.players[1].requiredDiscards = 1;
    state.players[0].discardSelection = [papers[0]!.id];
    state.players[1].discardSelection = [papers[1]!.id];
    state.players[0].locked = true;
    state.players[1].locked = true;

    const outcome = finalizeDiscards(state, 9_000, seededRandom(1));

    expect(outcome).toMatchObject({ kind: "winner", winnerId: "left", reason: "showdown" });
    expect(state.deck).toHaveLength(5);
    assertMatchInvariants(state);
  });
});
