import type { CardSymbol } from "../types.js";
import type { BayesianType, PairPlan, CurrentStakeConstraint, FullPlanEquilibrium } from "./types.js";
import { EPSILON, cloneCounts, subtractSymbols } from "./common.js";
import { solveBayesianMaximin } from "./solver.js";
import { duelUtility } from "./utility.js";

export function orderedSymbolSequences(
  counts: Record<CardSymbol, number>,
  length: number
): CardSymbol[][] {
  const sequences: CardSymbol[][] = [];
  const selected: CardSymbol[] = [];
  const visit = (): void => {
    if (selected.length === length) {
      sequences.push([...selected]);
      return;
    }
    for (const symbol of ["rock", "paper", "scissors"] as const) {
      if (counts[symbol] <= 0) continue;
      counts[symbol] -= 1;
      selected.push(symbol);
      visit();
      selected.pop();
      counts[symbol] += 1;
    }
  };
  visit();
  return sequences;
}

export function heartDistributions(total: number, length: number, minimumFirst: number): number[][] {
  if (length === 0) return total === 0 ? [[]] : [];
  if (length === 1) return total >= minimumFirst ? [[total]] : [];
  const distributions: number[][] = [];
  for (let first = minimumFirst; first <= total; first += 1) {
    for (const rest of heartDistributions(total - first, length - 1, 0)) {
      distributions.push([first, ...rest]);
    }
  }
  return distributions;
}

export function constrainedHeartDistributions(
  total: number,
  length: number,
  constraint: CurrentStakeConstraint
): number[][] {
  if (constraint.kind === "minimum") {
    return heartDistributions(total, length, constraint.hearts);
  }
  if (length <= 0 || constraint.hearts < 0 || constraint.hearts > total) return [];
  return heartDistributions(total - constraint.hearts, length - 1, 0)
    .map((rest) => [constraint.hearts, ...rest]);
}

export function pairPlans(
  handCounts: Record<CardSymbol, number>,
  priorSymbols: readonly (CardSymbol | null)[],
  priorHearts: readonly number[],
  hp: number,
  currentStake: CurrentStakeConstraint
): PairPlan[] {
  const remainingCounts = cloneCounts(handCounts);
  if (!subtractSymbols(
    remainingCounts,
    priorSymbols.filter((symbol): symbol is CardSymbol => symbol !== null)
  )) return [];
  const remainingLanes = 3 - priorSymbols.length;
  const remainingHp = hp - priorHearts.reduce((sum, hearts) => sum + hearts, 0);
  if (remainingLanes <= 0 || remainingHp < currentStake.hearts) return [];
  const sequences = orderedSymbolSequences(remainingCounts, remainingLanes);
  const distributions = constrainedHeartDistributions(remainingHp, remainingLanes, currentStake);
  return sequences.flatMap((sequence) => distributions.map((hearts) => ({
    symbols: [...priorSymbols, ...sequence],
    hearts: [...priorHearts, ...hearts]
  })));
}

/** Within a fixed symbol sequence and zero/nonzero stake pattern, every
 * payoff is affine in HP (the only kink is max(stake - 1, 0)). Interior
 * integer splits are convex mixtures of these vertices. Removing them from
 * the LP preserves the exact value; all legal plans are still enumerated. */

export function equivalentExtremePlans(plans: readonly PairPlan[]): PairPlan[] {
  const groups = new Map<string, PairPlan[]>();
  for (const plan of plans) {
    const key = `${plan.symbols.join(",")}:${plan.hearts.map((hp) => Number(hp > 0)).join("")}`;
    const group = groups.get(key);
    if (group) group.push(plan);
    else groups.set(key, [plan]);
  }
  return [...groups.values()].flatMap((group) => {
    const minimum = [0, 1, 2].map((lane) => group.reduce((min, plan) => Math.min(min, plan.hearts[lane]!), Infinity));
    return group.filter((plan) => plan.hearts.filter((hp, lane) => hp > minimum[lane]!).length <= 1);
  });
}

export function solveFullPlanMaximin(
  rows: readonly PairPlan[],
  types: readonly BayesianType<PairPlan>[]
): FullPlanEquilibrium {
  const originalRows = rows;
  rows = equivalentExtremePlans(rows);
  const merged = new Map<string, BayesianType<PairPlan>>();
  for (const type of types) {
    const actions = equivalentExtremePlans(type.actions);
    const key = actions.map((plan) => `${plan.symbols.join(",")}:${plan.hearts.join(",")}`).sort().join(";");
    const previous = merged.get(key);
    if (previous) previous.probability += type.probability;
    else merged.set(key, { probability: type.probability, actions });
  }
  types = [...merged.values()];
  const payoffs = new Map<PairPlan, Map<PairPlan, number>>();
  const payoff = (own: PairPlan, opposing: PairPlan): number => {
    let row = payoffs.get(own);
    if (!row) { row = new Map(); payoffs.set(own, row); }
    const cached = row.get(opposing);
    if (cached !== undefined) return cached;
    const value = duelUtility(own.symbols, own.hearts, opposing.symbols, opposing.hearts);
    row.set(opposing, value);
    return value;
  };
  const expand = (result: FullPlanEquilibrium): FullPlanEquilibrium => {
    const probabilities = new Map(rows.map((row, index) => [row, result.probabilities[index]!]));
    return { ...result, probabilities: originalRows.map((row) => probabilities.get(row) ?? 0) };
  };
  const restricted = types.map((type) => [type.actions[0]!]);
  const restrictedSets = restricted.map((actions) => new Set(actions));
  const maximumIterations = types.reduce((sum, type) => sum + type.actions.length, 0) + 1;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const equilibrium = solveBayesianMaximin(
      rows,
      types.map((type, index) => ({ probability: type.probability, actions: restricted[index]! })),
      payoff
    );
    const support = equilibrium.probabilities
      .map((probability, index) => ({ probability, plan: rows[index]! }))
      .filter(({ probability }) => probability > EPSILON);
    let lowerBound = 0;
    const missingWorstResponses: Array<{ typeIndex: number; plan: PairPlan }> = [];
    for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
      const type = types[typeIndex]!;
      let worstPlan = type.actions[0]!;
      let worstValue = Number.POSITIVE_INFINITY;
      for (const opposing of type.actions) {
        const value = support.reduce((sum, own) => sum + own.probability
          * payoff(own.plan, opposing), 0);
        if (value < worstValue - EPSILON) {
          worstValue = value;
          worstPlan = opposing;
        }
      }
      lowerBound += type.probability * worstValue;
      if (!restrictedSets[typeIndex]!.has(worstPlan)) {
        missingWorstResponses.push({ typeIndex, plan: worstPlan });
      }
    }
    if (equilibrium.value - lowerBound <= 1e-7) {
      return expand({ ...equilibrium, iterations: iteration });
    }
    if (missingWorstResponses.length === 0) {
      if (equilibrium.value - lowerBound <= 1e-6) {
        return expand({ ...equilibrium, iterations: iteration });
      }
      throw new Error("The full-plan equilibrium stopped before reaching its lower bound.");
    }
    for (const response of missingWorstResponses) {
      restricted[response.typeIndex]!.push(response.plan);
      restrictedSets[response.typeIndex]!.add(response.plan);
    }
  }
  throw new Error("The full-plan equilibrium did not converge.");
}
