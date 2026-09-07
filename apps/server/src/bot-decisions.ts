import {
  chooseAdvancedTarget, chooseAdvancedPair, chooseAdvancedDraw, chooseAdvancedTableDiscards,
  chooseComputerTarget, chooseComputerPair, chooseComputerDiscards, shouldComputerPurchaseExtraDraw,
  type RandomSource
} from "@rps/game-core";
import { decideLearned } from "./learned-ai.js";

const algorithms = {
  chooseAdvancedTarget, chooseAdvancedPair, chooseAdvancedDraw, chooseAdvancedTableDiscards,
  chooseComputerTarget, chooseComputerPair, chooseComputerDiscards, shouldComputerPurchaseExtraDraw,
  learned: decideLearned
};
type Method = keyof typeof algorithms;
type WithoutRandom<T extends readonly unknown[]> = {
  [K in keyof T]: Exclude<T[K], undefined> extends RandomSource ? null : T[K]
};
export type BotDecisionRequest = {
  [K in Method]: { method: K; args: WithoutRandom<Parameters<typeof algorithms[K]>> }
}[Method];
export type BotDecisionResult = ReturnType<typeof algorithms[Method]>;
export type BotTurn = Generator<BotDecisionRequest, void, BotDecisionResult>;

/** Workers receive only algorithm inputs. Rules, journals and room state stay on the server. */
export function computeBotDecision(request: BotDecisionRequest, random: RandomSource): BotDecisionResult {
  const randomIndex: Record<Method, number> = {
    chooseAdvancedTarget: 1, chooseAdvancedPair: 1, chooseAdvancedDraw: 1,
    chooseAdvancedTableDiscards: 1, chooseComputerTarget: 3, chooseComputerPair: 1,
    chooseComputerDiscards: 2, shouldComputerPurchaseExtraDraw: 3, learned: 1
  };
  const args: unknown[] = [...request.args];
  args[randomIndex[request.method]] = random;
  const algorithm = algorithms[request.method] as (...args: unknown[]) => BotDecisionResult;
  return algorithm(...args);
}
