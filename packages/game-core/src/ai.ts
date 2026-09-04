import type { BattleSlot, Card, PlayerId, PreparationLane, RandomSource } from "./types.js";

export interface PublicOpponentPosition {
  occupied: boolean;
  hearts: number;
}

export interface ComputerPreparationView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  opponentPositions: readonly PublicOpponentPosition[];
}

export interface ComputerPreparationChoice {
  cardIds: [string, string, string];
  hearts: [number, number, number];
}

export interface ComputerPairView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  activeLane: PreparationLane;
  ownSlots: readonly BattleSlot[];
  opponentPositions: readonly PublicOpponentPosition[];
}

export interface ComputerPairChoice {
  cardId: string;
  hearts: number;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, selected: T[]): void => {
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

function shuffleSmall<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function setupScore(cards: readonly Card[]): number {
  const unique = new Set(cards.map((card) => card.symbol)).size;
  if (unique === 1) return 30;
  if (unique === 3) return 20;
  return 12;
}

export function chooseComputerPreparation(
  view: ComputerPreparationView,
  random: RandomSource = Math.random
): ComputerPreparationChoice {
  if (view.hand.length < 3) throw new Error("Computer needs at least three cards.");
  const choices = combinations(view.hand, 3)
    .map((cards) => ({ cards, score: setupScore(cards) + random() * 2 }))
    .sort((left, right) => right.score - left.score);
  const selected = shuffleSmall(choices[0]!.cards, random);

  const base = Math.floor(view.hp / 3);
  const hearts = [base, base, base];
  let remainder = view.hp - base * 3;
  const order = shuffleSmall([0, 1, 2], random);
  for (const index of order) {
    if (remainder <= 0) break;
    hearts[index] = hearts[index]! + 1;
    remainder -= 1;
  }

  return {
    cardIds: [selected[0]!.id, selected[1]!.id, selected[2]!.id],
    hearts: [hearts[0]!, hearts[1]!, hearts[2]!]
  };
}

export function chooseComputerPair(
  view: ComputerPairView,
  random: RandomSource = Math.random
): ComputerPairChoice {
  const committedIds = new Set(
    view.ownSlots.slice(0, view.activeLane).map((slot) => slot.cardId).filter((id): id is string => id !== null)
  );
  const available = view.hand.filter((card) => !committedIds.has(card.id));
  if (available.length === 0) throw new Error("Computer has no card available for the current pair.");

  const previousSymbols = view.ownSlots.slice(0, view.activeLane).map((slot) =>
    view.hand.find((card) => card.id === slot.cardId)?.symbol
  );
  const firstSymbol = previousSymbols[0];
  const buildingTriple = firstSymbol !== undefined && previousSymbols.every((symbol) => symbol === firstSymbol);
  const usedSymbols = new Set(previousSymbols);
  const ranked = available
    .map((card) => ({
      card,
      score:
        (buildingTriple && card.symbol === firstSymbol ? 35 : 0)
        + (!usedSymbols.has(card.symbol) ? 16 : 0)
        + random() * 8
    }))
    .sort((left, right) => right.score - left.score);

  const committedHp = view.ownSlots
    .slice(0, view.activeLane)
    .reduce((total, slot) => total + slot.hearts, 0);
  const remainingHp = Math.max(view.hp - committedHp, 0);
  if (view.activeLane === 2) {
    return { cardId: ranked[0]!.card.id, hearts: remainingHp };
  }

  const pairsRemaining = 3 - view.activeLane;
  const baseline = Math.floor(remainingHp / pairsRemaining);
  const visibleOpponentStake = view.opponentPositions[view.activeLane]?.hearts ?? 0;
  const pressure = visibleOpponentStake > baseline ? 1 : visibleOpponentStake === 0 ? 0 : -1;
  const maximum = Math.max(remainingHp - (pairsRemaining - 1), 0);
  const hearts = Math.min(Math.max(baseline + pressure, 0), maximum);
  return { cardId: ranked[0]!.card.id, hearts };
}

export function shouldComputerPurchaseExtraDraw(
  hand: readonly Card[],
  hp: number,
  deckCount: number,
  random: RandomSource = Math.random
): boolean {
  if (hp <= 1 || deckCount <= 0) return false;
  const counts = new Map<Card["symbol"], number>();
  for (const card of hand) counts.set(card.symbol, (counts.get(card.symbol) ?? 0) + 1);
  const bestCollection = Math.max(...counts.values());
  if (bestCollection >= 4 && hp >= 3) return true;
  if (bestCollection >= 3 && hp >= 5) return random() < 0.75;
  return hp >= 8 && random() < 0.35;
}

function remainingHandScore(cards: readonly Card[]): number {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.symbol, (counts.get(card.symbol) ?? 0) + 1);
  const values = [...counts.values()].sort((a, b) => b - a);
  if (cards.length === 5 && values[0] === 5) return 10_000;
  const diversityBlock = counts.size === 3 ? 24 : 0;
  const triplePower = (values[0] ?? 0) >= 3 ? 35 : 0;
  const collection = (values[0] ?? 0) * 12 + (values[1] ?? 0) * 3;
  return diversityBlock + triplePower + collection;
}

export function chooseComputerDiscards(
  hand: readonly Card[],
  requiredDiscards: number,
  random: RandomSource = Math.random
): string[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Computer discard count is invalid.");
  }
  if (requiredDiscards === 0) return [];
  const candidates = combinations(hand, requiredDiscards).map((discarded) => {
    const ids = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !ids.has(card.id));
    return {
      discarded,
      score: remainingHandScore(remaining) + random()
    };
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]!.discarded.map((card) => card.id);
}

export function publicPositions(slots: readonly BattleSlot[]): PublicOpponentPosition[] {
  return slots.map((slot) => ({ occupied: slot.cardId !== null, hearts: slot.hearts }));
}
