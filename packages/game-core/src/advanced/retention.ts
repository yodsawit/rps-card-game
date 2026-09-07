import type { Card, CardSymbol, RandomSource } from "../types.js";
import type { AdvancedShuffleView, AdvancedDrawAnalysis, BayesianType, PairPlan, AdvancedRetentionModel, AdvancedRetentionChoice } from "./types.js";
import { EPSILON, CRITICAL_HP_PRESERVATION_WEIGHT, emptyCounts, cloneCounts, countSymbols, totalCounts, countKey, compareSymbols, cardCombinations } from "./common.js";
import { sampleAllOpponentHands } from "./sampling.js";
import { solveBayesianMaximin } from "./solver.js";
import { pairPlans, solveFullPlanMaximin } from "./plans.js";

export function buildAdvancedRetentionModel(
  view: AdvancedShuffleView,
  random: RandomSource
): AdvancedRetentionModel {
  const sampled = sampleAllOpponentHands({
    copiesPerSymbol: view.copiesPerSymbol,
    observerHand: view.hand,
    opponents: view.opponents.map((opponent) => ({
      id: opponent.id,
      handCount: opponent.handCount,
      memory: opponent.memory,
      ...(opponent.currentRevealedSymbols
        ? { currentRevealedSymbols: opponent.currentRevealedSymbols }
        : {})
    }))
  }, random, view.sampleCount ?? 512);
  const expectedHeld = emptyCounts();
  for (const opponent of sampled) {
    for (const hand of opponent.hands) {
      expectedHeld.rock += hand.counts.rock * hand.probability;
      expectedHeld.paper += hand.counts.paper * hand.probability;
      expectedHeld.scissors += hand.counts.scissors * hand.probability;
    }
  }
  const ownCounts = countSymbols(view.hand.map((card) => card.symbol));
  const estimatedDeck = emptyCounts();
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    estimatedDeck[symbol] = Math.max(view.copiesPerSymbol - ownCounts[symbol] - expectedHeld[symbol], 0);
  }
  const estimatedDeckTotal = totalCounts(estimatedDeck);
  const drawProbabilities = emptyCounts();
  if (estimatedDeckTotal > EPSILON) {
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      drawProbabilities[symbol] = estimatedDeck[symbol] / estimatedDeckTotal;
    }
  }

  const activeOpponentIds = new Set(
    view.opponents.filter((opponent) => !opponent.eliminated).map((opponent) => opponent.id)
  );
  const activeOpponentCount = Math.max(activeOpponentIds.size, 1);
  const opponentCounts = new Map<string, { counts: Record<CardSymbol, number>; probability: number; hp: number }>();
  for (const opponent of sampled) {
    if (!activeOpponentIds.has(opponent.id)) continue;
    for (const hand of opponent.hands) {
      const hp = view.opponents.find((candidate) => candidate.id === opponent.id)!.hp;
      const key = `${countKey(hand.counts)}:${hp}`;
      const probability = hand.probability / activeOpponentCount;
      const previous = opponentCounts.get(key);
      if (previous) previous.probability += probability;
      else opponentCounts.set(key, { counts: cloneCounts(hand.counts), probability, hp });
    }
  }
  let opponentTypes: BayesianType<PairPlan>[] = [...opponentCounts.values()]
    .map(({ counts, probability, hp }) => ({
      probability,
      actions: pairPlans(counts, [], [], hp, { kind: "minimum", hearts: 0 })
    }))
    .filter((type) => type.actions.length > 0);
  if (opponentTypes.length === 0) {
    opponentTypes = [{
      probability: 1,
      actions: pairPlans(emptyCounts(3), [], [], view.opponents[0]?.hp ?? 10, { kind: "minimum", hearts: 0 })
    }];
  } else {
    const probabilityTotal = opponentTypes.reduce((sum, type) => sum + type.probability, 0);
    opponentTypes = opponentTypes.map((type) => ({
      ...type,
      probability: type.probability / probabilityTotal
    }));
  }

  return {
    opponentTypes,
    historyFallbackRate: sampled[0]?.hands[0]?.historyFallbackRate ?? 0,
    drawProbabilities,
    sampleCount: sampled[0]?.hands.reduce((sum, hand) => sum + hand.samples, 0) ?? 0,
    // Strict upper bound on every possible nonterminal HP payoff.
    showdownValue: Math.max(2, view.copiesPerSymbol - 4) * 10 * CRITICAL_HP_PRESERVATION_WEIGHT + 1,
    handValues: new Map()
  };
}

export function retainedHandValue(
  hand: readonly Card[],
  hp: number,
  model: AdvancedRetentionModel
): number {
  const showdown = hand.length === 5
    && hand[0] !== undefined
    && hand.every((card) => card.symbol === hand[0]!.symbol);
  if (showdown) return model.showdownValue;
  const counts = countSymbols(hand.map((card) => card.symbol));
  const key = `${countKey(counts)}:${hp}`;
  const cached = model.handValues.get(key);
  if (cached !== undefined) return cached;
  const ownPlans = pairPlans(counts, [], [], hp, { kind: "minimum", hearts: 0 });
  const equilibrium = ownPlans.length === 0
    ? -model.showdownValue
    : solveFullPlanMaximin(ownPlans, model.opponentTypes).value;
  model.handValues.set(key, equilibrium);
  return equilibrium;
}

export function bestAdvancedRetention(
  hand: readonly Card[],
  requiredDiscards: number,
  hp: number,
  model: AdvancedRetentionModel
): AdvancedRetentionChoice[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Advanced computer discard count is invalid.");
  }
  const candidates = cardCombinations(hand, requiredDiscards).map((discarded) => {
    const discardedIds = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !discardedIds.has(card.id));
    return { discarded, value: retainedHandValue(remaining, hp, model) };
  });
  const bestValue = Math.max(...candidates.map((candidate) => candidate.value));
  return candidates.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
}

export function chooseAdvancedDraw(
  view: AdvancedShuffleView,
  random: RandomSource = Math.random
): AdvancedDrawAnalysis {
  const model = buildAdvancedRetentionModel(view, random);
  const skipChoices = bestAdvancedRetention(view.hand, view.requiredDiscards, view.hp, model);
  const skipValue = skipChoices[0]!.value;
  if (view.hp <= 1 || view.deckCount <= 0) {
    return {
      purchase: false,
      objective: "hp-maximin",
      historyFallbackRate: model.historyFallbackRate,
      skipValue,
      purchaseValue: null,
      drawProbabilities: cloneCounts(model.drawProbabilities),
      sampleCount: model.sampleCount
    };
  }
  let purchaseValue = 0;
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    const probability = model.drawProbabilities[symbol];
    if (probability <= EPSILON) continue;
    const drawnCard: Card = { id: `advanced-draw-${symbol}`, symbol };
    const choices = bestAdvancedRetention(
      [...view.hand, drawnCard],
      view.requiredDiscards + 1,
      view.hp - 1,
      model
    );
    purchaseValue += probability * choices[0]!.value;
  }
  return {
    purchase: purchaseValue > skipValue + EPSILON,
    objective: "hp-maximin",
    historyFallbackRate: model.historyFallbackRate,
    skipValue,
    purchaseValue,
    drawProbabilities: cloneCounts(model.drawProbabilities),
    sampleCount: model.sampleCount
  };
}

export function chooseAdvancedTableDiscards(
  view: AdvancedShuffleView,
  random: RandomSource = Math.random
): string[] {
  const model = buildAdvancedRetentionModel(view, random);
  const best = bestAdvancedRetention(view.hand, view.requiredDiscards, view.hp, model);
  return best[Math.floor(random() * best.length)]!.discarded.map((card) => card.id);
}

export function chooseAdvancedDiscards(
  hand: readonly Card[],
  requiredDiscards: number,
  random: RandomSource = Math.random
): string[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Advanced computer discard count is invalid.");
  }
  if (requiredDiscards === 0) return [];
  const candidates = cardCombinations(hand, requiredDiscards).map((discarded) => {
    const ids = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !ids.has(card.id));
    const showdown = remaining.length === 5
      && remaining[0] !== undefined
      && remaining.every((card) => card.symbol === remaining[0]!.symbol);
    if (showdown) return { discarded, value: 2 };
    const ownSymbols = [...new Set(remaining.map((card) => card.symbol))];
    const value = solveBayesianMaximin(
      ownSymbols,
      [{ probability: 1, actions: ["rock", "paper", "scissors"] as const }],
      (own, opposing) => compareSymbols(own, opposing)
    ).value;
    return { discarded, value };
  });
  const bestValue = Math.max(...candidates.map((candidate) => candidate.value));
  const best = candidates.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
  return best[Math.floor(random() * best.length)]!.discarded.map((card) => card.id);
}
