import type {
  BotDifficulty,
  CardSymbol,
  DrawChangeMemory,
  MatchState,
  PlayedHandMemory,
  PlayerId
} from "@rps/game-core";
import type { ActionTimeLimit, MatchRoundLogView } from "@rps/protocol";

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
  actionTimeMs: ActionTimeLimit;
  players: RoomPlayer[];
  game: MatchState | null;
  knownHands: Map<PlayerId, KnownHandObservation>;
  recentBattleLosses: Map<PlayerId, RecentBattleLoss>;
  lastObservedBattleRound: number | null;
  loggedOutcomeGameId: string | null;
  matchLog: MatchRoundLogView[];
  createdAt: number;
  updatedAt: number;
}
