import type { BattleSlot, Card, CardSymbol, PlayerId, PreparationLane, RandomSource } from "./types.js";

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
  opponentKnownSymbols?: readonly CardSymbol[];
  opponentRepeatedTripleSymbol?: CardSymbol;
  turnsSinceObserved?: number;
}

export interface ComputerPairChoice {
  cardId: string;
  hearts: number;
}

export interface ComputerTarget {
  id: PlayerId;
  hp: number;
  eliminated: boolean;
  knownSymbols?: readonly CardSymbol[];
  turnsSinceObserved?: number;
}

export function chooseComputerTarget(
  playerId: PlayerId,
  hand: readonly Card[],
  players: readonly ComputerTarget[],
  random: RandomSource = Math.random
): PlayerId {
  const ownCounts = countSymbols(hand.map((card) => card.symbol));
  const candidates = players
    .filter((player) => player.id !== playerId && !player.eliminated)
    .map((player) => {
      const known = countSymbols(player.knownSymbols ?? []);
      const confidence = player.knownSymbols ? memoryConfidence(player.turnsSinceObserved) : 0;
      const favorable =
        ownCounts.rock * known.scissors
        + ownCounts.paper * known.rock
        + ownCounts.scissors * known.paper;
      const dangerous =
        ownCounts.rock * known.paper
        + ownCounts.paper * known.scissors
        + ownCounts.scissors * known.rock;
      const matchupScore = (favorable * 4 - dangerous * 2) * confidence;
      const finishingScore = Math.max(10 - player.hp, 0) * 0.65;
      return { player, score: matchupScore + finishingScore + random() * 2 };
    })
    .sort((left, right) => right.score - left.score);
  if (!candidates[0]) throw new Error("Computer has no living opponent to attack.");
  return candidates[0].player.id;
}

function countSymbols(symbols: readonly CardSymbol[]): Record<CardSymbol, number> {
  const result: Record<CardSymbol, number> = { rock: 0, paper: 0, scissors: 0 };
  for (const symbol of symbols) result[symbol] += 1;
  return result;
}

function memoryConfidence(turnsSinceObserved: number | undefined): number {
  const age = Math.max(turnsSinceObserved ?? 1, 1);
  return Math.max(0.3, 1 - (age - 1) * 0.15);
}

function matchupCounts(
  symbol: CardSymbol,
  opponentSymbols: readonly CardSymbol[]
): { favorable: number; dangerous: number } {
  const known = countSymbols(opponentSymbols);
  if (symbol === "rock") return { favorable: known.scissors, dangerous: known.paper };
  if (symbol === "paper") return { favorable: known.rock, dangerous: known.scissors };
  return { favorable: known.paper, dangerous: known.rock };
}

function counterSymbol(symbol: CardSymbol): CardSymbol {
  if (symbol === "rock") return "paper";
  if (symbol === "paper") return "scissors";
  return "rock";
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
  const confidence = view.opponentKnownSymbols
    ? memoryConfidence(view.turnsSinceObserved)
    : 0;
  const repeatedTripleCounter = view.opponentRepeatedTripleSymbol
    ? counterSymbol(view.opponentRepeatedTripleSymbol)
    : null;
  const ranked = available
    .map((card) => {
      const matchup = matchupCounts(card.symbol, view.opponentKnownSymbols ?? []);
      return {
        card,
        matchup,
        score:
          (buildingTriple && card.symbol === firstSymbol ? 35 : 0)
          + (!usedSymbols.has(card.symbol) ? 16 : 0)
          + (card.symbol === repeatedTripleCounter ? 500 : 0)
          + (matchup.favorable * 12 - matchup.dangerous * 7) * confidence
          + random() * 8
      };
    })
    .sort((left, right) => right.score - left.score);

  const committedHp = view.ownSlots
    .slice(0, view.activeLane)
    .reduce((total, slot) => total + slot.hearts, 0);
  const remainingHp = Math.max(view.hp - committedHp, 0);
  if (view.activeLane === 2) {
    return { cardId: ranked[0]!.card.id, hearts: remainingHp };
  }
  if (ranked[0]!.card.symbol === repeatedTripleCounter) {
    return { cardId: ranked[0]!.card.id, hearts: remainingHp };
  }

  const pairsRemaining = 3 - view.activeLane;
  const baseline = Math.floor(remainingHp / pairsRemaining);
  const visibleOpponentStake = view.opponentPositions[view.activeLane]?.hearts ?? 0;
  const pressure = visibleOpponentStake > baseline ? 1 : visibleOpponentStake === 0 ? 0 : -1;
  const matchup = ranked[0]!.matchup;
  const memoryBias = Math.round((matchup.favorable - matchup.dangerous) * confidence);
  const maximum = Math.max(remainingHp - (pairsRemaining - 1), 0);
  const hearts = Math.min(Math.max(baseline + pressure + memoryBias, 0), maximum);
  return { cardId: ranked[0]!.card.id, hearts };
}

export function shouldComputerPurchaseExtraDraw(
  hand: readonly Card[],
  hp: number,
  deckCount: number,
  random: RandomSource = Math.random,
  recentLossRatio = 0
): boolean {
  if (hp <= 1 || deckCount <= 0) return false;
  const counts = new Map<Card["symbol"], number>();
  for (const card of hand) counts.set(card.symbol, (counts.get(card.symbol) ?? 0) + 1);
  const bestCollection = Math.max(0, ...counts.values());
  if (bestCollection >= 4 && hp >= 3) return true;
  if (recentLossRatio >= 0.5 && hp >= 3) {
    const survivalDrawChance = Math.min(0.98, 0.7 + recentLossRatio * 0.28);
    return random() < survivalDrawChance;
  }
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
  random: RandomSource = Math.random,
  survivalMode = false
): string[] {
  if (requiredDiscards < 0 || requiredDiscards > hand.length) {
    throw new Error("Computer discard count is invalid.");
  }
  if (requiredDiscards === 0) return [];
  const handCounts = new Map<CardSymbol, number>();
  for (const card of hand) handCounts.set(card.symbol, (handCounts.get(card.symbol) ?? 0) + 1);
  const largestCollection = Math.max(0, ...handCounts.values());
  const dominantSymbols = new Set(
    [...handCounts.entries()]
      .filter(([, count]) => count === largestCollection)
      .map(([symbol]) => symbol)
  );
  const candidates = combinations(hand, requiredDiscards).map((discarded) => {
    const ids = new Set(discarded.map((card) => card.id));
    const remaining = hand.filter((card) => !ids.has(card.id));
    return {
      discarded,
      score:
        remainingHandScore(remaining)
        + (survivalMode
          ? discarded.filter((card) => dominantSymbols.has(card.symbol)).length * 80
          : 0)
        + random()
    };
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]!.discarded.map((card) => card.id);
}

export function publicPositions(slots: readonly BattleSlot[]): PublicOpponentPosition[] {
  return slots.map((slot) => ({ occupied: slot.cardId !== null, hearts: slot.hearts }));
}
