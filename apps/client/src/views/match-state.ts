import type { MatchSnapshot } from "@rps/protocol";
import type { MatchLogView } from "./match-log.js";
export interface PokerPosition { playerId: string; x: number; y: number; }
export interface MatchViewState {
  outcomeKey(view: MatchSnapshot): string;
  activeOutcomeSequence: { key: string; startedAt: number } | null;
  clock: { elapsed(): number };
  outcomeCrownDelay(view: MatchSnapshot): number;
  completedBattleSequences: ReadonlySet<string>;
  hpBeforeBattle(view: MatchSnapshot, playerId: string): number;
  selectedCardId: string | null;
  animatedDrawCards: ReadonlySet<string>;
  drawCardKey(view: MatchSnapshot, cardId: string): string;
  matchLogOpen: boolean;
  log: MatchLogView;
}
