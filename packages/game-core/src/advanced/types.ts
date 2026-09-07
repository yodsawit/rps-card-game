import type { BattleSlot, Card, CardSymbol, PlayerId, PreparationLane } from "../types.js";

export interface PlayedHandMemory {
  round: number;
  handCount: number;
  symbols: readonly [CardSymbol | null, CardSymbol | null, CardSymbol | null];
  hearts: readonly [number, number, number];
}

export interface DrawChangeMemory {
  round: number;
  drawnCount: number;
  discardedCount: number;
  handDelta: number;
  bonusDraw: boolean;
  paidDraw: boolean;
}

export interface AdvancedPublicMemory {
  playedHands: readonly PlayedHandMemory[];
  drawChanges: readonly DrawChangeMemory[];
}

export interface SampledHand {
  historyFallbackRate?: number;
  counts: Record<CardSymbol, number>;
  samples: number;
  probability: number;
}

export interface HandSamplingView {
  copiesPerSymbol: number;
  observerHand: readonly Card[];
  opponentHandCount: number;
  memory: AdvancedPublicMemory;
  currentRevealedSymbols?: readonly (CardSymbol | null)[];
}

export interface PublicOpponentSamplingView {
  id: PlayerId;
  handCount: number;
  memory: AdvancedPublicMemory;
  currentRevealedSymbols?: readonly (CardSymbol | null)[];
}

export interface JointHandSamplingView {
  copiesPerSymbol: number;
  observerHand: readonly Card[];
  opponents: readonly PublicOpponentSamplingView[];
}

export interface JointSampledHands {
  id: PlayerId;
  hands: SampledHand[];
}

export interface AdvancedTargetView {
  playerId: PlayerId;
  hand: readonly Card[];
  copiesPerSymbol: number;
  opponents: ReadonlyArray<{
    id: PlayerId;
    eliminated: boolean;
    handCount: number;
    memory: AdvancedPublicMemory;
  }>;
  sampleCount?: number;
}

export interface AdvancedShuffleOpponent extends PublicOpponentSamplingView {
  eliminated: boolean;
  hp: number;
}

export interface AdvancedShuffleView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  requiredDiscards: number;
  deckCount: number;
  copiesPerSymbol: number;
  opponents: readonly AdvancedShuffleOpponent[];
  sampleCount?: number;
}

export interface AdvancedDrawAnalysis {
  objective: "hp-maximin";
  historyFallbackRate: number;
  purchase: boolean;
  skipValue: number;
  purchaseValue: number | null;
  drawProbabilities: Record<CardSymbol, number>;
  sampleCount: number;
}

export interface AdvancedPairView extends HandSamplingView {
  playerId: PlayerId;
  hand: readonly Card[];
  hp: number;
  activeLane: PreparationLane;
  ownSlots: readonly BattleSlot[];
  opponentHp: number;
  opponentId?: PlayerId;
  opponentLocked?: boolean;
  tableOpponents?: readonly PublicOpponentSamplingView[];
  opponentPositions: ReadonlyArray<{ occupied: boolean; hearts: number }>;
  sampleCount?: number;
}

export interface AdvancedPairChoice {
  cardId: string;
  hearts: number;
  equilibriumValue: number;
  analysis: AdvancedPairAnalysis;
}

export interface AdvancedCurrentActionProbability {
  symbol: CardSymbol;
  hearts: number;
  probability: number;
}

export interface AdvancedPairAnalysis {
  historyFallbackRate: number;
  sampledHands: SampledHand[];
  sampleCount: number;
  nextCardProbabilities: Record<CardSymbol, number>;
  ownPlanCount: number;
  opponentSequenceCount: number;
  opponentPlanCount: number;
  equilibriumIterations: number;
  currentActions: AdvancedCurrentActionProbability[];
}

export interface BayesianType<TAction> {
  probability: number;
  actions: readonly TAction[];
}

export interface EquilibriumResult {
  probabilities: number[];
  value: number;
}

export interface PairPlan {
  symbols: readonly (CardSymbol | null)[];
  hearts: readonly number[];
}

export type CurrentStakeConstraint =
  | { kind: "minimum"; hearts: number }
  | { kind: "exact"; hearts: number };

export interface FullPlanEquilibrium extends EquilibriumResult {
  iterations: number;
}

export interface AdvancedRetentionModel {
  opponentTypes: BayesianType<PairPlan>[];
  historyFallbackRate: number;
  drawProbabilities: Record<CardSymbol, number>;
  sampleCount: number;
  showdownValue: number;
  handValues: Map<string, number>;
}

export interface AdvancedRetentionChoice {
  discarded: Card[];
  value: number;
}
