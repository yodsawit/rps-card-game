import type { Card, CardSymbol, PlayerId, RandomSource } from "../types.js";
import type { AdvancedTargetView, AdvancedPairView, AdvancedPairChoice, AdvancedCurrentActionProbability } from "./types.js";
import { EPSILON, emptyCounts, cloneCounts, countSymbols, totalCounts, subtractSymbols, compareSymbols, availableSymbols, chooseByProbability } from "./common.js";
import { sampleOpponentHands, sampleAllOpponentHands } from "./sampling.js";
import { solveBayesianMaximin } from "./solver.js";
import { pairPlans, solveFullPlanMaximin } from "./plans.js";

export function chooseAdvancedTarget(
  view: AdvancedTargetView,
  random: RandomSource = Math.random
): PlayerId {
  const ownSymbols = [...new Set(view.hand.map((card) => card.symbol))];
  if (ownSymbols.length === 0) throw new Error("Advanced computer has no card available.");
  const candidates = view.opponents.filter((opponent) => !opponent.eliminated && opponent.id !== view.playerId);
  if (candidates.length === 0) throw new Error("Advanced computer has no living opponent to attack.");
  const jointDistributions = sampleAllOpponentHands({
    copiesPerSymbol: view.copiesPerSymbol,
    observerHand: view.hand,
    opponents: candidates
  }, random, view.sampleCount ?? 512);
  const valued = candidates.map((opponent) => {
    const distribution = jointDistributions.find((candidate) => candidate.id === opponent.id)!.hands;
    const types = distribution.map((sample) => ({
      probability: sample.probability,
      actions: availableSymbols(sample.counts, [])
    }));
    const equilibrium = solveBayesianMaximin(
      ownSymbols,
      types,
      (own, opposing) => compareSymbols(own, opposing)
    );
    return { opponent, value: equilibrium.value };
  });
  const bestValue = Math.max(...valued.map((candidate) => candidate.value));
  const best = valued.filter((candidate) => Math.abs(candidate.value - bestValue) <= 1e-7);
  return best[Math.floor(random() * best.length)]!.opponent.id;
}

export function chooseAdvancedPair(
  view: AdvancedPairView,
  random: RandomSource = Math.random
): AdvancedPairChoice {
  const committedIds = new Set(
    view.ownSlots.slice(0, view.activeLane).map((slot) => slot.cardId).filter((id): id is string => id !== null)
  );
  const representativeCards = new Map<CardSymbol, Card>();
  for (const card of view.hand) {
    if (!committedIds.has(card.id) && !representativeCards.has(card.symbol)) representativeCards.set(card.symbol, card);
  }
  if (representativeCards.size === 0) throw new Error("Advanced computer has no card available for this pair.");
  const tableOpponents = view.tableOpponents;
  const distribution = tableOpponents && view.opponentId
    ? sampleAllOpponentHands({
        copiesPerSymbol: view.copiesPerSymbol,
        observerHand: view.observerHand,
        opponents: tableOpponents
      }, random, view.sampleCount ?? 512).find((candidate) => candidate.id === view.opponentId)!.hands
    : sampleOpponentHands(view, random, view.sampleCount ?? 512);
  const ownPriorSymbols = view.ownSlots.slice(0, view.activeLane).map((slot) =>
    view.hand.find((card) => card.id === slot.cardId)?.symbol ?? null
  );
  const ownPriorHearts = view.ownSlots.slice(0, view.activeLane).map((slot) => slot.hearts);
  const rows = pairPlans(
    countSymbols(view.hand.map((card) => card.symbol)),
    ownPriorSymbols,
    ownPriorHearts,
    view.hp,
    { kind: "minimum", hearts: view.ownSlots[view.activeLane]?.hearts ?? 0 }
  );
  if (rows.length === 0) throw new Error("Advanced computer has no complete legal plan.");
  const revealed = [...(view.currentRevealedSymbols ?? [])].slice(0, view.activeLane);
  const opponentPriorHearts = view.opponentPositions
    .slice(0, view.activeLane)
    .map((position) => position.hearts);
  const opponentSequenceKeys = new Set<string>();
  let opponentPlanCount = 0;
  const types = distribution
    .map((sample) => {
      const actions = pairPlans(
        sample.counts,
        revealed,
        opponentPriorHearts,
        view.opponentHp,
        {
          kind: view.opponentLocked ? "exact" : "minimum",
          hearts: view.opponentPositions[view.activeLane]?.hearts ?? 0
        }
      );
      opponentPlanCount += actions.length;
      for (const action of actions) {
        opponentSequenceKeys.add(action.symbols.slice(view.activeLane).join(","));
      }
      return { probability: sample.probability, actions };
    })
    .filter((type) => type.actions.length > 0);
  const probabilityTotal = types.reduce((sum, type) => sum + type.probability, 0);
  const normalizedTypes = types.map((type) => ({ ...type, probability: type.probability / probabilityTotal }));
  if (normalizedTypes.length === 0) throw new Error("No sampled opponent hand has a complete legal plan.");
  const equilibrium = solveFullPlanMaximin(rows, normalizedTypes);
  const actionMap = new Map<string, AdvancedCurrentActionProbability>();
  for (let index = 0; index < rows.length; index += 1) {
    const probability = equilibrium.probabilities[index] ?? 0;
    if (probability <= EPSILON) continue;
    const plan = rows[index]!;
    const symbol = plan.symbols[view.activeLane]!;
    if (!symbol) continue;
    const hearts = plan.hearts[view.activeLane]!;
    const key = `${symbol}:${hearts}`;
    const previous = actionMap.get(key);
    if (previous) previous.probability += probability;
    else actionMap.set(key, { symbol, hearts, probability });
  }
  const currentActions = [...actionMap.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol) || left.hearts - right.hearts
  );
  const currentTotal = currentActions.reduce((sum, action) => sum + action.probability, 0);
  for (const action of currentActions) action.probability /= currentTotal;
  const selected = chooseByProbability(
    currentActions,
    currentActions.map((action) => action.probability),
    random
  );
  const nextCardProbabilities = emptyCounts();
  for (const sample of distribution) {
    const counts = cloneCounts(sample.counts);
    subtractSymbols(counts, revealed.filter((symbol): symbol is CardSymbol => symbol !== null));
    const total = totalCounts(counts);
    if (total <= 0) continue;
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      nextCardProbabilities[symbol] += sample.probability * counts[symbol] / total;
    }
  }
  return {
    cardId: representativeCards.get(selected.symbol)!.id,
    hearts: selected.hearts,
    equilibriumValue: equilibrium.value,
    analysis: {
      historyFallbackRate: distribution[0]?.historyFallbackRate ?? 0,
      sampledHands: distribution.map((sample) => ({
        counts: cloneCounts(sample.counts),
        samples: sample.samples,
        probability: sample.probability
      })),
      sampleCount: distribution.reduce((sum, sample) => sum + sample.samples, 0),
      nextCardProbabilities,
      ownPlanCount: rows.length,
      opponentSequenceCount: opponentSequenceKeys.size,
      opponentPlanCount,
      equilibriumIterations: equilibrium.iterations,
      currentActions
    }
  };
}
