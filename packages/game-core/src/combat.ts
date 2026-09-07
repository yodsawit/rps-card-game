import type { Card, CardSymbol, LaneResult } from "./types.js";

export function compareSymbols(left: CardSymbol, right: CardSymbol): LaneResult {
  if (left === right) return "draw";
  if (
    (left === "rock" && right === "scissors")
    || (left === "scissors" && right === "paper")
    || (left === "paper" && right === "rock")
  ) return "win";
  return "loss";
}

function oppositeResult(result: LaneResult): LaneResult {
  if (result === "win") return "loss";
  if (result === "loss") return "win";
  return "draw";
}

export function laneResults(
  leftCard: Card | null,
  rightCard: Card | null,
  leftTriple: boolean,
  rightTriple: boolean
): [LaneResult, LaneResult, boolean] {
  if (!leftCard && !rightCard) return ["loss", "loss", false];
  if (!leftCard) return ["loss", "win", false];
  if (!rightCard) return ["win", "loss", false];
  const normal = compareSymbols(leftCard.symbol, rightCard.symbol);
  if (normal !== "draw") return [normal, oppositeResult(normal), false];
  if (leftTriple && !rightTriple) return ["win", "loss", true];
  if (rightTriple && !leftTriple) return ["loss", "win", true];
  return ["draw", "draw", false];
}

export function receivedHp(result: LaneResult, own: number, opposing: number): number {
  if (result === "loss") return 0;
  if (result === "draw") return own;
  return own + Math.max(opposing - 1, 0);
}
