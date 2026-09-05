import type {
  BotDifficulty,
  CardSymbol,
  DrawChangeMemory,
  MatchState,
  PlayedHandMemory,
  PlayerId
} from "@rps/game-core";

export interface KnownHandObservation {
  symbols: CardSymbol[];
  observedRound: number;
  tripleSymbol: CardSymbol | null;
  consecutiveTripleUses: number;
  playedHands: PlayedHandMemory[];
  drawChanges: DrawChangeMemory[];
}

export interface RecentBattleLoss {
  hpLost: number;
  lossRatio: number;
  battleRound: number;
}

export interface RoomPlayer {
  id: PlayerId;
  name: string;
  token: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  socketId: string | null;
  disconnectedAt: number | null;
}

export interface Room {
  code: string;
  hostPlayerId: PlayerId;
  players: RoomPlayer[];
  game: MatchState | null;
  knownHands: Map<PlayerId, KnownHandObservation>;
  recentBattleLosses: Map<PlayerId, RecentBattleLoss>;
  lastObservedBattleRound: number | null;
  loggedOutcomeGameId: string | null;
  createdAt: number;
  updatedAt: number;
}
