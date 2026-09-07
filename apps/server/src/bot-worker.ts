import { parentPort } from "node:worker_threads";
import { seededRandom, type RandomSource } from "@rps/game-core";
import { computeBotDecision, type BotDecisionRequest } from "./bot-decisions.js";

let random: RandomSource | null = null;
parentPort!.on("message", ({ request, seed }: { request: BotDecisionRequest; seed: number }) => {
  try {
    random ??= seededRandom(seed);
    parentPort!.postMessage({ decision: computeBotDecision(request, random) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : "Bot calculation failed." });
  }
});
