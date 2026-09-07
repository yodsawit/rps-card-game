import { expect, it } from "vitest";
import { solveFullPlanMaximin, solveBayesianMaximin, duelUtility } from "../src/advanced-ai.js";
import type { CardSymbol } from "../src/types.js";

it("preserves the full matrix value when removing redundant interior HP splits", () => {
  const plans = (symbols: CardSymbol[], hp: number, minimumFirst = 0) => {
    const result = [];
    for (let first = minimumFirst; first <= hp; first += 1) {
      for (let second = 0; second <= hp - first; second += 1) {
        result.push({ symbols, hearts: [first, second, hp - first - second] });
      }
    }
    return result;
  };
  for (const minimum of [0, 1, 2]) {
    const own = [...plans(["rock", "paper", "scissors"], 4, minimum), ...plans(["paper", "paper", "paper"], 4, minimum)];
    const types = [
      { probability: 0.3, actions: plans(["scissors", "rock", "paper"], 5) },
      { probability: 0.7, actions: plans(["rock", "rock", "rock"], 5) }
    ];
    const full = solveBayesianMaximin(own, types, (a, b) => duelUtility(a.symbols, a.hearts, b.symbols, b.hearts));
    const reduced = solveFullPlanMaximin(own, types);
    expect(reduced.value).toBeCloseTo(full.value, 7);
    const guaranteed = types.reduce((total, type) => total + type.probability * Math.min(...type.actions.map((opponent) =>
      own.reduce((value, plan, index) => value + reduced.probabilities[index]! * duelUtility(plan.symbols, plan.hearts, opponent.symbols, opponent.hearts), 0)
    )), 0);
    expect(guaranteed).toBeCloseTo(full.value, 7);
  }
});
