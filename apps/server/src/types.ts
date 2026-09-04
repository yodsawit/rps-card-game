import type { MatchState, PlayerId } from "@rps/game-core";

export interface RoomPlayer {
  id: PlayerId;
  name: string;
  token: string;
  isBot: boolean;
  socketId: string | null;
  disconnectedAt: number | null;
}

export interface Room {
  code: string;
  players: RoomPlayer[];
  game: MatchState | null;
  createdAt: number;
  updatedAt: number;
}
