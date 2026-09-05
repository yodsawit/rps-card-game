import type {
  Card,
  CardSymbol,
  BotDifficulty,
  LaneResult,
  MatchOutcome,
  MatchPhase,
  PreparationLane,
  PlayerId
} from "@rps/game-core";

export interface Success<T> {
  ok: true;
  data: T;
}

export interface Failure {
  ok: false;
  error: string;
}

export type Ack<T> = Success<T> | Failure;

export interface SessionReceipt {
  roomCode: string;
  playerId: PlayerId;
  token: string;
}

export interface PublicSlotView {
  occupied: boolean;
  hearts: number;
  symbol: CardSymbol | null;
}

export interface PublicPlayerView {
  id: PlayerId;
  seatIndex: number;
  name: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  connected: boolean;
  eliminated: boolean;
  hp: number;
  handCount: number;
  locked: boolean;
  rematchRequested: boolean;
  slots: [PublicSlotView, PublicSlotView, PublicSlotView];
}

export interface PrivatePlayerView {
  hand: Card[];
  slotCardIds: [string | null, string | null, string | null];
  drawnCardIds: string[];
  extraDrawPurchased: boolean;
  requiredDiscards: number;
  discardSelection: string[];
  noLossBonus: boolean;
}

export interface BattleSideView {
  playerId: PlayerId;
  symbol: CardSymbol | null;
  hearts: number;
  result: LaneResult;
  receivedHp: number;
}

export interface BattleLaneView {
  index: number;
  sides: [BattleSideView, BattleSideView];
  tripleOverride: boolean;
}

export interface BattleView {
  round: number;
  duelistIds: [PlayerId, PlayerId];
  lanes: [BattleLaneView, BattleLaneView, BattleLaneView];
  unassignedLost: [number, number];
  noLoss: [boolean, boolean];
  resultingHp: [number, number];
  eliminatedIds: PlayerId[];
}

export interface LobbySnapshot {
  kind: "lobby";
  roomCode: string;
  selfPlayerId: PlayerId;
  hostPlayerId: PlayerId;
  maximumSeats: number;
  players: Array<{
    id: PlayerId;
    seatIndex: number;
    name: string;
    isBot: boolean;
    botDifficulty: BotDifficulty | null;
    connected: boolean;
  }>;
}

export interface MatchSnapshot {
  kind: "match";
  roomCode: string;
  selfPlayerId: PlayerId;
  phase: MatchPhase;
  round: number;
  attackerId: PlayerId;
  defenderId: PlayerId | null;
  activeLane: PreparationLane;
  deadlineAt: number | null;
  serverNow: number;
  deckCount: number;
  players: PublicPlayerView[];
  self: PrivatePlayerView;
  battle: BattleView | null;
  outcome: MatchOutcome | null;
}

export type ServerSnapshot = LobbySnapshot | MatchSnapshot;

export interface CreateRoomPayload {
  name: string;
}

export interface RemoveBotPayload {
  playerId: PlayerId;
}

export interface AddBotPayload {
  difficulty: BotDifficulty;
}

export interface SelectTargetPayload {
  playerId: PlayerId;
}

export interface JoinRoomPayload {
  name: string;
  roomCode: string;
}

export interface ResumeRoomPayload extends SessionReceipt {}

export interface PlaceCardPayload {
  slotIndex: number;
  cardId: string;
}

export interface AdjustHeartsPayload {
  slotIndex: number;
  delta: number;
}

export interface DiscardSelectionPayload {
  cardIds: string[];
}

export interface ClientToServerEvents {
  "room:create": (
    payload: CreateRoomPayload,
    acknowledge: (result: Ack<SessionReceipt>) => void
  ) => void;
  "room:join": (
    payload: JoinRoomPayload,
    acknowledge: (result: Ack<SessionReceipt>) => void
  ) => void;
  "room:resume": (
    payload: ResumeRoomPayload,
    acknowledge: (result: Ack<SessionReceipt>) => void
  ) => void;
  "room:leave": () => void;
  "room:add-bot": (payload: AddBotPayload) => void;
  "room:remove-bot": (payload: RemoveBotPayload) => void;
  "room:start": () => void;
  "room:rematch": () => void;
  "match:target": (payload: SelectTargetPayload) => void;
  "match:place": (payload: PlaceCardPayload) => void;
  "match:hearts": (payload: AdjustHeartsPayload) => void;
  "match:discard": (payload: DiscardSelectionPayload) => void;
  "match:buy-draw": () => void;
  "match:lock": () => void;
}

export interface ServerToClientEvents {
  "state:snapshot": (snapshot: ServerSnapshot) => void;
  "state:error": (message: string) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  roomCode: string | null;
  playerId: PlayerId | null;
}
