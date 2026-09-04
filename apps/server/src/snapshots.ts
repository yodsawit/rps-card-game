import type { BattleSummary, MatchState, PlayerState } from "@rps/game-core";
import type {
  BattleView,
  LobbySnapshot,
  MatchSnapshot,
  PublicPlayerView,
  ServerSnapshot
} from "@rps/protocol";
import type { Room, RoomPlayer } from "./types.js";

function connected(room: Room, playerId: string): boolean {
  const record = room.players.find((player) => player.id === playerId);
  return record?.isBot === true || record?.socketId !== null;
}

function publicPlayer(
  room: Room,
  game: MatchState,
  player: PlayerState,
  viewerId: string
): PublicPlayerView {
  return {
    id: player.id,
    name: player.name,
    isBot: player.isBot,
    connected: connected(room, player.id),
    hp: player.hp,
    handCount: player.hand.length,
    locked: player.locked,
    rematchRequested: player.rematchRequested,
    slots: player.slots.map((slot, slotIndex) => {
      const card = player.hand.find((candidate) => candidate.id === slot.cardId);
      const maySeePlacedSymbol =
        player.id === viewerId
        || game.phase === "battle"
        || game.phase === "finished"
        || (game.phase === "preparation" && slotIndex < game.preparationLane);
      return {
        occupied: slot.cardId !== null,
        hearts: slot.hearts,
        symbol: maySeePlacedSymbol ? card?.symbol ?? null : null
      };
    }) as PublicPlayerView["slots"]
  };
}

function battleView(battle: BattleSummary | null): BattleView | null {
  if (!battle) return null;
  return {
    round: battle.round,
    lanes: battle.lanes.map((lane) => ({
      index: lane.index,
      tripleOverride: lane.tripleOverride,
      sides: lane.sides.map((side) => ({
        playerId: side.playerId,
        symbol: side.card?.symbol ?? null,
        hearts: side.hearts,
        result: side.result,
        receivedHp: side.receivedHp
      })) as BattleView["lanes"][number]["sides"]
    })) as BattleView["lanes"],
    unassignedLost: battle.unassignedLost,
    noLoss: battle.noLoss,
    resultingHp: battle.resultingHp
  };
}

export function snapshotFor(room: Room, viewer: RoomPlayer, now: number): ServerSnapshot {
  if (!room.game) {
    const snapshot: LobbySnapshot = {
      kind: "lobby",
      roomCode: room.code,
      selfPlayerId: viewer.id,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isBot: player.isBot,
        connected: player.isBot || player.socketId !== null
      }))
    };
    return snapshot;
  }

  const self = room.game.players.find((player) => player.id === viewer.id);
  if (!self) throw new Error("Viewer is not part of the active game.");
  const snapshot: MatchSnapshot = {
    kind: "match",
    roomCode: room.code,
    selfPlayerId: viewer.id,
    phase: room.game.phase,
    round: room.game.round,
    activeLane: room.game.preparationLane,
    deadlineAt: room.game.deadlineAt,
    serverNow: now,
    deckCount: room.game.deck.length,
    players: room.game.players.map((player) =>
      publicPlayer(room, room.game!, player, viewer.id)
    ) as MatchSnapshot["players"],
    self: {
      hand: self.hand.map((card) => ({ ...card })),
      slotCardIds: self.slots.map((slot) => slot.cardId) as MatchSnapshot["self"]["slotCardIds"],
      drawnCardIds: [...self.drawnCardIds],
      extraDrawPurchased: self.extraDrawPurchased,
      requiredDiscards: self.requiredDiscards,
      discardSelection: [...self.discardSelection],
      noLossBonus: self.noLossBonus
    },
    battle: battleView(room.game.battle),
    outcome: room.game.outcome ? { ...room.game.outcome } : null
  };
  return snapshot;
}
