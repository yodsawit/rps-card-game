import type { Card, CardSymbol, RandomSource } from "../types.js";
import { compareSymbols as compareCombatSymbols } from "../combat.js";

export const EPSILON = 1e-9;

export const LP_INFINITY = 1e100;

export const CRITICAL_HP_RATIO = 0.5;

export const CRITICAL_HP_PRESERVATION_WEIGHT = 1.5;

export function emptyCounts(copies = 0): Record<CardSymbol, number> {
  return { rock: copies, paper: copies, scissors: copies };
}

export function cloneCounts(counts: Record<CardSymbol, number>): Record<CardSymbol, number> {
  return { rock: counts.rock, paper: counts.paper, scissors: counts.scissors };
}

export function countSymbols(symbols: readonly CardSymbol[]): Record<CardSymbol, number> {
  const result = emptyCounts();
  for (const symbol of symbols) result[symbol] += 1;
  return result;
}

export function totalCounts(counts: Record<CardSymbol, number>): number {
  return counts.rock + counts.paper + counts.scissors;
}

export function subtractSymbols(
  counts: Record<CardSymbol, number>,
  symbols: readonly CardSymbol[]
): boolean {
  for (const symbol of symbols) {
    counts[symbol] -= 1;
    if (counts[symbol] < 0) return false;
  }
  return true;
}

export function containsSymbols(hand: readonly CardSymbol[], required: readonly CardSymbol[]): boolean {
  const available = countSymbols(hand);
  const needed = countSymbols(required);
  return needed.rock <= available.rock
    && needed.paper <= available.paper
    && needed.scissors <= available.scissors;
}

export function drawSymbol(counts: Record<CardSymbol, number>, random: RandomSource): CardSymbol | null {
  const total = totalCounts(counts);
  if (total <= 0) return null;
  let roll = random() * total;
  for (const symbol of ["rock", "paper", "scissors"] as const) {
    roll -= counts[symbol];
    if (roll < 0) {
      counts[symbol] -= 1;
      return symbol;
    }
  }
  return "scissors";
}

export function drawSymbols(
  counts: Record<CardSymbol, number>,
  amount: number,
  random: RandomSource
): CardSymbol[] | null {
  const drawn: CardSymbol[] = [];
  for (let index = 0; index < amount; index += 1) {
    const symbol = drawSymbol(counts, random);
    if (!symbol) return null;
    drawn.push(symbol);
  }
  return drawn;
}

export function countKey(counts: Record<CardSymbol, number>): string {
  return `${counts.rock},${counts.paper},${counts.scissors}`;
}

export function addCounts(target: Record<CardSymbol, number>, source: Record<CardSymbol, number>): void {
  target.rock += source.rock;
  target.paper += source.paper;
  target.scissors += source.scissors;
}

export function withinCounts(value: Record<CardSymbol, number>, maximum: Record<CardSymbol, number>): boolean {
  return value.rock <= maximum.rock
    && value.paper <= maximum.paper
    && value.scissors <= maximum.scissors;
}

export function compareSymbols(left: CardSymbol, right: CardSymbol): -1 | 0 | 1 {
  const result = compareCombatSymbols(left, right);
  return result === "draw" ? 0 : result === "win" ? 1 : -1;
}

export function availableSymbols(
  counts: Record<CardSymbol, number>,
  committed: readonly (CardSymbol | null)[]
): CardSymbol[] {
  const remaining = cloneCounts(counts);
  subtractSymbols(remaining, committed.filter((symbol): symbol is CardSymbol => symbol !== null));
  return (["rock", "paper", "scissors"] as const).filter((symbol) => remaining[symbol] > 0);
}

export function chooseByProbability<T>(items: readonly T[], probabilities: readonly number[], random: RandomSource): T {
  let roll = random();
  for (let index = 0; index < items.length; index += 1) {
    roll -= probabilities[index] ?? 0;
    if (roll <= EPSILON) return items[index]!;
  }
  return items[items.length - 1]!;
}

export function isTriple(symbols: readonly (CardSymbol | null)[]): boolean {
  return symbols.length === 3 && symbols[0] !== null && symbols.every((symbol) => symbol === symbols[0]);
}

export function cardCombinations(items: readonly Card[], size: number): Card[][] {
  const result: Card[][] = [];
  const visit = (start: number, selected: Card[]): void => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      selected.push(items[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return result;
}
