export const CARD_SYMBOLS = ["rock", "paper", "scissors"] as const;

export type CardSymbol = (typeof CARD_SYMBOLS)[number];
export type BotDifficulty = "basic" | "advanced" | "learned";
export type PlayerId = string;
export type PreparationLane = 0 | 1 | 2;
export type LaneResult = "win" | "loss" | "draw";
export type MatchPhase =
  | "targeting"
  | "preparation"
  | "battle"
  | "discard"
  | "finished";

export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

export interface Card {
  readonly id: string;
  readonly symbol: CardSymbol;
}

export interface BattleSlot {
  cardId: string | null;
  hearts: number;
}

export type ThreeSlots = [BattleSlot, BattleSlot, BattleSlot];

export interface PlayerState {
  readonly id: PlayerId;
  name: string;
  isBot: boolean;
  hp: number;
  hand: Card[];
  slots: ThreeSlots;
  locked: boolean;
  requiredDiscards: number;
  discardSelection: string[];
  drawnCardIds: string[];
  extraDrawPurchased: boolean;
  noLossBonus: boolean;
  rematchRequested: boolean;
  eliminated: boolean;
}

export interface BattleSide {
  playerId: PlayerId;
  card: Card | null;
  hearts: number;
  result: LaneResult;
  receivedHp: number;
}

export interface BattleLane {
  index: number;
  sides: [BattleSide, BattleSide];
  tripleOverride: boolean;
}

export interface MatchOutcome {
  kind: "winner" | "draw";
  winnerId: PlayerId | null;
  reason: "hp" | "showdown" | "forfeit";
  showdownSymbols?: [CardSymbol | null, CardSymbol | null];
}

export interface BattleSummary {
  round: number;
  duelistIds: [PlayerId, PlayerId];
  lanes: [BattleLane, BattleLane, BattleLane];
  unassignedLost: [number, number];
  noLoss: [boolean, boolean];
  resultingHp: [number, number];
  eliminatedIds: PlayerId[];
}

export interface GameConfig {
  startingHp: number;
  preparationMs: number | null;
  targetSelectionMs: number | null;
  duelIntroMs: number;
  battleRevealMs: number;
  discardMs: number | null;
  reconnectMs: number;
  copiesPerSymbol: number;
  startingHandSize: number;
  maximumHandSize: number;
}

export const DEFAULT_GAME_CONFIG: Readonly<GameConfig> = {
  startingHp: 10,
  targetSelectionMs: 20_000,
  preparationMs: 20_000,
  duelIntroMs: 2_000,
  // The client finishes its reveal/collection sequence in about 9.35 seconds,
  // leaving roughly 3.65 seconds of static results before drawing begins.
  battleRevealMs: 13_000,
  discardMs: 20_000,
  reconnectMs: 30_000,
  copiesPerSymbol: 6,
  startingHandSize: 3,
  maximumHandSize: 5
};

export interface MatchState {
  id: string;
  round: number;
  preparationLane: PreparationLane;
  phase: MatchPhase;
  deadlineAt: number | null;
  deck: Card[];
  players: PlayerState[];
  attackerId: PlayerId;
  defenderId: PlayerId | null;
  battle: BattleSummary | null;
  outcome: MatchOutcome | null;
  config: GameConfig;
}

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  isBot?: boolean;
}

export type RandomSource = () => number;

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}
