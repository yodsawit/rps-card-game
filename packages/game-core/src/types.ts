export const CARD_SYMBOLS = ["rock", "paper", "scissors"] as const;

export type CardSymbol = (typeof CARD_SYMBOLS)[number];
export type PlayerId = string;
export type PreparationLane = 0 | 1 | 2;
export type LaneResult = "win" | "loss" | "draw";
export type MatchPhase =
  | "preparation"
  | "battle"
  | "discard"
  | "finished";

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
  lanes: [BattleLane, BattleLane, BattleLane];
  unassignedLost: [number, number];
  noLoss: [boolean, boolean];
  resultingHp: [number, number];
}

export interface GameConfig {
  startingHp: number;
  preparationMs: number;
  battleRevealMs: number;
  discardMs: number;
  reconnectMs: number;
  copiesPerSymbol: number;
  startingHandSize: number;
  maximumHandSize: number;
}

export const DEFAULT_GAME_CONFIG: Readonly<GameConfig> = {
  startingHp: 10,
  preparationMs: 20_000,
  // The client resolves the three lanes in about 4.35 seconds, then holds the
  // completed battle for five seconds before the server advances.
  battleRevealMs: 10_000,
  discardMs: 20_000,
  reconnectMs: 30_000,
  copiesPerSymbol: 5,
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
  players: [PlayerState, PlayerState];
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
