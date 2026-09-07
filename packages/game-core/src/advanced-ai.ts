/** Public compatibility entry; implementation is organized by responsibility. */
export * from "./advanced/types.js";
export { sampleOpponentHands, sampleAllOpponentHands } from "./advanced/sampling.js";
export { solveBayesianMaximin } from "./advanced/solver.js";
export { solveFullPlanMaximin } from "./advanced/plans.js";
export { duelUtility } from "./advanced/utility.js";
export { chooseAdvancedTarget, chooseAdvancedPair } from "./advanced/pair.js";
export { chooseAdvancedDraw, chooseAdvancedTableDiscards, chooseAdvancedDiscards } from "./advanced/retention.js";
